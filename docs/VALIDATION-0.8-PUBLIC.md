# Windows 0.8 公网升级与 OPPO 验收

日期：2026-11-02。用户明确授权升级日常 Windows 配套端、保留公网/配对/自启并继续验证，不锁屏。

## 升级范围与保留验证

- 主源码：`D:/projects-test/paneflow-public`；日常实例：`D:/projects-test/codex-pane-mobile`。
- Windows 0.7 → 0.8；84 个程序文件逐文件 SHA-256 与构建输出一致，中继 `server.js` 与构建输出一致。
- 固定入口仍为 既有固定 HTTPS 域名（公开报告省略实际入口）；任务 `PaneFlow-Companion-AtLogon` 原动作、触发器及配置未改，已通过该任务启动新版。
- `persistent.json`、`named-tunnel.yml`、`remote/credentials.json` 升级前后 SHA-256 完全一致。没有重新配对、变更身份密钥、域名或云端隧道。
- 先通过原手机读取空闲快照：Codex ready、当前轮次 idle、无 activeTurn、活动列表与队列均为 0，才停止本实例。
- 停服与文件切换经独立只读复核；只操作核对命令行、创建时间和固定进程句柄的本实例进程，不按名称批量结束。
- 已运行版本 `0.8.0.0`（Windows 文件资源版本），固定公网 `/health` 正常，原手机自动认证并收到 `attachmentsV1`。

## 已完成真实验收

`NativePublicMediaLiveTest` 在 OPPO K10 原 legacy 绑定上通过，56.284 秒；没有 USB 端口转发，使用 HTTPS 公网入口。新建专用会话 `01a19ad9-82b5-74e3-be16-a090cb96b450`，保留其他聊天。

1. 第一轮真实文字回复并回到空闲。
2. 70,000 字节文本上传首块后主动断开，再用原绑定认证恢复；服务器偏移为 49,152 字节，重复首块保持偏移不变。
3. 续传文本与 PNG 图片，单次发送双附件，真实模型回复。
4. 历史恰好一条消息关联两份附件；两份下载字节及 SHA-256 与原文件一致。
5. 第三轮继续聊天，正确带回第一轮标记，验证上下文保留。

主动断开再恢复与异常断线自动重连分开记录，不能互相替代。自动重连补测及图片预览检查见后续结果。

## 恢复材料

- 配置与用户数据备份（不含运行日志、Chromium缓存）：`D:/projects-test/paneflow-public/outputs/stage-0.8-public/backup-20261102-135814`。
- 旧程序：`D:/projects-test/codex-pane-mobile/release/backup-0.7.0-20261102-135814`。
- 旧中继：`D:/projects-test/codex-pane-mobile/remote/relay/backup-dist-20261102-135814`。
- 不直接覆盖正在运行的程序或用旧数据覆盖新聊天。需要恢复时先核对当前实例与活动任务，准确退出后再切换程序；保留新增数据与恢复材料。

## 证据

本地忽略目录 `outputs/stage-0.8-public/`：`before-safety.txt`、`after-safety.txt`、`deployment.json`、`runtime-verification.json`、`relay-match.json`、`phone-public-media.txt`。

没有重启 Windows 或手机，因此登录自启验证为原计划任务保留且实际拉起新版，不代表重新开机验收。没有锁屏、绕过锁屏、改系统省电白名单、提交或推送 Git。

## 补充验收结果

- 自动重连：`NativePublicReconnectTest` 通过，26.203 秒。只取消现有 WebSocket，未调用 disconnect/resume/reconnect；观察到离线后自动认证恢复、新 socket、新 snapshot、原会话选择保持。完整分页前后消息 ID 与附件 ID 集合一致。首次在故障注入前历史查询超时，失败日志保留；后续诊断复测通过，不把首次失败删除或计为成功。
- 图片/文件界面：`NativePublicAttachmentUiTest` 通过，15.678 秒。真实聊天附件按钮触发下载，确认全屏图片控件和红色像素；文件预览显示完整性校验通过。关闭预览后附件行仍在视口内。截图 `phone-image-preview.png`、`phone-file-preview.png` 已由主线程目视核对。
- 修复原生列表误判到底：末条消息仅部分可见时，不再自动当作已到底；结合子视图像素位置保持阅读锚点。新版 APK 同签名覆盖安装并重新收集 SHA-256；Windows 程序文件未因此变化。
- 以上界面验收使用真实设备控件 performClick，不代表多指缩放、系统文件选择器、相机、麦克风或分享目标全部通过。此前一次 ADB 直接打开非导出 NativeChatActivity 被 Android 拒绝，随后通过正常 MainActivity 入口操作，未放宽导出权限。
- 没有进行锁屏测试，也未修改屏幕超时或电池策略。仪器测试只在已解锁状态临时设置窗口 KEEP_SCREEN_ON，结束后清除。

最终证据另含 `phone-automatic-reconnect.txt`、`phone-automatic-reconnect-first-failure.txt`、`phone-attachment-ui.txt`、`android-fix-build.txt`、`final-state.json`。3 个本轮公网真机验收测试均通过，不将它们与前阶段非界面测试混算。自启通过原计划任务实际拉起新版验证，未重启电脑。

收尾组合命令（状态检查并重新打开手机应用）被自动审批拒绝，仅返回 blocked by policy。未重复打开应用；改用只读进程、任务及配置哈希终检，证实新版各自有进程仍运行、原配置与凭据不变。此前真实聊天、自动重连及预览测试均已完成通过。

公开仓库中的公网真机测试需显式传入 instrumentation 参数 `expectedPublicOrigin`（自己的 HTTPS 入口），并沿用各测试原有启用开关与会话参数；未提供正确入口时校验失败，不接管其他绑定。
