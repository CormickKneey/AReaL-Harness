import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class MakeArgumentsTest(unittest.TestCase):
    def test_dash_arguments_fail_before_build_or_launch(self):
        result = subprocess.run(
            ["make", "-n", "tui", "--", "--prompt", "hello"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("make tui ARGS='--prompt hello'", result.stderr)
        self.assertNotIn("cargo", result.stdout)

    def test_args_variable_is_forwarded(self):
        result = subprocess.run(
            ["make", "-n", "tui", "ARGS=--prompt hello"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cargo run --locked -p areal-cli -- --prompt hello", result.stdout)


class DesktopSchemaGenerationTest(unittest.TestCase):
    # Planned failures: a generator dies or emits invalid JSON after earlier
    # generators succeed; all previously published files must remain intact.
    def run_generation(self, mode):
        with tempfile.TemporaryDirectory(prefix="areal-schema-check-") as temp:
            root = Path(temp)
            shutil.copy2(ROOT / "Makefile", root / "Makefile")
            (root / "scripts").mkdir()
            generator = ROOT / "scripts/generate-desktop-schemas.py"
            if generator.exists():
                shutil.copy2(generator, root / "scripts" / generator.name)
            schemas = root / "schemas"
            schemas.mkdir()
            names = ["areal-core-v1.json", "native-host-v2.json", "local-service-v1.json"]
            originals = {name: json.dumps({"published": name}).encode() for name in names}
            for name, content in originals.items():
                (schemas / name).write_bytes(content)
            binary = root / "bin"
            binary.mkdir()
            cargo = binary / "cargo"
            cargo.write_text("""#!/usr/bin/env python3
import json, os, signal, sys
if 'service-schema' in sys.argv and os.environ['SCHEMA_FIXTURE'] == 'killed':
    os.kill(os.getpid(), signal.SIGKILL)
if '--native-host' in sys.argv and os.environ['SCHEMA_FIXTURE'] == 'invalid':
    print('not-json')
else:
    print(json.dumps({'generated': sys.argv[1:]}))
""")
            cargo.chmod(0o755)
            result = subprocess.run(
                ["make", "desktop-schemas"],
                cwd=root,
                capture_output=True,
                env={
                    **os.environ,
                    "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "SCHEMA_FIXTURE": mode,
                },
                check=False,
            )
            contents = {name: (schemas / name).read_bytes() for name in names}
            remaining = sorted(p.name for p in schemas.iterdir())
            return result, originals, contents, remaining

    def test_killed_generator_preserves_every_published_schema(self):
        result, originals, contents, remaining = self.run_generation("killed")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, originals, "generator failure destroyed published schemas")
        self.assertEqual(remaining, sorted(originals))

    def test_invalid_json_preserves_every_published_schema(self):
        result, originals, contents, remaining = self.run_generation("invalid")
        self.assertNotEqual(result.returncode, 0, "invalid generated JSON was published")
        self.assertEqual(contents, originals)
        self.assertEqual(remaining, sorted(originals))

    def test_success_publishes_all_valid_outputs(self):
        result, originals, contents, remaining = self.run_generation("ok")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        for name, content in contents.items():
            self.assertNotEqual(content, originals[name])
            self.assertIn("generated", json.loads(content))
        self.assertEqual(remaining, sorted(originals))


if __name__ == "__main__":
    unittest.main()
