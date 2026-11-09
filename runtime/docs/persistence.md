# 实例持久化装配（experimental，state-session-v1）

Core StateSession 管理 JSON 捕获、精确地址、恢复收据、修订、有限 flush、clear、seal 和 dispose；不依赖 Node、DOM、Preact 或 Worker。只读 StateBinding.inspect 派生已有事实，旧代次只得到 STALE_BINDING/DISPOSED，不订阅、不排队、不保存第二份错误历史。

Worker 为实际 Host 分配的 AppInstanceId 创建一个 A 会话，提供只含 bind/flush 的 AppStatePersistence 给 AppKernel，再传到 SDK 上下文。它持窄 StateStorage 代理，不持路径或文件系统。代理只统计待决 IPC；Host 另行监督真实后端访问。

Host 使用模块内共享的 createNodeStateStorage backend，构造无 I/O；也可通过 AppWorkerHostConfig.persistenceBackend 注入已构造的同合同 backend。需要互斥的 Hosts 应共享它。多个 backend、物理 Runtime 副本、进程及旧 SDK 的外部直接访问不受同一张所有权表保证。

根路径从已合并 launchConfig.AOTUI_DATA_DIR 捕获，不能由存储请求提供。非空字符串按 Host 构造时 cwd 解析并追加 app-state；无配置/空字符串为 `~/.aotui/app-state`。Desktop Manager 已注入的 `~/.aotui/data` 保持对应 `~/.aotui/data/app-state`。非字符串或 NUL 明确拒绝。SDK 不读取 process.env 来选另一个根；业务 namespace 为 JSON.stringify([desktopId, appKey])。历史合法名称原样映射，非法或不可安全表示的名称不清洗，不自动迁移。

INIT 独立提供协议版本、实例和有限预算。Worker 只接受同时声明 `persistenceSupport: 'state-session-v1'` 与 `appLifecycleSupport: 'app-lifecycle-v2'` 的正式 SDK 工厂，校验 Host offers 后返回 ACK；Host 校验 ACK 的协议和实例。工厂标记、offer 或 ACK 缺失或非法时拒绝初始化，不提供旧 SDK fallback。持久化标记不会扩展或授予当前 `view-type-parameters-v1` Worker interaction mode。一个 Host 只初始化一次，物理 Worker 正常 RESET 后必须换新 Host/实例。

STATE_STORAGE_REQUEST/RESPONSE 使用 version=1、instanceId、单调 sequence、action。read/replace/remove 接受精确 address，replace 另含 text，release 不带正文/地址。自有数据属性、精确字段、预算、实例、Desktop 和高水位在 I/O 前验证；release 有独立监督资格，不占普通请求槽。回复匹配实例/序号/action；畸形修改回执不能 applied。明确发送前拒绝是 failed/effects:none；已发送但结果不能确认的修改为 unknown，迟到回执不会升级成成功。既有风险阻止新请求时，新请求仍属于已知未进入，而非假装其已写过。

记录正文只接受精确的 `{ version: 1, updatedAt: <finite number>, value: <JSON> }` 外壳。裸 JSON、未知版本、缺项或额外字段在恢复时报告 `UNSUPPORTED_FORMAT` 并保持原文本；不会自动迁移、覆盖或删除旧记录。确认不再需要旧内容后，应用可显式 clear。解包只进行一层，因此业务对象自己的 `value` 字段保持原样。

Host 在首次合法访问时才 open，同一实例共享一次 opening Promise。接纳与正文计数同步登记，再 await open/实际 I/O；release/失联先关准入，等待已接纳访问与 late owner 实际结束后释放。未使用持久化的 managed 应用启动/关闭均为零存储 I/O。open 失败时未进入目标的修改是 failed/none。IPC 超时不移除真实 I/O；不确定 namespace 和 Node adapter 资源保留规则继续生效。

| 默认会话拒绝上限 | 数值 |
| --- | --- |
| maxKeys / maxDepth / maxNodes | 128 / 32 / 16384 |
| maxValueBytes / maxRecordBytes / maxAddressBytes | 262144 / 262272 / 1024 |
| maxRetainedBytes | 8388608 |
| maxPendingRequests / maxConcurrentRequests | 128 / 4 |
| maxRevision | Number.MAX_SAFE_INTEGER |

| 默认 Node 后端拒绝上限 | 数值 |
| --- | --- |
| maxActiveOwners / maxRoots / maxClaimedNamespaces | 64 / 16 / 512 |
| maxPendingRequests | 256 |
| maxRecordBytes / maxAddressBytes | 262272 / 1024 |
| maxPathBytes / maxSegmentBytes / maxDirectoryEntries | 4096 / 128 / 4096 |
| maxBufferedBytes | 16777216 |

传输每实例最多 16 个普通 pending，sequence 至 MAX_SAFE_INTEGER 不回绕；逻辑 UTF-8 封套最多 265344 字节（262272 正文＋1024 地址＋2048 元数据），不是额外 JSON 转义后的长度或实际堆大小。Host timeout 必须为 1–300000 ms 安全整数。小预算构造只供精确边界测试；这些是工程拒绝上限，不是产品延迟/RSS/磁盘总量 SLA，不保证所有上限同时可达。

App 端口 flush 同步共享 Promise，下一微任务才进入 Core 快照。APP_SHUTDOWN 同步 seal，等待既有手工 batch；成功再取最终快照，没有既有 batch 时只一次最终保存。失败批次不暗中整批重试，应用可在开放期显式修复、更新并主动保存检查。APP_CLOSE 随后独立尝试 unmount，始终 dispose 并等实际 release。初始提交失败不保存部分默认值。失败/unknown/未结束资源均不允许 healthy RESET/pool；旧异步回调绑定原记录，不访问继任 app。activeFileReplacements 与既有 Tool 传输不确定保护保持。

`AppWorkerHost.getPersistenceReport()` 是有限只读快照：

- support：offered / managed / rejected，为实际协商事实。
- unsafe：Host 已识别不可健康复用的持久化/关闭风险，后续真实 release 不会将其抹掉。
- pending、actualIO：当前已接纳、尚未真正结束的后端访问数量（含等待 open）；opening 为真实 opening Promise 是否未完成。它们不是代理 IPC 数量或逐 syscall 数量。
- bufferedBytes：上述访问持有的请求正文逻辑字节；ownerRetained 表示已得到而尚未确认释放的实际 owner；opening 时另有打开中的归属。
- highWater、closing、uncertain：当前序号/准入和 Host 已见结果不确定事实。Worker 丢回执导致的 unknown 也可能只体现在 lifecycle 与 unsafe，不能只看 backend uncertain。
- release：Host 末次真实释放收据；lifecycle：经有限捕获的末次 Worker flush/dispose/unmount 报告。最多本实例 128 条条目，不保留业务正文或无限事件史。没有报告表示尚无该事实，不能按缺失判成功。

完整 Manager/Desktop/Kernel CloseReport、全局 drain/期限策略为 W08-C；无 DOM Producer、tarball 与总资源为 W09。本批没有跨进程锁、硬掉电 fsync、任意外部并发写入、完整 IDE/LSP 或跨平台保证。SDK 使用与迁移见 [SDK 持久化](../../sdk/docs/persistence.md)。

F01 补充：AppStatePersistence.captureValue(unknown) 是同步纯捕获，直接复用 A 的 captureStateValue 与本实例同一份已捕获预算；不 bind、不分配会话 entry/队列、不进行 I/O，也不保存输入/输出。pending setter 在当刻调用它，只暂存一个独立不可变 JSON 快照或失败标志；后续对象修改不能改变快照或掩盖失败。用户 T 不被冻结。bind 后快照交 update，预绑定捕获/预算拒绝交既有 reportUpdateFailure，诊断为 SERIALIZATION_FAILED；已绑定 update 直接捕获一次，其 CAPACITY_EXCEEDED 等准确预算诊断保持。纯捕获在 dispose 后仍是纯操作，不能恢复绑定权限。
