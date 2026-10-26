---
id: tabs
title: Tabs
summary: 标签切换，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["标签切换"]
related: ["button"]
exports: ["Tabs", "TabsList", "TabsTrigger", "TabsContent", "tabsListVariants"]
---

# Tabs 标签切换

## 何时使用

同层内容或有限选项切换。

## 组成

本合同覆盖同模块导出的整组组件：Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants。真实API读取生成的TypeScript声明。

## 状态

横向/纵向、选中、焦点、禁用。

## 行为

`R-TABS-001` 保留手动/自动激活能力；需要未保存导航守卫时由宿主选择手动激活，焦点移动不等于保存。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-tabs)直接使用包导出，生产消费者继续沿原路径。
