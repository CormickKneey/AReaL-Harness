"""直接调用安装器与可执行合成完整包，验证入口提交和失败不变量。"""

import fcntl
import io
import json
import os
import platform
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import test_release

installer = test_release.installer
release = test_release.release


class InstallTransactionTests(unittest.TestCase):
    def setUp(self):
        fixture = test_release.ReleaseTests(methodName="runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.root = fixture.root.resolve()
        fixture.root = self.root
        self.prefix = self.root / "prefix with spaces"
        self.target = installer.TARGETS[(platform.system(), platform.machine())]
        self.home = self.root / "home"
        self.home.mkdir()
        for name, content in {
            ".areal/config.toml": "synthetic model config",
            ".areal/projects/history.json": "synthetic history",
            ".areal/credentials.json": "synthetic credential sentinel",
        }.items():
            path = self.home / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.services = self.root / "services.json"
        self.services.write_text("[]")
        environment = patch.dict(
            os.environ,
            {
                "HOME": str(self.home),
                "AREAL_INSTALL_FIXTURE_SERVICES": str(self.services),
            },
        )
        environment.start()
        self.addCleanup(environment.stop)
        self.data_before = self.user_data()

    def user_data(self):
        return {
            str(p.relative_to(self.home)): p.read_bytes()
            for p in self.home.rglob("*")
            if p.is_file()
        }

    def args(self, version):
        archive = release.archive(
            self.fixture.bundle(version, self.target[0], manifest_version=2),
            self.root / ("assets-" + version),
        )
        return SimpleNamespace(
            prefix=self.prefix,
            archive=archive,
            checksums=archive.with_name(archive.name + ".sha256"),
        )

    def install(self, version, args=None):
        with redirect_stdout(io.StringIO()) as output:
            installer.install(args or self.args(version), version, self.target)
        return output.getvalue()

    def old_install(self):
        self.install("0.1.5")
        self.old = (self.prefix / "bin/areal").resolve()
        self.old_bytes = self.old.read_bytes()

    def unchanged(self, rejected="0.1.6"):
        self.assertEqual((self.prefix / "bin/areal").resolve(), self.old)
        self.assertEqual(self.old.read_bytes(), self.old_bytes)
        self.assertEqual(self.user_data(), self.data_before)
        self.assertFalse((self.prefix / f"lib/areal/{rejected}-{self.target[2]}").exists())
        self.assertEqual(list((self.prefix / "lib/areal").glob(".install-*")), [])

    def test_new_install_upgrade_version_path_and_data(self):
        self.old_install()
        output = self.install("0.1.6")
        link = self.prefix / "bin/areal"
        result = subprocess.run(
            [str(link), "--version"], capture_output=True, text=True, check=True
        )
        self.assertEqual(result.stdout, "areal 0.1.6\n")
        self.assertEqual(self.old.read_bytes(), self.old_bytes)
        self.assertEqual(self.user_data(), self.data_before)
        self.assertIn(str(link) + " --version", output)
        self.assertEqual(
            link.resolve(), self.prefix / f"lib/areal/0.1.6-{self.target[2]}/bin/areal"
        )

    def test_path_shadow_is_reported(self):
        shadow = self.root / "other-areal"
        shadow.write_text("user managed")
        with patch.object(installer.shutil, "which", return_value=str(shadow)):
            output = self.install("0.1.6")
        self.assertIn("PATH selects another installation: " + str(shadow), output)
        self.assertEqual(shadow.read_text(), "user managed")

    def test_checksum_failure_retains_old_install_and_can_retry(self):
        self.old_install()
        args = self.args("0.1.6")
        original = args.checksums.read_text()
        args.checksums.write_text("0" * 64 + "  " + args.archive.name + "\n")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.install("0.1.6", args)
        self.unchanged()
        args.checksums.write_text(original)
        self.install("0.1.6", args)
        self.assertEqual(
            (self.prefix / "bin/areal").resolve().parent.parent.name, "0.1.6-" + self.target[2]
        )

    def test_interrupted_download_retains_old_install(self):
        self.old_install()
        args = SimpleNamespace(prefix=self.prefix, archive=None, checksums=None)

        def interrupted(_url, path):
            path.write_bytes(b"partial download")
            raise ConnectionResetError("fixture interruption")

        with patch.object(installer, "download", side_effect=interrupted):
            with self.assertRaisesRegex(ConnectionResetError, "fixture interruption"):
                self.install("0.1.6", args)
        self.unchanged()
        self.install("0.1.6")
        self.assertEqual(self.user_data(), self.data_before)

    def test_service_states_do_not_block_entry_only_install_or_mutate_records(self):
        self.old_install()
        for index, value in enumerate(
            [
                '[{"state":"ready"}]',
                '[{"state":"stopping"}]',
                '[{"state":"unavailable"}]',
                "{}",
                "invalid",
            ]
        ):
            self.services.write_text(value)
            version = f"0.2.{index}"
            self.install(version)
            self.assertEqual(self.services.read_text(), value)
            self.assertEqual(self.old.read_bytes(), self.old_bytes)
            self.assertEqual(self.user_data(), self.data_before)
            self.assertEqual(
                subprocess.check_output([str(self.prefix / "bin/areal"), "--version"], text=True),
                f"areal {version}\n",
            )

    def test_first_install_does_not_operate_existing_services(self):
        self.services.write_text('[{"state":"ready"}]')
        self.install("0.1.6")
        self.assertEqual(self.services.read_text(), '[{"state":"ready"}]')
        self.assertEqual(self.user_data(), self.data_before)

    def test_service_start_after_validation_preserves_its_old_complete_bundle(self):
        self.old_install()
        check = installer.check_program

        def validated_then_started(binary, version):
            check(binary, version)
            self.services.write_text('[{"state":"ready"}]')
            self.assertEqual(
                subprocess.check_output([str(self.old), "--version"], text=True), "areal 0.1.5\n"
            )

        with patch.object(installer, "check_program", side_effect=validated_then_started):
            self.install("0.1.6")
        self.assertEqual(self.services.read_text(), '[{"state":"ready"}]')
        self.assertEqual(self.old.read_bytes(), self.old_bytes)
        self.assertEqual(self.user_data(), self.data_before)
        self.assertEqual(
            subprocess.check_output([str(self.prefix / "bin/areal"), "--version"], text=True),
            "areal 0.1.6\n",
        )

    def test_beta_complete_bundle_reports_exact_semver(self):
        version = "0.1.7-beta.10"
        self.install(version)
        entry = self.prefix / "bin/areal"
        self.assertEqual(
            subprocess.check_output([str(entry), "--version"], text=True), "areal 0.1.7-beta.10\n"
        )
        self.assertEqual(entry.resolve().parents[1].name, version + "-" + self.target[2])

    def test_link_commit_failure_or_interrupt_rolls_back_candidate(self):
        self.old_install()
        args = self.args("0.1.6")
        for failure in [OSError("fixture full disk"), KeyboardInterrupt()]:
            with patch.object(installer.os, "replace", side_effect=failure):
                with self.assertRaises(type(failure)):
                    self.install("0.1.6", args)
            self.unchanged()
        self.install("0.1.6", args)
        self.assertEqual(self.user_data(), self.data_before)

    def test_another_installer_cannot_enter_same_prefix(self):
        self.old_install()
        args = self.args("0.1.6")
        with (self.prefix / "lib/areal/.install.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(
                [
                    sys.executable,
                    str(test_release.ROOT / "scripts/install.py"),
                    "--version",
                    "0.1.6",
                    "--prefix",
                    str(self.prefix),
                    "--archive",
                    str(args.archive),
                    "--checksums",
                    str(args.checksums),
                ],
                text=True,
                capture_output=True,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("another installation is in progress", result.stderr)
        self.unchanged()

    def test_interruption_after_committed_switch_keeps_active_version_usable(self):
        self.old_install()
        args = self.args("0.1.6")
        replace = installer.os.replace

        def committed_then_interrupted(source, destination):
            replace(source, destination)
            raise KeyboardInterrupt()

        with patch.object(installer.os, "replace", side_effect=committed_then_interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.install("0.1.6", args)
        entry = self.prefix / "bin/areal"
        self.assertEqual(
            subprocess.check_output([str(entry), "--version"], text=True), "areal 0.1.6\n"
        )
        self.assertEqual(self.old.read_bytes(), self.old_bytes)
        self.assertEqual(self.user_data(), self.data_before)
        self.assertEqual(list((self.prefix / "lib/areal").glob(".install-*")), [])

    def test_candidate_must_report_expected_version(self):
        self.old_install()
        bundle = self.fixture.bundle("0.1.6", self.target[0])
        program = bundle / "bin/areal"
        program.write_text(program.read_text().replace("areal 0.1.6", "areal 9.9.9"))
        manifest = json.loads((bundle / "manifest.json").read_text())
        manifest["files"]["bin/areal"] = installer.checksum(program)
        (bundle / "manifest.json").write_text(json.dumps(manifest))
        archive = release.archive(bundle, self.root / "assets")
        args = SimpleNamespace(
            prefix=self.prefix,
            archive=archive,
            checksums=archive.with_name(archive.name + ".sha256"),
        )
        with self.assertRaisesRegex(ValueError, "program version"):
            self.install("0.1.6", args)
        self.unchanged()

    def test_missing_linux_reaper_is_not_a_complete_bundle(self):
        bundle = self.fixture.bundle("0.1.6", "linux/x86_64")
        (bundle / "libexec/areal/areal-runtime-reaper").unlink()
        path = bundle / "manifest.json"
        manifest = json.loads(path.read_text())
        del manifest["files"]["libexec/areal/areal-runtime-reaper"]
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "inventory"):
            installer.verify_bundle(bundle, "0.1.6", "linux/x86_64")

    def test_homebrew_and_unmanaged_entry_are_not_replaced(self):
        self.prefix.joinpath("bin").mkdir(parents=True)
        cellar = self.root / "Cellar/areal/0.1.6/bin/areal"
        cellar.parent.mkdir(parents=True)
        cellar.write_text("brew fixture")
        link = self.prefix / "bin/areal"
        link.symlink_to(cellar)
        with self.assertRaisesRegex(ValueError, "Homebrew"):
            self.install("0.1.7")
        self.assertEqual(link.resolve(), cellar)
        self.assertEqual(cellar.read_text(), "brew fixture")
