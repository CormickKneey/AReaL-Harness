#!/usr/bin/env python3
"""Build a relocatable Harness bundle with an integrity manifest."""

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("debug", "release"), default="release")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    destination = args.output.resolve()
    if destination.exists():
        parser.error("output must not exist")
    targets = {("Darwin", "arm64"): "darwin/arm64", ("Linux", "x86_64"): "linux/x86_64"}
    target_platform = targets.get((platform.system(), platform.machine()))
    if target_platform is None:
        parser.error("package targets are macOS arm64 and Linux x86_64")
    names = ["areal", "areal-runtime", "areal-runtime-fs"]
    if platform.system() == "Linux":
        names.append("areal-runtime-reaper")
    source = root / "target" / args.profile
    for name in names:
        if not (source / name).is_file():
            parser.error(f"missing {name}; build the selected Cargo profile first")
    files = {}
    (destination / "bin").mkdir(parents=True)
    shutil.copy2(root / "LICENSE", destination / "LICENSE")
    files["LICENSE"] = hashlib.sha256((destination / "LICENSE").read_bytes()).hexdigest()
    for name in names:
        relative = Path("bin" if name == "areal" else "libexec/areal") / name
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
        if platform.system() == "Darwin":
            subprocess.run(
                ["/usr/bin/codesign", "--force", "--sign", "-", str(target)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["/usr/bin/codesign", "--verify", "--strict", str(target)],
                check=True,
                capture_output=True,
            )
        files[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
    version = subprocess.check_output([str(source / "areal"), "--version"], text=True).strip()
    manifest = {
        "manifestVersion": 1,
        "productVersion": version,
        "sourceRevision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip(),
        "workingTree": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root)),
        "profile": args.profile,
        "apiVersion": "areal.core.v1",
        "stateVersion": 14,
        "platform": target_platform,
        "files": files,
        "prerequisites": [
            *(
                [
                    {"path": "/usr/bin/sandbox-exec"},
                    {
                        "path": "/usr/bin/python3",
                        "requiredFor": "macOS Runtime and trusted helper launch; executable interpreter required",
                    },
                ]
                if platform.system() == "Darwin"
                else [
                    {"glibc": ">=2.35", "verifiedVersion": platform.libc_ver()[1]},
                    {
                        "path": "/usr/bin/bwrap",
                        "requiredFor": "restricted scopes; usable user namespaces required",
                    },
                ]
            ),
        ],
        "optionalRuntimes": "Node/Python for configured tool hosts; explicitly supplied by deployment",
        "signing": "ad-hoc; no Developer ID or notarization"
        if platform.system() == "Darwin"
        else "unsigned; verify release SHA256SUMS",
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"bundle": str(destination), "manifest": "manifest.json"}))


if __name__ == "__main__":
    main()
