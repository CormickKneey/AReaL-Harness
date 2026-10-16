# 设计依据与参考校正

## Cindy：分开规则、数值、目录与视觉证据

参考版本 `febe2e5110f5f9ef5b8e0506314f35274a98b524`：

- [规则入口](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/docs/design-rules/README.md)
- [治理合同](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/docs/design-rules/design-governance.md)
- [Token 决策](https://github.com/makecindy/cindy/blob/febe2e5110f5f9ef5b8e0506314f35274a98b524/docs/design-rules/token-decision-table.md)

采纳：规则指导用途，生产源拥有数值，目录记录覆盖，真实截图承担视觉证据；语义用途优先，未迁移范围如实登记。落点分别是本目录、现有 CSS/组件、inventory 与本地证据。借鉴方法不迁入 Cindy 的主题、品牌、登录尺寸、工具链或审批流程。

## Raft Flutter：来源可追溯，组合约束高于页面补丁

参考版本 `22d51f32c3276c5d67ed454e12d4aa3225074541`：

- [Design tokens](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/docs/design-tokens.md)
- [Dimensions and constraints](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/docs/design-dimensions.md)
- [Pinned source manifest](https://github.com/kevinzhow/raft-flutter/blob/22d51f32c3276c5d67ed454e12d4aa3225074541/tool/design-source/manifest.json)

采纳：按真实挂载的变体和约束对照，不把库默认值当成产品效果；区分绘制、布局和命中范围；在公共组合修复换行与对齐，避免逐页偏移补丁。AReaL 已有 CSS 与偏好链，本次保留它们为唯一来源，不为单一 renderer 增加 Flutter 映射、DTCG 生成器或跨平台像素承诺。

## Codex 参考校正记录

v1 先由现有代码和上述方法建立。[governance](governance.md) 定义后续截图字段和证据分层。每条校正写明直接观察、关联规则、采纳/保留差异、缺口；截图像素只有在主题、字体、缩放和具体控件条件一致时才参与测量。

尚未采集的状态不能填作观察结论。参考截图不替代 AReaL 运行验收，也不导出 Codex 的账号、对话、内部桥接或执行实现。

### 设置组的有界观察与采纳

参考运行 ID `codex-settings-reference-20261016`，Codex `26.1013.31256`，通过已授权的 agent-browser / CDP 观察 General → Notifications。证据只覆盖该安装版本的 renderer，使用默认深色、DPR 2 与列明的布局模拟条件；原图和逐项元数据留本地，不导出账号材料。

直接观察：约 655.48px 宽设置组的标签为13px、说明为12px、表面圆角20px；两个下拉触发器高28px、水平留白12px、圆角12.5px；三个开关为32×20px。约495.48px宽的同组仍左右排列；菜单展示 Never / Only when unfocused / Always。以上是实测，不声明内部 Token、断点、原生窗口最小尺寸或未观察状态。

与[固定迁移题](exercises/settings-reflow.md)的同内容对照发现：字体与设置表面角色可沿用，设置单选和预览开关选择了偏小的紧凑档。候选0.1.1在公共 SettingsSelect 修正角色，并让预览沿用默认 Switch；没有新建数值源。控件尺寸的使用规则归现有 DESIGN_SYSTEM.md，布局规则归 patterns.md。

AReaL 保留窄容器上下排列：这是既有长文案可达性合同，与该参考状态不同；本题按大字号和长文案验证后保留。此决定不是逐像素一致声明，也不是已批准的视觉基线。
