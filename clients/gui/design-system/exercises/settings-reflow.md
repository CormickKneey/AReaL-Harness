# 设置组合迁移题：长文案与窄面板

题目 ID：`settings-reflow`；问题 ID：`Q-SETTINGS-REFLOW-01`。这是 Base 阶段的小范围探索题，固定候选 `0.1.0` / 源码 `269ab4ec` 为实验输入，不升级为已冻结 Base 或独立盲测；实现者已观察参考。正式阶段 C 仍按架构准入。

## 固定输入与实现约束

任务：用 P-SETTINGS 建立一个只在开发预览中运行的通知设置页。复用 SettingsPage、SettingsSection、SettingsGroupCard、SettingsRow、SettingsSelect、Switch 和 Feedback；页面填内容和值，不添加控件/布局 CSS，不连接桌面 bridge 或真实通知服务。

参考内容集包含五行：Turn completion notifications（Never / Only when unfocused / Always，初始 Only when unfocused）；Enable permission notifications、Enable question notifications、Enable dot notifications（初始均开启）；Notification sound（Default / None / Soft，初始 Default）。说明文字见 fixture 的 reference 内容集，固定为所观察 Codex General 中同一设置组。菜单打开后 Escape 保持值；明确选择 Always 后显示新值；Space 切换权限通知。

压力内容集保留同样五个任务与控件，替换成长中文标签和中英说明。它检验共享约束，不作为与英文参考逐像素对齐的目标。

初始状态 ready；busy 禁用控件并显示文字，failed 显示 alert，unknown 显示待核对且不提供重复提交；另有始终禁用的预览动作。均为本地 fixture 状态，不证明 Core/通知服务路径。

## 评判依据（在运行前固定）

- 相同内容下保持标签、说明、当前值与可操作控件；标签和说明完整换行，行高随内容增长。
- 宽组的控件右边缘对齐；窄组按现有 P-SETTINGS 的共享容器规则上下排列并左对齐。Codex 在所采约 495px 宽条件下仍左右排列，此差异单独评判，不能直接把参考断点抄成规范。
- 明暗、14/18 用户字号、宽/窄代表组合不横向溢出；长文案不通过缩字号、负 margin 或页面专有 CSS 修补。
- 操作记录前态、动作、可观察 ready 和后态。菜单关闭、值确认、开关变化、异常文字分别有真实浏览器断言。
- 参考与实现的整体窗口不同，比较时按实际组件 CSS 宽度、DPR、字体、内容和状态列明匹配与差异；未匹配条件不得写像素一致。

## 证据与归因

复用 `test:design` runner 的 `--settings-exercise` 模式。每个 step 关联条件、测量、原图哈希和所支持的问题；未请求/不可用/部分材料须明确，不能当作相同。原始截图、DOM、trace 和 manifest 留本地；稳定结论回到 patterns / foundations / governance 的原所有者。

报告区分：直接观察、推断、保留差异、规则缺失、公共组合缺陷、实现偏离和题目歧义。修订共享规则前需证据；没有发现缺陷时保留现有实现，不为了展示迭代而制造样式改动。

预览：`design-system.html?settings-exercise`；验收：`pnpm --dir clients/gui test:design --settings-exercise`。本题不证明整体泛化、原生窗口、服务或安装包通过。
