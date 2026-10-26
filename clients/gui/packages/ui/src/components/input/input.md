---
id: input
title: Input
summary: 输入框，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["输入框"]
related: ["button"]
exports: ["Input", "inputVariants"]
---

# Input 输入框

## 何时使用

单行字段、文件及数值输入；保持原size/htmlSize分工。

## 组成

本合同覆盖同模块导出的整组组件：Input, inputVariants。真实API读取生成的TypeScript声明。

## 状态

`R-INPUT-001` 默认、xs/sm/lg、只读、禁用、无效及文件字段。

## 行为

`R-INPUT-002` 原生输入事件、ref和输入法沿原控件，不因外观迁移改变提交。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

`R-INPUT-003` `unstyled` 仅用于已经拥有完整外观的组合，如会话搜索与重命名弹层。它保留原生输入、输入法、事件、disabled 和 ref，不应用尺寸与外观 recipe。组合负责布局和可见焦点；普通字段仍使用原有 size。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-input)直接使用包导出，生产消费者继续沿原路径。
