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

### 设置说明的明暗与偏好边界

问题 `Q-SETTINGS-TEXT-CONTRAST-02` 补采同版本参考：深色默认contrast60、明亮默认45，调色板分别为#181818/白色和#FFFFFF/#1A1C1F。在两种主题各自的0、默认、100三个已观测点，设置说明均为前景色65%透明度；深色卡片背景随contrast变化。采集在可见滑块值确认、计算颜色/几何连续稳定后执行；此前过渡中的样本保留但不用于终态颜色判断。未据这些点推断参考内部完整转换函数。

采纳：深色设置说明默认层级在唯一 paletteVariables 所有者修订。保留差异：AReaL继续支持原对比度斜率，明亮说明保留原69.5%混合；禁用和已完成过程信息不变。规则用途归foundations与DESIGN_SYSTEM；[设置说明题](exercises/settings-contrast.md)固定默认、端点、自定义颜色和隔离范围。此处不将全部次文字统一为同一个透明度。

### 对话信息流的动态观察

问题 `Q-CONVERSATION-FLOW-04` 与 `Q-CONVERSATION-DYNAMIC-05`，参考版本仍为Codex26.1013.31256，暗色、1509×949 CSS px、DPR2。使用合成验证聊天观察，不迁入原始聊天、录像或采集日志。以下采样任务不是该产品全部模式的通则，也不是AReaL验收。

| 观察ID | 已观察内容 | 限制与规则用途 |
| --- | --- | --- |
| OBS-CONV-GROUP | 综合任务完成后，短过程commentary与常规活动进入Worked过程总组，final独立；展开可恢复过程及活动顺序 | 只描述已采版本和正常完成样本；不能据此隐藏异常或推断完整内部状态机 |
| OBS-CONV-TOOL | 真实cat运行行有停止入口；完成后展开看到Shell原命令、四行结果和Success | 是两个实际工具状态；不能由模型自述替代，也未连续覆盖全部中间瞬态 |
| OBS-CONV-READ | 目标助手正文581→709且仍运行时，同一可见旧段落相对top54.25→53.75 CSS px；显式返回后正文881→1062，后续样本bottomGap均0 | 0.5px仅为样本值；点击后的平滑过渡与实际到达分别判断，不推断全时段无跳动 |
| OBS-CONV-RESOURCE | 图片可打开预览，子代理可打开独立侧边Conversation；网页搜索与来源入口可见 | 独立网页面板未打开；资源状态不替代父任务完成 |
| OBS-CONV-INPUT | 输入区出现未发送文本，用户确认为“预测下一个指令” | 不验证预测机制，不计入目标助手正文或已受理用户消息，不新增AReaL预测功能 |
| OBS-CONV-OPEN-GAP | 完成后的总组、活动和具体命令可展开 | 同一工具运行中手动展开跨完成的保留仍未知；保留人工选择是本产品目标，待复验 |

关键阅读切片的9.333秒录像已完整解码，并以可见内容做约1秒精度的状态校准；完成截图在短录像之后单独登记。工具轮次与文字补采独立引用。采纳结论、生产所有者及检查点统一归[信息流目标合同](patterns.md#从证据回溯到规则和组件)，当前实现差异也在那里列明；参考观察不等于AReaL已迁移或已验收。

失败材料也保留：首段曾因提示词中的末标记误判完成；长录制有文件提前结束；一次补采复用了错误触发标记。后续独立短补采先验证当前助手DOM与新标记，分别核验原图、事件和录像，不将失败/补采拼成一次无缺口全程。录像分段、时钟关联及覆盖结论以本地manifest为准，采样分辨率不证明没有瞬态遗漏。
