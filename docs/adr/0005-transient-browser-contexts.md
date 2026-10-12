**中文** | [English](0005-transient-browser-contexts.en.md)

# 先交付临时隔离，延后持久 Profile

**状态：源码已实现；统一原生验收待完成**

同页协作需要保留正在使用的临时网页状态，但持久 Profile 管理、导入与长期凭据治理增加明显范围。每个 Browser Workspace 使用独立临时存储上下文；其页面共享上下文，其他 Thread 不共享。已有预览按原对象接入，保留其当前 Session，不复制登录信息。

## 考虑的方案

所有页面共享全局 Profile 实现简单却扩大串线与隐私影响；每页独立则破坏 popup/重定向等常见工作流。选择 Workspace 级临时上下文。跨 Thread 页面转移首期不支持。

## 后果

关闭最后页面并显式关闭 Workspace、归档归属或退出 GUI 会释放其上下文。只允许当前进程内的临时登录，不承诺重启保存。临时隔离不等于进程/网络隔离，也不保证网站允许嵌入登录。

Main 为每个 Workspace 分配内存中的 Electron Session。认领、隐藏及空闲页面替换期间，兄弟页面沿用该 Session；最后一页释放后，关闭请求策略并清理连接、存储、缓存及认证状态。普通人工公网与本地浏览使用 Chromium 正常系统代理、DNS、重定向和跨源依赖，支持 HTTP(S)/WebSocket；不导入个人浏览状态，不修改 OS/Surge，也不按公网/私网或 fake-IP 分类拒绝普通请求。无需逐 Origin 许可，不注入或删改站点 CSP、Connection-Allowlist 和下载响应头。Main 将当前 Core/adapter 控制端口在所有主机名上保留并拒绝，以防 DNS 别名、重绑定和代理 fake-IP 绕过；无关站点占用相同活动端口也会被拒绝。关闭上下文保持拒绝策略，既有人工 Frame 授权仍限于其页面和父文档。Agent 读取与动作另外经过 Core 的页面/代次权限机制；网页仍无产品 bridge。此边界不是操作系统级网络沙箱。统一真实 Core/GUI 原生与安装包验收仍待完成。

关联：[规格](../design/browser.md)、[契约](../api/browser.md)。
