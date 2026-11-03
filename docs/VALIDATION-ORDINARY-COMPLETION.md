# 普通任务完成提醒修复验证

日期：2026-11-03。范围：Windows 配套端与 Android 通用 APK，本地部署；未发布 GitHub。

## 原因与规则

此前真实验收使用显式目标，只验证了目标转为 complete。普通聊天 goal=null，因此 GitHub 发布任务结束时没有通知。

新增只读完成证据：本地 Codex sessions 中完整 task_complete 记录且有最终答复。只传根轮次 ID 和完成时间，不传通知正文；工具、commentary、取消及运行态 idle 不能触发。有显式目标时保持原规则。读取完成标记后刷新目标状态，避免目标缓存误判；目标查询失败不推测完成。

Android 按电脑/会话加密持久保存已消费标记，使用电脑 serverTime 建立监听基线，首次历史不补发，主动关闭后台后重建基线。普通任务通知表示最终答复已产出，不等于独立判断业务目标已达成。前台保持原有不发系统通知行为。

## 实测

- Windows 全量 Vitest：54 个文件，350 项通过；相关回归 55 项通过；构建与打包通过。
- Android：17 项单元测试通过，通用 APK 构建及 MatePad Pro 同签名覆盖安装通过。
- MatePad 保持解锁，回到桌面；公网连接，未使用 USB 网络转发。全过程未锁屏。
- 独立普通任务确认 goal=null；先 commentary，再实际执行只读命令等待 20 秒并计算 37×43+89。
- commentary 和命令执行期间仅有后台连接通知；最终答复 1680 后系统收到“任务已完成”，约 4.3 秒后入系统通知列表。
- 后续重复快照没有更新该通知创建/更新时间；点击通知进入该测试聊天，显示算式与结果。
- 强制退出 APP 后重新启动并回桌面，后台服务恢复，完成通知没有重复出现。
- Windows 配套端替换前备份，验证 80 个程序文件；原配对凭据、公网配置、隧道配置哈希和登录计划任务保持一致。未停止外部 Codex 会话。

## 产物与证据

- 本地 APK：outputs/completion-live/PaneFlow-Android-0.8.0-completion-fix.apk
- SHA256：9a2d5d8c37be43557e0bc8d5c21503b050c045f04ac2d02dc4dedafb44d9fb9d
- 忽略目录中的证据：outputs/completion-live/ordinary/、notifications-ordinary-*.txt、deployment.json、tests-fix.log、android-fix.log。
- 公共文档不包含真实会话截图、域名、设备身份或密钥。旧 GitHub APK 尚未包含本修复。

限制：后台连接须开启，系统通知须允许；首次建立基线前的完成不追溯补发。此轮验证为一台 MatePad 真机，未冒称 OPPO 复验。
