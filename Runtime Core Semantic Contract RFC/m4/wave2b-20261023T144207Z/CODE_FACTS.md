# Wave 2B — 当前源码事实

本包是 Ref 参数合同的设计证据。生产实现、Snapshot Schema、公开 SDK API、IPC、默认 Router、实验开关及 Strict 标志均未修改。新增测试断言**当前行为**，没有实现提案解析器。阅读时点的 HEAD 是 `789ef07cb18084d97b0476c1ffc234ae0b9319f0`；工作树已经包含经独立验收的 Stage 8/R1/Wave 2A，不能用 HEAD 单独代表当前源码。起始完整清单见 `baseline-readonly/inventory.json`。

## 逐链路事实

以下位置是当前工作树的行号。`reference` 参数声明与 Ref 数据注册是两条不同的信息流，必须分别追踪。

| 环节 | 真实运行时数据／动作 | reference 类别及 refType 的去向 | 主要源码 |
| --- | --- | --- | --- |
| SDK 参数声明 | `defineParams` 返回原 schema 对象；非 production 下检查部分 type/itemType/enum/constraints | `type:'reference'`、`refType` 如果写了就是运行时属性。`refType?:string` 只是可选 TS 属性，注释“必填”没有实现；未写仍可声明 | `sdk/src/operation/types.ts:82`；`defineParams.ts:6` |
| SDK 类型推断 | `InferArgs` 把 reference 推为 `Record<string,unknown>`，数组 reference 推为 `unknown[]` | 推断只在编译期存在，不能证明对象来源。字符串也能通过实际 validator，不能按 TS 注释假定收到的是已解析对象 | `sdk/src/operation/types.ts:125` |
| SDK Ref 注册 | `useDataRef(refId,data)` 在 layout effect 注册；`RefHandle<T>` 返回 `[label](refId)`、`.id`、`.data` | 泛型 T 会擦除。没有 refType 参数；marker label/字符串不是权威类型。`useEntityRef` 用严格的 `$aotuiEntityRefV1` 数据标记声明 entity 身份/版本 | `sdk/src/hooks/useRef.ts:47`、`:95` |
| View → Runtime Ref Registry | `View.refs.registerRef` 把 viewId/refId/data 交给 exporter；AppKernel 用 `viewId:refId` 保存对象，mutation 通知 projection | 注册接口没有 refType；Registry 保存 live 对象而非已冻结 Snapshot 副本。`useArrayRef` 的类型前缀是额外 refId alias，不是 RefDescriptor.refType | `sdk/src/components/View.tsx:230`；`runtime/src/spi/app/ref-exporter.interface.ts:10`；`AppKernel.ts:430`；`sdk/src/hooks/useArrayRef.ts:93` |
| SDK Tool → AppKernel → Core Registry | View-local Hook 将完整 params 交给 port；AppKernel 调用 `paramsToJsonSchema` 后 `owned.registerTool` | **在转换处丢失**：reference → JSON Schema string；refType 不被复制；array/itemType reference 抛 Unsupported。SDK wrapper 的 paramsRef 仍保留原声明用于运行时形态验证，但它不在 Host 的可信 Snapshot 里 | `sdk/src/hooks/useViewTypeTool.ts:123`、`:181`；`View.tsx:239`；`AppKernel.ts:608`；`dom-snapshot-producer.ts:258` |
| Runtime View-owned Registry | spec 只含 name/description/inputSchema/isMutating，严格 JSON 复制；按 App+ViewType+name 聚合；同类公开合同不一致拒绝；实例持有 Handler | inputSchema 是已转换的 JSON 数据，没有独立 ParamDef。Registry 不解释 Ref 参数；不能从 reference 与 string 的相同投影恢复原类型 | `runtime/src/core/tool/view-owned-tools.ts:11`、`:161`、`:233` |
| DOM Producer → Draft V2 | 从 Runtime View/Tool inventory 绑定实例；Ref key 用三元组；普通 payload 成 snapshot-value，entity marker 成 entity | 每个 RefDescriptorV2 的 `refType` **硬编码 unknown**。V2 Tool 原样拷贝 Registry inputSchema，不恢复参数类别。V1 也写 unknown，但不识别 entity marker 为 entity target | `runtime/src/worker-runtime/dom-snapshot-producer.ts:109`、`:168`、`:202`、`:230` |
| Core validator／Store | 严格 JSON 脱离原对象并深冻结；验证 Ref key/owner/target 及 Tool target/binding；Store 按 Snapshot 保存 | RefDescriptor 有 refType 字符串字段，Core fixture/其他 Producer 可以保留 File/Todo 等值，但**不等于 SDK 已生产它**。没有将参数 refType 与 descriptor.refType 比较的步骤 | `runtime/src/core/snapshot/types.ts:98`；`validator.ts:201`；`v2-validator.ts:134`；`store.ts:277` |
| Host 来源选择／授权 | Wave 2A 固定完整请求；`acquireToolSource` 获取来源及 lease；授权只认 true；await 后同来源再检查 | scope.args 是冻结的 caller JSON；没有 Ref 参数解析、Ref provenance 或参数级类型判断。`isMutating:false` 也不是 OS 沙箱/业务授权 | `runtime/src/engine/app/worker-host.ts:466`；`source-binding.ts:40` |
| IPC → Worker → AppKernel | `VIEW_TOOL_INVOKE` 携带 app/instance/tool/target/args；Worker 再查当前 App 实例与开关；AppKernel 调 Registry | 当前消息没有 Ref 参数模式、Snapshot ID 或 Ref provenance。args 按值克隆并原样转交，不调用 Legacy Ref resolver | `runtime/src/spi/worker-protocol/messages.ts:96`；`worker-runtime/index.ts:565`；`AppKernel.ts:147` |
| Registry → SDK wrapper → Handler | Registry 检查当前具体实例、enabled、bindingVersion、公开 spec；SDK validateArgs 后调用该 View handler；保留 OperationResult.success | SDK reference 只检查 string/object 形态，refType 只用于错误描述；不检查对象是否来自 Snapshot，不改写参数。额外 args 字段不自动解析、也不被现有 validator 删除 | `view-owned-tools.ts:97`、`:273`；`sdk/src/utils/validateArgs.ts:60`、`:139`、`:289`；`useViewTypeTool.ts:134` |

因此，两个不同的声明 `file:{type:'reference',refType:'File'}`、`file:{type:'reference',refType:'Todo'}`，甚至普通 `file:{type:'string'}`，在其余选项相同时可以产生**相同 inputSchema**。Snapshot 的确有 owner/实例/值，却没有足够信息说明“这个参数位置应作 Ref 解析”。参数名叫 file、字符串形似链接、对象有 id 均不能补上这项信息。

## RefSelector、refKey 与 resolveRef 的边界

`RefSelector` 要求 snapshotId/appId/instanceId/viewId/refId，并选择 V1 viewGeneration 或 V2 viewInstanceId。没有 expectedRefType、target kind 或业务权限参数（`types.ts:207`）。`refKey` 编码 `JSON.stringify([viewId, instance, refId])`，没有后缀搜索（`validator.ts:84`）。

`store.resolveRef`（`store.ts:365`）依次：

1. `getById(snapshotId)` 获取仍保留的数据。
2. 检查该 Snapshot 自身的 App/AppInstance。
3. 检查选择的 View 实例属于该 Snapshot。
4. 按完整三元组查找 Ref，返回 descriptor 和 target。

它不会查看 latest View/Tool，不会 acquire lease，不会比较参数类型，不会读取 entity 资源，也不会授权或运行 Handler。错 App/实例 → APP_INSTANCE_MISMATCH；错来源 ViewInstance → VIEW_INSTANCE_REVOKED；缺 Ref → REF_NOT_FOUND。合法 entity 或任意非空 refType 可被返回，这不是通用只读 Ref 执行能力。

`acquireToolSource` 则先检查 latest ready/AppInstance，acquire 指定 Snapshot，要求 V2，取来源 Tool 的明确 target；再比较**当前** ViewInstance、Tool bindingVersion 和公开合同（包含 canonical inputSchema）。它不检查 Ref payload。返回 selection 没有 Handler，也没有跨进程 deadline。现有 `acquireVersionedEntitySource` 是另一条显式版本资源预检，要求 mutating Tool；不能当作 snapshot-value 只读参数解析器或 entity 读取许可。

同 viewId 重挂载后：旧 Snapshot 的旧 selector 仍可以读旧值；旧 selector 配新 Snapshot，或新实例配旧 Snapshot，会拒绝；`acquireToolSource(old)` 拒绝旧挂载。这里是历史存储与当前执行资格的分工，不是旧值读到新实例的漏洞。

## 历史值、TTL 和预算

| 项目 | 当前合同／实现 |
| --- | --- |
| Ref-only 更新 | canonical Snapshot 内容包括 refs；A→B 生成新 revision。旧 Snapshot 冻结 A，不随 Registry/caller 对象变化；若 View/Tool 不变，旧 Tool 来源仍可能合法 |
| 数据保留 | 默认 history 64 条、32 MiB、retiredAt 起 10 分钟。pin 可让历史数据在保留 TTL 后继续被 getById/resolveRef 读到 |
| 执行来源重新 acquire | 历史 retiredAt+TTL 到期即拒绝，即使数据被 pin；当前 Snapshot 没有仅凭年龄过期的规则。单个 lease 到期不会自动撤销仍为 current 的 Snapshot |
| lease | 默认 60 秒、最多 1024 个；释放幂等。pin 是保留能力，不是永久授权。Wave 2A 授权后重新 acquire 同一来源 |
| Snapshot | depth 48、nodes 100000、总 4 MiB；views 1000、refs 10000、tools 1000；单 Ref payload 512 KiB、单 Tool Schema 64 KiB（canonical UTF-8 字节另查） |
| SDK View-local 声明 fingerprint | depth 24、nodes 5000、approx 64 KiB；Registry spec copy 另有 depth 48/nodes 10000/approx 128 KiB |
| 当前只读请求 | 完整四字段请求 depth 25/nodes 10004/approx 136 KiB；args 子树 depth 24/nodes 10000/approx 128 KiB。当前没有“Ref 展开后”预算阶段，因为未展开 |
| JSON codec | 拒绝 getter/隐藏/symbol/非 JSON/class/Date/Map/循环等；共享对象每次出现都复制并计费；Proxy 反射可能执行 trap，不是恶意 JS 沙箱 |

来源：`store.ts:26`、`:81`、`:331`；`validator.ts:7`；`json.ts:21`；`AppKernel.ts:596`；`worker-host.ts:484`。

实测：140 KiB 文本的 Ref 可以是合法 Snapshot payload，却放不进现有 128 KiB args copy；70 KiB 同对象两次出现会超 args 字节预算，不能按共享对象只算一次；嵌入 args 会增加根深度；重复 5000 个 null 的数组也会超聚合 nodes 额度。这些只验证现有 codec 的边界，不表示已实现 Ref 展开。

## 兼容路径与文档差异

- Legacy 五参数 `useViewTypeTool` 仍走 type-wide 注册。`AppKernel.resolveTypeToolArgs/resolveRefId`（`:805`／`:888`）使用当前 Registry，在声明 ViewType 范围内查找并拒绝歧义；不是来源 Snapshot 解析，不能接入本提案当替代实现。
- `useViewTypeTool` 的顶部注释/TypeToolOptions 注释仍描述 legacy 的 view_id 必填；当前 View-local 重载依赖 View context，不要求业务 params 手写 view_id。本批不改注释或 API。
- Producer 文件顶部提到 passive-effect 注册，这是历史说明；所读 Hook 实际已改 layout effect。仍存在没有全面 Strict CommitBarrier 证明的限制，不能因这个注释差异提升 Strict。
- `ParamDef.refType` 注释写“必填”，代码中是可选属性，defineParams 不验证必填，validateArgs 也不比较类型。新增 SDK 探针固定了这个事实；没有把它描述成已证实的权限绕过。

未发现需要中止本设计批次的新增严重可复现问题。已经存在并在 Wave 2A 明示的限制，是 reference 在已验收入口中仍为普通 caller JSON。2B 将缺失信息和下一步授权边界写成提案，没有修复或放开生产执行。
