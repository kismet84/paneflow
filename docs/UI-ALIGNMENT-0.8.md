# 0.8 任务 / 会话页面视觉对齐

日期：2026-11-02。范围：原生 Android 页面局部调整，保持现有视觉风格及行为。

## 实施

- 共用页面标题：32 sp、左右 20 dp、新建按钮 44 dp。
- 统一搜索框颜色、圆角、文字与内边距。
- 任务快捷入口等宽排列；筛选按钮紧凑化，保留横向滚动与全部入口。
- 会话电脑选择器改为页面内缩；卡片标题最多两行，日期顶对齐且不换行。
- 任务卡片标题、路径与详情入口调整文字层级。完整路径仍可在详情查看。
- 底部导航、连接协议、配对、后台设置及 Windows 运行实例未修改。

## 验证

- Gradle :app:assembleDebug 成功；ADB install -r 成功，同包名覆盖安装到 OPPO K10。
- 已连接工作电脑，真实任务卡片与会话列表正常显示。
- 任务详情数据加载、返回、状态筛选弹层、任务/会话标签切换通过。
- 1080 × 2412 真机截图检查：标题边线一致，按钮无裁切，长标题与日期无重叠。
- 本轮未发送聊天、停止任务或处理审批；不将此前功能验收当作本轮重测。
- 全程未执行锁屏、解锁或重启；未提交或推送 Git。

## 本地证据

目录：D:/projects-test/paneflow-public/outputs/ui-alignment/

- tasks-before.png：修改前任务页。
- tasks-connected.png：修改后任务页（公网已连接）。
- sessions-after.png：修改后会话页。
- task-detail-loaded.png：任务详情已加载。
- task-filter.png：状态筛选弹层。
- build.txt：构建日志；changes.diff：相对于本轮开始备份的差异。

APK：D:/projects-test/paneflow-public/release/stage-0.8.0/PaneFlow-Android-0.8.0.apk。
校验值：同目录 SHA256SUMS.txt。安装包为本地 debug 签名构建，未发布至 GitHub。
