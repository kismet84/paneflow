# 固定公网部署

使用自己的 Cloudflare 账号和域名，创建专用 Named Tunnel；不要复用或覆盖其他应用的隧道。Quick Tunnel 的随机域名不用于本版本自启。

1. 按 [Cloudflare 官方配置说明](https://developers.cloudflare.com/tunnel/get-started/) 登录 cloudflared，创建隧道并把自己的子域名路由到该隧道。
2. 完成 README 中的 Windows 与 relay 构建。
3. 创建 `data/public-companion/logs`。将 `docs/deployment/persistent.example.json` 复制为 `data/public-companion/persistent.json`，将 `named-tunnel.example.yml` 复制为同目录 `named-tunnel.yml`。
4. 替换所有示例值：域名、隧道 UUID、cloudflared / Node 路径以及隧道凭据路径。两个配置里的 UUID 和域名应一致。凭据保持在用户私有目录，禁止上传 GitHub。
5. 运行 `启动公网原型.cmd`。中继仅监听 `127.0.0.1:48322`；健康检查为自己的固定域名 `/health`。
6. 手机原生 APP 粘贴电脑生成的配对链接；仅在双方六位码一致时在电脑确认。已有同一电脑的旧地址可通过手机“设置 → 连接管理 → 连接地址”迁移，不更换身份密钥。
7. 确认运行正常后，用当前 Windows 用户运行 `scripts/install-paneflow-startup.ps1`，注册 `PaneFlow-Companion-AtLogon`。应先通过托盘退出手动启动的实例，再 `Start-ScheduledTask -TaskName PaneFlow-Companion-AtLogon` 测试计划任务。

自启为当前用户登录后启动，采用 Interactive / Limited，使用同一 Windows 用户解密桌面身份。普通关闭窗口隐藏到托盘；“退出并停止手机连接”停止本次服务。禁用下次登录自启：`Disable-ScheduledTask -TaskName PaneFlow-Companion-AtLogon`。

请保留 `data/public-companion/remote/credentials.json` 和 Android 应用数据。删除它们会丢失绑定。不要把自己的生产凭据复制到测试目录。手机后台保持连接需在设置中主动开启并允许通知。

系统 DNS 失败时，APP 会尝试 AliDNS / Cloudflare HTTPS DNS，查询仅包含域名。未修改系统 DNS；始终验证 HTTPS 证书和桌面密钥。失败仍会退避重试。

安全诊断默认关闭 `inspectUi`；仅本机排障时可临时打开，结束后关闭并重启服务。不要将 48325 调试端口暴露到公网。
