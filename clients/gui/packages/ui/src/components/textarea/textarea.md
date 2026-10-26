---
id: textarea
title: Textarea
summary: 多行输入，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["多行输入"]
related: ["button"]
exports: ["Textarea"]
---

# Textarea 多行输入

## 何时使用

设置脚本和多行正文输入。

## 组成

本合同覆盖同模块导出的整组组件：Textarea。真实API读取生成的TypeScript声明。

## 状态

空值、长正文、聚焦、禁用、无效。

## 行为

`R-TEXTAREA-001` 保持原生textarea事件与field-sizing，不承担草稿持久化或发送。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

`R-TEXTAREA-002` `unstyled` 用于已经由所属组合定义完整外观的编辑区，例如审批回复、标注笔记和配置文本。它保留原生 textarea、输入法、事件、disabled 与 ref，不应用尺寸、自动高度或外观 recipe。组合负责布局和可见焦点。普通多行字段继续使用默认外观。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-textarea)直接使用包导出，生产消费者继续沿原路径。
