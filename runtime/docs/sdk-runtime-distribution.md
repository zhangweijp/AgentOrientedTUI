# Runtime / SDK 的分发与验证边界

## 当前 Runtime 入口

- [Runtime package guide](../README.md)：Node Host 入口、纯 Core 子路径、独立适配包与接入文档导航。
- [Semantic Host integration](semantic-host-integration.zh-CN.md)：标准 Source 的 Context、AppInteraction、Observation、Tool 和 Receipt 合同。
- [Runtime App interaction](runtime-app-interaction.md)：`interactionModes`, `getAppInteraction`, `SemanticAOTUIDrivenSource.getContext()` 与 Context release。
- [Tool lifecycle and cleanup](tool-lifecycle.md)：统一 ViewType Worker 参数模式、Tool 结果与 managed App 生命周期。
- [Pure Core entry](core-public-entry.md)：从正式包名编译运行的无 DOM Producer / Host 示例。
- 仓库内示例见 [IDE local consumer](../../demo-apps/aotui-ide/SCOPED_IDE.md#local-terminal-from-exact-installed-packages)：在正常安装的匹配包中直接运行随包入口；旧的仓库 prepare/run/verify 启动包装已退出。

<a id="current-delivery"></a>
## 当前本地交付

| 包 | 版本 | 正式依赖关系 |
| --- | --- | --- |
| `@aotui/runtime` | `7.0.0` | 提供纯 Core、Node Host 和 Worker |
| `@aotui/sdk` | `0.8.0` | 精确依赖 Runtime `7.0.0`，要求 TypeBox `1.4.3`，Preact 为可选 peer |
| `@aotui/agent-driver-adapter` | `0.4.0` | 精确要求 Runtime `7.0.0` 和 Driver `0.3.1` 两个 peer |
| `@aotui/agent-driver-v2` | `0.3.1` | 完整 Source Host 使用的 Driver，严格类型安装见包内 `STRICT_TYPES.md` |

安装时使用同一次本地交付的 tar，并以其清单核对 SHA-256。版本号用于选择包，Worker 与 App 通过各自协议确认是否能协作。可用范围以本地验证记录为准。

在仓库根目录指定一个新的绝对路径运行交付入口。使用 `--store-dir` 可指定已有 pnpm store，缓存齐全时可加 `--offline`。

```sh
pnpm run release:local --out /absolute/path/aotui-local-delivery
```

入口从当前源码冻结构建输入，使用相同锁文件在两个新目录依次构建 Runtime、SDK、Driver、Adapter。它调用 npm pack，比较每个包的文件内容、权限和内部链接，然后将第一组 tar 放入 `artifacts/`。实际输入、工具链、两组 payload 与原始 tar 的哈希、安装解析图、命令和报告写入 `release-manifest.json`。

`consumers/plain/` 是普通 TypeScript 作者及中立 Host 的最小依赖图。`consumers/host/` 包含 Preact、标准 Source 和 Driver 的严格类型图。各自使用同一组最终 tar 正常安装、验证，并在另一个新目录同锁重装和复验。要重装，保留 `artifacts/`、消费者 manifest、lock 与 patch 的相对位置，在所选消费者目录运行 `pnpm install --frozen-lockfile`。完整 Host 首次配置见 `@aotui/agent-driver-v2` 包内 `STRICT_TYPES.md`。

App 作者可从 `@aotui/sdk` 包内 `docs/runtime-compatibility.md` 开始。Host 迁移、Core 的 `inspect()` 和声明容量边界分别见 [公共 App 交互](runtime-app-interaction.md)、[纯 Core 入口](core-public-entry.md) 和 [初始化诊断](initialization-diagnostics.md)。

## 当前协议与拒绝边界

下表供 Runtime／宿主集成者定位当前合同。SDK 作者使用工厂与组件，由 SDK 提供协议标记。包版本、工厂、端口、Snapshot、调用和持久化各自演进，没有统一的协议大版本；源码文件或类型名里的 V2／V3 也不能替代实际字段。

| 合同 | 当前身份与生产／消费位置 | 支持与拒绝边界 |
| --- | --- | --- |
| 托管 App 工厂 | SDK 的 `createApp` 与 `createTUIApp` 提供 `toolAuthoringProtocol: 'view-type-tools-v4'`，Runtime 的 `hasViewTypeToolAuthoringProtocol` 校验 | Registry 从生成的 aoapp.json 读取该标记。Worker 的模块 default 必须是托管对象工厂。`isTUIAppFactory` 先检查形状、持久化及生命周期声明，再检查工具标记。缺失、旧值或 accessor 工具标记产生 `APP_AUTHORING_PROTOCOL_UNSUPPORTED`。 |
| App Tool 注册端口 | Runtime `IAppTypeToolPort.protocol: 'view-type-tools-v4'`，由 Preact 适配器内部使用 | 端口与工厂声明共用 Runtime SPI 的 `VIEW_TYPE_TOOL_PROTOCOL`。端口标识或注册函数无效时为 `TOOL_BINDING_PORT_INVALID`。普通 TS 托管工厂通过完整帧进入同一个 ViewType 注册表。 |
| 当前状态 Snapshot | Core 的 `PreparedAppSnapshotDraftV3`／`AppSnapshotV3` 使用 `schemaVersion: 3`；DOM Producer 或普通 TS Producer 提交，Core `v3-validator` 接收 | 内容格式支持 `markdown-v1`／`semantic-v1`。Runtime 自己生成并请求 `app-snapshot/v3`，Worker 在导入 App 前要求该能力，Host 在 OPEN 前要求 ACK；缺失为 `WORKER_SNAPSHOT_UNSUPPORTED`，未知版本能力为 `WORKER_CAPABILITY_UNSUPPORTED`。其他实际 schemaVersion 仍由数据边界拒绝为 `SNAPSHOT_INVALID`；握手不代替身份、序列、Ref owner、Tool activation 及预算检查。 |
| Host 交互选择 | SPI `SEMANTIC_INTERACTION_MODES` 只含 `view-type-parameters-v1`；Host `captureInteractionModes` 捕获配置 | 默认启用该模式；显式空数组关闭 Tool 执行协商，仍协商当前 Snapshot。重复、未知值及 accessor 配置为 `INTERACTION_MODES_INVALID`，不会改选旧模式。 |
| Worker Tool IPC | `PARAMETERS_V5_CAPABILITY = 'view-tool-parameters-invoke/v5'`。`VIEW_TOOL_INVOKE_V5`／`VIEW_TOOL_INVOKE_V5_RESPONSE` 的 `argumentMode` 为 `view-type-parameters-v1` | 启用工具时 Host INIT 请求此能力，Worker 明确返回 acceptedCapabilities；Host 要求全部请求的能力被确认，缺少调用能力为 `WORKER_CAPABILITY_UNAVAILABLE`。双方仍独立校验完整调用消息、success 判别的 JSON 结果、身份与预算；不尝试旧 RPC。 |
| 可信 invoker ABI | Runtime Core 导出并独立检查 `ORDINARY_INVOKER_ABI_V3 = 'ordinary-invoker/v3'`，SDK 按自身实现声明同一 literal。 | 旧公共 `ORDINARY_INVOCATION_MODE` 导入失败，旧内联注册值在执行前拒绝。 |
| 参数与 Ref profile | Core `ordinaryParameterProfile`／`compileOrdinaryProfile` 处理 `x-aotui-parameter-contract`。当前 ViewType 路径使用 `view-type-parameters-v1`，SDK `refParam` 生成 Ref schema | 普通字段与 Ref 目标共享有限 JSON 值域，显式 Ref 从 Observation 解析。支持的关键词和位置见 `@aotui/sdk` 包内 `docs/ordinary-v2.md`。 |
| App 生命周期 | SDK 声明 `appLifecycleSupport: 'app-lifecycle-v2'`；Runtime 端口／清理报告用该 protocol，INIT offer／ACK 另带 `version: 2` 和同一 instanceId | Worker 校验 offer，Host `captureAppLifecycleAck` 校验 ACK；缺失、旧值、错误版本或实例不能建立托管生命周期。Host 的 ACK 失败为 `APP_LIFECYCLE_NEGOTIATION_FAILED`；清理报告仍另行校验，不把 ACK 当作已关闭。 |
| 实例持久化与传输 | SDK 声明 `persistenceSupport: 'state-session-v1'`；Runtime 的 `STATE_SESSION_PROTOCOL` 标识 offer／ACK、App 端口和报告。offer／ACK 与 `STATE_STORAGE_REQUEST`／`STATE_STORAGE_RESPONSE` 的传输版本为 `1` | Worker `capturePersistenceOffer` 与 Host `capturePersistenceAck` 分别检查版本、实例及预算；Host ACK 失败为 `PERSISTENCE_NEGOTIATION_FAILED`。请求／响应还核对 sequence、action、地址和结果，不能用生命周期 ACK 代替持久化结算。 |
| 持久化记录编码 | Core `encodeStateRecord`／`decodeStateRecord` 的 JSON 外壳为 `{ version: 1, updatedAt, value }` | 记录格式与实例传输是独立合同；无版本的裸业务 JSON 或其他记录版本为 `UNSUPPORTED_FORMAT`。业务自己的 version 字段可位于 value 内，不充当外壳版本。 |

Worker 握手对退役或未知能力返回 `WORKER_CAPABILITY_UNSUPPORTED`，对不合法的能力列表返回 `WORKER_CAPABILITY_INVALID`。纯 Core 的 `ExecutionBinding.mode = 'ordinary-v2'` 和 `ordinary-params-v1` 普通参数 profile 继续支持。使用本批实际重建和配对的产物，版本号相同的旧包也可能含有 Tool IPC v4 或旧 invoker ABI。

这些检查发生在各自入口。旧工厂、缺少必要 offer／ACK、未知能力或不匹配的调用身份不能靠“包版本看起来相近”通过。Worker INIT／OPEN 的失败仍按原阶段和诊断合同报告，不将不同错误统一改写成一个兼容错误。

## Historical W09 / W10 distribution evidence

The sections below preserve the W09 / D5 and W10 handover decisions, compatibility facts, performance budgets, and dated delivery references as they were recorded. They are evidence for those artifact sets, not a description of the current supported API or a claim that old compatibility paths remain supported. W10 package preparation, offline comparison, full workflow, resource, recovery, and product performance evidence were recorded under the dated decisions below. Initial delivery was `rfcs/sdk-runtime-delivery/w10-takeover-20261027T034501Z`; subsequent shutdown and type decisions were recorded in `w10-hardening-20261027T055450Z`, and local launch plus snapshot-cache work in `w10-operability-20261027T093500Z`. The Minimalist batch was `w10-minimalist-20261027T145418Z`. Use each batch's own D6 decision for its exact artifacts and acceptance scope; do not mix artifacts solely by version. For those historical deliveries, `scripts/scoped-ide.mjs` prepared a local consumer from their tar, manifest and lock. That wrapper is retired; the current IDE instructions linked above use the normally installed package entry.

Runtime 的纯语义入口是 `@aotui/runtime/core` 和 `@aotui/runtime/adapters/memory-state-storage`。它们负责快照、身份、保留、选择、调用与内存状态存储，可在 ES2022、无 Node/DOM 类型的消费者中使用。普通 TypeScript Producer 可以从业务状态构造 V3 Draft，使用 `createSnapshotCore`、`createViewOwnedTools` 与 `createAppInteraction`；它承担注册、稳定提交和停止生命周期，不必引入 Preact 或 Node Worker。完整示例见 [Core 公共入口](core-public-entry.md)。受限同 realm VM 是环境依赖检查，不等于完整 Browser/Edge 产品支持。

`@aotui/runtime` 根入口是 Node 宿主：负责 Worker、Desktop/App、传输、存储与实际资源完成。`@aotui/sdk` 负责 Preact 组件、View/Ref/Tool 声明和提交。SDK 不能授予权限；Host 的模式、Worker ACK、逐 Binding 的 Wrapper 资格、来源/授权复核必须同时成立。根入口依赖不能按纯 Core 的环境要求描述。真实应用示例见 [公共 App 交互](runtime-app-interaction.md)，SDK 边界见 [兼容说明](../../sdk/docs/runtime-compatibility.md)。

构建顺序固定为 Runtime → SDK → IDE → Token。构建后对 Runtime/SDK 执行 `npm pack --ignore-scripts`；外部消费者用包名导入，使用默认 Worker 定位。包的 version 相同不足以证明二进制相同，必须保存 tar 和运行模块 SHA256、npm lock 的 resolved/integrity，以及安装内容/权限/内部链接。

在空目录中把最终 Runtime 和 SDK 两个 tar 同时作为直接依赖安装。SDK 对 Runtime 的依赖必须解析到唯一的最终 Runtime tar，不能悄悄引入 registry 中的同版本旧包。正常安装原声明依赖范围，可以使用封存的下载缓存；不使用 force、legacy-peer-deps、生产源码 alias 或工作区软链。第二个空目录从同一 lock 执行 `npm ci --offline --ignore-scripts`，逐文件比较内容、模式、内部链接和正确 Runtime 身份。安装脚本未执行的边界必须写入报告，不能称为 registry 发布。

兼容矩阵逐行区分 W00 原产物、W00 与源码匹配的重建产物、W07-B3B Wrapper 和最终候选。W00 原 SDK 有21个文件不同，构建来源未知，原件必须保留。旧普通接口支持的路径仍需真实成功和业务失败保真；没有新协议 ACK 的组合不支持新 Scope。旧 Wrapper 不因新 Worker ACK 获得新执行资格；同一 Worker 里的旧/新 SDK 也逐 Binding 核对。旧 Host 无法表达新调用时，报告“不支持/不可发现、零非法进入”，不捏造旧代码不存在的错误码。每个实际支持组合与拒绝结果应以本批交付的兼容证据为准，不能推广到未测版本。

C-Q01 允许没有 legacy TypeTools 的 AppKernel 在 owned View 非空或本次 DOM View fragments 确实为空时生成 V2。初始空和最后 View 卸载后的空态都有明确空 inventory；缺 inventory 方法、孤立 DOM、重复/错身份/集合不完整必须拒绝，失败不能降级 V1。非 AppKernel、legacy/mixed TypeTools、有旧 DOM View 但无 owned View 的路径保留 V1。空 selection 仍为 OBSERVATION_INVALID，同 ID 重挂产生新 ViewInstance，旧 Binding 不重新获得资格。

参数 default 仅为声明注释，验证器不填值；业务 Handler 可以自行默认。非法输入在授权和 Handler 前拒绝。Ref 来源来自原 Observation 的同 View 只读对象，Ref-only 值更新需要新来源，不能把旧 Observation 指向新值。合法业务 `success:false` 映射为 failed，保留 data/error。真实异常或无法确认结果时报告 unknown。等待结束后原执行仍可结算，可信 Host 使用完整原请求重新授权读取。Tool IPC v5 与 invoker ABI `ordinary-invoker/v3` 需要同批产物，见 [匹配包说明](../../sdk/docs/runtime-compatibility.md)。

资源上限按有限 Runtime/App 数量理解。Interaction 的 maxTotalBytes=64MiB 只约束 invocation 费用，Observation registry 另有独立预算。combinedBytes 为 invocationBytes + observations.totalBytes；默认分项给出64MiB + min(64MiB,32+16+8MiB)=120MiB的保守逻辑上界，不是一个共享64MiB池，也不是RSS。两边通过lease持有Store的同一不可变Snapshot，同一payload的来源费用可在两个账本重复计费，不能把这些JSON费用直接相加成独立堆内存。Store 的current/history/lease与调用者持有的返回对象有各自归属；history64项/32MiB是可配置默认，不是不可提高硬上限。关闭停止新工作，但实际回调/IO的finally未结束时仍由原owner保留；deadline不能把未完成工作改成已释放。安装元数据可能为reopen保留，删除Desktop后的生命周期释放与业务持久值留存分别核对。完整逐资源责任表及实测曲线在W09-C交付报告中。

工程预算固定在 Apple M2 Pro arm64、10CPU、16GiB、Node24.15.0，三个独立进程顺序测量，每场景独立nearest-rank p50/p95。纯Core发布不含构造、参数验证不含编译；公开调用包含Host/IPC/Worker/真实Handler，IDE IPC+Handler为联合区间。冻结p95上限：小型Core1ms、100View12ms、1MiB75ms、IDE切片发布/observe各2ms、ordinary完整调用5ms、32KiB验证1ms、精确4MiB350ms；公开小型/32KiB ordinary各5ms、32KiB Ref10ms、Ref+ordinary15ms、四种observe各2ms；单Runtime双App启动/关闭150/10ms，多Runtime混合500/40ms，最后project回调到父级实际完成10ms。预热5，实测50；4MiB/多Runtime/最后回调实测20。常规Core峰值RSS512MiB，4MiB/多Runtime768MiB，公开Ref与挂起清理256MiB。单live Runtime/池2Worker每轮10000次Desktop双App实际ready/关闭，每500次记录曲线，三轮；峰值768MiB，GC主heap1000→10000增长4MiB，RSS5000→10000增长32MiB。数字是本机工程门槛，实际结果和未测项以独立验收记录为准。

上述 W09 / D5 批次不授权 Strict、Full M4、默认 Router 切换、完整 IDE/LSP、Agent Driver/Mobile 或 registry 发布。W10 在单独证据与决定下增加完整 IDE 显式入口及固定 TypeScript LSP profile；其余排除项保持。

兼容 adapters 在 D5 时确有严格类型限制：该次实际安装的 `@ai-sdk/provider` 3.0.19、`ai` 6.0.315、TypeScript 5.9.3、`json-schema` 0.4.0 均未安装 `@types/json-schema`，`@aotui/runtime/adapters` 的声明链因此在 `skipLibCheck=false` 下产生两条 TS7016；B2/C 独立对照相同。历史决定编号为 W09-C-Q02。该缺口 `D-LEGACY-ADAPTER-TYPES-01` 已在 W10 hardening 的精确依赖图中关闭：Runtime 正式携带 `@types/json-schema` 7.0.15，实际安装 tar 的 adapters 以 `skipLibCheck=false` 通过，纯 Core 仍以 ES2022-only / `types:[]` 单独通过；未用类型 shim 或关闭严格检查。证据与适用版本保存在 `w10-hardening-20261027T055450Z` 的公开包验证及 D6 决定；不能把这一结果推广至任意未来依赖组合。
