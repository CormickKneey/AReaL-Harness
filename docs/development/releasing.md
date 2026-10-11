**中文** | [English](releasing.en.md)

# 发行包发布

当前可验收的独立渠道为 macOS arm64 与 Linux x86_64 glibc 完整包 + Python 安装器；macOS 另可发布 Homebrew formula。与 [Codex CLI 官方安装矩阵](https://learn.chatgpt.com/docs/codex/cli#getting-started)相比，npm、Windows 在本项目尚无完整 Runtime 包或原生支持，不能列为可用渠道。`cargo install areal-cli` 同样不提供完整布局。安装范围见[安装指南](../guides/installation.md)。

## 候选构建

`Release bundles` workflow 可通过相关 PR 或 workflow_dispatch 构建候选；这两种触发只上传 CI artifacts，不创建 Git tag 或 Release。固定 Rust 工具链与 Cargo.lock；macOS 15 arm64、Ubuntu 22.04 x86_64 分别原生构建。

流水线执行 `make release`、生成完整 bundle 与逐文件 manifest、生成 tar.gz 和 SHA256，然后解压到含空格的新路径，以本地 HTTP 模型 fixture 验证真实命令写入与文件读取。Linux 执行安装器再验证安装入口，并验证原生工具；macOS 在临时 tap 安装本地同一归档，执行 `brew test` 和真实读写，再运行 release-profile 的 bundle 生命周期 soak。

macOS 打包保留构建产物的签名与原始字节，并执行 `codesign --verify --strict`；签名缺失或无效时停止打包，需修复构建产物。打包不强制重签二进制，manifest 校验和对应实际复制的文件。

`release-artifacts.py` 拒绝 dirty working tree 或非 release-profile 的 manifest。候选输出包括平台 tar.gz、manifest、SHA256 sidecar；macOS 另生成最终下载 URL 和真实归档 SHA256 的 `areal.rb`。不要手工编写占位 SHA256，也不要将 CI 候选发布为已验收正式版本。

## 发布步骤

1. 合并发布准备变更；确认选定提交的 Verify 与 Release bundles 验收通过，并检查当前版本、许可证和迁移说明。
2. 审阅两平台候选、Homebrew 测试和 Linux 安装日志，确认版本及支持范围。
3. 在固定提交创建 `v0.1.3` tag；tag 必须与 `areal --version` 一致。tag workflow 重建并验收两平台产物，全部通过后才创建 **draft** Release，不自动公开。
4. 下载 draft assets，核对 SHA256SUMS、manifest 中的 sourceRevision、profile 和平台；补齐 release notes（默认权限、依赖、旧超时配置移除、压缩默认值及缓存已知限制）。macOS 尚无 Developer ID/公证，不应标为已公证。
5. 明确批准后公开 draft。创建/更新 `areal-project/homebrew-tap` 的 `Formula/areal.rb`，内容来自该 Release 资产；先确认公开下载 URL 可用，再测试 `brew install areal-project/tap/areal`。
6. 在干净 Linux 上用公开地址安装并跑读写验收；记录发行 digest 与最终结果。后续版本重复本流程，不替换已公开版本的归档。

Release tag 与公开、tap 创建/更新是外部发布操作，应在产物审阅完成后执行。draft job 不覆盖已有 Release；失败重试前应先检查已存在的远端状态，避免替换已公开资产。GitHub Release 不是 Linux 容器镜像发布，此流程不推送镜像。

## 本地命令

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

Homebrew formula 安装 `bin`、`libexec`、LICENSE 和 manifest，避免改变 Core 查找 helper 的相对路径。Linux 安装器将不同版本放在不同目录，只原子替换入口符号链接；用户配置与历史不由安装器维护。校验失败不得切换入口。
