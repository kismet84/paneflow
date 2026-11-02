# PaneFlow 0.8.0

Windows + Android 的个人 Codex 任务与聊天配套工具。

## 本次更新

- 原生 Markdown、代码块复制、长回答与历史折叠。
- 图片、文件、拍照及系统语音转文字；加密附件分块上传、断点核对与预览。
- 多电脑独立绑定与会话选择、持久草稿、请求回执核对和历史分页。
- 任务中心、队列、审批中心、详情与模板。
- Windows 配置向导、固定公网入口、登录自启、后台连接与重连。
- 任务/会话页视觉对齐；README 移除早期草图，更新无手机状态栏的实机截图。

## 安装与升级

- Windows：下载 `PaneFlow-Desktop-0.8.0-Setup.exe`。保留原数据、设备身份、隧道和自启配置；不要把已有数据目录作为安装目标。安装包未作 Authenticode 签名。
- Android：下载 `PaneFlow-Android-0.8.0.apk`。包名 `com.codexpane.companion`，版本码 10。此包是已验证的 **debug 签名原型**，不是正式 release 签名构建。与本机此前分发包同签名，可覆盖安装；不同签名包无法直接覆盖，不要为安装而卸载已有绑定。
- 电脑需要已安装并登录 Codex，具备 Node.js 22+ 与 cloudflared；公网使用自己的固定域名和隧道。
- 本次同时提供 `update.json` 与 `SHA256SUMS.txt`。应用内更新仍需用户确认，不自动安装。

## 验证范围

本地通过 334 项桌面测试、12 项中继测试、3 项 Companion 测试；Android 应用/测试 APK 构建及单元测试通过。OPPO K10 已验证公网聊天、附件、重连与任务/会话界面；分项记录见仓库 docs/VALIDATION-0.8.md、docs/VALIDATION-0.8-PUBLIC.md 和 docs/UI-ALIGNMENT-0.8.md。本轮发布未再次运行会发送消息的真机测试。

仍为原型：后台通知受 Android 限制，未接入厂商推送；跨进程任务控制能力有限。不包含私钥、设备绑定或本地部署配置。

## SHA256

```text
0450c537ebc2f1f6674576659e7c5007da96a355ba96419e1e634e51b93f1a0c  PaneFlow-Desktop-0.8.0-Setup.exe
fed460e8c6cfa93e9b1c3519225d3e982565dc672a34c55712fef3f5fe03d9bc  PaneFlow-Android-0.8.0.apk
```

PowerShell 校验：`Get-FileHash -Algorithm SHA256 <下载文件路径>`，结果应与以上校验值一致。
