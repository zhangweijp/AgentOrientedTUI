# Core 的身份域、保留额度与永久关闭

本合同适用于一个 Snapshot Core、一个 View-owned Registry 及其实际 owner。它约束受管理集合和指定逻辑字节，不代表整个进程的 RSS 恒定，也不限制调用者或业务 handler 自己持有的对象。本阶段使用现有内部模块；公共子路径和 Producer 接入由后续工单定义。

## Snapshot 额度

`createSnapshotCore(options)` 按值捕获以下新额度。缺省即硬上限，可下调到 0；必须是范围内的安全整数。0 表示不允许该类新保留，不能通过设置更大的数字绕过硬上限。原 history、lease、单 Draft 配置保持原语义。

| 字段 | 缺省及硬上限 | 单位 |
| --- | ---: | --- |
| maxAppRecords | 1,024 | App Map 条目，包含 stopped |
| maxInstanceIds | 65,536 | 本 Core 已发行的不同 instanceId，包含已停止的身份 |
| maxIdentityBytes | 8 MiB | 每个不同 appId 的 UTF-8 字节一次，加每个已发行 instanceId 的 UTF-8 字节一次 |
| maxCurrentBytes | 32 MiB | 所有当前 SnapshotEntry 的完整已接受 Draft canonical JSON 字节 |

身份额度在撤销旧 current 或消费新身份之前预检。失败抛带 `code='SNAPSHOT_CAPACITY'` 的 Error，旧来源保持；相同活动身份即使满额仍幂等。停止 App 或历史 TTL 到期均不删除已发行身份。这样才能防止旧请求因身份重用而重新获得权限。

current 预算失败沿用原 commit 次序：消费本次 producerSeq、进入 degraded、保留旧 revision/lastGood 和旧 Ref 内容。相同语义的 unchanged 沿用原 entry 的字节费用，即使新尝试的序号更长。当前快照不会被暗中驱逐，活 lease 也不会被额度强制取消。

stop 或换身份会把当前费用移入 history。活 lease 可能让历史暂时超出 history 额度，但迁移本身不增加总字节；新的发布同时满足 current 与原 history 预算。默认 current+history 逻辑预算为 64 MiB，此数值不能套用于任意自定义 history/单 Draft 配置。

Core 输出和保存的 Issue 中，message/path 各不超过 512 UTF-8 字节；过长使用完整 Unicode 码点组成的前缀和“…”表示，后缀也计费。短诊断保持原样。trusted prepare-failure 被无效 JS 调用传入非字符串或超过 64 字节的 code 时，归一为 SNAPSHOT_INVALID。diagnosticBytes 是当前各 App.issue 的 code/message/path 字节之和；成功、unchanged、stop 清除相应费用。

`store.inspect()` 返回独立冻结值：原 activeApps/currentSnapshots/historicalSnapshots/historicalBytes/activeLeases，以及 state、appRecords、issuedInstanceIds、identityBytes、currentBytes、diagnosticBytes。诊断、身份和快照是分别计量的保留数据。

## 永久 dispose 与 lease

只有可信 owner 的 `lifecycle.dispose()` 有销毁权，只读 store 没有该方法。它同步且幂等，永久清空 apps、已发行身份、entries 和 lease Maps。dispose 后：

- startApp 在读取输入之前抛 SNAPSHOT_CORE_CLOSED；accept/reportPrepareFailure 不读取输入，返回 APP_STOPPED。
- readLatest 返回 stopped，readAppIdentity 返回 absent；旧 Snapshot/Ref/Tool 查找返回 SNAPSHOT_EXPIRED。
- inspect 为 disposed，所有数字为 0；dispose、关闭后的 inspect/stop/旧 lease.release 不读取 clock，即使 clock 已失败也能清理。

lease 使用内部 opaque object token，释放函数只捕获 lease Map/token。调用者已经得到的 `lease.snapshot` 或其他不可变 Snapshot 值仍可由调用者持有，不会被 Core 改写；这部分外部保留不属于 Core 的清理保证。

## View-owned Registry 额度

`createViewOwnedTools(appId, appInstanceId, limits?)` 保留原二参调用，第三参数仅接受 maxViews、maxBindings、maxRetainedBytes，未知项拒绝。数值规则同上，创建时捕获。

| 字段 | 缺省及硬上限 |
| --- | ---: |
| maxViews | 1,000 |
| maxBindings | 10,000 |
| maxRetainedBytes | 32 MiB |

Views 按实际 mounted 实例计数，bindings 按实际注册计数；每个注册 binding 都会出现在当前 Tool 投影中，它们不等于 Snapshot 聚合后的 Tool definition 数。retainedBytes 等于 canonical JSON({appId,appInstanceId}) 一次，加每个活动 ViewInstance 的 canonical JSON 字节，加每个活动 binding 的既有 canonical ToolSpec 字节。相同声明在不同 binding 中分别收费。闭包捕获的业务对象和调用者已取得的输出不属于这份 JSON 账。

maxViews/maxBindings 为 0 允许构造，但相应新增活动会被拒绝。maxRetainedBytes=0 是合法额度值，但不能容纳必需的基础 identity，因此构造以 VIEW_CAPACITY 拒绝。挂载超限为 VIEW_CAPACITY，注册超限为 TOOL_CAPACITY；失败发生在消费 sequence/bindingVersion 前，旧注册保持。Core 没有原地启停 API：条件能力通过 release 当前 binding 后重新注册表达；重新注册取得新的 bindingVersion，使旧观察失效。release/unmount 实时归还活动费用。cleanup 仅以 View 身份、工具名和注册 token 识别所属项，旧 cleanup 不会删除同名后继 binding。

`inspect()` 返回冻结的 state/views/bindings/retainedBytes。`dispose()` 同步、幂等、永久清空活动 Map、费用和自有身份字符串。之后 mount/registerTool 抛 VIEW_REGISTRY_CLOSED，lists 为冻结空数组。六类 validate/invoke 在读取调用输入前按原结构拒绝：generic/validate 为 VIEW_INSTANCE_REVOKED；safe 普通/Ref 为 not-entered+失败 result；create 为 not-entered+rejected。关闭前已进入 handler 的 Promise 继续返回原业务成功、业务失败或异常语义，不会被改造成取消。

## 实际 owner 与下一身份域

`createScopedInteraction()` 的 owner 先同步撤销 authority，再停止接收新调用，并等待已经接纳的 project、验证、授权、执行、回执读取和实际 `OperationProvider.query` 进入清理完成。关闭不能丢弃 authority 对象来伪造在途归零；拥有它的层随后才 dispose 自己的 Core 与 Registry。Worker、App 和 Desktop 的顺序见 [Worker 生命周期](worker-lifecycle.md) 与 [Runtime 关闭报告](runtime-shutdown.md)。

AppKernel 保留 C2 同步 closing 门禁及 open/delete 等待，在 renderer unmount 结算后的独立清理阶段 dispose 自有 Registry。同步 throw、异步 reject 也会执行其余清理。该接入不改变 B2 flush→unmount→存储 dispose 的顺序。

dispose 不能 reset。新 Core/Registry 是新的可信身份域：装配者必须使用其授权范围内从未复用的 AppInstance ID，新 Scoped authority 必须使用新的 namespace。默认 Host 的 randomUUID 和 host:instanceId 保持。旧 Client 永不转到新 Client；旧序列化请求也不能授权新 handler。刻意同时重用身份和 namespace 会制造来源碰撞，属于违反可信装配前提的负对照，不能用来说明合法装配的行为。

本阶段不证明公共无 DOM 包入口、独立 tarball 分发、任意数量 Runtime 的总 RSS、跨进程身份服务或产品 p95/RSS 预算。这些事项仍需后续工单的独立证据。
