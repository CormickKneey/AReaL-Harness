# 自动化设计系统：来源核对与 v1 取舍

## 工程检查入口

`R-CHECK-001` `node scripts/gui-health.mjs` 在 GUI 工作目录输出生产范围、计数口径、源码摘要与指标证据。`--check` 对照 `health-baseline.json`，逐文件限制存量大文件增长，并拒绝新增超过 800 行的生产源码。`--write` 只收紧基线；明确的 `--allow-regression=<metric>` 会输出豁免项，CI 仍检查基准提交中的上限。Main 总行数与 UI 包 CSS 总行数只报告，避免阻止类型注释和样式归属迁移。

`R-CHECK-002` 测试元数据归 `scripts/test-manifest.json`，命令仍归根 `package.json`。`node scripts/test-manifest.mjs --list --platform=linux --layer=contract --available=git,gui-build` 只选择声明可运行且前提满足的测试；它不执行或证明其他平台的测试。实际跨进程、原生界面和安装包证据仍由原 runner 保留。

## 核对结论

`R-CHECK-003` 减少页面单点设计依靠四个环节相接：唯一设计源、有限组件/组合、可执行约束、独立效果验证。只统一颜色不限制组合；只做截图又会退回逐页修补。结构化数据负责消除歧义和驱动派生物，不能自动替人决定产品任务与视觉质量。

## Cindy 的机制

见[冻结参考研究](../../../design/archive/gui/automation-research.md#cindy-的机制)。

## Product Design Skills 的方法

见[冻结参考研究](../../../design/archive/gui/automation-research.md#product-design-skills-的方法)。

## AReaL v1 已接入的闭环

| 输入 / 所有者 | 派生或检查 | 实际消费者 |
| --- | --- | --- |
| 现有生产 CSS、主题与外观设置 | 校验登记 Token 名有生产定义；数值不搬家 | 所有现有生产组件 |
| [registry.json](registry.json) 的 Token 名与角色 | 生成 `renderer/src/design-system/catalog.ts` | 现有组件预览读取生产 computed style |
| `R-CHECK-004` 同一 registry 的组件、模式与 Base 候选范围 | 生成 inventory / patterns / base 中标记的表格区块，导出预览所用候选版本 | Agent 先选模式与生产参考；候选集不等于已冻结版本 |
| [surfaces](surfaces) 中的页面合同 | 核对版本、目标/参考路径、模式/组件/槽位、必需状态及证据元数据 | 当前设置控件预览的实现说明；后续页面采用同样输入 |
| 现有 `verify:design` | 先验证目录与派生物，再执行原 CSS 审计 | 本地和已有 verify 调用链 |

维护命令：

```sh
pnpm --dir clients/gui design:sync
pnpm --dir clients/gui verify:design
```

`R-CHECK-005` 生成器只重写 catalog 和标记的文档表格，不改 CSS、组件、页面、用户设置、测试基线或截图。`verify:design` 默认只读，过期时给出修复命令。单改生成物会失败；改源后应显式同步并审阅实际变化。

## 增量设计检查

`R-CHECK-006` `design-system-audit.mjs` 在既有目录检查、已迁移文件完整审计之外，自动读取 Git 的生产 renderer 变更：`renderer/src/` 下的 `.css`、`.tsx`、`.jsx`，包括已提交分支差异、暂存、未暂存和未忽略的未跟踪文件；开发预览 `design-system/` 不在新增页面门禁内。新增生产文件无需加入固定清单。

- `R-CHECK-007` 本地默认与 `HEAD` 比较；提交后检查整条分支时设置 `AREAL_DESIGN_BASE=<base-sha>`。
- `R-CHECK-008` GUI 和 provider 配置 CI 获取完整历史：PR 使用 base 与当前检出的合并提交的 merge-base，push 使用事件的 before，手动运行使用 `HEAD^`；显式传入 `AREAL_DESIGN_BASE`。GitHub Actions 缺少基线或指定提交不可读取时失败，不静默退回 `HEAD`。
- `R-CHECK-009` 逐文件比较原有与当前的违规类型、具体值和出现次数；存量相同问题不因文案编辑阻断，新增或增加次数会失败。Git 能识别的重命名继承原文件基线，复制为新文件按新增检查。
- 新增硬编码字号、颜色及静态 JSX 中的 `button/input/select/textarea` 会失败。公共基础控件目录可实现原生控件，仍检查字号和颜色。基础 CSS 可定义设计值，组件局部 CSS 变量的裸色仍受检查。
- `R-CHECK-010` 例外沿原变更准入提供理由与证据；检查器没有整文件免检或自动更新基线入口。确需公共能力时修改原所有者，调整审计策略须显式评审。

`R-CHECK-011` 现有 `verify` 和 `verify:design` 都执行门禁；后者同时运行目录与真实临时 Git 仓库回归。CI 通过既有 workflow 执行；GUI workflow 保留设计日志。脚本退出失败能阻止该 job 成功；远端是否配置 required check 由仓库保护规则决定，本地不能证明它已启用。

## 尚未接入的自动化

`R-CHECK-012` 入口通过本机 agent 指令及版本化贡献/开发指南连接。读取 AGENTS 的 agent 会收到条件入口；普通 Markdown、PR 模板不能强制所有客户端读取。根 AGENTS 按本机协作约定不随本任务提交，新工作区需配置相同入口。规则是否遵守还由检查和评审共同约束。

`R-CHECK-013` 目录检查不能证明声明的组件被实际使用。静态审计不解析动态间接 class/style、普通 `.ts` 内构造的样式、任意自定义组件是否重复实现，也不证明视觉、动效或业务状态可达。逐值次数基线允许在同一文件中等量移动旧问题，不能替代 diff 审阅。组件预览与真实桌面验收继续独立；视频分析和视觉批准未接入自动裁决。

## REA 的问题与证据方法

见[冻结参考研究](../../../design/archive/gui/automation-research.md#rea-的问题与证据方法)。

## 视频分析辅助核查的默认路线

`R-CHECK-014` 后续页面工作按[结构化流程](structured-flow.md#执行顺序与每步完成条件)执行选定的B路线；准入与裁决只在[governance](governance.md#差异筛选准入)维护。可复用入口为[分析提示词](templates/video-analysis.prompt.md)、[候选输出schema](templates/video-analysis.schema.json)和[本地核查记录模板](templates/evidence-review.template.json)。它们是设计期材料，尚未接入`verify:design`作为视觉判断或强制模型调用；目录检查不能自动核实帧内容、拒绝误判或证明流程已执行。

`Q-CONVERSATION-VIDEO-AB-07`采用相同任务/Base/三段录像比较独立生成与视频分析后集成。核查拒绝了对既有子面板、完成收敛、主动回看和人工工具展开的误判，确认图片缺少缩放控制，并沿共享附件所有者修复；实际验收和规则采纳见[复合题](exercises/conversation-flow.md#视频分析辅助的双路线实验)。样本用于选择可审查的工作流程，不用于推导模型准确率、供应商排名或整体效率结论。

`R-CHECK-016` 视频观察器与页面实现者分工：前者提名视觉事件/差异，后者结合合同、原件和日志裁决并实现。工具可以复用本机已授权的Antigravity或其它可处理视频的接口；启动前确认当前能力与素材范围，保留实际模型、强度、输入读取方式和采样限制。页面实现/采集不因采用本流程而获得新的外发、登录、执行或发布权限。

## 无障碍与主题证据

当前准入与检查边界引用[无障碍验收](accessibility.md)（[English](accessibility.en.md)）。历史调色板与报告模式记录见[原始自动化研究](../../../design/archive/gui/automation-research.md#无障碍与主题证据)。
