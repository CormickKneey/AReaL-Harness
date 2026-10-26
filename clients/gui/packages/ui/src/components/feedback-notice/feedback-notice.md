---
id: feedback-notice
title: FeedbackNotice
summary: 带恢复动作与详情的持久状态。
status: experimental
entry: experimental
layer: core
category: composition
aliases: ["带恢复动作与详情的持久状态"]
related: ["button"]
exports: ["FeedbackNotice"]
---

# FeedbackNotice 带恢复动作与详情的持久状态

## 何时使用

`R-FEEDBACKNOTICE-001` 带恢复动作与详情的持久状态。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖FeedbackNotice；完整Props从同目录生成TS API读取。

## 状态

引用 [R-UI-COMMON-005](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-014](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-006](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-007](../../../README.md#共同合同)。

## 规则

`R-FEEDBACKNOTICE-002` 这是底层纯展示表面，不用于新的操作通知。生产renderer适配默认经ToastHost显示统一短时NotificationToast，包含核对动作；真正的任务事实由原专用状态组件呈现。组件不核对请求、不重试未知操作。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-feedback-notice)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
