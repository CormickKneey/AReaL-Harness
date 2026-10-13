"""临时生成全部桌面 schema 后比较或原子替换，失败不截断已提交契约。"""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GENERATORS = [
    ("areal-engine", "desktop-schema", [], "areal-core-v1.json"),
    ("areal-engine", "desktop-schema", ["--native-host"], "native-host-v2.json"),
    ("areal-protocol", "service-schema", [], "local-service-v1.json"),
]


def normalized(value):
    return json.dumps(json.loads(value), sort_keys=True, separators=(",", ":"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="areal-schema-") as temporary:
        prepared = []
        for package, example, arguments, name in GENERATORS:
            subprocess.run(
                ["cargo", "build", "--locked", "-q", "-p", package, "--example", example],
                cwd=ROOT,
                check=True,
            )
            # 此脚本由 Python 持有原生子进程，与本机既有启动入口一致。
            value = subprocess.check_output(
                [str(ROOT / "target/debug/examples" / example), *arguments], cwd=ROOT
            )
            normalized(value)
            generated = Path(temporary) / name
            generated.write_bytes(value)
            prepared.append((generated, ROOT / "schemas" / name))
        for generated, committed in prepared:
            if args.write:
                staged = committed.with_suffix(".json.tmp")
                staged.write_bytes(generated.read_bytes())
                staged.replace(committed)
            elif normalized(generated.read_bytes()) != normalized(committed.read_bytes()):
                raise SystemExit(f"schema differs: {committed.name}; run make desktop-schemas")
            print(f"schema verified: {committed.name}")


if __name__ == "__main__":
    main()
