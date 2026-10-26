---
id: tooltip
title: Tooltip
summary: 辅助提示，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["辅助提示"]
related: ["button"]
exports: ["Tooltip", "TooltipContent", "TooltipProvider", "TooltipTrigger"]
---

# Tooltip 辅助提示

## 何时使用

对已有可见操作补充说明。

## 组成

本合同覆盖同模块导出的整组组件：Tooltip, TooltipContent, TooltipProvider, TooltipTrigger。真实API读取生成的TypeScript声明。

## 状态

延迟、打开、四向定位、触发器聚焦。

## 行为

`R-TOOLTIP-001` 不作为唯一按钮名称，不在提示中放必须完成的业务动作。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-tooltip)直接使用包导出，生产消费者继续沿原路径。
