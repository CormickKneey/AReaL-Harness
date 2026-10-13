**中文** | [English](codex-plugins-plan.en.md)

# Codex 插件实施任务与验收

本计划按已确认方案实施完整纵切。当前批次是 P0；P1–P3 仍是最终兼容目标，不能以 P0 完成代替。每个阶段只依据该阶段自己的证据验收。

## 基线与边界

固定 Codex 0.162.1（`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）、Agent Plugins 1.0.0 与 OpenAI MCP Extensions `0d606217705e0e71eb21fff009619b67b80611dc`。Core 拥有安装与选择状态，现有 Skill/MCP/Runtime 路径执行组件。私有服务接入仍需合法外部条件。

发现/安装不执行包代码；显式 Profile 不自动扩权；活动 Turn 不替换版本；UNKNOWN 不重放；Renderer 不取得秘密。现有独立 Skills/MCP 与 Native Host 保持原契约。

## P0 · 本地插件包与 Skills

| 任务 | 所有者/入口 | 工作 | 可观察验收标准 |
|---|---|---|---|
| P0-01 | `upstream/pins.json`、设计/任务文档 | 固定兼容基线、来源和能力声明 | 固定 Codex0.162.1 / Agent Plugins1.0.0；MCP/hooks/apps 的未支持项可见 |
| P0-02 | `core/plugins/src/package.rs` | 两种 manifest 与 overlay 解析 | 原包不改写；空内联 overlay 不与旧文件合并；未知 schema 不降级 |
| P0-03 | `core/plugins/src/lib.rs` | 本地 marketplace 发现和添加 | 固定路径优先级；条目错误隔离；根路径来源 . / ./ 有效 |
| P0-04 | `core/plugins` 安装 Store | 安装事务、摘要、CAS 与重启 | 绑定选中 source/digest；不执行脚本；缓存不可变；并发冲突可见 |
| P0-05 | `core/engine/src/desktop/{skills,catalog}.rs` | 插件 Skills 与资源读取 | 现有普通会话可选；显式 Profile 不扩权；同包资源可读，跨包拒绝 |
| P0-06 | Engine Turn/queue 与 Store | 调用策略、Turn 版本与停用 | 隐式禁止仍可显式选；活动版本固定；停用后新读取被拒绝 |
| P0-07 | Engine plugins 与现有提交账本 | 显式 onboarding 与受理恢复 | setup 使用普通聊天；双击/断连不重复；UNKNOWN 只查收据 |
| P0-08 | app-server、CLI plugins、GUI PluginsSettings | Core/CLI/GUI 管理与验收 | 同一安装状态；真实桌面安装→setup→停用；权限与重启路径有证据 |

P0 执行依赖：01 固定基线，02/03 建立格式与目录边界，04 完成安装事务，05/06 接入 Skills 与生命周期，07/08 完成 setup、客户端和组合验收。P1 使用 P0 的不可变包与状态所有者；P2 接入现有 Engine/Runtime 权限和事件；P3 在 MCP/认证/生命周期就绪后接入桌面与托管服务。

## P1 · 来源、MCP 与连接生命周期

| 任务 | 工作 | 可观察验收标准 |
|---|---|---|
| P1-01 | Git marketplace 与 source pin | ref 解析到 commit；子目录受限；失败保留旧安装 |
| P1-02 | npm source 与完整性 | 版本解析与 integrity 固定；不运行 lifecycle scripts |
| P1-03 | 便携和 legacy MCP adapter | env/cwd/header/transport 归一化符合各格式，保留诊断 |
| P1-04 | OAuth 与安全凭据 | provided/DCR/CIMD、refresh、取消/失败；秘密不进入 renderer/日志 |
| P1-05 | 认证和工具策略 | ON_INSTALL/ON_USE、enabled_tools 与审批状态区分 |
| P1-06 | 元信息、结果与版本目录 | instructions/structured/media 保留；活动 schema 不被替换 |
| P1-07 | 升级、撤权、排空和恢复 | 旧 generation 不污染新会话；清理未确认可见；UNKNOWN 不重放 |
| P1-08 | 真实 MCP 与跨实例验收 | 原包 stdio/HTTP；同时连接/升级/停用与服务重启 |

## P2 · 完整公开 hooks 执行语义

| 任务 | 工作 | 可观察验收标准 |
|---|---|---|
| P2-01 | 配置、信任摘要与平台 shell | 默认发现/覆盖、regex/alias、秒 timeout、Windows override |
| P2-02 | 全部 Session/Turn 生命周期布点 | 固定公开事件；多客户端 attach 不重复；顺序与归属明确 |
| P2-03 | 工具拦截和权限裁决 | deny/参数修改/approval/post反馈独立；不突破部署权限 |
| P2-04 | 后台 command 与 MCP handler | 安全点投影；不递归；结束取消；晚响应隔离 |
| P2-05 | 输出、错误与不支持语义 | exit2/JSON/stderr/未知字段按固定基线处理 |
| P2-06 | 对照、故障与恢复验收 | 相同自有插件在固定 Codex/AReaL 跑关键行为；不重放副作用 |

## P3 · 桌面扩展、Connector 与完整验收

| 任务 | 工作 | 可观察验收标准 |
|---|---|---|
| P3-01 | MCP Apps 资源与隔离宿主 | 保留 _meta；initialize/bridge/CSP 与窗口归属真实可验 |
| P3-02 | OpenAI 桌面扩展 | 固定清单的入口/设置/mentions/文件/上下文更新逐项验收 |
| P3-03 | Connector resolver 与合法服务接入 | 原 ID 保留；认证/无访问/未支持分开；指定服务真实连接 |
| P3-04 | Codex 实验管理 wire adapter | 固定 RPC 类型；共享 handlers；未支持 remote 服务不伪造 |
| P3-05 | 原包兼容语料、跨平台和分发 | 包/执行/UI/服务/安装包证据分开；源与版本绑定 |
| P3-06 | 最终兼容声明 | 所有必需 capability 及服务清单通过或明示条件；无静默缺项 |

## 验证与状态

实现前先定义实际边界的失败断言，优先集成与 E2E。源码检查、本地确定性模型、真实供应商、原生桌面和安装分发是独立证据。开发期间只跑受影响检查，收尾运行相关端到端验收。

当前状态：P0 源码实现与本地组合验收通过；P1–P3 未开始。48 项包/Engine 集成、真实 Core/CLI 权限与丢失响应恢复、GUI 类型/公开契约/构建、真实 Electron 安装/setup/停用/卸载和显式收据恢复均通过，独立评审为 SHIP。证据及未覆盖范围见[P0 验收记录](codex-plugins-p0-acceptance.md)。这不代表整个 Codex 插件协议已经兼容。

P3 验收前须明确桌面扩展集合、必须运行的服务/Connector 与支持平台。格式解析不会赋予托管服务权限，未解决要求必须保留在最终矩阵中。
