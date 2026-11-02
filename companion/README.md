# Codex随行 0.4.1 — PaneFlow 原生 Android 配套端

主入口为 Java 原生 Android Views，聊天、任务列表与控制不使用 WebView 或 Chrome。最低 Android 8.0 / API 26。保留早期 Vue + Capacitor 页面，仅作为“设置 → 浏览器备用入口”，不会自动切换过去。

## 0.4.0 全屏界面

按已选草图实现浅色原生界面：任务 / 会话 / 设置三标签，聊天独立全屏；系统状态栏、手势区及软键盘保留安全间距。

- 任务读取最近 100 个会话的持久目标状态，区分实施中、暂停和本连接的执行状态；未知状态不当作零。
- 会话按服务端更新时间排序，首批 5 条，下滑按游标追加 10 条；搜索重新开始分页。重连后回到首批 5 条。
- 模型选择压缩行距；OPPO K10 上 8 个模型、6 档推理强度和应用按钮同屏。
- 桌面名称 Codex随行，启动品牌 PaneFlow，标语“任务随行，随时继续。”。
- 新建会话可填 Windows 工作目录、真实模型/推理强度、初始消息；需搭配本次更新的 Windows 端。
- 分叉可命名；模型、停止、审批、连接管理均使用原生底部弹层。
- 未确认发送与当前输入分开保留，旋转和连接中断不自动重发；进程强制终止不承诺草稿持久保存。
- 后台完成提醒、审批提醒分别开关；系统异常提醒保留。
- 验证范围见 VALIDATION.md。


## 0.4.1 固定公网连接

固定入口示例：https://paneflow.example.com；请配置自己的域名。使用独立 Cloudflare Named Tunnel；重启不再生成随机地址。

- Windows 计划任务 PaneFlow-Companion-AtLogon，在当前 Windows 用户登录后隐藏启动；沿用 data/public-companion 中的加密身份。登录前不运行此 GUI 配套端。
- 关闭窗口隐藏到托盘，手机连接继续；托盘“退出并停止手机连接”沿用保存及活动任务确认流程。
- 中继、隧道、桌面异常退出自动恢复；守护自身崩溃由独立 IPC 看护回收三个精确子进程，启动包装程序约 5 秒后恢复。不会按名称或进程树终止其他工具。
- 手机“设置 → 连接管理 → 连接地址”可迁移旧入口，仅改变地址，保留原设备及电脑密钥。TLS 与电脑身份校验继续有效；不会自动信任另一台电脑。
- 手机系统 DNS 失败时，使用 AliDNS / Cloudflare 的 HTTPS DNS 备用解析，只发送域名；不修改系统 DNS，不发送配对或聊天数据。
- 手机网络恢复时自动重连；开启“后台保持连接”后切到其他应用仍保留连接。强制停止或厂商清理后仍不能保证后台运行，重新打开 APP 会恢复。
- 撤销设备或身份校验失败不会自动重新绑定；重启不自动重发未确认消息。

固定入口启动脚本：scripts/public-companion-supervisor.mjs；旧“启动公网原型.cmd”已统一进入固定入口。配置 data/public-companion/persistent.json 与 named-tunnel.yml，凭据留在用户 .cloudflared 下，不入库。

关闭登录自启可运行 Disable-ScheduledTask -TaskName PaneFlow-Companion-AtLogon；此命令只禁用下次启动，当前服务通过托盘退出。不要删除 data/public-companion/remote/credentials.json 或手机应用数据，否则绑定不能保留。

验证范围见 VALIDATION.md。未重启整台 Windows、未锁屏；按真实计划任务启动及故障恢复验证。

## 当前功能

- 粘贴 Windows 配对 URL，显示六位确认码；必须由用户在电脑核码确认。
- 原生会话列表、历史正文、实时回复、文字发送、任务状态。
- 停止当前任务、一次审批/拒绝、MCP 选项、分叉、模型与推理强度选择。
- 断线自动重连；重连进行新的临时密钥握手，不自动重发未确认消息。
- 用户明确开启后的 remoteMessaging 前台服务；持续通知可停止后台连接。
- 后台/锁屏收到任务完成、异常或待确认提醒，通知仅显示泛化文案，不含会话标题、正文或命令。

## 原生认证与网络边界

设备身份使用 Android Keystore 中不可导出的 P-256 签名私钥。元数据只写 APP 私有存储，Android 备份关闭。每次连接使用内存中的临时 ECDH 密钥，HKDF-SHA-256 派生 AES-256-GCM 密钥；会话 ID 与消息序号进入认证数据，校验桌面签名和密文序号。

原生配对显式使用 authentication: native，没有伪装成 Passkey。首次绑定需电脑确认，后续后台重连以设备密钥证明身份，不再次弹出生物识别或 Passkey。借用/失去手机时应在电脑撤销此设备。

公网仅支持 HTTPS/WSS，使用系统 TLS 证书验证，没有 trust-all、证书错误忽略或 WebView 任意明文开关。明文仅限本机 USB 验证的 localhost / 127.0.0.1；生产包没有绕过配对的 ADB Intent 或导出原生聊天入口。

## 使用

1. 电脑启动当前版本 PaneFlow Desktop 和匹配的中继，在远程访问设置生成配对链接。
2. 手机打开 Codex随行，点“粘贴配对链接”。
3. 核对手机和电脑显示的六位数，仅在一致时点击电脑确认。
4. 连接后打开“会话”，选择真实会话或新建，开始发送消息。
5. 如需锁屏提醒，在“设置 → 后台与通知”开启后台保持连接，阅读说明并允许系统通知。
6. 后台不再需要时，可在应用菜单关闭，或点持续通知的“停止后台连接”。

后台服务不是云推送。**强制停止、厂商清理进程、系统深度省电或网络不可用时不能保证提醒送达。** 没有注册公网 FCM/厂商推送，也没有自动申请电池优化豁免。USB 转发断开时手机无法访问电脑上的 localhost；跨网络使用需可信 HTTPS 中继。

会话正文使用可选择复制的原生文本显示，支持基础 Markdown 标题、列表、粗体与代码块复制；附件传输、富媒体渲染和完整历史分页仍受桌面远程协议能力限制。

## USB 本机验证

电脑中继监听 127.0.0.1:48321，设置 PUBLIC_ORIGIN=http://localhost:48321。确认手机序列号和现有转发后：

```powershell
$adb = Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
& $adb -s '<手机序列号>' reverse tcp:48321 tcp:48321
& $adb -s '<手机序列号>' install -r '<项目目录>/companion/android/app/build/outputs/apk/debug/app-debug.apk'
& $adb -s '<手机序列号>' shell am start -n com.codexpane.companion/.MainActivity
```

## 构建与测试

要求 Node 22+、JDK 21、Android SDK 36。SDK 路径位于不入库的 android/local.properties。

```powershell
npm ci
npm test
npm run apk
$env:JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=<项目目录>/companion/.java-tmp'
./android/gradlew.bat -p android testDebugUnitTest --no-daemon
```

产物：android/app/build/outputs/apk/debug/app-debug.apk，本地调试签名，非商店发布包。npm run apk 仅在本次构建进程设置项目内 JDK Unix socket 临时目录，避免本机路径导致的 loopback 错误，不修改全局环境。

主要实现：NativeChatActivity.java、NativeConnection.java、NativeCrypto.java、NativeIdentity.java、NativeMessagingService.java。固定 Node 互操作向量在 android/app/src/test/resources/crypto-vector.properties；其中私钥是测试专用随机生成材料，不是用户设备密钥。

真机验证以主项目验收记录为准，构建成功不表示手机端所有流程已经验收。
