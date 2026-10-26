"""门禁、路径映射和独立审计的离线故障注入。"""

import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import shutil
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load("ci-scope")
audit = load("dependency-audit")


class CiContracts(unittest.TestCase):
    def test_web_compile_time_assets_are_copied_into_container_and_trigger_checks(self):
        source = ROOT / "core/app-server/src/lib.rs"
        dockerfile = (ROOT / "tests/e2e/docker/Dockerfile").read_text()
        copied = re.findall(r"^COPY (\S+) ", dockerfile, re.MULTILINE)
        for relative in re.findall(r'include_str!\("([^"]+)"\)', source.read_text()):
            asset = (source.parent / relative).resolve().relative_to(ROOT).as_posix()
            with self.subTest(asset=asset):
                self.assertTrue(
                    any(asset == path or asset.startswith(path + "/") for path in copied)
                )
                self.assertTrue(scope.applicable("gui", [asset]))
                self.assertTrue(scope.applicable("release", [asset]))

    def test_release_inputs_and_actual_workflow_scripts_are_mapped(self):
        paths = [
            "core/engine/src/lib.rs",
            "runtime/daemon/src/main.rs",
            "schemas/local-service-v1.json",
            "Makefile",
            "rust-toolchain.toml",
            "scripts/release-smoke.py",
            "scripts/native-tools-smoke.py",
            "examples/desktop-api/soak.mjs",
            "package-lock.json",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(scope.applicable("release", [path]))
        self.assertFalse(scope.applicable("release", ["docs/features.md"]))

    def test_gui_inputs_and_inapplicable_docs(self):
        for path in (
            "clients/cli/src/main.rs",
            "clients/tui/src/lib.rs",
            "clients/web/app.js",
            "core/server/build.rs",
            "runtime/daemon/src/main.rs",
            "schemas/native-host-v2.json",
            "Makefile",
        ):
            with self.subTest(path=path):
                self.assertTrue(scope.applicable("gui", [path]))
        self.assertFalse(scope.applicable("gui", ["docs/features.md"]))

    def test_real_npm_scanner_error_in_isolated_lock_fixture_still_runs_next_scan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("package.json", "package-lock.json"):
                shutil.copy2(ROOT / name, root / name)
            results = audit.scan_all(
                [
                    (
                        "offline-registry",
                        [
                            "npm",
                            "audit",
                            "--json",
                            "--registry",
                            "http://127.0.0.1:1",
                            "--fetch-retries=0",
                            "--fetch-timeout=1000",
                        ],
                        ".",
                    ),
                    (
                        "next-scan",
                        [
                            sys.executable,
                            "-c",
                            'print(\'{"metadata":{"vulnerabilities":{"total":0,"high":0}}}\')',
                        ],
                        ".",
                    ),
                ],
                root=root,
            )
            self.assertEqual([item["status"] for item in results], ["scan_error", "clean"])
            self.assertFalse(all(item["status"] == "clean" for item in results))

    def test_unexpected_skip_failure_cancel_or_missing_result_fails(self):
        for needed in (True, False):
            for result in ("success", "failure", "cancelled", "skipped", ""):
                self.assertEqual(
                    scope.require_result(needed, result),
                    result == ("success" if needed else "skipped"),
                )

    def test_all_scanners_run_despite_vulnerable_fixture_and_scan_error(self):
        calls = []

        def runner(command, **kwargs):
            calls.append(command[0])
            if command[0] == "rust":
                return subprocess.CompletedProcess(
                    command, 1, '{"vulnerabilities":{"list":[{"id":"fixture-only"}]}}', ""
                )
            if command[0] == "broken":
                return subprocess.CompletedProcess(
                    command, 1, '{"error":{"code":"registry-unavailable"}}', ""
                )
            return subprocess.CompletedProcess(
                command, 0, '{"metadata":{"vulnerabilities":{"total":0,"high":0}}}', ""
            )

        results = audit.scan_all(
            [(name, [name], ".") for name in ("rust", "broken", "npm", "pnpm")], run=runner
        )
        self.assertEqual(calls, ["rust", "broken", "npm", "pnpm"])
        self.assertEqual(
            [item["status"] for item in results],
            ["vulnerabilities", "scan_error", "clean", "clean"],
        )

    def test_malformed_or_missing_scanner_results_cannot_pass(self):
        for report in (
            None,
            {},
            {"error": "failed"},
            {"metadata": None},
            {"metadata": []},
            {"metadata": "invalid"},
            {"metadata": {"vulnerabilities": None}},
            {"metadata": {"vulnerabilities": {"high": -1}}},
            {"metadata": {"vulnerabilities": {"high": "1"}}},
        ):
            self.assertEqual(audit.outcome(0, report), "scan_error")
        self.assertEqual(audit.outcome(1, {"vulnerabilities": {"list": []}}), "scan_error")


class PreflightExecution(unittest.TestCase):
    """Exercise Make recipes while replacing only heavyweight external tools."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shutil.copy2(ROOT / "Makefile", self.root / "Makefile")
        (self.root / "clients/gui").mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        tool = self.bin / "tool"
        tool.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "with open(os.environ['COMMAND_LOG'], 'a') as log:\n"
            " log.write(json.dumps({'tool': pathlib.Path(sys.argv[0]).name, "
            "'args': sys.argv[1:], 'base': os.environ.get('AREAL_DESIGN_BASE'), "
            "'core': os.environ.get('AREAL_CORE_BIN')}) + '\\n')\n"
            "sys.exit(43 if os.environ.get('FAIL_ARG') and "
            "os.environ['FAIL_ARG'] in sys.argv[1:] else 0)\n"
        )
        tool.chmod(0o755)
        for name in ("cargo", "uv", "npm", "pnpm", "node", "python3", "actionlint"):
            (self.bin / name).symlink_to(tool)
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "COMMAND_LOG": str(self.log),
            # 此夹具使用自有假 Core，不能继承真实 pre-push 的固定产物路径。
            "AREAL_CORE_BIN": "",
        }
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.git("add", "Makefile")
        self.git("commit", "-qm", "fixture base")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.comparison = self.git(
            "commit-tree", f"{self.base}^{{tree}}", "-p", self.base, "-m", "target branch"
        ).strip()
        (self.root / "head-only").write_text("current branch")
        self.git("add", "head-only")
        self.git("commit", "-qm", "current branch")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def make(self, target, *args, **env):
        return subprocess.run(
            ["make", target, *args],
            cwd=self.root,
            env={**self.environment, **env},
            capture_output=True,
            text=True,
        )

    def calls(self):
        return (
            [json.loads(line) for line in self.log.read_text().splitlines()]
            if self.log.exists()
            else []
        )

    def test_static_requires_base_and_uses_one_merge_base_with_health_fallback(self):
        missing = self.make("ci-gui-static", "CI_BASE=")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("CI_BASE", missing.stderr)
        result = self.make("ci-gui-static", f"CI_BASE={self.comparison}")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        for script in ("check", "verify:design", "typecheck", "verify", "test:regressions"):
            selected = [call for call in calls if script in call["args"]]
            self.assertEqual(len(selected), 1, script)
            self.assertEqual(selected[0]["base"], self.base)
        result = self.make(
            "ci-gui-health", f"CI_BASE={self.comparison}", AREAL_DESIGN_BASE=self.comparison
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        health = [
            call for call in self.calls() if "clients/gui/scripts/gui-health.mjs" in call["args"]
        ]
        self.assertTrue(any("--check" in call["args"] for call in health))
        self.assertTrue(all(not call["base"] for call in health))
        self.assertFalse(
            any(any(arg.startswith("--base") for arg in call["args"]) for call in health)
        )
        baseline = self.root / "clients/gui/health-baseline.json"
        baseline.parent.mkdir(parents=True, exist_ok=True)
        baseline.write_text("{}")
        self.git("add", str(baseline.relative_to(self.root)))
        self.git("commit", "-qm", "fixture baseline")
        base = self.git("rev-parse", "HEAD").strip()
        self.log.unlink()
        result = self.make("ci-gui-health", f"CI_BASE={base}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(f"--base={base}" in call["args"] for call in self.calls()))

    def test_static_failure_blocks_later_checks(self):
        result = self.make("ci-gui-static", f"CI_BASE={self.comparison}", FAIL_ARG="check")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("test:regressions" in call["args"] for call in self.calls()))

    def test_core_is_required_and_portable_does_not_inherit_core(self):
        for core in ("", str(self.root / "missing-core")):
            result = self.make("ci-core-contracts", f"AREAL_CORE_BIN={core}")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("AREAL_CORE_BIN", result.stderr)
        core = self.bin / "areal"
        core.symlink_to(self.bin / "tool")
        result = self.make("ci-core-contracts", f"AREAL_CORE_BIN={core}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(
            any(
                "--core-contracts" in call["args"] and call["core"] == str(core)
                for call in self.calls()
            )
        )
        self.log.unlink()
        result = self.make("ci-gui-portable", AREAL_CORE_BIN=str(core))
        self.assertEqual(result.returncode, 0, result.stderr)
        runners = [
            call for call in self.calls() if "scripts/run-portable-tests.mjs" in call["args"]
        ]
        self.assertEqual(len(runners), 1)
        self.assertFalse(runners[0]["core"])

    def test_preflight_runs_shared_gates_and_stops_on_portable_failure(self):
        core = self.root / "target/debug/areal"
        core.parent.mkdir(parents=True)
        core.symlink_to(self.bin / "tool")
        result = self.make("ci-preflight", f"CI_BASE={self.comparison}")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        for argument in (
            "scripts/check-workflows.py",
            "scripts/check-docs.py",
            "scripts.tests.test_ci_contracts",
            "scripts.tests.test_git_hooks",
            "test:browser-contracts",
            "audit",
            "--core-contracts",
        ):
            self.assertTrue(any(argument in call["args"] for call in calls), argument)
        self.assertTrue(any(call["tool"] == "cargo" and "build" in call["args"] for call in calls))
        for script in ("check", "verify:design", "typecheck", "verify", "test:regressions"):
            self.assertEqual(
                sum(call["tool"] == "pnpm" and script in call["args"] for call in calls), 1, script
            )
        self.log.unlink()
        result = self.make(
            "ci-preflight", f"CI_BASE={self.comparison}", FAIL_ARG="scripts/run-portable-tests.mjs"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("--core-contracts" in call["args"] for call in self.calls()))
        self.assertFalse(
            any(call["tool"] == "cargo" and "build" in call["args"] for call in self.calls())
        )

    def test_preflight_selects_only_a_fixed_core_matching_the_fresh_build(self):
        built = self.root / "target/debug/areal"
        built.parent.mkdir(parents=True)
        shutil.copy2(self.bin / "tool", built)
        fixed = self.bin / "fixed-areal"
        shutil.copy2(built, fixed)
        result = self.make("ci-preflight", f"CI_BASE={self.comparison}", f"AREAL_CORE_BIN={fixed}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(
            any(
                "--core-contracts" in call["args"] and call["core"] == str(fixed)
                for call in self.calls()
            )
        )
        fixed.write_text(fixed.read_text() + "# stale deployment\n")
        self.log.unlink()
        result = self.make("ci-preflight", f"CI_BASE={self.comparison}", f"AREAL_CORE_BIN={fixed}")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256", result.stderr)
        self.assertFalse(any("--core-contracts" in call["args"] for call in self.calls()))
        self.assertTrue(
            any(call["tool"] == "cargo" and "build" in call["args"] for call in self.calls())
        )
