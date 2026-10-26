# Raft 设计系统是怎么搭起来的

本页为迁移入口，保留一个迁移周期。外部项目拆解属于参考研究。完整内容见[归档原文](archive/research/raft-design-analysis.md)。当前规则从[使用者入口](../clients/gui/packages/ui/README.md)或[维护者入口](../clients/gui/design-system/README.md)读取。

## 核心 Mental Model：设计系统是一个编译器

见[原文段落](archive/research/raft-design-analysis.md#核心-mental-model设计系统是一个编译器)。

## 仓库全景：从意义到产物

见[原文段落](archive/research/raft-design-analysis.md#仓库全景从意义到产物)。

## 六个贯穿整个仓库的思路

见[原文段落](archive/research/raft-design-analysis.md#六个贯穿整个仓库的思路)。

### 每种颜色只有一个意思，全产品线通用

见[原文段落](archive/research/raft-design-analysis.md#每种颜色只有一个意思全产品线通用)。

### 三种线，三种意思；两个区域之间只有一条线

见[原文段落](archive/research/raft-design-analysis.md#三种线三种意思两个区域之间只有一条线)。

### 每条规则 = 规则 + 为什么 + 怎么推广到新情况

见[原文段落](archive/research/raft-design-analysis.md#每条规则--规则--为什么--怎么推广到新情况)。

### 不要 `kind` / `state` / `emphasis` 这种万能开关

见[原文段落](archive/research/raft-design-analysis.md#不要-kind--state--emphasis-这种万能开关)。

### "一整天开着"的产品，每一点视觉噪音都按分钟付费

见[原文段落](archive/research/raft-design-analysis.md#一整天开着的产品每一点视觉噪音都按分钟付费)。

### 设计系统的第二类读者是 AI

见[原文段落](archive/research/raft-design-analysis.md#设计系统的第二类读者是-ai)。

## 一个 class 是怎么一路解析到颜色值的

见[原文段落](archive/research/raft-design-analysis.md#一个-class-是怎么一路解析到颜色值的)。

## 谁拥有什么：组件库的状态边界

见[原文段落](archive/research/raft-design-analysis.md#谁拥有什么组件库的状态边界)。

## 四个可以随身带走的思考框架

见[原文段落](archive/research/raft-design-analysis.md#四个可以随身带走的思考框架)。

### 颜色、线条、动效都是花注意力的

见[原文段落](archive/research/raft-design-analysis.md#颜色线条动效都是花注意力的)。

### 画任何新元素之前先问

见[原文段落](archive/research/raft-design-analysis.md#画任何新元素之前先问)。

### 原则打架时怎么裁决

见[原文段落](archive/research/raft-design-analysis.md#原则打架时怎么裁决)。

### 人说的话和机器写的东西要能一眼分开

见[原文段落](archive/research/raft-design-analysis.md#人说的话和机器写的东西要能一眼分开)。

## 分阶段引入到你们的项目

见[原文段落](archive/research/raft-design-analysis.md#分阶段引入到你们的项目)。

## 对 GUI + TUI 双端的 Agent 产品，最值得拿的几样

见[原文段落](archive/research/raft-design-analysis.md#对-gui--tui-双端的-agent-产品最值得拿的几样)。

### 一份 tokens.json，同时生成 GUI 和 TUI 主题

见[原文段落](archive/research/raft-design-analysis.md#一份-tokensjson同时生成-gui-和-tui-主题)。

### Agent 状态静止显示，不用循环动画

见[原文段落](archive/research/raft-design-analysis.md#agent-状态静止显示不用循环动画)。

### 人说的用比例字体，机器产出的用等宽字体

见[原文段落](archive/research/raft-design-analysis.md#人说的用比例字体机器产出的用等宽字体)。

### 红色只留给不可撤销的操作

见[原文段落](archive/research/raft-design-analysis.md#红色只留给不可撤销的操作)。

## Raft 的代价和局限

见[原文段落](archive/research/raft-design-analysis.md#raft-的代价和局限)。
