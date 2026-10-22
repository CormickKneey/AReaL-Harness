# Token 语义与平台映射

共享设计先统一角色及含义，再选择共同演进的默认值。首组共享值是浏览器焦点的宽度与偏移。其余数值与动态偏好仍由各客户端拥有。

## 三类信息分开维护

| 信息 | 所有者 | 维护方式 |
| --- | --- | --- |
| 语义角色及使用理由 | [基础表达角色](roles.md)及[设计基础](README.md) | 描述主内容、次内容、状态、焦点和密度的用途 |
| 跨端共享默认值 | [focus.css](../tokens/focus.css) | `--focus-width` 与 `--focus-offset` 只有此处可编辑 |
| 平台映射与动态偏好 | 当前各客户端代码 | CSS 变量、终端颜色、字号偏好及系统能力各自适配 |

## 当前映射地图

下表列出已有来源，角色之间只是候选对应关系，不声明数值或完整行为相同。

| 角色 | GUI | TUI | 本地 Web |
| --- | --- | --- | --- |
| 主要与次要内容 | `--color-foreground` 等语义变量 | `Role::Text`、`Role::Muted` | `--text`、`--muted` |
| 成功、警告、错误 | 既有反馈组件与主题角色 | `Role::Success`、`Role::Warning`、`Role::Error` | `--success`、`--warning`、`--error` |
| 选择与强调 | 按钮及选中状态角色 | `Role::Accent` 与 `selected()` | `--accent` 与各控件状态 |
| 空间与密度 | 控件、文字、间距和形状角色 | 终端字符单元及 Ratatui 布局 | 本端 CSS 与响应式布局 |
| 焦点与动态反馈 | 公共控件、focus 与 reduced motion | 键盘焦点与文字状态 | 浏览器控件与 CSS |

GUI 的 [styles.css](../../clients/gui/renderer/src/styles.css)直接导入共享焦点 CSS，Vite 将其合入样式产物。现有 workbench 焦点规则与 DecisionCard 消费这两个变量。其他数值由该文件、[applicationSettings](../../clients/gui/renderer/src/settings/applicationSettings.ts)及相关偏好链拥有。UI 字号还有 [App](../../clients/gui/renderer/src/App.tsx) 的独立来源。具体控件选择见 [GUI Token 指南](../../clients/gui/DESIGN_SYSTEM.md#token-选择)。

TUI 的 [theme.rs](../../clients/tui/src/theme.rs)拥有角色与颜色转换，支持无色、终端色、真彩色及能力相关映射。本地 Web 由 [style.css](../../clients/web/style.css)和 [app.js](../../clients/web/app.js)拥有样式与主题偏好。Remote Web 的 [RemoteWorkbench](../../clients/gui/renderer/src/remote/RemoteWorkbench.tsx)是另一消费路径，不能用本地 Web 的接线代替它。

本地 Web 的 `:focus-visible` 消费共享焦点变量。[Core 静态资源入口](../../core/app-server/src/lib.rs)在编译时将共享 CSS 与 Web CSS 拼接到原有 `/ui/style.css` 响应，保留资源头与路由。颜色和选择器继续由各端拥有。Remote 构建包含 GUI 样式，不代表已接入审批交互。TUI 的字符单元没有对应的 CSS 长度。

[设计审计](../../clients/gui/scripts/design-system-audit.mjs)检查共享默认值、重复声明和两条资源接线。[interaction smoke](../../clients/gui/scripts/interaction-smoke.mjs)的 `--focus-only` 模式通过真实隔离 Core 的批准与拒绝核对键盘焦点和文件效果。本地 Web 由无 Desktop bridge 的 Electron Chromium 窗口加载实际 HTTP 与 WebSocket，不代表其他浏览器或安装包验收。

非交互 CLI 可以共享状态含义和文案层级，但其 JSON、stream-json、退出码与 stdout 内容仍归 [CLI 契约](../../docs/api/claude-cli.md)。不用 CSS 或终端颜色角色改写机器协议。

## 当前偏好边界

GUI 的 UI 字号、内容字号、字体、调色板与动效偏好由不同的现有路径处理。Main 返回的主题 CSS 不能视作已被 App 完整消费；Remote Web 也没有与桌面共享全部选择。源码归属核对于 `17144634`，后续改变这些所有者时重新核对。

迁移时先明确每种偏好的持久化、默认值与应用顺序，再提供本端适配。UI 字号和内容字号是不同角色，不能为收敛来源而合并。跨设备同步范围属于独立产品决定。

## 何时扩大共享数值源

当其他实际消费者确认一组默认值应共同演进时，再选定源格式和平台输出。当前两个浏览器消费者直接使用 CSS，无需 JSON、生成器或新构建步骤。DTCG 是后续候选格式，不是前置要求。每次迁移删除旧的可编辑定义，并验证实际消费。不能同时保留手写 JSON、CSS 和 Rust 三份同义数值源。

动态偏好和终端能力是运行输入，不是另一个默认值来源。共享默认值的加入不自动引入跨设备偏好同步。仅为图形平台成立的圆角或动效无需伪造终端等价物。
