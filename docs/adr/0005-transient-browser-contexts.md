**中文** | [English](0005-transient-browser-contexts.en.md)

# 先交付临时隔离，延后持久 Profile

**状态：proposed（设计提案，尚未实施）**

同页协作需要保留正在使用的临时网页状态，但持久 Profile 管理、导入与长期凭据治理增加明显范围。每个 Browser Workspace 使用独立临时存储上下文；其页面共享上下文，其他 Thread 不共享。已有预览按原对象接入，保留其当前 Session，不复制登录信息。

## 考虑的方案

所有页面共享全局 Profile 实现简单却扩大串线与隐私影响；每页独立则破坏 popup/重定向等常见工作流。选择 Workspace 级临时上下文。跨 Thread 页面转移首期不支持。

## 后果

关闭最后页面并显式关闭 Workspace、归档归属或退出 GUI 会释放其上下文。只允许当前进程内的临时登录，不承诺重启保存。临时隔离不等于进程/网络隔离，也不保证网站允许嵌入登录。

关联：[规格](../design/browser.md)、[契约](../api/browser.md)。
