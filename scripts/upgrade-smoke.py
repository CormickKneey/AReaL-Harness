#!/usr/bin/env python3
"""隔离运行真实 CLI 升级；服务记录为合成数据，不证明真实任务存活。"""

import argparse
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target/debug/areal"
PLATFORMS = {
    ("Darwin", "arm64"): ("darwin/arm64", "aarch64-apple-darwin", "macos-arm64"),
    ("Linux", "x86_64"): ("linux/x86_64", "x86_64-unknown-linux-gnu", "linux-x86_64"),
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def snapshot(root):
    result = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        mode = path.lstat().st_mode
        if path.is_symlink():
            result[relative] = (mode, os.readlink(path))
        elif path.is_file():
            result[relative] = (mode, digest(path))
        else:
            result[relative] = (mode, None)
    return result


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


def archive(root, version, binary=None):
    target, archive_target, _ = PLATFORMS[(platform.system(), platform.machine())]
    bundle = root / version / "areal"
    (bundle / "bin").mkdir(parents=True)
    if binary:
        shutil.copy2(binary, bundle / "bin/areal")
    else:
        executable(
            bundle / "bin/areal",
            f'#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 91\n'
            f"printf 'areal {version}\\n'\n",
        )
    helpers = ["areal-runtime", "areal-runtime-fs"]
    if target.startswith("linux/"):
        helpers.append("areal-runtime-reaper")
    for name in helpers:
        executable(bundle / "libexec/areal" / name, f"#!/bin/sh\nprintf '{name} {version}\\n'\n")
    (bundle / "LICENSE").write_text("offline smoke fixture\n")
    files = {str(p.relative_to(bundle)): digest(p) for p in bundle.rglob("*") if p.is_file()}
    (bundle / "manifest.json").write_text(
        json.dumps(
            {
                "manifestVersion": 1,
                "productVersion": "areal " + version,
                "platform": target,
                "files": files,
                "profile": "release",
                "workingTree": False,
            }
        )
    )
    output = root / f"areal-harness-v{version}-{archive_target}.tar.gz"
    with tarfile.open(output, "w:gz", compresslevel=1) as stream:
        stream.add(bundle, arcname="areal")
    sums = output.with_suffix(".sha256")
    sums.write_text(f"{digest(output)}  {output.name}\n")
    return output, sums


class UpgradeSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 短路径满足真实服务登记的 Unix socket 路径长度限制，不创建监听端点。
        cls.temporary = tempfile.TemporaryDirectory(prefix="au-", dir="/tmp")
        cls.root = Path(cls.temporary.name).resolve()
        cls.addClassCleanup(cls.temporary.cleanup)
        probe = cls.root / "probe/areal"
        probe.parent.mkdir()
        shutil.copy2(BINARY, probe)
        home = cls.root / "probe-home"
        home.mkdir()
        env = cls.environment(home)
        output = subprocess.run(
            [str(probe), "--version"],
            env=env,
            cwd=home,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout.strip()
        match = re.fullmatch(r"areal (\d+)\.(\d+)\.(\d+)(-beta\.[1-9]\d*)?", output)
        if not match:
            raise RuntimeError(f"expected stable or beta CLI version, got {output!r}")
        cls.current = output.removeprefix("areal ")
        major, minor, patch = map(int, match.groups()[:3])
        cls.latest = f"{major}.{minor}.{patch if match[4] else patch + 1}"
        cls.old_archive = archive(cls.root, cls.current, probe)
        cls.new_archive = archive(cls.root, cls.latest)
        cls.installer = (ROOT / "scripts/install.py").read_text()
        print(
            f"Copied CLI {output}; sha256={digest(probe)}; fixture latest={cls.latest}", flush=True
        )

    @staticmethod
    def environment(home):
        return {
            "HOME": str(home),
            "AREAL_HARNESS_HOME": str(home / "harness"),
            "AREAL_HARNESS_SERVICE_HOME": str(home / "registry"),
            "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_DATA_HOME": str(home / "data"),
            "XDG_CACHE_HOME": str(home / "cache"),
            "TMPDIR": str(home),
            "PATH": "/usr/bin:/bin",
            "LANG": "C",
        }

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix="c-", dir=self.root))
        self.home = self.case / "h"
        self.workspace = self.case / "w"
        self.other_workspace = self.case / "other"
        for directory in [self.home, self.workspace, self.other_workspace]:
            directory.mkdir(mode=0o700)
        self.env = self.environment(self.home)
        self.prefix = self.case / "prefix with spaces"
        self.registry = Path(self.env["AREAL_HARNESS_SERVICE_HOME"])
        self.state = self.case / "state"
        self.state.mkdir(mode=0o700)
        (self.state / "sentinel").write_bytes(b"state must remain untouched\x00\xff")
        command = [
            sys.executable,
            "-I",
            "-S",
            "-c",
            self.installer,
            "--version",
            self.current,
            "--prefix",
            str(self.prefix),
            "--archive",
            str(self.old_archive[0]),
            "--checksums",
            str(self.old_archive[1]),
        ]
        result = subprocess.run(
            command, env=self.env, cwd=self.workspace, text=True, capture_output=True, timeout=90
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.cli = self.prefix / "bin/areal"
        self.old = self.cli.resolve().parents[1]
        self.shim = self.case / "shims"
        self.trace = self.case / "python-calls.jsonl"
        self.brew_trace = self.case / "brew-called"
        self.checksums = self.case / "SHA256SUMS"
        shutil.copy2(self.new_archive[1], self.checksums)
        executable(
            self.shim / "python3",
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            f"trace = {str(self.trace)!r}\n"
            "args = sys.argv[1:]\n"
            "if args[:3] != ['-I', '-S', '-c'] or len(args) < 4:\n"
            "    raise SystemExit('unexpected Python invocation')\n"
            "with open(trace, 'a') as stream:\n"
            "    stream.write(json.dumps(args[4:]) + '\\n')\n"
            "if args[4:] == ['--version', 'latest', '--check']:\n"
            f"    print({self.latest!r})\n"
            "else:\n"
            f"    expected = ['--version', {self.latest!r}, '--prefix', {str(self.prefix)!r}]\n"
            "    if args[4:] != expected:\n"
            "        raise SystemExit('unexpected installer arguments')\n"
            f"    args += ['--archive', {str(self.new_archive[0])!r}, "
            f"'--checksums', {str(self.checksums)!r}]\n"
            f"    os.execv({sys.executable!r}, [{sys.executable!r}] + args)\n",
        )
        executable(self.shim / "brew", f"#!/bin/sh\nprintf called > '{self.brew_trace}'\nexit 93\n")
        self.env["PATH"] = str(self.shim) + ":/usr/bin:/bin"
        self.old_before = snapshot(self.old)

    def invoke(self, *args):
        return subprocess.run(
            [str(self.cli), *args],
            cwd=self.workspace,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def record(self, stored_state):
        service_id = "a" * 24
        directory = self.registry / "services" / service_id
        directory.mkdir(parents=True, mode=0o700)
        for parent in [self.registry, directory.parent]:
            parent.chmod(0o700)
        record = {
            "protocolVersion": 1,
            "serviceId": service_id,
            "generation": "synthetic-generation",
            "workspace": str(self.other_workspace),
            "dataDir": str(self.state),
            "configFingerprint": "synthetic-config",
            "endpoint": "synthetic-no-network-endpoint",
            "webUrl": "synthetic-no-web-url",
            "authFile": str(self.state / "absent-auth"),
            "logFile": str(self.state / "absent-log"),
            "hostPid": 0,
            "corePid": 0,
            "state": stored_state,
        }
        descriptor = directory / "service.json"
        descriptor.write_text(json.dumps(record) + "\n")
        descriptor.chmod(0o600)
        for path in [directory / "start.lock", self.state / "service.lock"]:
            path.touch(mode=0o600)
        if stored_state != "stopped":
            lock = (self.state / "service.lock").open("r+")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.addCleanup(lock.close)
        else:
            # 预建观察路径可能打开的锁，比较中不掩盖新增状态文件。
            (self.state / "owner.lock").touch(mode=0o600)
        before = snapshot(self.registry), snapshot(self.state)
        listed = self.invoke("service", "list", "--json")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        services = json.loads(listed.stdout)
        self.assertEqual(len(services), 1)
        self.assertEqual(services[0]["serviceId"], service_id)
        self.assertEqual(
            services[0]["state"], "stopped" if stored_state == "stopped" else "unavailable"
        )
        self.assertEqual((snapshot(self.registry), snapshot(self.state)), before)
        return before

    def assert_preserved(self, before):
        self.assertEqual((snapshot(self.registry), snapshot(self.state)), before)
        self.assertEqual(snapshot(self.old), self.old_before)
        self.assertFalse(self.brew_trace.exists(), "Homebrew must not be invoked")

    def assert_installed(self, result, before):
        self.assert_preserved(before)
        self.assertEqual(result.returncode, 0, f"stdout:\n{result.stdout}stderr:\n{result.stderr}")
        suffix = PLATFORMS[(platform.system(), platform.machine())][2]
        new = self.prefix / f"lib/areal/{self.latest}-{suffix}"
        self.assertEqual(self.cli.resolve(), new / "bin/areal")
        version = self.invoke("--version")
        self.assertEqual((version.returncode, version.stdout), (0, f"areal {self.latest}\n"))
        self.assertEqual(snapshot(new), snapshot(self.root / self.latest / "areal"))
        self.assertEqual(
            self.calls(),
            [
                ["--version", "latest", "--check"],
                ["--version", self.latest, "--prefix", str(self.prefix)],
            ],
        )
        for helper in (self.old / "libexec/areal").iterdir():
            output = subprocess.run(
                [str(helper)],
                env=self.env,
                cwd=self.workspace,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(output.returncode, 0)
            self.assertEqual(output.stdout, f"{helper.name} {self.current}\n")

    def calls(self):
        return [json.loads(line) for line in self.trace.read_text().splitlines()]

    def upgrade_record(self, state):
        # 无控制监听端点，ready/stopping 登记在持锁时只能被观察为 unavailable。
        before = self.record(state)
        self.assert_installed(self.invoke("upgrade"), before)

    def test_standalone_ready_record(self):
        self.upgrade_record("ready")

    def test_standalone_stopping_record(self):
        self.upgrade_record("stopping")

    def test_standalone_unavailable_record(self):
        self.upgrade_record("unavailable")

    def test_standalone_without_services(self):
        self.registry.mkdir(mode=0o700)
        before = snapshot(self.registry), snapshot(self.state)
        self.assert_installed(self.invoke("upgrade"), before)

    def homebrew(self):
        binary = self.case / "Cellar/areal" / self.current / "bin/areal"
        binary.parent.mkdir(parents=True)
        shutil.copy2(self.old / "bin/areal", binary)
        self.cli = binary
        (binary.parents[1] / "INSTALL_RECEIPT.json").write_text(
            json.dumps({"source": {"tap": "custom/release", "versions": {"stable": self.current}}})
        )
        executable(
            self.case / "bin/brew",
            f"#!{sys.executable}\nimport json, sys\nprint(json.dumps({{'formulae':[{{'full_name':'custom/release/areal', 'versions':{{'stable':{self.latest!r}}}}}]}}))\n",
        )

    def test_homebrew_non_stopped_record_blocks_without_invoking_brew(self):
        self.homebrew()
        # 当前编译版本是 beta，模拟正确 beta formula 收据。
        if "-beta." in self.current:
            beta_binary = self.case / "Cellar/areal-beta" / self.current / "bin/areal"
            beta_binary.parent.mkdir(parents=True)
            shutil.copy2(self.cli, beta_binary)
            self.cli = beta_binary
            (beta_binary.parents[1] / "INSTALL_RECEIPT.json").write_text(
                json.dumps(
                    {"source": {"tap": "custom/release", "versions": {"stable": self.current}}}
                )
            )
        before = self.record("unavailable")
        install_before = snapshot(self.case / "Cellar")
        result = self.invoke("upgrade")
        self.assert_preserved(before)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stop all shared services before upgrading", result.stderr)
        self.assertEqual(snapshot(self.case / "Cellar"), install_before)
        self.assertFalse(self.trace.exists())

    def test_check_has_no_install_or_service_mutation(self):
        before = self.record("unavailable")
        for installation in ["standalone"]:
            with self.subTest(installation=installation):
                if installation == "homebrew":
                    self.homebrew()
                prefix_before = snapshot(self.prefix)
                home_before = snapshot(self.home)
                state_before = snapshot(self.state)
                result = self.invoke("upgrade", "--check")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"latest published: {self.latest}", result.stdout)
                self.assertEqual(snapshot(self.prefix), prefix_before)
                self.assertEqual(snapshot(self.home), home_before)
                self.assertEqual(snapshot(self.state), state_before)
                self.assert_preserved(before)
        self.assertEqual(self.calls(), [["--version", "latest", "--check"]])

    def invalid_checksum(self, state):
        self.checksums.write_text("0" * 64 + "  " + self.new_archive[0].name + "\n")
        before = self.record(state)
        prefix_before = snapshot(self.prefix)
        result = self.invoke("upgrade")
        self.assert_preserved(before)
        self.assertEqual(snapshot(self.prefix), prefix_before)
        self.assertEqual(self.cli.resolve(), self.old / "bin/areal")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive checksum missing, ambiguous or incorrect", result.stderr)

    def test_invalid_checksum_stopped_record(self):
        self.invalid_checksum("stopped")

    def test_invalid_checksum_unavailable_record(self):
        self.invalid_checksum("unavailable")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=BINARY)
    args, remaining = parser.parse_known_args()
    BINARY = args.binary.resolve(strict=True)
    if (platform.system(), platform.machine()) not in PLATFORMS:
        parser.error("requires macOS arm64 or Linux x86_64 glibc installer platform")
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
