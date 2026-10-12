**中文** | [English](0003-native-view-and-driver.en.md)

# 保留 WebContentsView 与窄 CDP Driver

**状态：accepted（2026-10-10 用户批准技术方案；生产集成尚未实施）**

R0 原生证据完成后，用户批准保留现有 WebContentsView、Main 窄 debugger Driver、可信原生输入遮罩，以及优先使用冻结截图承载区域反馈。后续实现按既有票的依赖推进；批准技术选择不代表 Core 工具链、接管、UNKNOWN 或发布验收已经完成。

当前原生预览已采用 WebContentsView，且没有网页 preload/Node/产品桥。保留这一安全与生命周期边界，通过 Main 的 debugger 传输实现范围受限的 Browser Driver；不开放整个 Electron 的远程调试端口，不把不同 View 技术迁移当作 Browser 集成前置条件。

## 考虑的方案

ZCode 的 guest 控制和快照组织可参考，但其 webview 表面不原样迁移。Playwright 用于真实端到端验证；如提取其内部 injected script，必须固定版本、保留归属并承担内部 API 维护，不能声称属于稳定公开 SDK。Ego 上层 SDK 依赖原生 snapshot，不能直接替代观察实现。

## 后果

原生 View 遮挡 React 浮层是实际成本：先以真实 Electron 验证可信原生覆盖层。失败时区域批注可用冻结截图，输入屏障不可取消。DevTools attach/detach 是显式资源状态，不能让多个 CDP 所有者争用。

关联：[规格](../design/browser.md)、[契约](../api/browser.md)。

Driver 必须在打开 DevTools 前显式暂停、撤销旧调试代次并 detach，同时处理原生打开事件；不能依赖特定 Electron 版本自动 detach。关闭后重新附加并重新观察。R0 的隔离实验入口见[原生验证](../development/browser-testing.md#r0-原生实验入口)，它不代表生产 Driver 已接入 Core。
