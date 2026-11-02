# 活动状态修正与用量管理（0.8.0 本地增量）

> 最终界面已按后续要求移除 Token 和费用展示，仅保留账户额度、剩余比例与重置时间；以下验证记录按实施阶段保留。参见 [UI 精简](UI-CLEANUP.md)。

## 用户可见变化

- 手机设置新增「用量管理」，按当前电脑查询 Codex 账户额度窗口、Token 汇总和接口可提供的当前会话估算费用。
- 额度窗口显示已用、剩余与重置时间；缺失数据不显示成零；离线显示缓存和最后读取时间。
- 不同电脑可能共用一个账户，不能直接相加。费用仅为接口估算，不是账单。
- 外部 Codex 会话的实时状态不再把 `notLoaded` 当空闲；无法核实时显示「状态待确认」。目标实施状态仍与实时轮次状态分开。
- 只读会话继续保留历史、附件读取、复制和草稿；不开放发送、停止、审批或模型修改。

## 状态依据与边界

独立 app-server 的 `thread/turns/list` 可能在外部 writer 仍运行时返回 `interrupted` 或 `completed`，不能独立证明空闲。本机 Windows 使用 app-server 提供的路径，验证真实路径位于 CODEX_HOME/sessions 且文件名匹配线程 ID，最多读取末尾 512 KiB：

- 最新完整 task_started 且只读锁探测返回 EBUSY：运行中。
- 最新完整 task_complete / turn_aborted：已结束。
- 缺失开始/结束证据、部分写入尾行、无法读取、已无活动 writer：状态待确认。

只读取锁，不获取、删除或覆盖外部锁。该状态仅用于展示，不赋予跨进程控制权。缓存约 5 秒，随列表刷新更新；有磁盘与网络延迟，不承诺逐 Token 或精确秒级同步。记录格式不兼容、归档路径或非 Windows 环境可能显示待确认。

## 协议

新增 usageSummary 能力、usage.get 只读命令和 usage.snapshot 事件。查询受已认证设备与当前会话检查，返回前再次校验授权，仅向请求设备返回白名单字段。账户原始身份和上游错误不透传。客户端请求不进入副作用重发记录，按请求 ID 匹配响应；缓存按电脑隔离。

## 验证（2026-11-02）

- 18 个远程测试文件、130 项测试通过，含未知状态、外部历史伪中断、本地生命周期、失败后完成、缺失用量与鉴权。
- 完整构建与 Android 构建通过；Windows 打包冒烟 2 项通过。
- OPPO K10：5 项用量/只读/打开回执 instrumentation 测试通过。
- 真实独立 Codex 测试会话：运行时历史 API 返回 interrupted，本地记录为 started 且锁 EBUSY；手机显示 running。完成后本地记录为 complete、锁消失，手机显示 idle。
- 公网原绑定读取用量成功：实际 Token 汇总可读；额度窗口本次在部署实例暂不可用，显示明确提示。接口可用性会随请求变化。
- OPPO 公网主动断线后自动认证重连通过，无需重新配对；重连后再次查询用量收到有效响应。
- Windows 配套程序与 APK 已更新，域名、身份、配对、自启配置保留；无锁屏操作。

详细本地证据位于 outputs/status-usage/，包括 tests.log、build-final.log、packaged-tests-final.log、device-tests.log、live-device-final.log、live-device-completed.log、observer-final-running.json、observer-final-ended.json、deployment.json 与 usage-phone.png。输出包含本地路径和账户用量，不作为公开发布附件。

代码尚未提交或推送；GitHub v0.8.0 Release 未修改。

## 额度读取修复补充（2026-11-02 晚间）

已确认此前部署端额度不可用的直接原因：account/rateLimits/read 必须省略 params（或 null），代码传入 {} 被 RuntimeProtocolValidator 拒绝。现改为 undefined，并用真实协议校验器验证完整用量查询路径。

手机额度卡片突出显示窗口类型、剩余百分比、已用百分比与重置时间；支持将 300 分钟显示为 5 小时额度、10080 分钟显示为每周额度。只展示接口实际返回的窗口，不虚构缺失额度。

本次 19 文件共135测试通过，Android额度UI测试2项、严格真实额度测试1项、Windows打包冒烟2项通过。OPPO原公网绑定成功返回每周额度比例与重置时间，现场截图 outputs/quota-fix/quota-phone.png，日志 outputs/quota-fix/live-quota.log。全程未锁屏。

部署前以 Windows Restart Manager 只读查询全部 writer lock 归属，并核对自有 app-server PID与开始时间、实际全局队列文件不存在；所有外部writer属于其他Codex进程，未触碰。验证自有 app-server已退出后才替换程序。原身份、隧道、配置哈希与自启保持不变，详细备份及校验在 outputs/quota-fix/。未提交、推送或修改公开Release。
