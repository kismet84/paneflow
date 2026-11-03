# 任务目标完成提醒验证 — 2026-11-03

## 行为
- 删除 running/waiting → idle 的完成通知：单轮结束不是整个任务完成。
- 删除队列 completed 的完成通知：队列项目前依据单轮结果收尾，不能作为整个目标完成证据。
- 仅处理 goalStateKnown=true 且 goalStatus 为有效目标状态的数据。
- 已观察的非完成目标状态 → complete 才提醒；首次看见已完成历史目标不提醒。
- 目标状态按电脑和会话加密保存；重复快照及服务重启去重。未知目标状态不覆盖已知状态。
- 完成后明确恢复为未完成目标，再次完成可再次提醒。
- 保留待审批和失败提醒；应用前台不发系统完成通知。后台连接及“任务目标完成”开关须开启。
- 无目标状态的普通会话不推测完成。目标变化取决于电脑提供的快照；不依据文本“已完成”或静默时长判断。
- 为优先避免重复，先持久化再通知；落盘失败或落盘后进程异常可能漏报，不承诺必达。

## 验证
- assembleDebug 和 testDebugUnitTest 成功，16 项测试通过，含4项新增目标完成边界测试。
- git diff --check 通过。
- MatePad Pro WEB-W00 同签名覆盖安装成功，保留平板UI及绑定。
- 真机设置：后台保持连接、任务目标完成、待审批提醒均已开启；NativeMessagingService isForeground=true。
- 后续已完成真实模型两阶段验收：小轮结束无提醒；真实目标完成后约8.2秒收到系统通知；点击进入对应聊天；重复同步和APP重启不重发。全过程未锁屏。详见本地 outputs/completion-live/VALIDATION.md。

APK：outputs/matepad/PaneFlow-Android-0.8.0-task-completion.apk
SHA256：eb44c979d7d872cf3e0e926359b0c1119233b3d112991af7163330977d82ce72

## 通用包发布

上述本地构建已合并到2026-11-03通用增量，手机和平板使用同一个APK；见 README 最新下载入口。最终 APK SHA256：`eb44c979d7d872cf3e0e926359b0c1119233b3d112991af7163330977d82ce72`。
