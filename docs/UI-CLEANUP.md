# Android UI 精简与对齐

日期：2026-11-02。源码：D:/projects-test/paneflow-public。

## 改动

- 删除手机端 Token 使用情况、累计统计及估算费用展示；用量页保留账户额度、剩余比例、重置时间和刷新入口。兼容协议字段未删除。
- 精简设置、用量、电脑管理、连接、配对、通知、新建会话、任务队列、模板和更新页重复介绍。
- 对齐二级标题、内容边距、卡片留白、状态行；多行任务输入顶对齐。
- 空列表不重复显示零计数；会话加载期间显示加载状态；队列明确显示空状态。
- 保留只读、认证、审批、升级签名、系统后台限制等必要提示。

## 验证

- Android debug APK、instrumentation APK 与单元测试构建成功。
- OPPO K10 同包名覆盖安装成功，保留绑定；全程未执行锁屏、解锁、重启或清除应用数据。
- NativeUsageTest、NativeTaskConsoleTest、NativeUpdateTest、NativeReadOnlyTest、NativeChatPresentationTest：19 项通过。
- NativeVisualCleanupTest：1 项通过，导航并截图 16 个页面：任务、会话、设置、用量、连接、电脑管理、通知、诊断、新建会话、队列、添加排队任务、审批、模板、更新、配对、聊天。
- 真实公网认证及会话列表读取成功；用量显示真实额度数据。截图完成视觉复核，最终修正的会话、排队表单、审批、模板、队列页面另行复查。
- 本轮为 UI 回归与只读页面走查，没有执行真实发送、停止、审批、更新安装或重新配对，不作为这些流程的新端到端验收。

## 产物

- APK：outputs/ui-cleanup/PaneFlow-Android-0.8.0-ui-cleanup.apk（debug 签名，本机测试版）。
- SHA256：outputs/ui-cleanup/SHA256SUMS.txt。
- 日志：outputs/ui-cleanup/android-build.log、device-tests.log、visual-walkthrough.log。
- 最终截图：outputs/ui-cleanup/screens-final2/。
- 未提交或推送 Git，未修改 GitHub Release、Windows 部署或公网/自启配置。
