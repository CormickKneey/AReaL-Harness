#!/usr/bin/env python3
"""从验收 bundle 生成版本化归档、校验和及 Homebrew formula。"""

import argparse
import hashlib
import json
import re
import tarfile
from pathlib import Path

TARGETS = {"darwin/arm64": "aarch64-apple-darwin", "linux/x86_64": "x86_64-unknown-linux-gnu"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive(bundle, output):
    manifest = json.loads((bundle / "manifest.json").read_text())
    version = manifest["productVersion"].removeprefix("areal ")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("invalid product version")
    if manifest["profile"] != "release" or manifest["workingTree"]:
        raise ValueError("release artifacts require a clean release-profile bundle")
    if not re.fullmatch(r"[a-f0-9]{40}", str(manifest.get("sourceRevision", ""))):
        raise ValueError("release artifacts require a full source commit SHA")
    if manifest["platform"] == "linux/x86_64":
        glibc = next(
            (p.get("verifiedVersion") for p in manifest.get("prerequisites", []) if "glibc" in p),
            None,
        )
        if glibc != "2.35":
            raise ValueError("Linux release must be built against the verified glibc 2.35 baseline")
    target = TARGETS[manifest["platform"]]
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"areal-harness-v{version}-{target}.tar.gz"
    sums = output / (path.name + ".sha256")
    metadata = output / f"manifest-{target}.json"
    if any(p.exists() or p.is_symlink() for p in (path, sums, metadata)):
        raise ValueError("release output already exists; use a new output directory")
    with path.open("xb") as archive_file, tarfile.open(fileobj=archive_file, mode="w:gz") as stream:
        stream.add(bundle, arcname="areal")
    with sums.open("x") as checksums:
        checksums.write(f"{sha(path)}  {path.name}\n")
    with metadata.open("xb") as manifest_file:
        manifest_file.write((bundle / "manifest.json").read_bytes())
    return path


def formula(path, output, url=None, extra_archives=()):
    paths = [path, *extra_archives]
    platforms = {}
    version = None
    for item in paths:
        match = re.fullmatch(
            r"areal-harness-v(\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?)-(aarch64-apple-darwin|x86_64-unknown-linux-gnu).tar.gz",
            item.name,
        )
        if not match or version not in (None, match[1]) or match[2] in platforms:
            raise ValueError(
                "formula requires distinct supported archives of the same stable/beta version"
            )
        version = match[1]
        platforms[match[2]] = item
    if url and len(paths) != 1:
        raise ValueError("local URL override requires one platform archive")
    beta = "-beta." in version
    name = "ArealBeta" if beta else "Areal"
    blocks = []
    for target, item in platforms.items():
        address = (
            url
            or f"https://github.com/areal-project/AReaL-Harness/releases/download/v{version}/{item.name}"
        )
        if "#{" in address or not address.startswith(("https://", "file://")):
            raise ValueError("unsupported formula URL")
        mac = target == "aarch64-apple-darwin"
        requirements = (
            "    depends_on arch: :arm64\n    depends_on macos: :sequoia\n    depends_on xcode: :clt"
            if mac
            else "    depends_on arch: :x86_64"
        )
        blocks.append(f'''  on_{"macos" if mac else "linux"} do
{requirements}
    url {json.dumps(address)}
    sha256 "{sha(item)}"
  end''')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Homebrew 会自动 link :versioned_formula；预览必须始终保持显式隔离。
    isolation = (
        '  keg_only "the beta channel is opt-in and must not replace the stable CLI"\n'
        if beta
        else ""
    )
    output.write_text(f'''class {name} < Formula
  desc "Agent harness with a terminal UI and local tool runtime"
  homepage "https://github.com/areal-project/AReaL-Harness"
  version "{version}"
  license "Apache-2.0"
{isolation}
{chr(10).join(blocks)}

  def install
    if OS.linux?
      glibc = Utils.safe_popen_read("/usr/bin/getconf", "GNU_LIBC_VERSION").split.last
      odie "AReaL requires host glibc >= 2.35" if Version.new(glibc) < Version.new("2.35")
      odie "Install system bubblewrap at /usr/bin/bwrap" unless File.executable?("/usr/bin/bwrap")
    end
    prefix.install "bin", "libexec", "manifest.json", "LICENSE"
  end

  def caveats
    <<~EOS
      Configure your model in ~/.areal/config.toml before starting a task.
      Homebrew may remove old kegs: finish tasks and stop shared services before upgrading.
      Use areal service list to inspect services; upgrade never stops them automatically.
      macOS binaries are ad-hoc signed, without Developer ID signing or Apple notarization.
      Python 3.9+ is required for standalone installation and upgrades.
    EOS
  end

  test do
    assert_equal "areal {version}", shell_output("#{{bin}}/areal --version").strip
    assert_path_exists prefix/"libexec/areal/areal-runtime"
    assert_path_exists prefix/"libexec/areal/areal-runtime-fs"
    assert_path_exists prefix/"libexec/areal/areal-runtime-reaper" if OS.linux?
  end
end
''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("archive")
    pack.add_argument("--bundle", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    brew = commands.add_parser("formula")
    brew.add_argument("--archive", type=Path, required=True, action="append")
    brew.add_argument("--output", type=Path, required=True)
    brew.add_argument("--url", help="local file URL for prepublication Homebrew verification")
    args = parser.parse_args()
    if args.command == "archive":
        print(archive(args.bundle, args.output))
    else:
        formula(args.archive[0], args.output, args.url, args.archive[1:])


if __name__ == "__main__":
    main()
