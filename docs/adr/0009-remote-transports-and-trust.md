**中文** | [English](0009-remote-transports-and-trust.en.md)

# 0009：同一 Remote 契约支持 Direct 与可自托管 Relay

个人的低运维需求与组织的普通浏览器公网访问需求不同，因此保留 Direct 和 Relay 两条通路，但共用既有 Noise、安全配对与 Host 授权。Relay 只登记 Host 和转发密文，不成为账号、审批或业务存储中心。

相较统一强制 SaaS，该设计增加两个 transport 的一致性测试与部署文档成本，换来独立开源部署和无 AReaL 后端的可用路径。相较第一版引入 WebRTC/P2P/TURN，它避免额外网络状态机。

E2EE 保护业务数据经过转发层，不保护由不可信发布者提供的 Web JavaScript。Host/组织 Web origin 作为受信任软件发布入口；不宣传“Relay 同时控制 Web 代码也绝不可能访问明文”。
