#!/usr/bin/env python3
"""使用隔离 Homebrew prefix 原生验证稳定/beta 安装升级，不触碰用户 Cellar。"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    candidate = args.archive.resolve()
    target = "aarch64-apple-darwin" if platform.system() == "Darwin" else "x86_64-unknown-linux-gnu"
    # macOS Homebrew 沙箱允许临时目录写入，prefix 必须放在其外以保留 brew 自身写保护。
    isolation = ROOT / "target"
    isolation.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="homebrew-", dir=isolation)).resolve()
    owner = subprocess.check_output(["brew", "--repository"], text=True).strip()
    prefix = root / "brew"
    subprocess.run(["git", "clone", "--quiet", "--shared", owner, str(prefix)], check=True)
    # 仅共享只读 Ruby runtime；Cellar、tap、缓存、home 与配置均为本轮私有。
    portable = prefix / "Library/Homebrew/vendor/portable-ruby"
    origin = Path(owner) / "Library/Homebrew/vendor/portable-ruby"
    if origin.exists():
        if portable.exists():
            shutil.rmtree(portable)
        portable.symlink_to(origin, target_is_directory=True)
    env = {
        k: v for k, v in os.environ.items() if not k.startswith(("HOMEBREW_", "AREAL_", "OTEL_"))
    }
    env.update(
        # 干净 Linux runner 无 Git 身份，tap-new 的本地提交不能依赖用户全局配置。
        HOMEBREW_GIT_NAME="AReaL release validation",
        HOMEBREW_GIT_EMAIL="validation@example.invalid",
        HOME=str(root / "user"),
        AREAL_HARNESS_HOME=str(root / "state"),
        HOMEBREW_NO_AUTO_UPDATE="1",
        HOMEBREW_NO_INSTALL_CLEANUP="1",
        HOMEBREW_NO_ANALYTICS="1",
        HOMEBREW_CACHE=str(root / "cache"),
        HOMEBREW_TEMP=str(root / "build-tmp"),
        PATH=f"{prefix}/bin:" + os.environ["PATH"],
    )
    Path(env["HOME"]).mkdir()
    Path(env["HOMEBREW_TEMP"]).mkdir()
    brew = prefix / "bin/brew"

    def run(*command, capture=False):
        return subprocess.run(
            list(map(str, command)),
            env=env,
            cwd=ROOT,
            text=True,
            check=True,
            stdout=subprocess.PIPE if capture else None,
        ).stdout

    assert Path(run(brew, "--prefix", capture=True).strip()) == prefix
    run(brew, "tap-new", "areal-validation/channel")
    tap = Path(run(brew, "--repository", "areal-validation/channel", capture=True).strip())
    spec = importlib.util.spec_from_file_location("release", ROOT / "scripts/release-artifacts.py")
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)

    def published(version):
        name = f"areal-harness-v{version}-{target}.tar.gz"
        base = f"https://github.com/areal-project/AReaL-Harness/releases/download/v{version}"
        archive = root / name
        for item in [name, "SHA256SUMS"]:
            with (
                urllib.request.urlopen(f"{base}/{item}", timeout=120) as response,
                (root / item).open("wb") as output,
            ):
                shutil.copyfileobj(response, output)
        sums = [
            line.split()[0]
            for line in (root / "SHA256SUMS").read_text().splitlines()
            if line.split()[1] == name
        ]
        assert sums == [hashlib.sha256(archive.read_bytes()).hexdigest()]
        return archive

    def formula(archive, beta=False):
        path = tap / "Formula" / ("areal-beta.rb" if beta else "areal.rb")
        release.formula(archive, path, archive.as_uri())

    stable = "areal-validation/channel/areal"
    beta = "areal-validation/channel/areal-beta"
    formula(published("0.1.5"))
    run(brew, "install", "--formula", stable)
    run(brew, "test", stable)
    formula(published("0.1.6"))
    run(brew, "upgrade", "--formula", stable)
    run(brew, "test", stable)
    formula(published("0.1.7-beta.1"), True)
    run(brew, "install", "--formula", beta)
    run(brew, "test", beta)
    candidate_beta = "-beta." in candidate.name
    selected = beta if candidate_beta else stable
    formula(candidate, candidate_beta)
    run(brew, "upgrade", "--formula", selected)
    run(brew, "test", selected)
    beta_prefix = Path(run(brew, "--prefix", selected, capture=True).strip())
    cli = beta_prefix / "bin/areal"
    checked = run(cli, "upgrade", "--check", capture=True)
    assert selected in checked, checked
    if candidate_beta:
        assert run(prefix / "bin/areal", "--version", capture=True).strip() == "areal 0.1.6", (
            "beta must not replace stable PATH entry"
        )
    run(
        sys.executable,
        ROOT / "scripts/release-smoke.py",
        "--bundle",
        beta_prefix,
        "--executable",
        cli,
    )
    unpacked = root / "candidate"
    unpacked.mkdir()
    run("tar", "-xzf", candidate, "-C", unpacked)
    run(
        sys.executable,
        ROOT / "scripts/install-smoke.py",
        "--bundle",
        unpacked / "areal",
        "--homebrew-executable",
        cli,
        "--evidence",
        args.evidence.with_suffix(".lifecycle.json"),
    )
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(
        json.dumps(
            {
                "platform": platform.system(),
                "prefix": str(prefix),
                "passed": True,
                "publicTapVerified": False,
                "checks": [
                    "public old archives and checksums",
                    "stable 0.1.5 to 0.1.6",
                    "beta.1 to candidate",
                    "beta keg-only leaves stable PATH",
                    "receipt-based actual tap check",
                    "complete native Runtime smoke",
                    "active task blocks Homebrew without stopping service",
                ],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Homebrew evidence: {args.evidence}")
    shutil.rmtree(root)


if __name__ == "__main__":
    main()
