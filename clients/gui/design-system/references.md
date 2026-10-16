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
