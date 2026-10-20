"""Cleanup CLI contract checks; all artifacts belong to isolated fixtures."""

import fcntl
import hashlib
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "artifact-cleanup.py"


class ArtifactCleanupTest(unittest.TestCase):
    def test_preview_keeps_five_rounds_and_never_changes_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="artifact cleanup ") as tmp:
            root = Path(tmp).resolve() / "artifacts"
            root.mkdir()
            for i in range(7):
                folder = root / f"round-{i}"
                app = folder / "package" / "AReaL Harness GUI.app"
                resources = app / "Contents" / "Resources"
                resources.mkdir(parents=True)
                (resources / "app.asar").write_bytes(str(i).encode())
                core = resources / "areal-core"
                core.mkdir()
                files = {}
                for relative in [
                    "bin/areal",
                    "libexec/areal/areal-runtime",
                    "libexec/areal/areal-runtime-fs",
                ]:
                    binary = core / relative
                    binary.parent.mkdir(parents=True, exist_ok=True)
                    binary.write_bytes(b"embedded")
                    files[relative] = hashlib.sha256(b"embedded").hexdigest()
                (core / "manifest.json").write_text(
                    json.dumps({"coreBuild": {"inputHash": str(i)}, "files": files})
                )
                executable = app / "Contents/MacOS/AReaL Harness GUI"
                executable.parent.mkdir()
                executable.write_bytes(b"gui")
                with (app / "Contents" / "Info.plist").open("wb") as f:
                    plistlib.dump({"CFBundleShortVersionString": "1.0"}, f)
                evidence = folder / "package-evidence.json"
                evidence.write_text(json.dumps({"app": str(app)}))
                os.utime(evidence, (1000 + i, 1000 + i))
            before = {
                str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
            }
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--no-worktrees", "--json"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            rounds = report["gui_rounds"]
            self.assertEqual(len(rounds), 7)
            self.assertEqual(sum(r["retained"] for r in rounds), 5)
            self.assertEqual(
                {Path(r["path"]).name for r in rounds if not r["retained"]}, {"round-0", "round-1"}
            )
            after = {
                str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
            }
            self.assertEqual(before, after)
            applied = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(root),
                    "--no-worktrees",
                    "--apply",
                    "--report",
                    str(root.parent / "apply.json"),
                    "--json",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertFalse((root / "round-0/package/AReaL Harness GUI.app").exists())
            self.assertFalse((root / "round-1/package/AReaL Harness GUI.app").exists())
            self.assertTrue((root / "round-2/package/AReaL Harness GUI.app").exists())
            self.assertTrue((root / "round-0/package-evidence.json").exists())

    def test_rust_bundle_retention_is_separate_from_cache_and_obeys_locks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for i in range(7):
                repo = root / f"repo-{i}"
                (repo / "core/engine").mkdir(parents=True)
                (repo / "core/engine/Cargo.toml").write_text('[package]\nname = "areal-engine"\n')
                (repo / "Cargo.toml").write_text("[workspace]\n")
                profile = repo / "target/debug"
                (profile / "deps").mkdir(parents=True)
                (profile / "deps/cache").write_bytes(b"cache")
                binary = profile / "areal"
                binary.write_bytes(b"runnable")
                binary.chmod(0o755)
                bundle = repo / "core-bundle"
                files = {}
                for relative in [
                    "bin/areal",
                    "libexec/areal/areal-runtime",
                    "libexec/areal/areal-runtime-fs",
                ]:
                    path = bundle / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(f"binary-{i}".encode())
                    path.chmod(0o755)
                    files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
                manifest = bundle / "manifest.json"
                manifest.write_text(
                    json.dumps({"coreBuild": {"inputHash": str(i)}, "files": files})
                )
                os.utime(manifest, (1000 + i, 1000 + i))
            lock = root / "repo-0/target/debug/.cargo-lock"
            with lock.open("w") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "--root", str(root), "--no-worktrees", "--json"],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(len(report["rust_profiles"]), 7)
                self.assertEqual(sum(r["retained"] for r in report["rust_bundles"]), 5)
                planned = {i["path"]: i for i in report["items"]}
                self.assertEqual(
                    planned[str(root / "repo-0/target/debug/deps")]["status"], "blocked-build-lock"
                )
                self.assertIn(str(root / "repo-6/target/debug/deps"), planned)
                self.assertNotIn(str(root / "repo-6/target/debug"), planned)
                self.assertIn(str(root / "repo-0/core-bundle"), planned)
                self.assertNotIn(str(root / "repo-6/core-bundle"), planned)
                self.assertTrue((root / "repo-0/target/debug/areal").exists())

    def test_invalid_keep_fails_before_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "untouched"
            marker.write_text("keep")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", tmp, "--keep", "0", "--apply"],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), "keep")

    def test_symlink_outside_root_is_not_discovered(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            (Path(outside) / "package-evidence.json").write_text("{}")
            (Path(tmp) / "escape").symlink_to(outside, target_is_directory=True)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", tmp, "--no-worktrees", "--json"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["gui_rounds"], [])


if __name__ == "__main__":
    unittest.main()
