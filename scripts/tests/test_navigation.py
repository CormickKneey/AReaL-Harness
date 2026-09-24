import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "navigation", ROOT / "core/engine/src/tools/navigation.py"
)
navigation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(navigation)


@unittest.skipUnless((ROOT / "target/debug/tools/rg").is_file(), "make build installs builtin rg")
class SearchTest(unittest.TestCase):
    def test_builtin_ignores_host_config_and_preserves_workspace_ancestor_rules(self):
        with tempfile.TemporaryDirectory(prefix="search with spaces ") as directory:
            outer = Path(directory)
            repo = outer / "repo"
            target = repo / "src"
            target.mkdir(parents=True)
            (repo / ".git").mkdir()
            (outer / ".ignore").write_text("keep.py\n")
            (repo / ".gitignore").write_text("ignored.py\n")
            (target / "keep.py").write_text("needle 中文\n")
            (target / "ignored.py").write_text("needle forbidden\n")
            (repo / "sibling.py").write_text("needle outside selection\n")
            fake = outer / "rg"
            fake.write_text("#!/bin/sh\nexit 99\n")
            fake.chmod(0o755)
            config = outer / "rg-config"
            config.write_text("--glob=!*.py\n")
            request = {
                "path": "workspace://repo/src",
                "roots": {"repo": str(repo)},
                "pattern": "needle",
                "context": 0,
                "rg": str(ROOT / "target/debug/tools/rg"),
            }
            with patch.dict(os.environ, {"PATH": str(outer), "RIPGREP_CONFIG_PATH": str(config)}):
                result = navigation.search_files(request)
            self.assertFalse(result["limited"])
            self.assertEqual(len(result["matches"]), 1)
            self.assertEqual(result["matches"][0]["text"], "needle 中文\n")
            request["pattern"] = "absent"
            self.assertEqual(navigation.search_files(request)["matches"], [])
            request["pattern"] = "["
            with self.assertRaisesRegex(ValueError, "search failed"):
                navigation.search_files(request)

    def test_selection_escapes_glob_characters_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "selected").mkdir()
            (repo / "other[1]").mkdir()
            (repo / "selected/code").write_text("match\n")
            (repo / "other[1]/code").write_text("match\n")
            request = {
                "path": "workspace://repo/selected",
                "roots": {"repo": str(repo)},
                "pattern": "match",
                "context": 0,
                "rg": str(ROOT / "target/debug/tools/rg"),
            }
            self.assertEqual(len(navigation.search_files(request)["matches"]), 1)
            (repo / "link").symlink_to(repo / "selected", target_is_directory=True)
            request["path"] = "workspace://repo/link"
            with self.assertRaisesRegex(ValueError, "symlink"):
                navigation.search_files(request)


class NavigationTest(unittest.TestCase):
    def test_lines_unicode_hash_and_output_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "code.py"
            content = "首行\nsecond\nthird\n"
            path.write_text(content)
            request = {
                "roots": {"repo": temp},
                "path": "workspace://repo/code.py",
                "offset": 2,
                "limit": 1,
            }
            result = navigation.read_file(request)
            self.assertEqual(result["lines"], [{"number": 2, "text": "second\n"}])
            self.assertEqual(result["nextLine"], 3)
            self.assertFalse(result["eof"])
            self.assertEqual(result["sha256"], hashlib.sha256(content.encode()).hexdigest())
            request["offset"] = 3
            self.assertTrue(navigation.read_file(request)["eof"])
            path.write_text("x" * 20000)
            request["offset"] = 1
            with self.assertRaisesRegex(ValueError, "single line"):
                navigation.read_file(request)
            path.unlink()
            path.symlink_to("/etc/hosts")
            with self.assertRaisesRegex(ValueError, "symlink"):
                navigation.read_file(request)

    def test_search_distinguishes_empty_invalid_and_limited(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a.py").write_text("first\nneedle\nlast\nneedle\n")
            request = {
                "roots": {"repo": temp},
                "path": "workspace://repo",
                "pattern": "needle",
                "rg": str(ROOT / "target/debug/tools/rg"),
                "context": 1,
                "limit": 10,
            }
            result = navigation.search_files(request)
            self.assertFalse(result["limited"])
            self.assertEqual([r["line"] for r in result["matches"] if r["kind"] == "match"], [2, 4])
            request["limit"] = 1
            self.assertTrue(navigation.search_files(request)["limited"])
            request["pattern"] = "absent"
            self.assertEqual(navigation.search_files(request)["matches"], [])
            request["pattern"] = "["
            with self.assertRaisesRegex(ValueError, "search failed"):
                navigation.search_files(request)
