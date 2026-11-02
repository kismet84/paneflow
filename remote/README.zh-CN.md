# Codex Pane 远程端

[English](README.md) | 简体中文

Codex Pane 远程访问通过自托管中转连接桌面和手机。中转只提供网页引导和转发加密消息，不保存账号或业务消息；手机业务界面随桌面版本下发。

## 部署中转服务

需要 Docker Compose 和 HTTPS 域名。在仓库根目录运行 `npm run package:relay`，将生成的 `release/relay-deploy` 上传到服务器，按[部署指南](relay/deploy/README.zh-CN.md)操作。直接从源码部署时，同样的指南适用于仓库的 `remote/relay` 目录。

部署后，按[桌面端远程访问步骤](../README.zh-CN.md#远程访问)启用服务并扫码配对。远程使用期间桌面应用需保持运行。

## 设备与数据

可在桌面设置中分别撤销手机；撤销后需重新扫码。“退出所有手机”只清除登录状态，已登记设备仍可用 Passkey 登录。

中转重启后，桌面和手机会自动重连。Docker 持久卷仅保存 Caddy 证书和配置，无需备份业务数据库。中转可看到 IP、连接时间和帧大小；消息采用端到端加密，但中转被攻陷时仍可能替换网页引导代码，因此仍需信任中转的部署环境。

## 更新

手机业务界面随桌面更新，通常无需更新中转。中转自身的安全修复、基础设施或外层协议变更仍需重新部署。

## 本地开发

使用 Node.js 24 或更高版本。先在仓库根目录运行 `npm install`，再分别在 `relay` 和 `mobile` 中安装依赖并运行 `npm run dev`、`npm test` 和 `npm run build`。启动中转前需设置 `PUBLIC_ORIGIN`，默认端口可使用 `http://localhost:3000`；修改端口时还需设置 `PORT`。

WebAuthn 只能在安全上下文中使用。手机真机测试应使用生产 HTTPS 部署；只有浏览器认可的本机可信来源才适合用 localhost 调试。
