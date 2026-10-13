**中文** | [English](codex-plugins-p1-p3-acceptance.en.md)

# Codex 插件 P1/P3 验收记录

**状态：GitHub 首批交付；P1/P3 完整验收仍开放。** 更新于 2026-10-13。源码、实际 Core/CLI 与原生桌面路径已有证据；不能据此宣称完整 Codex 兼容。分支 `codex/codex-plugins-p1-p3`，起点 `d4ee44af837afec758c89224a2351881ce2b5661`。

## 范围与固定契约

当前批次覆盖 P1 来源获取/MCP 生命周期和 P3 桌面 Apps/扩展，以 GitHub 为首个真实服务；不包含 P2 hooks。P0 保留独立的[验收记录](codex-plugins-p0-acceptance.md)，不能代替[阶段计划](codex-plugins-plan.md)中的新增要求。

| 契约 | 固定参考与声明边界 |
|---|---|
| Codex 包行为与插件管理 wire 类型 | `0.162.1`，commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`；仅插件 adapter，不升级现有 `0.145.0` app-server 契约 |
| Agent Plugins manifest/MCP schema | `1.0.0`；manifest SHA-256 `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`，MCP SHA-256 `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb` |
| OpenAI 公开 MCP Extensions | revision `0d606217705e0e71eb21fff009619b67b80611dc`；来源固定与服务访问资格分开 |
| MCP 连接宿主 | rmcp `3.3.0`，宿主协商基线 `2025-11-25`；Apps capability 为 `io.modelcontextprotocol/ui`，MIME 为 `text/html;profile=mcp-app` |

固定的 OpenAI 公开规范要求 OpenAI 注册服务的 forms 使用 MCP `2026-07-28` 或更新版本以及多轮请求 MRTR。直接 MCP 连接可以使用 legacy forms。本宿主的 `2025-11-25` 行为没有实现该现代 MRTR 路径；不能因 Apps/forms 已有实现就宣称支持全部 OpenAI 机制。协议能力和私有服务权限是独立前提。

## 已实现的所有者与可观察接口

| 所有者 | 当前源码/接口 | 证据边界 |
|---|---|---|
| 包 Store | `core/plugins/src/{remote,components,metadata}.rs`；来源解析、固定 Git/npm 内容和组件文档 | 安装/解析不执行包 lifecycle scripts；来源测试不能证明真实远程 MCP 服务通过 |
| MCP 归一化/认证 | `normalize_plugin_document`、`PluginServerConfig::redacted_view`、`AuthPolicy::is_supported`；`AuthManager::{start,status,cancel,ready_credential}` | 配置字面量与凭据留在内部；公开状态为 Pending/Ready/Failed/Cancelled |
| MCP 连接 | `Connections::connect_plugins_with_options`、generation 绑定的 `McpTool::call_raw_with_meta`、`McpServer` 资源 API 与 `ResourceUpdates` | 保留原始元信息和完整结果；generation 内 schema 固定；撤权取消克隆句柄；list change 不重放调用 |
| Legacy elicitation | `ElicitationBroker`、标准及 `openai/elicitation/create` 请求 | 绑定 server/generation/request 身份与取消；不代表现代 MRTR 已验收 |
| Core 桌面协议 | `core/protocol/src/plugin_runtime.rs`；`areal/plugin/connection`、`areal/plugin/auth`、`areal/plugin/connector/configure`、`areal/mcp/tool/result` 和 App/extension/form 方法 | 类型化归属与收据；Main 授权的文件路径不能从 App 输入推导 |
| 桌面宿主 | `clients/gui/app/src/core/mcp-apps*.cjs`、`McpAppHost`、`McpAppForm`、`McpAppsWorkspace` | Electron 拥有隔离表面/文件，Core 拥有执行；下列 GUI/SDK 检查不证明原生显示或用户上传 |
| Codex 管理 adapter | `core/app-server/src/codex_plugins.rs`，固定的 `plugin/*`、`marketplace/*` handlers | 使用原有 Store；未配置的托管 catalog/search/sharing 明示 capability 不可用 |

这些条目用于定位实现所有者。验收以以下证据和最终集成候选为准，不能由路由或类型存在推断完成。

## 认证机制矩阵

| 机制 | 当前结果 |
|---|---|
| Legacy 仅有 `auth: "oauth"`、没有 OAuth 对象 | 建立 discovery policy，不静默归一化为匿名 |
| OAuth discovery、provided public client、DCR、带 metadata URL 的 legacy CIMD | SDK 与本地真实 HTTP fixture 覆盖 callback state/issuer、refresh、取消；不代表真实供应商验收 |
| HTTP401/403 与 refresh `invalid_grant` | 比对实际请求 token 后撤销拒绝凭据；显式重试重新授权；不自动重放 MCP POST |
| 并发所有者 | 原子替换 flow、epoch 绑定 callback、权威重读和私有 OS store lock；最新跨进程执行限制见下表 |
| 供应商错误/code/token 日志 | 自有 freshness 判断调用 SDK direct refresh；认证 future 局部 NoSubscriber 防止 SDK 秘密日志，不改变全局日志策略 |
| Portable `extensions["com.openai"].auth` | 私有保留声明和有效同级 server，并诊断固定 Codex 拒绝 extensions；也识别 dotted 声明形式 |
| Portable discovery/provided public client/DCR/base scopes | 当前归一化/认证所有者支持 |
| Portable endpoint/resource/OIDC/default-scope override、client secret/key 配置、无宿主 metadata URL 的 CIMD preference、mixed 认证和 API-key 执行 | 保留声明但宿主明示未支持；`is_supported()` 与脱敏 `authenticationSupported` 报告缺口；不宣称匿名回退可用 |
| Legacy SSE transport | 按固定 Codex 明确拒绝，不宣称支持全部 Agent Plugins transport |

本轮新鲜评审发现五项认证/归一化问题：拒绝 token 重试、SDK 秘密日志、并发 start 替代关系、共享 store refresh 串行化，以及 portable/legacy auth 保留。相应限定修复已进入源码。修复前三项有实际失败复现：错误的 Ready 状态、sentinel 日志泄漏、重复 refresh。修复存在和本地检查通过不能代替最终集成评审或真实凭据/服务验收。

## 最终本地证据

| 层次 | 结果 | 验收边界 |
|---|---|---|
| 来源/包 | 27 项通过：metadata 1、remote 11、store 15 | 本地 Git/npm registry fixture；不代表实际 SSH/所有 registry |
| MCP | 24 项未受子进程失败影响的检查通过 | client 7、concurrency 1、GitHub 本地 2、OAuth 6、optional 2、normalization 4、resources/forms 2；真实服务另计 |
| Engine | 最终 primary 24 项通过，1 项因重启探针 SIGKILL 未通过 | admission 9、plugins 8、MCP runtime 7；独立 lane 的原始集成 harness 8 项通过，不能替代 primary 缺口 |
| 实际 Core/CLI | CLI 8 项、固定 Codex 管理 wire 6 项通过 | 来源固定、共享状态、收据去重、丢失响应后只读恢复；私有服务返回能力错误 |
| 真实 GitHub | 5 项通过 | 原始不透明 ID → 显式配置 → 官方 `api.githubcopilot.com` → 一次只读 `get_me` 经普通 Core journal → 断开；没有 GitHub 写操作；不是 DCR 或真实模型验收 |
| 原生 Electron Apps | 8 项通过 | 显式 Profile/model-only 声明入口、沙箱与私有元信息、App 后续 visibility/同服务器限制、草稿/类型资源、模型过滤和撤权 |
| 原生桌面扩展 | 5 项通过 | settings 仅保存改变字段一次、mentions、legacy form 跨 Thread 归属/接受/取消、文件入口不透明 URI 与实际只读 I/O |
| GUI/构建 | workspace build、GUI build/typecheck/public boundary、官方 SDK 与 draft smoke 通过 | 未执行 CI、签名/公证、安装包或跨平台验收 |

源码清单摘要为 `b63428ca03285806fc5fd2e11134e2bc11a9b25d39b6ce11f3c6e02337eea908`；Core 二进制 SHA-256 为 `000307ca6e63e62afa3dcab51d22f1b08c20daccaa7f8eadcaa2b7f64d31de61`。本地证据保存在被 Git 排除的 `.scratch/codex-plugins/evidence/p1-p3/`，包括 `candidate.json`、各层日志、manifest 和原生截图；摘要绑定受测代码/锁文件/schema，不含凭据或服务状态目录。

最终独立源码评审为 **SHIP（限定已审源码）**。评审修复包括认证重试/日志/并发、npm 可执行位与 Git 来源、App 进程 epoch、文件 descriptor/CAS/收据、关闭竞态、服务器名长度、optional 失败与显式重连、多 Connector 凭据隔离，以及可信 Main 服务文件授权被 IPC 错拒绝。最后一项保留 renderer 传入文件路径的禁止规则，请求 JSON 不能伪造可信 `serviceOnly` 选项。

## 未通过及尚未覆盖

- 最终 OAuth 跨进程刷新和 Engine 重启探针子进程收到 SIGKILL（9），stdout/stderr 为空；两个已有 MCP proxy fixture 也失败且子进程没有输出。原因未确认，没有绕过或循环重试；这些验收仍开放。
- Engine `cargo test --lib` 被既有 3 个 `TaskControl.expected_run_id` 缺失字段阻断。私有 Connector 凭据隔离 RED/GREEN 使用隔离 lane 临时补齐测试 literal，结束恢复；这是替代 harness 证据，不算 final primary 库测试通过。
- 文件读写实现复用 Runtime descriptor 助手，Core harness 已验证写入/CAS/收据；本轮原生路径只验读取。真实 writable Runtime、原生写入/CAS 和祖先目录替换竞态未验收。
- `ON_INSTALL/ON_USE` 时机保留并投影，连接/授权仍显式进行；完整自动安装时授权语义尚未关闭。便携认证缺口见上表。
- 原生用户文件/目录上传整表拒绝；现代 2026 MRTR 尚未实现。App 重启后必须重新打开；关闭时停止投递，尚未逐项资源 unsubscribe。
- P2 hooks、OpenAI 私有注册服务/catalog/sharing、marketplace sparse checkout、跨平台、真实供应商 OAuth、真实模型与签名/公证分发均未接受。GitHub 通过不能关闭这些要求。

## 重复执行

从仓库根执行；`AREAL_TEST_BIN_DIR`/`AREAL_CORE_BIN` 指向同次 workspace build。原生脚本串行运行，使用隔离 home/workspace；外部模型只用确定性 fixture。GitHub 脚本在内存中读取已登录 `gh` 凭据，只执行 `get_me`，不把 token 放入命令行或日志。

```sh
cargo build --locked --workspace
cargo test --locked -p areal-plugins --tests
cargo test --locked -p areal-mcp --tests
cargo test --locked -p areal-engine --test plugin_mcp_runtime --test codex_plugins --test admission_guards
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui run verify
node scripts/plugin-wire-smoke.mjs
node scripts/plugin-cli-p1-smoke.mjs
node scripts/plugin-github-smoke.mjs
node clients/gui/scripts/plugin-p1-p3-smoke.mjs
node clients/gui/scripts/plugin-p3-extensions-smoke.mjs
```

完整测试命令包含上述未通过项，不保证当前环境全绿。需要诊断失败并补齐剩余契约/平台证据后，才可关闭 P1/P3 与最终兼容声明。
