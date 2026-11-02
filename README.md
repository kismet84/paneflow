# PaneFlow · Codex随行

Windows + Android 的 Codex 任务与会话配套端。基于 [Codex Pane](https://github.com/jadchene/codex-pane) 扩展，保留上游 MIT 许可。

手机原生应用 **Codex随行 0.4.1**，启动品牌 **PaneFlow**，Windows 配套端 **PaneFlow Desktop**。

> 任务随行，随时继续。

## 功能

- 原生 Android 全屏任务、会话、聊天和设置界面；浏览器界面保留作备用入口。
- 查看任务目标状态、继续真实会话、停止当前轮次、审批、分叉、模型与推理强度切换。
- 会话首批 5 条，下滑按服务端游标追加 10 条。
- 设备密钥配对、桌面身份校验、端到端加密；重连不自动重发未确认消息。
- 固定 Cloudflare Named Tunnel 公网入口；Windows 登录自启、托盘后台及服务故障恢复。
- Android 后台连接与通知、网络恢复重连；系统 DNS 失败时使用 HTTPS DNS 备用解析。

## 构建

要求 Windows、Node.js 22+、npm、Codex CLI、PowerShell 7；Android 构建还需 JDK 21、Android SDK 36。先完成 Codex 登录或模型提供方配置。

```powershell
npm ci
npm --prefix remote/mobile ci
npm --prefix remote/relay ci
npm --prefix companion ci
npm run build
npm --prefix remote/relay run build
npm run package:win
npm --prefix companion run apk
```

Android SDK 路径写入本地 `companion/android/local.properties`，或使用 `ANDROID_HOME`。不要提交本地配置。产物为 `release/win-unpacked/PaneFlow Desktop.exe` 与 `companion/android/app/build/outputs/apk/debug/app-debug.apk`。APK 使用本机调试签名；本仓库不包含发布私钥或预构建安装包。

## 固定公网与自启

按 [部署说明](docs/PUBLIC_DEPLOYMENT.md) 创建自己的域名、独立 Cloudflare Tunnel 和本地配置，再运行 `启动公网原型.cmd`。首次配对须核对电脑与手机上的六位数字。之后保持配置与设备身份数据，重启无需重新配对。

不要直接使用别人的域名或部署凭据；本仓库只提供模板，不包含运行中的服务地址、用户数据、聊天记录或设备绑定。

## 测试

```powershell
npm test
npm --prefix remote/relay test
npm --prefix companion test
node --test scripts/test-public-restart.mjs
```

`test-public-restart.mjs` 需要先构建 relay。Android 真机测试位于 `companion/android/app/src/androidTest`，需要自己的已配对设备；详细范围见 [验证说明](companion/VALIDATION.md)。

## 当前边界

- 当前为原型版本。桌面目标状态可跨窗口读取，实时轮次与控制来自配套端连接的 app-server；不等于控制所有 Codex 进程。
- 任务目录为最近 100 个会话。重新连接后会话列表回到首批 5 条。
- 自启发生在当前 Windows 用户登录后。电脑关机、休眠或手机被强制停止时，不保证后台连接和通知。
- 后台通知使用 Android 前台服务，未接入 FCM／厂商推送。
- 当前手机共用桌面端选中会话；未实现每台手机独立选择状态。

## 来源与许可

上游基线：`jadchene/codex-pane`，提交 `13b9308`。本仓库以独立初始提交发布最新代码快照，未携带本机开发历史。上游说明见 [英文](README.upstream.md) / [中文](README.upstream.zh-CN.md)。版权声明与 [MIT LICENSE](LICENSE) 保留。
