---
id: switch
title: Switch
summary: 布尔开关，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["布尔开关"]
related: ["button"]
exports: ["Switch"]
---

# Switch 布尔开关

## 何时使用

二值设置。

## 组成

本合同覆盖同模块导出的整组组件：Switch。真实API读取生成的TypeScript声明。

## 状态

`R-SWITCH-001` checked/unchecked、sm/default、disabled。

## 行为

`R-SWITCH-002` 由Base UI维护原生按钮语义与键盘，宿主提供受控值和真实写入。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-switch)直接使用包导出，生产消费者继续沿原路径。
