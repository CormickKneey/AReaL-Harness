# Codex 字体与默认字号核对

## 桌面字号依据

参考为 macOS Codex 桌面版 `26.1021.31345`（build `21828`，bundle ID `com.openai.codex`）。只读检查安装包的静态前端资源与偏好定义，不读取账号、聊天或用户保存的偏好，不提取或分发字体文件，也不将截图像素当作 CSS 字号。

| 角色 | 默认 CSS 字号 | 静态依据 |
| --- | --- | --- |
| 界面基础文字 | 14px | `app-shared-2cae01273bae.js` 的 `sansFontSize.default = 14`；`app-shared-bd3e4e649b69.css` 的 `--text-base:14px` |
| 普通聊天输入、用户消息、回答正文 | 14px | electron 的 body 将 `--font-ui-size` 连接到 `--text-base`，聊天字号 override 默认引用它；`text-size-chat` 与 Markdown host 使用 `--codex-chat-font-size` |
| 代码与终端 | 12px | 同一偏好模块的 `codeFontSize.default = 12`；代码块使用 `--codex-chat-code-font-size`，`terminal-panel-4cdcb40fd53e.js` 读取 `codeFontSize` |
| 次级小字 | 12px / 11px | `--text-sm:12px`、`--text-xs:11px`；紧凑菜单还有 13px 局部角色，不是所有文字都设成基础字号 |

共享 CSS 的 SHA-256 为 `af8636f03c49c5c7676116af7e972b499a5928ea354822e5977d6caa90ed3acb`。正文接线另核对 `app-initial-56db6e0bcb8b.css` 的 Markdown root；代码块接线在共享 CSS。browser、extension、批注、onboarding 与打印具有独立覆盖，不能用这些局部值替代普通桌面默认值。这是安装包静态证据，不是运行中用户设置或逐像素渲染一致的证明。

## AReaL 采纳范围

界面默认值归 `clients/gui/packages/ui/tokens.json` 与宿主 `useWorkbenchAppearance.ts`；内容默认值归 `applicationSettings.ts`，经 `applicationPreferences.ts` 应用到输入、用户消息和回答。二者默认均为 14px，但继续保留独立偏好。代码默认 12px；终端初始化仍为 12px，已有原生终端 profile 的覆盖继续生效。

派生标题、紧凑标签及 12px/11px 小字下限仍沿既有角色，不逐组件复制 Codex 样式；内容 CSS fallback 与默认内容字号一致。已有字号（包括以前保存的 12px）保留，因为不能可靠区分自动保存的旧默认值与用户主动选择。设置的恢复配色按钮不扩张为全体字号重置。

此次仅对齐默认字号，不改变字体家族、字重、行高、消息间距或执行行为，不宣称所有区域、平台、缩放和用户偏好下逐像素一致。没有 Agent 策略或能力收益声明。

## 字体家族边界

此前静态核对的 `app-shared-fadc3c6ec518.css` 中，桌面默认 `--font-sans-default` 为 `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`，`--font-sans` 经 `--font-ui-family` 覆盖。OpenAI Sans 资源存在不等于桌面对话正文默认使用它；browser 分支也不能直接套给桌面。

AReaL 保留现有系统字体及明确 CJK、跨平台回退，不引入新字体依赖。[官方品牌页面](https://openai.com/brand/)描述 OpenAI Sans，但不证明具体桌面状态的实际 CSS 选择。精确渲染对照需相同机器、字号、内容宽度与文字；iframe 字体不继承父页，其 Token 桥需独立验证。
