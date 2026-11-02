# 验证范围 · Android 0.4.1

在 OPPO K10 上验证了原生配对、固定地址迁移（保留原绑定）、真实聊天、任务控制台、模型与推理强度、会话 5/10 分页和草稿恢复。

0.4.1 实测中继、隧道、桌面、守护进程异常后自动恢复，并验证手机在前台与后台均能恢复认证且不重新配对。固定公网版本测试全程未锁屏；未重启整台 Windows，登录自启通过实际计划任务启动验证。

后端针对认证、任务、分页和重连的 39 项测试通过，额外真实 WebSocket 策略启动/撤销测试 2 项通过；Android 单元测试 6 项通过。完整个人验收日志、会话正文及设备数据不公开。

真机测试必须使用自己的测试设备和专用会话，勿对运行中的业务任务注入故障。

```powershell
# 已安装主 APK 和测试 APK、已配对自己的固定 HTTPS 服务后：
adb shell am instrument -w -e class com.codexpane.companion.NativeReconnectTest -e relayOrigin https://paneflow.example.com com.codexpane.companion.test/androidx.test.runner.AndroidJUnitRunner
```

测试输出 READY_FOR_RESTART 后，由测试操作者仅中断自己的测试服务。该用例验证断连、重新认证与原绑定保持，不主动锁屏。

不同手机的系统省电和厂商后台策略可能影响通知。强制停止后的提醒、整机实际重启以及所有模型提供方兼容性不在本轮通过范围内。
