**中文** | [English](GLOSSARY.en.md)

# AReaL Harness 产品术语

本文定义 AReaL Harness 各用户入口的共同语言，不表示规划中的入口已经实现。

## Language

**AReaL 客户端（Client）**：
用户访问 AReaL Harness 会话和执行能力的交互入口；桌面端、移动端、TUI 与 CLI 属于同一层级。
_Avoid_：将客户端等同于执行引擎，或将移动端视为桌面端的下级产品

**桌面端（GUI）**：
用户在电脑上使用的完整 AReaL 图形应用，包含交互界面及其所需的桌面能力。
_Avoid_：仅将界面组件或页面源码称为完整桌面端

**共享浏览器（Shared Browser）**：
用户与 Agent 围绕同一组真实网页交替操作、观察和交流的环境。
_Avoid_：独立自动化浏览器；相同 URL 的另一页面

**浏览工作区（Browser Workspace）**：
属于一个 Thread 的一组 Browser Page 及其浏览上下文，是一次共享浏览任务的资源边界。
_Avoid_：代码 Workspace；AReaL Task；ego Task Space 的直接别名

**浏览页面（Browser Page）**：
共享浏览器内可被认领、观察和交付的单个真实网页。标签是它的界面呈现，不是另一个页面。
_Avoid_：当前活动 Tab；URL 作为身份

**页面来源（Page Origin）**：
页面最初由人、Agent 或未知来源创建的归属线索，与网页的网络 Origin 不同。
_Avoid_：把创建者等同于当前控制者；混同站点 Origin

**浏览器宿主（Browser Host）**：
向 Core 提供受控浏览器能力的可信桌面宿主。
_Avoid_：网页脚本；第二套 Agent Harness

**浏览器控制器（Browser Controller）**：
拥有真实 Browser Page 与控制切换规则的原生资源所有者。
_Avoid_：React Store；会话历史所有者

**认领（Claim）**：
在既定授权下把一个已有人工页面纳入当前 Thread 的 Agent 可控范围。
_Avoid_：复制页面；自动读取所有用户标签

**人工接管（Human Takeover）**：
用户取得 Browser Workspace 的交互权并暂停 Agent 对它的输入与观察。
_Avoid_：只停止点击；暂停整个 Core 服务

**交还控制（Resume Control）**：
用户明确允许 Agent 在重新观察后继续使用当前浏览工作区。
_Avoid_：自动重试；恢复旧坐标

**控制代次（Control Epoch）**：
标识一次连续浏览控制授权的版本；换手后的动作必须属于新的代次。
_Avoid_：连接代次；页面加载次数

**页面观察（Browser Observation）**：
Agent 在已知 Page、文档和视口条件下获得的一次语义或视觉证据。
_Avoid_：网页指令；永久页面真相

**元素引用（Element Ref）**：
由一次有效观察提供、指向特定文档中元素身份的短引用。
_Avoid_：随意猜的 selector；永久 DOM ID

**动作计划（Prepared Action）**：
宿主基于真实页面准备、可供 Core 审批并核对的具体浏览动作。
_Avoid_：模型自然语言意图；可无限重用的授权

**动作回执（Action Receipt）**：
记录一次浏览动作是否未派发、已完成或结果无法确认的执行事实。
_Avoid_：业务验收通过；网页可以回滚

**页面批注（Browser Annotation）**：
用户附着于页面元素或捕获区域的反馈，含其证据来源。
_Avoid_：Agent 工具授权；代码补丁

**样式试改（Style Preview）**：
供用户比较和撤销的临时页面外观或文字变化，不代表源代码修改。
_Avoid_：已保存代码；永久网站改动

**浏览器证据（Browser Evidence）**：
与 Thread 及相关操作关联、可回取核对的页面观察与验证材料。
_Avoid_：实时页面本身；公开分享链接

**浏览器验证（Browser Verification）**：
把明确检查与浏览器证据结合，对交付行为或视觉结果作出的判断。
_Avoid_：点击成功；模型自称完成

**临时浏览上下文（Transient Browser Context）**：
本次 Browser Workspace 生命周期内使用的 Cookie 与站点存储容器。
_Avoid_：持久 Profile；OS 沙箱

**浏览器档案（Browser Profile）**：
可跨浏览工作区或桌面重启保留浏览身份与登录状态的用户档案。
_Avoid_：Agent Profile；临时上下文
