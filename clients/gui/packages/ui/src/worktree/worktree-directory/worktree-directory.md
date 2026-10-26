---
id: worktree-directory
title: WorktreeDirectory
summary: 按项目分组目录身份、展开详情与删除反馈。
status: experimental
entry: experimental
layer: worktree
category: worktree
aliases: ["Worktree目录列表"]
related: ["worktree-settings", "button"]
---

# WorktreeDirectory Worktree目录列表

## 何时使用

用于Worktrees General的已管理目录清单。它呈现原记录，不承担Git或文件系统管理。

## 组成

Root、Group和Item。Item接收name、受控open、details children、删除意图回调和宿主操作状态。

## 状态

`R-WORKTREEDIRECTORY-001` 收起/展开、删除中、删除受阻及未知。行状态独立，错误不因其他行刷新而变成成功。

## 行为

`R-WORKTREEDIRECTORY-002` 查看和删除是分开的按钮。删除回调只表达意图；确认、requestId、锁与安全检查由原宿主负责。删除受阻时目录记录保留。

## 内容

`R-WORKTREEDIRECTORY-003` 名称优先任务名/分支，路径与请求身份在详情中可读；不展示未实现的恢复快照能力。

## 可访问性

`R-WORKTREEDIRECTORY-004` 展开有独立唯一id与aria关系；删除按钮带目录名，真实disabled阻止重复操作。路径与详情窄窗换行。

## 规则

`R-WORKTREEDIRECTORY-005` Item不会自动确认、重试或移除目录。提示Toast消失不清除原删除结果；具体受阻原因仍可在详情核对。

## 示例

`R-WORKTREEDIRECTORY-006` 独立实例可查看长路径和模拟删除受阻；生产调用原deleteWorktree并保留确认和Core安全约束。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-directory)。

### 按项目管理目录

`WT-LIST-01`：设置组下方留区块间距，呈现一个紧凑列表，而不是每个项目一张大卡片。项目头行用文件夹图标与项目名；其下工作区行按相同缩进排列：层级入口 / 可识别名称 / 弹性空间 / 查看详情或删除。

- `R-WORKTREEDIRECTORY-007` 名称优先使用绑定会话标题，其次为分支，再无名称时使用短标识。完整路径、分支、环境、状态在展开详情中可读，不能只藏在不可复制的 tooltip。短标识不取代真实身份。
- 行首 Chevron 表达目录层级展开；选中 / 展开 / hover 是三种状态。纯图标删除按钮具名，hover 和键盘聚焦时可辨，不依赖红色小图标解释后果。
- `R-WORKTREEDIRECTORY-008` 一次只给正在操作的行 busy 反馈；读取失败、删除受阻、结果未知在该项目 / 行附近显示，不把整个列表变成空态。
- `R-WORKTREEDIRECTORY-009` 删除前显示目录身份及“移除目录，保留分支和历史”，沿现有删除确认合同。未提交、未跟踪、忽略文件、未合并提交、活动执行等阻挡原因用原检查结果说明；不增加强制删除按钮。
- `R-WORKTREEDIRECTORY-010` 空列表显示“尚无 Worktree”；未知项目归属明确分组，不猜成当前项目。刷新保留已确认列表与展开位置，删除只有确认成功才移除该行。

页面只有一个主纵向滚动区；目录列表随页滚动，详情中的短字段不额外套独立滚动容器。
