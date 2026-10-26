---
id: worktree-settings
title: WorktreeSettings
summary: 组合项目、环境、脚本与Action的既有设置布局。
status: experimental
entry: experimental
layer: worktree
category: worktree
aliases: ["Worktree设置组合"]
related: ["settings-page", "settings-section", "worktree-directory"]
---

# WorktreeSettings Worktree设置组合

## 何时使用

用于Worktrees General/Environments的目录管理和环境编辑。继续组合既有SettingsPage/Section/Row。

## 组成

Root、Breadcrumb、Project、Environment、Script、Action。平台Tabs、输入、变量Popover和保存动作由宿主作为内容传入。

## 状态

`R-WORKTREESETTINGS-001` 项目/环境空态、编辑、分平台覆盖、Actions空态、保存中、失败与待核对。配置与动作定义不等于脚本已执行。

## 行为

`R-WORKTREESETTINGS-002` 面包屑和列表发出导航意图；原useGuardedNavigation与useDraftBlocker决定能否离开。Setup/Cleanup/Action各自保留平台和草稿，只有宿主保存写入。

## 内容

`R-WORKTREESETTINGS-003` 支持Default/macOS/Linux。仅说明现有变量，不新增自定义变量或密钥能力。脚本正文保留换行、等宽字体和可读路径。

## 可访问性

`R-WORKTREESETTINGS-004` 实际Tabs/Input/Textarea由宿主命名、禁用和关联说明。窄窗单列，页面仍只有SettingsPage滚动所有者。

## 规则

`R-WORKTREESETTINGS-005` 包不认识存储revision或requestId，不改变确认、版本冲突和锁定语义。通用几何在包，产品页面宽度与刷新按钮定位留renderer。

## 示例

`R-WORKTREESETTINGS-006` 独立实例验证项目→环境→脚本、平台值保留、保存中禁用及失败保留；生产WorktreesSettings沿原配置路径使用。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-settings)。

## 设置：页面骨架与 General

`WT-SETTINGS-01`（WT-R01、03）：设置导航只有 Worktrees 一个入口。页面标题“Worktrees”，简短用途说明，下方 General / Environments 两个轻量导航标签。刷新作为标题区的尾部图标动作，具名且不清空当前编辑。两页共用相同起始边缘和内容列。

### General

顶部“创建与清理”区只有一个设置组，按下面的顺序排列；组内使用轻分隔和共享右对齐控件。

| 行 | 标签 / 说明 | 控件 |
| --- | --- | --- |
| `R-WORKTREESETTINGS-007` Worktree 根目录 | 留空使用默认位置；默认 `~/.areal/worktrees` | 右侧路径输入，窄窗换到说明后；改值只影响未来创建 |
| 创建前获取上游 | 准确描述 fetch；不承诺自动合并 | 右侧开关 |
| `R-WORKTREESETTINGS-008` 自动清理旧 Worktree | 说明仅清理符合安全条件的目录；不声称有恢复快照 | 右侧开关，默认值沿实际配置 |
| `R-WORKTREESETTINGS-009` 保留数量 | 固定 / 活动 / 受保护目录可能超过数量 | 右侧数字输入；关闭自动清理时保留值并说明其生效条件 |

`R-WORKTREESETTINGS-010` 分支前缀是 AReaL 的已有配置，但不在参考主组中。设计决定：放入独立“高级创建选项”披露区，避免打断参考中的主设置顺序；不删除能力。General 沿当前显式保存合同，修改后显示同列末尾的“保存 / 放弃”，不要暗示自动保存。

### 按项目管理目录

组件专属合同由[WT-LIST-01 等规则](../worktree-directory/worktree-directory.md#按项目管理目录)维护。

## 设置：Environments 与环境编辑

`WT-ENV-01`（WT-R01）：Environments 默认是项目列表。顶部“选择项目”，右侧“添加项目”沿现有项目添加入口；它不创建一个同名环境。每行项目图标、项目名、必要的归属说明、尾部添加 / 进入入口。点击项目进入其环境列表，已有环境按名称列出，并有“新建环境”。这个中间层为多环境场景的设计决定，不由图 1 的加号推断已存在。

`R-WORKTREESETTINGS-011` 环境编辑是独立内容页，不追加在项目选择器和完整环境列表底部。返回路径固定为“环境 > 项目名 > 环境名 / 新建环境”，返回项目时保留列表位置；不同时叠一条 Back 和同功能面包屑。未保存内容继续受原设置导航保护。

`WT-ENV-02`（WT-R02、07）：编辑内容自上而下为页面标题 → 名称组 → Setup script → Cleanup script → Actions → 保存。

| 区域 | 组成与对齐 |
| --- | --- |
| `R-WORKTREESETTINGS-012` 名称 | 一个安静的圆角分组，标签在上、全宽名称输入在下；项目归属在导航中明确，不在名称旁重复完整路径 |
| `R-WORKTREESETTINGS-013` Setup | 标题左、Variables 入口右；下一行说明执行位置与时机；下一行 Default / macOS / Linux 标签；下方完整宽度的代码输入 |
| Cleanup | 标题、执行说明、独立的三平台标签、代码输入；与 Setup 的左边缘、编辑器宽度和节奏一致 |
| `R-WORKTREESETTINGS-014` Actions | 标题左、“添加 Action”右；简短用途说明；空态为安静的整行占位，不再套标题卡片 |
| `R-WORKTREESETTINGS-015` 保存 | 内容列末尾右对齐的主按钮；旁边可放“放弃”。保存中保留值并禁用重复提交，失败就近显示，成功只表达配置已保存 |

`R-WORKTREESETTINGS-016` Setup 与 Cleanup **各自拥有当前平台标签**；切 Setup 到 macOS 不改变 Cleanup 或 Action 正在编辑的平台。切换标签保留未保存的其他平台文本。空覆盖回退 Default 的真实规则就近说明；标签不以“空”冒充“禁用”。代码输入使用单一边框和等宽字体，候选最小高度为六行代码的行高加内边距，可增长 / 纵向滚动，不能横向撑宽页面。

Variables 入口打开小型只读说明，列出 `AREAL_WORKTREE_PATH`、`AREAL_PROJECT_PATH`、`AREAL_WORKTREE_BRANCH` 的含义与可复制名称；不显示截图的 `CODEX_*` 变量，不诱导填写凭据。主执行位置为新 Worktree 的项目根；保存脚本不执行脚本。

### Action 的有限形态

`WT-ACTION-01`：已有 Action 行以名称为主、必要的命令摘要为次，尾部“编辑 / 删除”；添加或编辑在所属行下展开名称与脚本，沿同样的平台标签规则。不要让每个 Action 常驻三个大编辑器。顺序沿已保存配置，删除仅移除配置；运行入口在会话工作区详情，不能把设置里的“保存”变成运行。

`R-WORKTREESETTINGS-017` 通用用途可以是“构建”“测试”“启动开发命令”，这些是名称示例，不预填会执行的项目命令。没有 Action 时不出现虚假的可运行按钮。当前受管命令的超时与后台进程限制沿现有指南，不把“启动”描述成持久服务管理能力。
