# Wave 2A — 现有只读 View Tool 的限定执行合同

范围仅为 `AppWorkerHost.executeReadOnlyViewTool` → Core `acquireToolSource` → Worker `VIEW_TOOL_INVOKE` → AppKernel `invokeBoundReadOnlyTool` → View-owned Registry → SDK Handler。没有第二套执行器、Snapshot Store、公开身份或 IPC Schema。默认实验开关保持关闭；Shadow 保持 unverified / strictEligible:false。

## 固定一次调用

入口先检查实验开关、Shadow 与 Host running 状态；不满足时返回 TOOL_UNAVAILABLE，不读取 caller 请求。启用时要求根对象恰好具有 snapshotId/toolId/viewId/args 四个 JSON 数据属性，三个 selector 是非空字符串，args 是普通 JSON 对象。

在来源选择、授权或 Worker await 之前，对**完整外部请求只复制一次**，复用 `copyJson`。之后来源、授权、派发只使用首次复制的值，不再次读取外部 request。普通对象 getter、隐藏/symbol 属性、class、Date/Map、循环、函数、非有限数字、数组根、无效 selector、额外根字段等拒绝为 OPERATION_INVALID_ARGS。

| 预算 | 保留/新增的明确限制 |
| --- | --- |
| 原 args 子树 | maxDepth 24、maxNodes 10000、maxApproxBytes 128 KiB，全部保持原值 |
| 完整请求 | maxDepth 25、maxNodes 10004、maxApproxBytes 136 KiB；外层对象和三个 selector 另占深度/节点/字节 |

为了精确保留原 args 边界，用同一 codec **在已冻结副本上**再检查原 args 预算。第二次校验生成的副本不参与执行，也不读取 caller；实际派发始终使用首次完整副本中的 args。这样不用扩展 JSON codec 或放宽 args 额度。精确边界、超一节点/深度/UTF-8 字节的用例已运行。

JSON 反射可能执行 Proxy trap；抛异常时会转为确定性输入失败，但不能阻止 trap 的副作用或同步死循环。此处不是恶意 JavaScript 沙箱。

## 来源、授权、再复核

1. 来源只能来自 Host 当前可信 Core Store。必须是可 acquire 的已提交 V2，不接受 caller Tool JSON。
2. latest App 必须 ready，AppInstance 必须匹配；历史来源里的 Tool 必须包含该确切 viewId/内部 viewInstanceId/bindingVersion。
3. 当前 View 仍必须是原挂载实例；当前 Tool 必须存在，bindingVersion 与公开的 name/description/inputSchema/isMutating 等合同一致。没有同名 View/Ref 后缀回退，也不按 ViewType 随意挑 Handler。
4. 只读入口拒绝 source.isMutating。Controller 是显式传入的可信授权函数；**只有字面值 true 放行**。1、字符串、对象、null、undefined 均拒绝。
5. 授权 scope 本身和 args 在 Host 内冻结。scope 的 snapshotId/toolId/viewId/viewInstanceId 来自原来源，args 来自固定请求。Snapshot 可用、View 身份或 isMutating:false 都不是角色/业务资源授权；Controller 仍须检查参数涉及的业务权限。
6. 授权 await 后先检查 Host 仍 running，再用**同一个 sourceRequest**重新 acquire 来源。不能用 caller 替换后的最新 Snapshot 洗白旧调用。
7. 临时复核 lease 立即释放；原 selection 在成功、业务失败、拒绝或异常结束时 finally 释放。失败的来源获取由 Core 自身清理；release 幂等。

无关展示/Ref 内容更新、另一个 View 的挂卸载，不自动使仍匹配的目标 Tool 失效。重挂载同名 View、移除/禁用/重新注册、Schema/公开合同或 binding 改变会拒绝旧观察。SDK enabled:false 的当前实现会 cleanup/unregister，重新启用得到新 binding。

## TTL 与 lease 的实际含义

保持现有 Store 规则，不将 pin 当永久权限：默认历史保留 10 分钟，从 retiredAt 起算；默认单次 lease TTL 60 秒。当前 Snapshot 没有仅因 capturedAt 变旧而自动到期的规则。

已 pin 的历史条目在保留期结束后可能仍可 getById 读取，但**不能重新 acquire 为执行来源**。授权后复核必须重新 acquire，不能只看原 selection 对象是否仍存在。

单个 lease 到期不等于仍为 current 的 Snapshot 到期；若当前状态和身份/Tool 合同仍满足要求，可以重新 acquire 新 lease。纯 Core 测试分别验证了这两种情形，没有改变过期语义或容量策略。测试使用现有 Core 的受控 clock，不使用 sleep。

TTL 检查是 Host 派发前的来源检查，不是 Worker 队列/Handler 执行的原子截止时间。派发后不提供 TTL 取消或跨 Host/Worker 的原子提交保证，不能升级成 Strict。

## Worker 活态检查与结果

Worker 仍要求独立只读 opt-in、Shadow、当前 AppInstance 和 AppKernel 匹配。AppKernel 和 Registry 再检查当前只读声明、具体挂载实例、启用状态、bindingVersion 和 Schema，然后执行该 View 的注册 Handler。故即使 Host 漏收较新 PREPARED，旧观察也不能命中新注册或重挂载实例。

SDK 保留原参数验证：不符合声明的参数在用户 Handler 前返回 E_INVALID_ARGS；没有新增第二套 Schema 引擎，也未收紧 SDK 对未声明 args 字段的既有规则。Handler 返回 success:false 时保持业务失败，即使 OPERATION_RESPONSE 的 transport success:true。真实测试检查了两个层次的值。

Host scope.args 与发送的 args 是同一冻结对象；跨 Worker structured clone 后保证初始 JSON **值一致**，不宣称冻结属性跨 IPC 保留，也不限制可信 Handler 修改自己的本地参数副本。

viewId 是可读地址，viewInstanceId 是真实挂载身份，bindingVersion 是注册版本。R1 lifecycleContextVersion 仍仅保护 Host 生命周期旧 continuation，没有进入本合同的公开身份。

同一注册内部的 SDK stable wrapper 会读取最新 handlerRef；本批保证的是 View/注册绑定，不冻结闭包状态、任意业务数据或未通知的内部突变。重新注册/声明变化与普通 rerender 的边界沿用当前 Hook 实现。

## Ref 参数与不支持的语义

本入口没有通用的 source-bound Ref 参数解码/授权合同。SDK reference 参数目前只验证字符串/对象形态；在此链路上它们是普通 caller JSON，不能当作 Runtime 已解析、已授权的实体。

真实双 View 测试在两个 View 都注册名为 file 的 Ref 后，更新 Ref-only 数据，再传 `[File B](file)`；A Handler 仍收到原字符串，不解析为 B 或最新同名对象。本批不调用 Legacy 的最新 indexMap Ref resolver，不新增 Ref Codec。需要真正源绑定 Ref 语义的应用必须等待单独接口合同，不能依靠该字符串或 caller 对象获得资源权限。

## 确定性失败与生命周期边界

| 阶段 | 结果 |
| --- | --- |
| 未 opt-in / Shadow 关闭 / 入场非 running | TOOL_UNAVAILABLE |
| 非法请求、访问器、非 JSON、预算超出 | OPERATION_INVALID_ARGS |
| 普通来源拒绝 | 保留 Core 的 SNAPSHOT_EXPIRED / SNAPSHOT_UNREADY / APP_INSTANCE_MISMATCH / TOOL_UNAVAILABLE / VIEW_INSTANCE_REVOKED / TOOL_SOURCE_STALE 等明确 issue code |
| mutating 声明或非 true 授权 | TOOL_PERMISSION_DENIED |
| 授权结束前 App close/error/RESET | APP_STOPPED，不向 Worker 发送该 Tool 调用 |
| 初次来源选择 throw，或授权/派发异常 | VIEW_TOOL_DISPATCH_FAILED，固定错误信息，不读取任意 throw 值的 message |
| SDK 参数或业务执行失败 | 保持现有 E_INVALID_ARGS / Handler OperationResult，不转成业务成功 |

RESET 后归还物理 Worker 需要新 Host/AppInstance；旧 Snapshot 在新 Store 不可用或实例不匹配。实验能力默认值不继承。Legacy 五参数 Hook 与默认 Agent 路由均未改动。

Handler 已开始后，关闭/错误不构成回滚或“从未执行”的证明；IPC 失败也不证明 Handler 未运行。本批不自动重试、不承诺 exactly-once、取消或持久化。isMutating:false 是开发者声明，不是 OS 文件权限或沙箱；Worker/SDK 的可信应用代码和既有 Handler 异常映射没有被改造成恶意代码隔离器。

本合同只支撑 Wave 2A 限定交付；完整 M4、Strict、默认 Agent 路由切换、可写 Tool、文件 CAS 和后续批次均不在本批批准范围。
