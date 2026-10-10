**中文** | [English](browser-testing.en.md)

# Browser 行为与发布验收

本文件定义完整 Browser 的测试契约。R0 原生实验已有独立入口，其结果以具体运行证据为准，不表示全部场景已经运行。后续主要测试切口沿用现有桌面 smoke/connection/architecture 的真实 Electron+Core+Runtime+确定性模型形态，参照[GUI指南](../../clients/gui/README.md)。

## 测试层级

1. **行为单测**只穷尽Ref身份、预算、去重、代次和状态转换；不要断言内部Map/类名。
2. **Core契约测试**覆盖真实app-server双向请求、准备/批准/执行、旧Thread追加、observer不重绑、UNKNOWN与重启；复用现有动态工具fixture。
3. **真实桌面E2E（主验收）**从用户入口或公开Core请求驱动真实native Page；断言fixture服务端副作用计数、页面sentinel、Core记录及GUI投影一致。不可通过直接Controller调用绕开权限后再称E2E。
4. **人工视觉/可访问性验收**针对native overlay、焦点、截图反馈、IME和安装版。自动测试不能证明完整主观视觉质量。

Fixture 至少含：不同端口的A/B站点、HTTPOnly Cookie登录模拟、跨源iframe、Shadow DOM、重复同名元素、动态替换、Canvas、popup、阻塞dialog、下载/chooser、失败API、含测试令牌日志、延迟表单提交、HMR样式页。测试仅用合成数据，不导入真实Profile。访问Core/adapter控制端口的测试使用测试服务，不探测用户现有服务。

## 场景矩阵

| 场景 | 行为 | 必须证明的事实 | Ticket |
|---|---|---|---|
| B-01 | 原生对象不变 | 同一页面sentinel/表单/scroll在读取与隐藏后不变；记录native对象身份。 | 01 |
| B-02 | 真实输入屏障 | 遮罩下点击/键盘不达网页，接管仍可触发；不能仅断言CSS。 | 01 |
| B-03 | 调试连接冲突 | DevTools触发detach；重新attach后旧计划失效。 | 01 |
| B-04 | Core同页工具闭环 | 模型经真实Core工具回调读出既有页sentinel，GUI证据与历史callId一致。 | 02 |
| B-05 | 身份与回执伪造 | 跨Thread、不同socket同id、假pageId/hostGeneration均拒绝。 | 02 |
| B-06 | 宿主不存在 | 无Main或无浏览能力不创建替代浏览器；capability与错误一致。 | 02 |
| B-07 | Ref替换 | 同名元素换节点、frame文档导航及partial snapshot，Ref不误复用。 | 03 |
| B-08 | 观察覆盖与截断 | iframe/Shadow/动态DOM及超预算明确coverage/truncation。 | 03 |
| B-09 | 图像与证据授权 | 模型实际接收图像；跨Thread读Blob拒绝；大图不突破Core帧限制。 | 03 |
| B-10 | 真实批准链 | 拒绝不输入；允许只执行记录的真实目标计划。 | 04 |
| B-11 | 审批后页面变化 | 导航、重绘、缩放或接管后旧批准不能点击替代目标。 | 04 |
| B-12 | 权限伪造 | 模型arguments或网页文本中的allow标志不能创建许可。 | 04 |
| B-13 | 已派发与未派发 | 注入prepare失败与发送后断线；前者not_sent，后者UNKNOWN。 | 04 |
| B-14 | 接管优先 | 长wait/队列满/Core不响应仍本机先fence，后续input计数为0。 | 05 |
| B-15 | 人工阶段隐私 | 接管后测试secret不进入DOM/截图/日志，交还不补发缓冲。 | 05 |
| B-16 | 接管中的不明提交 | fixture服务端已记一次submit，回执丢失后不再提交；历史UNKNOWN。 | 05 |
| B-17 | 旧Thread追加 | 旧历史/工具保持、追加幂等、重启可读，同页浏览首次执行。 | 06 |
| B-18 | 忙碌与工具冲突 | 活跃Thread/其他Host/同名不同schema/不支持版本拒绝。 | 06 |
| B-19 | Tab与popup归属 | popup关联opener/Thread/Context；未知页不可被无授权关闭。 | 07 |
| B-20 | 不抢焦点 | 后台Thread页变化不切当前chat/tab；活动Tab不是全局执行目标。 | 07 |
| B-21 | 临时存储隔离 | A/B Workspace分别用Cookie/localStorage/IndexedDB/SW标记，互不可见。 | 08 |
| B-22 | 临时登录交接 | 人工登录后同Workspace sibling有效，退出重开不承诺恢复。 | 08 |
| B-23 | 内网与控制端口 | 授权开发Origin可达；控制端口、未授权redirect/frame/传输被拒绝或明确门控。 | 08 |
| B-24 | 容量与pin | 8页上限，所有候选pin时新页拒绝，执行页不驱逐。 | 09 |
| B-25 | 崩溃与旧代次 | 崩溃重建后旧ref/事件/回执不能操作或覆盖新Page。 | 09 |
| B-26 | 隐藏与归属释放 | hide保状态，archive释放，迟到show不复活。 | 09 |
| B-27 | 区域批注来源 | 选区与原截图坐标一致，发送正确Thread，取消不导航。 | 10 |
| B-28 | 草稿与中文输入 | 输入法Enter、切Thread、失败发送不误发或丢草稿。 | 10 |
| B-29 | 元素过期 | 选取后DOM换代，批注保旧证据，下一动作要求重观测。 | 11 |
| B-30 | 元素降级 | 不可读iframe/Canvas只提供区域反馈，不编造selector。 | 11 |
| B-31 | 诊断脱敏与预算 | Console和network含测试令牌，输出脱敏、缓冲有界。 | 12 |
| B-32 | 人工调试后恢复 | 用户DevTools期间自动动作阻止，关闭后明确恢复与新观察。 | 12 |
| B-33 | 坐标矩阵 | DPR1/2、pageZoom、scroll、viewport变化后命中指定点，旧图拒绝。 | 13 |
| B-34 | Canvas状态验证 | 键鼠/drag作用于真实Canvas状态，取消释放按键。 | 13 |
| B-35 | 服务路由 | 只复用真实项目服务；端口冲突和服务失败不跳错项目。 | 14 |
| B-36 | 源码与验证关联 | 改前失败改后通过，刷新后仍通过；检查/截图关联call与变更。 | 14 |
| B-37 | 样式撤销与HMR | 撤销只移除自己覆盖，HMR换节点不覆盖应用新值。 | 15 |
| B-38 | 清除试改后验证 | 未改源码仅试改时不能验收通过；清除后展示真实结果。 | 15 |
| B-39 | 上传人类选择 | 模型路径拒绝，chooser取消正常，用户文件不自动给Agent读取。 | 16 |
| B-40 | 下载有界 | 来源/目标/大小及取消保回执，超限/关闭清理，不自动执行。 | 16 |
| B-41 | 批量前缀 | 第3步前拒绝时前2步不重复，剩余不执行。 | 17 |
| B-42 | 批量接管与UNKNOWN | 每步fence，任一步UNKNOWN不继续也不重放。 | 17 |
| B-43 | 观察不重绑 | CLI原子订阅不改变GUI ToolHost；错误socket回执无效。 | 18 |
| B-44 | 退出隔离 | GUI退出影响Browser但另一Core任务继续，适配器存活不算Page存活。 | 18 |
| B-45 | 迟到结果 | 旧Host/请求回执不能写入新Turn/新Page或改写UNKNOWN。 | 18 |
| B-46 | 重连不重放 | 读取快照和重绑不重新派发旧call，重复请求保持幂等。 | 18 |
| B-47 | 键盘与辅助技术 | 关键操作键盘可达，状态可读，focus与IME不退化。 | 19 |
| B-48 | 安装版自包含 | 隔离安装无开发依赖/全局Chrome/CDP端口仍通过流程。 | 19 |
| B-49 | R2综合交付 | 真实安装版完成要求的开发协作故事并保留审核证据。 | 19 |

## 故障注入时刻

至少在prepare前、审批等待、execute发送前、输入已到fixture但回执未到、Core持久化前、Main退出、适配器断线、Core重启和页面换代时切断。对每个时刻检查 `not_sent / confirmed / UNKNOWN` 区分、工具无重放、旧结果无写权限。取消测试不能只断言AbortSignal。

## 性能与资源记录

记录工具次数、模型输入文本/图像预算、prepare/审批/原生执行/回执分段时间、请求队列峰值、WebContents数和截图编码字节。支持复现实验的机器/版本/视口/输入固定；不把项目方宣传的加速数字作为验收阈值。初始页面/队列/观察上限来自[契约](../api/browser.md)，需要压力fixture证明不会无界增长。性能退化与安全正确性分别报告。

## 发布门

- R0：B-01至B-03有真实原生证据，ADR-0003的技术选择可复核。
- R1：Tickets 01–09完成，各自场景通过，授权/接管/UNKNOWN/隔离无已知阻断缺陷，功能仍明确标为安全共享Browser阶段。
- R2：全部49场景及19号发布票通过，真实安装版完成同页→批注→源码修改→验证，Profile等延期项显示清楚。
- 任何安全门失败不可通过仅关闭日志、降低权限断言或删除测试绕过。不能为了全部通过而修改外部站点真实结果。

## 证据包格式（新增约定）

每次运行保存 run-manifest.json：git SHA、包版本、OS/arch、Electron/驱动版本、fixture版本、测试入口、场景ID、开始结束时间、检查结果、未测项；附Core call/Item关联、合成站点副作用计数、去敏感日志与截图。UNKNOWN用其真实值，不用0/失败代替。截图只作观察证据；业务成功要由明确断言或人工评审给出。

## 现有命令与新增命令

现有可用入口包括 `make gui-smoke`、`pnpm --dir clients/gui run test:connection`、`pnpm --dir clients/gui run test:architecture`、`pnpm --dir clients/gui run test:composer`、GUI typecheck与verify；详见GUI指南。Browser专用测试入口应在实现票中真实加入package/Makefile后才使用，不能假设现在已有 `test:browser`。

文档与类型变更同时运行当前仓库要求的检查。原始设计交付仅做产物结构校验，没有运行仓库测试、真实 Electron 或安装版，不能作为发布证据；实际 R0 运行按下面的独立入口留证。

## R0 原生实验入口

```sh
make gui-install
pnpm --dir clients/gui run test:browser-feasibility
```

入口只启动隔离的 Electron fixture，复用当前 `CorePreview` 与其既有 WebContentsView；不启动 Core、Runtime 或独立桌面适配器，不登记 `browser_v1`。测试控制使用继承的私有管道，不启用全应用 CDP/Inspector 端口。网页保持独立临时 Session、sandbox、contextIsolation，无 Node、preload 或产品 bridge。实验位于 GUI scripts，普通启动与打包不加载它。

测试在三个 checkpoint 等待真实桌面输入：先在网页输入 `HUMAN_DRAFT` 并点击 CENTER；遮罩出现后以桌面坐标点击同一目标、按一个字母键，再点击顶栏“接管”；最后查看冻结截图并点击“返回实时页”。鼠标必须经过原生窗口命中测试，不能用网页 DOM click 代替。可用桌面自动化或人工输入，并在 checkpoint 保存包含原生页面与叠层的窗口截图。

自动断言检查原生对象、sentinel、表单、滚动与 AX 读取，遮罩接收输入而网页计数不变，截图 bitmap/CSS/zoom/scroll 变换及合成站点回执，最小化返回 `page_not_visible`，DevTools 原生 detach/重新附加和旧调试代次拒绝，以及冻结后返回原对象。截图前等待可见页面绘制提交；不假定缩放属性更新就代表合成帧已经更新，也不依赖特定 Electron 版本自动 detach。测试显式在打开 DevTools 前暂停并 detach，关闭后重新附加。

入口输出临时证据目录，保存 `run-manifest.json`、场景事实、截图元数据和页面 PNG；manifest 记录工作树、源码散列、运行版本、未测项及空 Core call 列表。原生窗口截图单独采集，Renderer 截图不能替代。失败运行保留原貌；不同进程的画面不得拼成一次连续运行。该实验没有生产 Browser 权限、Host 回调、UNKNOWN 恢复、区域评论或安装版验收能力。
