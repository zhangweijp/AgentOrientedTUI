# Core 的身份域、保留额度与永久关闭

本合同适用于一个 Snapshot Core、一个持有 View 与 App/ViewType Tool 注册的 Registry 及其实际 owner。它约束受管理集合和指定逻辑字节，不代表整个进程的 RSS 恒定，也不限制调用者或业务 handler 自己持有的对象。Producer/Host 通过 `@aotui/runtime/core` 使用正式低层合同；可消费的入口与完整装配示例见 [Core 公共入口](core-public-entry.md)。

## 单次 App 运行的 Snapshot Core

`createSnapshotCore({ appId, instanceId, ...options })` 捕获非空的身份字符串和可选额度。构造后，`readAppIdentity(appId)` 返回活动身份，`readLatest(appId)` 在第一次有效发布前返回 `unready`。读取其他 App 时分别返回 `absent` 和 `unready`。观察与调用只接受绑定到该活动实例的交互。

下表配置缺省即硬上限，每项可设置为 0 至该上限的安全整数。单次 Draft 的九项 `options.limits` 在创建时独立捕获，history 和 lease 使用各自的配置。 [单次 Draft 限额](core-public-entry.md#snapshot-limits)

| 字段 | 缺省及硬上限 | 单位 |
| --- | ---: | --- |
| maxIdentityBytes | 8 MiB | 此次运行的 appId 与 instanceId 的 UTF-8 字节总和 |
| maxCurrentBytes | 32 MiB | 当前快照对应的完整已接受 Draft canonical JSON 字节 |

构造时的身份总字节超限会抛出 `SNAPSHOT_CAPACITY`。同名 App 再次运行时，可信 Host 分配新的 instanceId，并创建新的 Core。

current 预算失败沿用原 commit 次序：消费本次 producerSeq、进入 degraded、保留旧 revision/lastGood 和旧 Ref 内容。相同语义的 unchanged 沿用原 entry 的字节费用，即使新尝试的序号更长。当前快照不会被暗中驱逐，活 lease 也不会被额度强制取消。

当前快照被替换或实例停止时，仍有合法 lease 的旧快照进入 history。没有持有人的旧快照立即删除。最后一个 lease 显式释放后立即清理，时限 lease 在原有读／检查清理中识别过期后退出。新 current、degraded 的 lastGood、已采用观察、观察准备或在途调用所需的数据按各自持有人保留。

`lifecycle.stop()` 撤销新发布和观察，并把仍有持有人的当前快照移入 history。停止时保留的历史可以暂时超出 history 额度，直到持有人释放。运行时新的发布必须同时满足单份 Draft、current 与发布后 history 的额度。

Core 输出和保存的 Issue 中，message/path 各不超过 512 UTF-8 字节。过长使用完整 Unicode 码点组成的前缀和“…”表示，后缀也计费。短诊断保持原样。trusted prepare-failure 被无效 JS 调用传入非字符串或超过 64 字节的 code 时，归一为 SNAPSHOT_INVALID。diagnosticBytes 是当前诊断的 code/message/path 字节之和。成功、unchanged、stop 清除相应费用。

`store.inspect()` 返回独立冻结值，包含 state、currentSnapshots、currentBytes、historicalSnapshots、historicalBytes、activeLeases 和 diagnosticBytes。

## 永久 dispose 与 lease

可信 owner 在在途责任结算后调用 `lifecycle.dispose()`。它同步且幂等，永久清除绑定身份、快照、诊断和 lease。dispose 后的行为如下。

- accept/reportPrepareFailure 直接返回 APP_STOPPED。
- readLatest 返回 stopped，readAppIdentity 返回 absent；旧 Snapshot/Ref/Tool 查找返回 SNAPSHOT_EXPIRED。
- inspect 为 disposed，所有数字为 0；dispose、关闭后的 inspect/stop/旧 lease.release 不读取 clock，即使 clock 已失败也能清理。

lease 使用内部 opaque object token，释放函数在首次调用时清除其 lease Map 和结算回调引用；释放不读取 clock，重复释放幂等。调用者已经得到的 `lease.snapshot` 或其他不可变 Snapshot 值仍可由调用者持有，不会被 Core 改写；这部分外部保留不属于 Core 的清理保证。

## View 挂载与 ViewType Tool Registry 额度

`createViewOwnedTools(appId, appInstanceId, limits?)` 保留原二参调用，第三参数仅接受 maxViews、maxBindings、maxRetainedBytes，未知项拒绝。数值规则同上，创建时捕获。

| 字段 | 缺省及硬上限 |
| --- | ---: |
| maxViews | 1,000 |
| maxBindings | 10,000 |
| maxRetainedBytes | 32 MiB |

Views 按实际 mounted 实例计数，bindings 按 App/ViewType Tool 的注册计数；同类型多个 View 不复制注册。retainedBytes 保留 Registry identity、活动 View、类型声明和 activation 的既有逻辑计费；类型声明的 declarationBytes 及活动身份费用不能因旧实例 Tool 退出而免除。闭包捕获的业务对象和调用者已取得的输出不属于这份 JSON 账。

maxViews/maxBindings 为 0 允许构造，但相应新增活动会被拒绝。maxRetainedBytes=0 是合法额度值，但不能容纳必需的基础 identity，因此构造以 VIEW_CAPACITY 拒绝。挂载超限为 VIEW_CAPACITY，注册超限为 TOOL_CAPACITY；失败不消费新的 View/activation 身份，旧注册保持。Core 没有原地启停 API：条件能力通过 release 当前类型注册后重新注册表达，取得新 activation，旧观察不能重新绑定。release/unmount 按实际归属归还活动费用；关闭一个 View 不撤销其他匹配 View 仍需的类型能力。cleanup 以类型注册 token 或 View 实例身份识别所属项，旧 cleanup 不删除后继 owner。

`inspect()` 返回冻结的 state/views/bindings/retainedBytes。`dispose()` 同步、幂等、永久清空活动 Map、费用和自有身份字符串。之后 mount/registerTypeTool 抛 VIEW_REGISTRY_CLOSED，lists 为冻结空数组。保留的 validateTypeToolBinding/invokeTypeTool 在读取调用输入前拒绝旧 activation；invoke 保持 not-entered 的失败终态。旧实例 Tool 的专属 validate/invoke/create 入口退出，不为它们保留兼容分支。关闭前已进入 handler 的 Promise 继续返回原业务成功、业务失败或异常语义，不会被改造成取消。

## 实际 owner 与下一身份域

`createAppInteraction()` 的 owner 先同步撤销 authority，再停止接收新调用，并等待已经接纳的 project、验证、授权、执行以及 `invoke()` 返回结果前的读取授权进入清理完成。关闭不能丢弃 authority 对象来伪造在途归零；拥有它的层随后才 dispose 自己的 Core 与 Registry。Worker、App 和 Desktop 的顺序见 [Worker 生命周期](worker-lifecycle.md) 与 [Runtime 关闭报告](runtime-shutdown.md)。

AppKernel 保留 C2 同步 closing 门禁及 open/delete 等待，在 renderer unmount 结算后的独立清理阶段 dispose 自有 Registry。同步 throw、异步 reject 也会执行其余清理。该接入不改变 B2 flush→unmount→存储 dispose 的顺序。

dispose 不能 reset。新 Core/Registry 是新的可信身份域：装配者必须使用其授权范围内从未复用的 AppInstance ID，新的实例交互必须使用新的 namespace。默认 Host 的 randomUUID 和 host:instanceId 保持。旧交互句柄永不转到继任实例；旧序列化请求也不能授权新 handler。刻意同时重用身份和 namespace 会制造来源碰撞，属于违反可信装配前提的负对照，不能用来说明合法装配的行为。

本阶段不证明公共无 DOM 包入口、独立 tarball 分发、任意数量 Runtime 的总 RSS、跨进程身份服务或产品 p95/RSS 预算。这些事项仍需后续工单的独立证据。
