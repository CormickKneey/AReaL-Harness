# 自动化设计系统：来源核对与 v1 取舍

## 核对结论

减少页面单点设计依靠四个环节相接：唯一设计源、有限组件/组合、可执行约束、独立效果验证。只统一颜色不限制组合；只做截图又会退回逐页修补。结构化数据负责消除歧义和驱动派生物，不能自动替人决定产品任务与视觉质量。

## Cindy 的机制

固定版本和规则链接见 [references](references.md#cindy分开规则数值目录与视觉证据)。进一步核对了以下实际入口：

| 机制 | 源码依据 | 作用与限制 |
| --- | --- | --- |
| reference → semantic → component | [design-tokens README](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/packages/design-tokens/README.md)、[production.ts](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/packages/design-tokens/src/production.ts) | 以 DTCG 编辑源和绑定生成生产子集，运行期不加载生成器；保留动态值和平台未接管边界 |
| 同源生成与漂移检查 | [package.json](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/packages/design-tokens/package.json)、[generate.ts](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/packages/design-tokens/src/generate.ts) | 生产映射与文档摘要一起生成；check:generated 拒绝缺失、手改、过期；独立冻结预期不自动更新 |
| 规则依据进入评审 | [check-pr-design-basis](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/scripts/check-pr-design-basis.mjs)、[workflow](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/.github/workflows/pr-design-basis.yml) | UI 变更需填写设计依据；只验证格式与引用，不能证明内容正确 |
| 目录与增量审计 | [design-inventory](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/scripts/design-inventory.mjs)、[layer report](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/scripts/shared/design-layer-report.mjs) | 生成来源事实，区分语义引用、混合表达式与待人工判断；登记不是视觉批准 |

AReaL 采纳唯一来源、生成检查与职责分离。本次保留现有 CSS/主题/偏好作为数值源；未引入 Terrazzo，也未复制其 Token、登录几何或 CI 工作流。

## Raft Flutter 的机制

| 机制 | 源码依据 | 作用与限制 |
| --- | --- | --- |
| 固定来源及可重复 Token 转换 | [design-tokens](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/docs/design-tokens.md)、[source manifest](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/tool/design-source/manifest.json) | Web CSS/主题输入被固定，产物可查来源；跨渲染器转换不等于用户路径通过 |
| 组件 recipe 解析后再生成 | [recipes/run](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/tool/recipes/run)、[component-recipes](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/docs/component-recipes.md) | 抽取真实变体组合，经 Tailwind 编译、层叠和变量解析，再生成 Dart recipe 和文档；不是只从图片估计 padding |
| 页面共享组合 | [page_recipes.dart](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/packages/raft_ui/lib/src/page_recipes.dart)、[dimension contract](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/docs/design-dimensions.md) | 页面复用布局与状态角色；实际挂载覆盖与库默认分开，绘制/布局/命中范围分开 |
| AST 漂移审计与棘轮 | [ds-audit](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/tool/ds-audit)、[AST scanner](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/tool/ds_audit/lib/ds_audit.dart) | 按文件/类别比较存量基线，限制新增漂移；平台例外有理由且单独计数，扫描不代替布局验收 |

AReaL 采纳可重复目录和有限模式，沿用现有设置组合与生产预览。跨平台 Token/recipe 转译、AST 全仓棘轮暂未接入；不写一个正则就声称达到 Raft 的 AST 覆盖。

## Product Design Skills 的方法

方法来源为已安装的 `product-design@0.1.56`：`get-context`、`image-to-code`、`design-qa`、`references/existing-codebase-edits.md`。此处借鉴其步骤，不执行整站原型、模板生成或发布流程。

- 先确定目标和用户结果，已有代码库先找相近流程、Token 与组件。
- 实现前固定具体视觉目标及资产；参考序号、截图与设计稿不能被实现者自行替换。
- 核对核心交互和实际可见状态；同 viewport、主题、内容、密度和交互状态下比较设计与实现。
- 同时检查字体、空间、颜色、资产、文案；区分客观偏差、产品约束与主观润色，缺少任一方材料不能写视觉通过。

这些 Skills 没有提供统一页面 JSON DSL。下述结构化合同是 AReaL 的适配设计，用于把这些步骤保留下来；数据格式本身不会自动产生高保真结果。

## AReaL v1 已接入的闭环

| 输入 / 所有者 | 派生或检查 | 实际消费者 |
| --- | --- | --- |
| 现有生产 CSS、主题与外观设置 | 校验登记 Token 名有生产定义；数值不搬家 | 所有现有生产组件 |
| [registry.json](registry.json) 的 Token 名与角色 | 生成 `renderer/src/design-system/catalog.ts` | 现有组件预览读取生产 computed style |
| 同一 registry 的组件、模式与 Base 候选范围 | 生成 inventory / patterns / base 中标记的表格区块，导出预览所用候选版本 | Agent 先选模式与生产参考；候选集不等于已冻结版本 |
| [surfaces](surfaces) 中的页面合同 | 核对版本、目标/参考路径、模式/组件/槽位、必需状态及证据元数据 | 当前设置控件预览的实现说明；后续页面采用同样输入 |
| 现有 `verify:design` | 先验证目录与派生物，再执行原 CSS 审计 | 本地和已有 verify 调用链 |

维护命令：

```sh
pnpm --dir clients/gui design:sync
pnpm --dir clients/gui verify:design
```

生成器只重写 catalog 和标记的文档表格，不改 CSS、组件、页面、用户设置、测试基线或截图。`verify:design` 默认只读，过期时给出修复命令。单改生成物会失败；改源后应显式同步并审阅实际变化。

## 尚未接入的自动化

目录检查能拒绝坏引用、缺状态和过期输出，不能证明页面实际使用了声明的组件，不能拦截所有新硬编码样式，也不证明状态在浏览器里可达。组件预览的运行脚本和真实桌面验收继续独立。

若下一阶段扩大自动约束，应先选一个真实迁移范围：用 TypeScript AST / CSS 解析器检查新增裸控件与设计值，建立按文件/类别的基线，只允许减少存量；规则的反例先验证，报告稳定后再提升为阻断。现阶段不引入全仓计数基线、不批量接受截图，也不将人工例外作为整文件免检。

## REA 的问题与证据方法

参考 `morluto/rea@781d5751` 的 [Evidence](https://github.com/morluto/rea/blob/781d5751ad18b25a1fe1ffa8c6035388be8c3283/src/domain/evidence.ts)、[ResidualUnknown](https://github.com/morluto/rea/blob/781d5751ad18b25a1fe1ffa8c6035388be8c3283/src/domain/residualUnknown.ts) 和[场景比较](https://github.com/morluto/rea/blob/781d5751ad18b25a1fe1ffa8c6035388be8c3283/docs/browser-scenario-contract.md)：来源、观察/推断、局限和逐步比较需可追溯；缺失证据保持未知。这些是不同契约，不能称为一个现成的设计系统 JSON DSL。

AReaL 在[设置迁移题](exercises/settings-reflow.md)中复用现有 renderer runner，记录问题、步骤、截图有效性、测量、trace 与原始材料摘要；研究结论与视觉基线批准分开。未引入 REA 工具、通用问题账本或 Token 提取器；参考应用继续由已授权的 agent-browser CDP 会话观察。视觉判断仍需选定目标和人工审查。


## 视频分析辅助核查的默认路线

后续页面工作按[结构化流程](structured-flow.md#执行顺序与每步完成条件)执行选定的B路线；准入与裁决只在[governance](governance.md#差异筛选准入)维护。可复用入口为[分析提示词](templates/video-analysis.prompt.md)、[候选输出schema](templates/video-analysis.schema.json)和[本地核查记录模板](templates/evidence-review.template.json)。它们是设计期材料，尚未接入`verify:design`作为视觉判断或强制模型调用；目录检查不能自动核实帧内容、拒绝误判或证明流程已执行。

`Q-CONVERSATION-VIDEO-AB-07`采用相同任务/Base/三段录像比较独立生成与视频分析后集成。核查拒绝了对既有子面板、完成收敛、主动回看和人工工具展开的误判，确认图片缺少缩放控制，并沿共享附件所有者修复；实际验收和规则采纳见[复合题](exercises/conversation-flow.md#视频分析辅助的双路线实验)。样本用于选择可审查的工作流程，不用于推导模型准确率、供应商排名或整体效率结论。

视频观察器与页面实现者分工：前者提名视觉事件/差异，后者结合合同、原件和日志裁决并实现。工具可以复用本机已授权的Antigravity或其它可处理视频的接口；启动前确认当前能力与素材范围，保留实际模型、强度、输入读取方式和采样限制。页面实现/采集不因采用本流程而获得新的外发、登录、执行或发布权限。
