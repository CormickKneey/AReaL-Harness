"""用锁定版本检查工作流语法、上下文和依赖；首次下载校验公开发行摘要。"""

import argparse
import hashlib
import io
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.7.12"
ARCHIVES = {
    ("Darwin", "arm64"): (
        "darwin_arm64",
        "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    ),
    ("Darwin", "x86_64"): (
        "darwin_amd64",
        "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    ),
    ("Linux", "x86_64"): (
        "linux_amd64",
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    ),
    ("Linux", "aarch64"): (
        "linux_arm64",
        "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    ),
}


def executable():
    target = ARCHIVES.get((platform.system(), platform.machine()))
    if target is None:
        raise ValueError("Workflow lint supports macOS and Linux on arm64 or x86_64")
    name, digest = target
    directory = ROOT / ".local/tools/actionlint" / VERSION / name
    binary = directory / "actionlint"
    if binary.is_file():
        return binary
    directory.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/rhysd/actionlint/releases/download/v{VERSION}/actionlint_{VERSION}_{name}.tar.gz"
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != digest:
        raise ValueError("actionlint archive SHA-256 does not match the pinned release")
    # 只读取命名二进制，不向仓库展开第三方归档路径或执行安装脚本。
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        member = package.extractfile("actionlint")
        if member is None:
            raise ValueError("actionlint release has no executable")
        contents = member.read()
    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temporary:
        temporary.write(contents)
        installed = Path(temporary.name)
    installed.chmod(0o755)
    os.replace(installed, binary)
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "files", nargs="*", help="Workflow files; defaults to all repository workflows"
    )
    args = parser.parse_args()
    files = [Path(value).resolve() for value in args.files] or sorted(
        (ROOT / ".github/workflows").glob("*.y*ml")
    )
    if not files or any(not path.is_file() for path in files):
        parser.error("Every workflow input must exist")
    # 统一只检查 Actions 契约，避免 runner 是否预装 ShellCheck/pyflakes 改变检查范围。
    return subprocess.run(
        [str(executable()), "-shellcheck=", "-pyflakes=", *map(str, files)], cwd=ROOT
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
