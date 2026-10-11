[中文](releasing.md) | **English**

# Publishing release bundles

Validated standalone channels are complete macOS arm64 and Linux x86_64 glibc bundles with the Python installer; macOS may also ship a Homebrew formula. Unlike the [official Codex CLI installation matrix](https://learn.chatgpt.com/docs/codex/cli#getting-started), this project has no complete npm or native Windows distribution yet. `cargo install areal-cli` also lacks the Runtime and bundled tools. See [installation](../guides/installation.en.md) for platform scope.

## Candidate builds

The `Release bundles` workflow builds candidates on relevant pull requests or workflow_dispatch. These triggers upload CI artifacts without creating Git tags or Releases. It uses the pinned Rust toolchain and Cargo.lock, building natively on macOS 15 arm64 and Ubuntu 22.04 x86_64.

The workflow runs `make release`, creates complete bundles with file manifests, tar.gz archives and checksums, then extracts them into relocated paths containing spaces. A local HTTP model fixture verifies real command writes and file reads. Linux additionally installs through the installer and verifies its entry point and native tools. macOS installs the same local archive through a temporary Homebrew tap, runs `brew test` and real read/write checks, then runs the release-profile bundle lifecycle soak.

macOS packaging preserves the build artifacts' signatures and original bytes and runs `codesign --verify --strict`. Missing or invalid signatures stop packaging and must be fixed in the build artifacts. Packaging does not force a new signature onto binaries; manifest checksums describe the files actually copied.

`release-artifacts.py` rejects dirty-tree or non-release-profile manifests. Candidate outputs include platform archives, manifests and SHA256 sidecars. The macOS job also generates `areal.rb` using the final download URL and actual archive checksum. Never use placeholder SHA256 values or describe unapproved candidates as released versions.

## Publication steps

1. Merge preparation changes. Confirm Verify and Release bundles pass for the selected commit; inspect version, licenses and migration notes.
2. Review both platform candidates, Homebrew checks and Linux installation logs; confirm scope and version.
3. Create tag `v0.1.3` on the selected commit. It must match `areal --version`. Tag builds reconstruct and verify both packages, then create a **draft** Release only after all checks pass; they do not publish it.
4. Download draft assets and verify SHA256SUMS and manifest sourceRevision, profile and platform. Complete release notes covering default permissions, dependencies, retired timeout settings, compaction defaults and known caching limitations. macOS has no Developer ID signing/notarization and must not be labeled notarized.
5. Publish the draft after explicit approval. Create/update `Formula/areal.rb` in `areal-project/homebrew-tap` from that Release asset. Confirm public download availability before testing `brew install areal-project/tap/areal`.
6. Install through the public URL on clean Linux and run read/write validation. Record artifact digests and results. Repeat for future versions without replacing published archives.

Tagging, publishing and tap creation/updates are external publication operations performed after artifact review. The draft job does not overwrite existing Releases; inspect remote state before retrying failures. This workflow does not publish Linux container images.

## Local commands

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

The formula installs `bin`, `libexec`, LICENSE and the manifest, preserving Core's relative helper discovery. Linux installs versions into separate directories and atomically switches only the entry symlink. Configuration and history remain outside installer ownership. Validation failure must not switch the entry point.
