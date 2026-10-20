"""在独立 Git 仓库验证来源门禁；不依赖真实远端或分支状态。"""

import subprocess
import tempfile
import unittest
from pathlib import Path

import test_release

source = test_release.load("release_source", "release-source.py")


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.root / "source").write_text("initial")
        self.git("add", "source")
        self.git("commit", "-m", "initial")
        self.base = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/remotes/origin/main", self.base)

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.root, text=True, stderr=subprocess.PIPE
        ).strip()

    def test_accepts_fixed_clean_merged_source(self):
        self.assertEqual(
            source.verify_source(self.root, self.base),
            {
                "sourceRevision": self.base,
                "mergedMainRevision": self.base,
            },
        )

    def test_rejects_unmerged_then_accepts_after_main_contains_it(self):
        (self.root / "source").write_text("candidate")
        self.git("commit", "-am", "candidate")
        revision = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(ValueError, "not merged"):
            source.verify_source(self.root, revision)
        self.git("update-ref", "refs/remotes/origin/main", revision)
        self.assertEqual(source.verify_source(self.root, revision)["sourceRevision"], revision)

    def test_rejects_dirty_relabelled_or_abbreviated_source(self):
        (self.root / "source").write_text("dirty")
        with self.assertRaisesRegex(ValueError, "clean checkout"):
            source.verify_source(self.root, self.base)
        self.git("restore", "source")
        for value in [self.base[:8], "f" * 40]:
            with self.assertRaises(ValueError):
                source.verify_source(self.root, value)
        (self.root / "untracked-code").write_text("untracked")
        with self.assertRaisesRegex(ValueError, "clean checkout"):
            source.verify_source(self.root, self.base)
