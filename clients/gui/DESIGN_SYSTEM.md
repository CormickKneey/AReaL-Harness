# 客户端设计系统

本指南供客户端开发使用，默认中文。设计数值归生产 CSS，组件变体归现有公共组件；新增功能按角色组合，不复制另一套样式。执行、权限、历史和草稿继续由原业务所有者管理。

## Token 选择

基础定义见 [styles.css](renderer/src/styles.css)，用户外观覆盖由 [applicationSettings.ts](renderer/src/settings/applicationSettings.ts) 和 [applicationPreferences.ts](renderer/src/settings/applicationPreferences.ts) 提供。以下目录描述用途，不复制数值；预览使用同一外观路径并显示当前计算值。

| 角色 | Token | 使用约定 |
|---|---|---|
| 输入与强调文字 | `--text-ui-lg` | 编辑器、较突出标题 |
| 正文 | `--text-ui-base` | 卡片内容、普通反馈 |
| 控件标签 | `--text-ui-caption` | 按钮、菜单及紧凑标签 |
| 说明 | `--text-ui-sm` | Side 标题、上下文说明、次要反馈 |
| 辅助信息 | `--text-ui-xs` | 来源细节；不用于主要正文 |
| 公共行高 | `--line-height-ui`、`--line-height-ui-sm` | 决策正文与紧凑说明，随 UI 字号增长 |
| 文字层级 | `--color-foreground`、`--color-foreground-subtle/subtlest` | 主内容、说明、低强调信息；不能只用颜色表达状态 |
| 表面 | `--color-background`、`--color-composer`、`--color-composer-catalog` | 页面、输入区、相关浮层；明暗由主题提供 |
| 边框与错误 | `--color-border`、`--color-destructive` | 边界与错误反馈 |
| 控件尺寸 | `--spacing-control` 及 `--spacing-control-xs/sm/lg/form`，对应 Tailwind 的 `h-control-*` | 根据控件用途选尺寸，跟随用户字号 |
| 间距 | `--spacing-inline/field/section/panel` | 相邻内容、内容块、分区与面板；具体组合可以使用这些角色的倍数 |
| 圆角 | `--radius-control/overlay/composer/panel/dialog` | 按表面角色选择，不能为“看起来差不多”任意互换 |
| 内嵌与动作形状 | `--radius-inset`、`--radius-pill` | 表面内的预览内容、胶囊或圆形动作 |
| 焦点与动效 | `--focus-width/offset`、`--motion-fast/normal/slow` | 复用 focus-visible、ui-control/ui-popup；遵守 reduced motion |

Tailwind 的 `text-ui-sm`、`rounded-overlay` 等直接消费同一套 Token。独有宽度、滚动上限或定位属于具体组件，可以保留局部数值；共同角色才进入公共 Token。不得把字号与不相关布局尺寸绑定。

## 公共组件与试点组合

| 所有者 | 使用方式 | 业务边界 |
|---|---|---|
| [Button](renderer/src/components/ui/button.tsx) | 复用 default/outline/secondary/ghost/destructive/warning/link；选择既有 size | 是否可操作由调用方决定 |
| Button `variant="composer"` | 主和 Side 发送外观，共用禁用及文本角色；一般配合 `size="icon-md"` | 不决定 send、enqueue、steer 或清理草稿 |
| [ConversationComposer](renderer/src/ConversationComposer.tsx) | 主与 Side 的编辑器、工具栏及模型目录入口 | 调用方拥有输入、提交、配置和能力 |
| [ComposerSurface](renderer/src/prompt-editor/ComposerSurface.tsx) | editor/toolbar/context/overlay 插槽；样式在组件旁 [ComposerSurface.css](renderer/src/prompt-editor/ComposerSurface.css) | 只拥有布局；紧凑状态保持编辑器挂载 |
| [DecisionCard](renderer/src/DecisionCard.tsx) | label/icon/正文/反馈/footer 插槽，复用 [DecisionCard.css](renderer/src/DecisionCard.css) | 审批/提问拥有提交、核对与请求身份 |
| [Feedback](renderer/src/components/ui/feedback.tsx) | error 或 message；保留 alert/status 语义 | 文案和恢复动作归调用方 |
| 菜单、Popover、Tooltip、Input/Textarea | 从 [components/ui](renderer/src/components/ui) 选择既有组件 | 不在功能文件复制公共控件样式 |
| [CollapsibleText](renderer/src/CollapsibleText.tsx) | 渲染高度检测、有界预览与展开/收起，样式在 [CollapsibleText.css](renderer/src/CollapsibleText.css) | 只拥有展示状态；原文与复制/发送仍由调用方管理 |
| [SideChatPane](renderer/src/SideChatPane.tsx) | 组合共享 Composer 与 Side 上下文，样式在 [SideChat.css](renderer/src/SideChat.css) | 保留服务/来源/Side 草稿隔离与独立执行 |

审批按钮的 split 几何、Side 面板比例、Composer 紧凑布局是当前组合规则，不作为全局控件的新默认值。

## 长文本统一采用渐进展示

新增或修改含长文本的界面时，先确定阅读任务，再选择有界预览、显式展开或专用阅读面板。聊天中的已发送消息、引用、上下文说明和详情卡片应避免由单段长文本占满工作区；不要以缩小字号、无提示裁剪或嵌套滚动代替信息层级。

- **按实际布局折叠**：根据渲染高度判断，覆盖 Markdown、多行与自动换行；宽度、字号或字体变化后重新测量，不只按字符数判断。短文本完整展示，不出现无效展开入口。
- **预览与全文可逆切换**：默认保留开头预览，提供始终可见的“展开全文 / 收起”按钮；按钮位于裁剪区域之外，不能只在 hover 时出现。聊天默认预览约 8 行，数值归 [CollapsibleText.css](renderer/src/CollapsibleText.css)。新消费者优先复用 [CollapsibleText](renderer/src/CollapsibleText.tsx)，不要另写字符截断或折叠状态机。
- **全文完整可达**：折叠只改变展示，不截断存储、发送、复制和导出的原文；附件和独立操作在正文预览之外。展开后使用所属页面滚动，不再嵌套纵向滚动；收起时保持阅读位置与按钮焦点可达。
- **可访问且稳定**：原生按钮支持键盘、可见焦点、`aria-expanded` 与 `aria-controls`；聚焦裁剪正文内的操作时先展开。每条消息独立保存当前挂载期间的展开状态，流式刷新或尺寸变化不覆盖人工选择，换到其他消息不继承旧状态。不依赖动画表达状态，遵守 reduced motion。
- **按任务设定例外**：正在编辑的输入、流式主要回复、需要完整核对的审批关键信息以及专用文件/日志阅读器，保留其现有阅读机制；不能为了统一外观隐藏完成当前任务必需的信息。未来长文本设计评审必须说明所选机制与可达全文的路径。

已发送消息在共享 `Messages` 中应用此规则，主聊天、Side 与 Remote 复用同一展示路径。验收至少覆盖长/短文本、连续长段落、Markdown、明暗、窄宽面板、字号变化、展开再收起，以及原文复制。生产组件预览与脚本见下文；它们不代替真实服务或安装包验收。

## 新增功能的四步

1. 选择一个相近的生产组件或组合。新的工具结果卡片可以复用卡片结构、Button 与 Feedback。
2. 按角色选择 Token 和已有变体；多个实际消费者需要同一新角色时，在现有所有者补齐。
3. 新公共状态加入预览；仅业务组合变化时检查该组合，不重复维护所有基础控件。
4. 运行类型/构建和相关设计检查。修改交互、IME、权限或提交时追加相应真实桌面路径。

常规功能无需重新做全套设计规格或每次跑全量 E2E。业务差异通过内容、动作和有限变体表达；不要让 CSS 根据翻译文案猜测操作含义。

## 开发预览

从仓库根运行：

```sh
pnpm --dir clients/gui design:dev
```

打开 Vite 地址的 `/design-system.html`。这是独立开发入口，挂载生产 ConversationComposer、ApprovalRequest 与 SideChatPane，可切换明暗、UI 字号、宽窄面板，查看提交中、失败和未知结果。审批状态通过选择状态后点击审批动作呈现；Side 保留实际入口并明确拒绝真实操作。所有动作使用本地 fixture，不读取桌面 bridge，不连接 Core/供应商。状态预览不证明业务恢复或权限执行通过。

`design:build` 输出到 `clients/gui/dist/design-system/`；普通 renderer 构建不包含预览 HTML 或预览模块，安装包继续使用 `renderer/dist/`。

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
```

`test:design` 使用隔离 Chrome，保存截图、计算样式与 manifest；可用 `AREAL_GUI_TEST_BROWSER` 指定已有浏览器。检查编辑器草稿保留、模型菜单、实际审批状态、明暗、字号及宽窄布局。字体、平台、缩放不同的截图分别评估，不要求跨平台像素一致。

## 增量检查与验证边界

普通 `verify` 已包含 `verify:design` 的检查逻辑。`verify:design` 只检查已经迁移的 DecisionCard、ComposerSurface、SideChat 和 Feedback CSS：阻止局部硬编码字号/颜色，检查引用 Token 存在。合法局部几何不禁止。检查器包含错误示例，确认会拒绝目标写法；它不声称解析所有 Tailwind class 或 TypeScript 间接样式。

生产样式改变需查看相关组件和原消费者；变体变化看默认、焦点、禁用和提交状态。Composer、审批、Side 的业务兼容继续使用已有 `test:composer`、`test:interactions`、`test:conversation-derivation`，它们与组件预览各自提供不同证据。物理 IME、真实供应商及安装包需单独验收。
