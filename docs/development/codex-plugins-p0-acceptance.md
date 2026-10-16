**中文** | [English](codex-plugins-p0-acceptance.en.md)

# Codex 插件 P0 验收记录

2026-10-13，分支 `codex/codex-plugins-p0`。固定 Codex 0.162.1 / Agent Plugins 1.0.0。本批 P0 源码实现、本地集成和自动化 Electron 用户路径通过，完整兼容仍需 P1–P3；逐项任务见[实施计划](codex-plugins-plan.md)，使用方式见[插件指南](../guides/plugins.md)。

| 证据边界 | 结果 | 覆盖 |
|---|---|---|
| Rust workspace 构建 | PASS | 锁定依赖；Core、CLI、Runtime 与共享服务 |
| 包/Store 集成 | 15/15 PASS | 两种 manifest/overlay、本地目录、摘要/CAS/重启、范围优先级、危险文件拒绝、无效元信息不提交 |
| Engine 集成/回归 | 33/33 PASS | 插件8、独立 Skills7、Agents14、queue transfer4；活动版本固定、删除组件后旧引用、撤权、Profile/Side、显式调用与 setup 内容边界 |
| 真实 Core/CLI RPC | 11项 PASS | 认证拒绝、原包不执行、安装去重、共享资源、源码变化拒绝、撤权/CAS、setup/丢失响应收据、CLI 共用状态、重启与卸载 |
| GUI 静态/构建 | PASS | 类型、CJS 语法、公开源码边界、生产 renderer 构建 |
| 真实 Electron/Core | 5项 PASS | 目录→安装→setup→打开聊天与侧栏导航→停用/启用→卸载；Main→Renderer 丢失成功响应后查询真实 Core 收据，模型只运行一次 |
| 文档与独立评审 | PASS / SHIP | 中英文配对、链接检查；已修复评审发现的状态、权限与兼容性问题 |

Core/CLI 脚本还在 WebSocket 边界丢弃一次已执行 setup 的响应；后续只查询收据，未重放。GUI 故障注入位于 Main 到 Renderer 的响应边界，不代表覆盖所有真实网络断连。安装和发现的模型调用数为零。

本机证据位于 `.scratch/codex-plugins/evidence/`（排除提交）：`core-manifest.json`、`gui-manifest.json`、集成/构建日志、两张桌面截图和评审记录。两个清单绑定相同 Core SHA-256 `497e74273750f639e1bc5caed808b3dee3cd080b78cb34f764a4a9d174d0deff`，并记录变更源码逐文件摘要；完成检查已核对这些源码摘要仍一致。可重复命令见[测试指南](testing.md#codex-插件-p0)。

未执行真实供应商、签名/公证安装包、物理输入、其他操作系统或远端 CI。已有库级测试编译被三处原有 `TaskControl.expected_run_id` 初始化缺项阻断；本批未修改那些无关 Task 测试，未声称全套测试通过。隔离 Workgroup worker 不自动部署插件，受限引用拒绝访问；未来跨 Engine 部署需在后续阶段单独验收。Git/npm、MCP/OAuth、公开 hooks、MCP Apps、桌面扩展、Connector 及实验 Codex 管理 wire adapter 尚未实现。
