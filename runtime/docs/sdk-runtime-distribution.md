# Runtime / SDK 的分发与验证边界

## 当前 Runtime 入口

- [Runtime package guide](../README.md)：Node Host 入口、纯 Core 子路径、独立适配包与接入文档导航。
- [Semantic Host integration](semantic-host-integration.zh-CN.md)：标准 Source 的 Context、AppInteraction、Observation、Tool 和 Receipt 合同。
- [Runtime App interaction](runtime-app-interaction.md)：`interactionModes`, `getAppInteraction`, `SemanticAOTUIDrivenSource.getContext()` 与 Context release。
- [Tool lifecycle and cleanup](tool-lifecycle.md)：统一 ViewType Worker 参数模式、Tool 结果与 managed App 生命周期。
- [Pure Core entry](core-public-entry.md)：从正式包名编译运行的无 DOM Producer / Host 示例。
- [IDE local consumer](../../demo-apps/aotui-ide/SCOPED_IDE.md#local-terminal-from-exact-installed-packages)：在正常安装的匹配包中直接运行随包入口；旧的仓库 prepare/run/verify 启动包装已退出。

## Historical W09 / W10 distribution evidence

The sections below preserve the W09 / D5 and W10 handover decisions, compatibility facts, performance budgets, and dated delivery references as they were recorded. They are evidence for those artifact sets, not a description of the current supported API or a claim that old compatibility paths remain supported. W10 package preparation, offline comparison, full workflow, resource, recovery, and product performance evidence were recorded under the dated decisions below. Initial delivery was `rfcs/sdk-runtime-delivery/w10-takeover-20261027T034501Z`; subsequent shutdown and type decisions were recorded in `w10-hardening-20261027T055450Z`, and local launch plus snapshot-cache work in `w10-operability-20261027T093500Z`. The Minimalist batch was `w10-minimalist-20261027T145418Z`. Use each batch's own D6 decision for its exact artifacts and acceptance scope; do not mix artifacts solely by version. For those historical deliveries, `scripts/scoped-ide.mjs` prepared a local consumer from their tar, manifest and lock. That wrapper is retired; the current IDE instructions linked above use the normally installed package entry.

Runtime 的纯语义入口是 `@aotui/runtime/core` 和 `@aotui/runtime/adapters/memory-state-storage`。它们负责快照、身份、保留、选择、调用与内存状态存储，可在 ES2022、无 Node/DOM 类型的消费者中使用。普通 TypeScript Producer 可以从业务状态构造 V3 Draft，使用 `createSnapshotCore`、`createViewOwnedTools` 与 `createAppInteraction`；它承担注册、稳定提交和停止生命周期，不必引入 Preact 或 Node Worker。完整示例见 [Core 公共入口](core-public-entry.md)。受限同 realm VM 是环境依赖检查，不等于完整 Browser/Edge 产品支持。

`@aotui/runtime` 根入口是 Node 宿主：负责 Worker、Desktop/App、传输、存储与实际资源完成。`@aotui/sdk` 负责 Preact 组件、View/Ref/Tool 声明和提交。SDK 不能授予权限；Host 的模式、Worker ACK、逐 Binding 的 Wrapper 资格、来源/授权复核必须同时成立。根入口依赖不能按纯 Core 的环境要求描述。真实应用示例见 [公共 App 交互](runtime-app-interaction.md)，SDK 边界见 [兼容说明](../../sdk/docs/runtime-compatibility.md)。

构建顺序固定为 Runtime → SDK → IDE → Token。构建后对 Runtime/SDK 执行 `npm pack --ignore-scripts`；外部消费者用包名导入，使用默认 Worker 定位。包的 version 相同不足以证明二进制相同，必须保存 tar 和运行模块 SHA256、npm lock 的 resolved/integrity，以及安装内容/权限/内部链接。

在空目录中把最终 Runtime 和 SDK 两个 tar 同时作为直接依赖安装。SDK 对 Runtime 的依赖必须解析到唯一的最终 Runtime tar，不能悄悄引入 registry 中的同版本旧包。正常安装原声明依赖范围，可以使用封存的下载缓存；不使用 force、legacy-peer-deps、生产源码 alias 或工作区软链。第二个空目录从同一 lock 执行 `npm ci --offline --ignore-scripts`，逐文件比较内容、模式、内部链接和正确 Runtime 身份。安装脚本未执行的边界必须写入报告，不能称为 registry 发布。

兼容矩阵逐行区分 W00 原产物、W00 与源码匹配的重建产物、W07-B3B Wrapper 和最终候选。W00 原 SDK 有21个文件不同，构建来源未知，原件必须保留。旧普通接口支持的路径仍需真实成功和业务失败保真；没有新协议 ACK 的组合不支持新 Scope。旧 Wrapper 不因新 Worker ACK 获得新执行资格；同一 Worker 里的旧/新 SDK 也逐 Binding 核对。旧 Host 无法表达新调用时，报告“不支持/不可发现、零非法进入”，不捏造旧代码不存在的错误码。每个实际支持组合与拒绝结果应以本批交付的兼容证据为准，不能推广到未测版本。

C-Q01 允许没有 legacy TypeTools 的 AppKernel 在 owned View 非空或本次 DOM View fragments 确实为空时生成 V2。初始空和最后 View 卸载后的空态都有明确空 inventory；缺 inventory 方法、孤立 DOM、重复/错身份/集合不完整必须拒绝，失败不能降级 V1。非 AppKernel、legacy/mixed TypeTools、有旧 DOM View 但无 owned View 的路径保留 V1。空 selection 仍为 OBSERVATION_INVALID，同 ID 重挂产生新 ViewInstance，旧 Binding 不重新获得资格。

参数 default 仅为声明注释，验证器不填值；业务 Handler 可以自行默认。非法输入在授权和 Handler 前拒绝。Ref 来源来自原 Observation 的同 View 只读对象，Ref-only 值更新需要新来源，不能把旧 Observation 指向新值。业务 success:false 的 data/error 保留；没有明确 failureEffects 时 Core 保守返回 unknown，不能自动重试。等待结束后原执行仍可结算，可信 Host 使用完整原请求重新授权读取。

资源上限按有限 Runtime/App 数量理解。Interaction 的 maxTotalBytes=64MiB 只约束 invocation 费用，Observation registry 另有独立预算。combinedBytes 为 invocationBytes + observations.totalBytes；默认分项给出64MiB + min(64MiB,32+16+8MiB)=120MiB的保守逻辑上界，不是一个共享64MiB池，也不是RSS。两边通过lease持有Store的同一不可变Snapshot，同一payload的来源费用可在两个账本重复计费，不能把这些JSON费用直接相加成独立堆内存。Store 的current/history/lease与调用者持有的返回对象有各自归属；history64项/32MiB是可配置默认，不是不可提高硬上限。关闭停止新工作，但实际回调/IO的finally未结束时仍由原owner保留；deadline不能把未完成工作改成已释放。安装元数据可能为reopen保留，删除Desktop后的生命周期释放与业务持久值留存分别核对。完整逐资源责任表及实测曲线在W09-C交付报告中。

工程预算固定在 Apple M2 Pro arm64、10CPU、16GiB、Node24.15.0，三个独立进程顺序测量，每场景独立nearest-rank p50/p95。纯Core发布不含构造、参数验证不含编译；公开调用包含Host/IPC/Worker/真实Handler，IDE IPC+Handler为联合区间。冻结p95上限：小型Core1ms、100View12ms、1MiB75ms、IDE切片发布/observe各2ms、ordinary完整调用5ms、32KiB验证1ms、精确4MiB350ms；公开小型/32KiB ordinary各5ms、32KiB Ref10ms、Ref+ordinary15ms、四种observe各2ms；单Runtime双App启动/关闭150/10ms，多Runtime混合500/40ms，最后project回调到父级实际完成10ms。预热5，实测50；4MiB/多Runtime/最后回调实测20。常规Core峰值RSS512MiB，4MiB/多Runtime768MiB，公开Ref与挂起清理256MiB。单live Runtime/池2Worker每轮10000次Desktop双App实际ready/关闭，每500次记录曲线，三轮；峰值768MiB，GC主heap1000→10000增长4MiB，RSS5000→10000增长32MiB。数字是本机工程门槛，实际结果和未测项以独立验收记录为准。

上述 W09 / D5 批次不授权 Strict、Full M4、默认 Router 切换、完整 IDE/LSP、Agent Driver/Mobile 或 registry 发布。W10 在单独证据与决定下增加完整 IDE 显式入口及固定 TypeScript LSP profile；其余排除项保持。

兼容 adapters 在 D5 时确有严格类型限制：该次实际安装的 `@ai-sdk/provider` 3.0.19、`ai` 6.0.315、TypeScript 5.9.3、`json-schema` 0.4.0 均未安装 `@types/json-schema`，`@aotui/runtime/adapters` 的声明链因此在 `skipLibCheck=false` 下产生两条 TS7016；B2/C 独立对照相同。历史决定编号为 W09-C-Q02。该缺口 `D-LEGACY-ADAPTER-TYPES-01` 已在 W10 hardening 的精确依赖图中关闭：Runtime 正式携带 `@types/json-schema` 7.0.15，实际安装 tar 的 adapters 以 `skipLibCheck=false` 通过，纯 Core 仍以 ES2022-only / `types:[]` 单独通过；未用类型 shim 或关闭严格检查。证据与适用版本保存在 `w10-hardening-20261027T055450Z` 的公开包验证及 D6 决定；不能把这一结果推广至任意未来依赖组合。

## 当前包边界

Runtime 不依赖具体 Agent Driver。标准 Source 从独立 `@aotui/agent-driver-adapter` 导入，Host 安装其匹配 Runtime／Driver peer。SDK 复用 Runtime 参数合同。当前组合、构建、正常 tar 安装和作者示例命令统一维护在 [SDK 包使用说明](../../sdk/docs/runtime-compatibility.md)。上方历史批次只适用于各自记录的产物，不证明当前包已发布或所有第三方严格类型问题已解决。
