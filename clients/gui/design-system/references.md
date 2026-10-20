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

### 复合任务的逐状态对照

`Q-CONVERSATION-COMPOSITE-06`把已有观察转成一条本地可重放场景。参考仍是上述run2及独立dynamic/retry2；不是新增Codex采集，也不补写参考未捕获的时序。具体对照表与当前差异统一维护在[复合题](exercises/conversation-flow.md#逐状态对照)，原图、实现帧、录像、时钟与运行身份仅留本地证据索引。

直接采纳：用户输入与过程分层、Shell详情、图片模态、独立子对话、完成总组与独立final。明确的产品选择：在同一场景中安排分批进程输出、图片打开期间继续推进、父子先后完成、人工详情跨完成保留。保留差异：本产品原有字体/图标/密度、子对话身份样式，以及图片预览尚无参考的缩放工具；这些不能因行为通过就记为视觉等同。


### E3 新内容与宿主观察

沿常驻 Codex 26.1013.31256 / 6.1 Sol Light，在原验证项目发送新的合成图书题。观察到内联 Python 命令、独立 `E3 library arithmetic` 子代理以及完成后可展开的 Worked 总组；最终回答包含中文表格、14节、列表和 JSON，净额13/5/18。原命令及子对话分别打开核查；模型文字不独立充当执行证据。

本轮原生窗口 CDP 接口返回不支持，尺寸样本采用 renderer viewport 模拟且 DPR 随模拟改变；不与真实 BrowserWindow 原生缩放等同。参考 Open subagents 关闭后焦点为 BODY；通过 CDP 发送 Cmd+, 没有可见设置页，因此原生菜单快捷键未覆盖。自有 Electron 的焦点恢复是产品采纳项，不冒充参考事实。中文原生按键仅在自有 Electron 采集，Codex 原生控制不可用；独立候选窗口仍未知。


### E4 原生网页与输入补充

本次恢复的常驻参考实例沿用原验证聊天，通过CDP在真实浏览器页签导航本地合成Project preview；启动应用包核对为Codex26.1013.40934（20770），与此前E3记录的版本分别标注。宿主工具栏和独立网页分别取证；点击Try preview后按钮变为Preview clicked，主宿主焦点记录为WEBVIEW；随后点击Hide tabs，焦点回到Work with Codex。该记录支持网页交互与本路径关闭后的焦点结果，不推断其内部恢复机制或任意入口的行为。

AReaL选定窗口往返与原生网页切片见[E4](exercises/conversation-flow.md#原生宿主补充-e4)。双方保留各自原生视图及宿主图，不把宿主空白当作网页缺失；本轮不调整Token或声称像素一致。自有应用的人工补采只确认英文文字上屏，用户明确未见候选字列表，候选浮窗仍未知；不能把既有组合事件升级成候选窗口已覆盖。参考的原生OS激活和中文候选仍无独立证据。
