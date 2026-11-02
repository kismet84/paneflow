# 会话占用错误与回执归属修复

日期：2026-11-02。基线：06cefca。仅本地 Android 修复，未覆盖 GitHub 0.8.0 发布资产。

## 原因与修复

电脑 app-server 在恢复其他 Codex 进程正在占用的会话时拒绝 thread/resume，返回 already has an active writer。此前手机在请求完成前进入聊天页并沿用旧 snapshot；任意失败回执都会清空切换目标并弹出错误，自动恢复失败也可覆盖当前语音输入弹层。

- 手动打开会话先等待匹配 requestId 的回执，成功且目标与 snapshot 一致才进入聊天。
- 打开操作串行；过期打开回执不清空新目标、不弹出错误。
- 自动恢复回执单独标记；失败只给出短提示，不弹出模态对话框。
- 切换未完成时不启动语音输入；真实 writer 冲突转为中文说明。
- 不抢占桌面会话、不删除锁、不自动重发消息。

## 验证

- assembleDebug、assembleDebugAndroidTest、testDebugUnitTest 成功；新增错误文案单元测试2项。
- OPPO K10 同签名覆盖安装，NativeOpenReceiptTest 通过（1项，覆盖后台/过期回执及当前打开失败）。
- 实际点击当前被桌面占用的聊天：中文说明出现，背景仍是会话列表。
- 关闭提示后打开 0.8 Node native media acceptance：成功进入正确聊天，历史可见。
- 全程未锁屏，未发送聊天，未改变公网、配对或自启配置。
- 本轮未验证真实语音识别质量；该错误来自会话恢复，不是识别引擎。

证据目录：outputs/writer-fix/，含 build.log、device-test.log、conflict.png、open-success.png。
修复 APK：outputs/writer-fix/PaneFlow-Android-0.8.0-writer-fix.apk。
