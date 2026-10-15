#!/usr/bin/env python3
"""Generate all desktop contracts before replacing any published snapshot.

Each final rename is atomic. The three replacements are not a filesystem-wide
transaction; generation or validation failures leave every old snapshot intact.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GENERATORS = (
    ("areal-core-v1.json", ["cargo", "run", "--locked", "-q", "-p", "areal-engine", "--example", "desktop-schema"]),
    ("native-host-v2.json", ["cargo", "run", "--locked", "-q", "-p", "areal-engine", "--example", "desktop-schema", "--", "--native-host"]),
    ("local-service-v1.json", ["cargo", "run", "--locked", "-q", "-p", "areal-protocol", "--example", "service-schema"]),
)


def main():
    destination = ROOT / "schemas"
    with tempfile.TemporaryDirectory(prefix=".desktop-schema-", dir=destination) as staging:
        staging = Path(staging)
        for name, argv in GENERATORS:
            print(shlex.join(argv), flush=True)
            path = staging / name
            with path.open("wb") as output:
                result = subprocess.run(argv, cwd=ROOT, stdout=output, check=False)
            if result.returncode:
                print(f"schema generator failed ({result.returncode}): {name}; published files retained", file=sys.stderr)
                return result.returncode if result.returncode > 0 else 128 - result.returncode
            try:
                value = json.loads(path.read_bytes())
                if not isinstance(value, dict):
                    raise ValueError("generated schema must be a JSON object")
            except (ValueError, UnicodeError) as error:
                print(f"invalid generated schema {name}: {error}; published files retained", file=sys.stderr)
                return 1
        for name, _ in GENERATORS:
            os.replace(staging / name, destination / name)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
