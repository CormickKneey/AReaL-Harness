# 深入查看与返回

`R-RETURN-001` 先判断用户要快速核对、持续阅读还是编辑，再选择有界预览、显式展开或独立阅读区域。信息层级不能靠缩小字号、无提示裁切或嵌套滚动代替。

`R-RETURN-002` 对话顶部的任务上下文采用紧凑概览：先核对改动、子代理和输入来源，再进入原阅读器。项目与分区标题使用次级表达，常用操作单行呈现；子代理完成数来自各自状态。来源默认预览三项，展开／收起有可见文字，查看全部后可返回原概览；关闭回到顶部入口并保留草稿。定时任务与真实项目关系沿原产品所有者提供，不为填满参考布局添加对象。共享实现见 [TaskContext](../../clients/gui/packages/ui/src/conversation/task-context/task-context.md)，状态合同见 [任务上下文](../../clients/gui/design-system/surfaces/task-context.json)。

## 长内容与全文

`R-RETURN-003` 短内容完整呈现，长内容保留明确的全文入口。折叠只改变展示，不截断存储、发送、复制或导出的原文。关键决策参数、正在编辑的输入和需要完整核对的内容保留专用机制，不为了统一外观隐藏必要信息。

展开后用户能继续阅读，收起后能找到原操作及上下文。正文之外的附件和动作保持可达。同一内容的人工选择按[过程阅读](task-progress.md)处理。

## 资源与返回

`R-RETURN-004` 资源入口标明当前对象及所属任务，打开后保留回到原任务的路径。关闭查看后的草稿、阅读位置和合理焦点由宿主恢复。资源读取失败不遮蔽其他有效内容。查看与控制的区别见[委派与交接](../people-and-agents/delegation-and-handoff.md)，Side 内容回传见[上下文与依据](../people-and-agents/context-and-evidence.md)。

| 平台 | 实现所有者 | 应核对的结果 |
| --- | --- | --- |
| 桌面 GUI | [长文本组件指南](../../clients/gui/packages/ui/src/conversation/collapsible-text/collapsible-text.md#gui-接线)、原资源宿主 | 全文可达、展开与收起、身份、返回、焦点及原生视图 |
| `R-RETURN-005` Remote Web 复用 | [RemoteWorkbench](../../clients/gui/renderer/src/remote/RemoteWorkbench.tsx) | 按实际接入的组件核对浏览器内的全文、返回与焦点，不推导桌面原生能力 |
| 本地 Web | [界面所有者](../../clients/web/app.js) | 浏览器内的展开、导航和草稿，不据此推导原生窗口能力 |

`R-RETURN-006` 返回是否成功需要实际操作验证。宿主截图不替代独立原生视图的可见性和交互证据。
