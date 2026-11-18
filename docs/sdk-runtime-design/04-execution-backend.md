# 04｜应用生命周期如何与 Node Worker 解耦

文档 ID AOTUI-D04 · 修订 0.5 · 2026-11-18（Asia/Shanghai）

> 默认后端运行可信 App，模型内置提示已校正。新增执行后端及其公开入口仍是候选方案。  
> 代码观察基线为 `90449dc2d` 加本批工作树。开页准入与恢复重设计继续暂缓。

## 有条件的结论

**默认 Node Worker 继续负责可信 App 的加载、通信与真实退出。本批先在两个现有生产者之间统一了帧提交。只有第三方确实要直接托管 SDK 工厂，才值得把实例生命周期连同启动失败和在途关闭作为一个新的受支持入口。** [首批装配决定](03-core-assembly.md)

## 一、同一个 IDE 换了运行位置，哪些事应当不变

用户的问题是：

> “‘默认托管把通用应用生命周期与 Node Worker 绑得过紧’ 有优秀/成熟的解耦方案吗？”

继续使用 IDE 例子。Files 页面为 `view_id=files`、`type=FileList`，有文件结果数组和 refs。起初 Editor 没打开，编辑工具未暴露；打开 `test.txt` 后，`view_id=editor`、`type=FileDetail` 的页面出现，并暴露对应类型工具。多个 FileDetail 页面共享一组定义；同一个 Editor 以后可以切到 `notes.txt`，不必 remount。

当操作接收 Files 选出的对象时，显示链接 `[测试文件](File:results[0])` 与调用地址 `files.results[0]` 严格分离；`view_id=editor` 独立指定接收页面。工具返回回执，数据通过 View 变化；Messages 同时是事实与记忆，当前页面区域每页只保留最新快照。

现在假设集成者想在受信任的 Node 服务里同进程运行这份 IDE，或在一个最小测试环境验证应用合同。他期待只改变“应用在哪里执行”，不用重新实现页面身份、类型工具共享和 Ref 来源。默认 Preact 作者方式也不应因此被迫改写。这里是用于检验边界的场景，不意味着已经决定支持任意浏览器或远程服务器。

冲突出现在异常时：Editor 的 handler 已经写完文件，Worker 却在回执送达前退出。调用端知道通道断了，但不知道这次写入是否发生。把 Worker 换成直接函数调用容易；保持正确的执行事实与资源报告更难。若把所有异常都翻译成“失败，可以重试”，换执行位置就改变了应用语义。

因此成熟解耦的目标是：**业务合同一致，环境差异如实表达。** 模型输入一旦冻结，后端不能让模型在生成中获得新世界；Ref 仍取自 `originalObservation`，执行仍使用当前有效闭包，文件冲突仍由 App 判断。

## 二、当前代码证明，耦合发生在托管装配而非纯 Core

当前路径是 `createRuntime → DesktopManager → AppManager → WorkerSandbox → AppWorkerHost → Node Worker`。公开 `RuntimeOptions` 主要只有存储后端注入；`AppManager.installMeta()` 直接创建 `WorkerSandbox`，后者直接创建 `AppWorkerHost`，其 `start()` 创建 Node Worker。[入口](../../runtime/src/facades/facades.ts)、[AppManager](../../runtime/src/engine/app/manager.ts)、[WorkerSandbox](../../runtime/src/engine/app/worker-sandbox.ts)、[AppWorkerHost](../../runtime/src/engine/app/worker-host.ts)

`existingWorker` 与 `workerScriptPath` 可以替换 Worker 实例或脚本，适合作为测试和部署控制，但仍不是一个没有 Worker 的执行方式。另一方面，`AppWorkerHost` 已拥有有价值的观察来源校验、未知终态与真实资源释放逻辑。解耦应重新安放这些责任，不是用接口把它们删掉。

## 三、成熟实践提供边界原则，不提供现成的 AOTUI 语义

| 一手来源 | 对本问题有用的经验 | 不应照搬或推导的部分 |
| --- | --- | --- |
| [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) | 区分扩展合同和本地、浏览器、远程运行位置 | 放置仍受扩展能力与环境限制；不能保证任意 Node App 可进浏览器 |
| [Cockburn：Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture) | 按应用与外部的实际交互定义端口，由适配器转换环境 | 不以端口和层数多少判断质量；AOTUI 不必为每个内部函数建接口 |
| [LSP](https://microsoft.github.io/language-server-protocol/) 与 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) | 领域消息可以稳定，不必固定执行位置或传输方式 | JSON-RPC 不替 AOTUI 决定 Observation、Ref、取消与业务执行保证 |
| [Node Worker 生命周期](https://nodejs.org/api/worker_threads.html#workerterminate) | `terminate()` 的 Promise 在退出事件后兑现，终止请求不等于已退出 | 同进程没有同等强制终止能力，不能伪造相同保证 |

据此推导出的最小方案是共同语义单元加一个执行边界；它不是上述系统现成 API 的移植。仅当以后真的需要复杂消息编解码时，才评估复用成熟 RPC 库，当前没有必要先建设一套 RPC 产品。

## 四、系统与模块：三个 owner，只有一份应用执行语义

下表区分当前三个所有者。若将来选择支持另一个完整执行环境，方案 C 可以从 AppKernel 迁出共同的实例生命周期，候选名称为 `AppExecutionSession`。本批找到的确定共用点是作者帧的提交顺序。[03 的源码与两路消费](03-core-assembly.md)

| 角色 | 唯一拥有的事实 | 另一侧不能代替它宣称的结果 |
| --- | --- | --- |
| 执行端 AppKernel 及其 registry、coordinator | 应用实例、工具登记、页面绑定、投影提交、应用停止/关闭 | 调用端停止发消息时，执行端仍可能有工作要完成 |
| 调用端 interaction | 已接收投影、Observation、资格、分派与收据、持有释放 | Worker 不决定调用者采用了哪份观察 |
| 执行 backend | 加载、消息交付、请求关联、断连、物理资源与退出 | 应用 close 成功不直接证明 Worker 已退出 |

“调用入口已关闭、应用正在收尾、Worker 仍存活”可以同时成立。最终报告应组合这些事实，不再创建一份独立可写的总生命周期状态。

下面仅示意一个内部端口，**所有名称和签名均为 proposal**，调用端句柄命名不在此冻结：

```ts
interface AppExecutionBackend {
  start(spec: AppStartSpec, publish: PublicationSink): Promise<ExecutionHandle>;
}
interface ExecutionHandle {
  flush(): Promise<PublicationBarrier>;
  invoke(call: BoundInvocation): Promise<ExecutionTerminal>;
  stop(): Promise<AppStopReceipt>;
  close(): Promise<AppCloseReceipt>;
  readonly released: Promise<ResourceReleaseFact>;
  terminate?(): Promise<ResourceReleaseFact>;
}
```

`start` 描述应用加载与实例要求；后端在目标位置加载 factory，再创建共同 Session。跨线程消息不携带 DOM、闭包或线程内 owner 对象。`publish` 交付完整语义投影，`flush` 确认提交达到明确发布边界，不能只报告消息已发送；实例身份和版本优先复用现有合同。

`invoke` 返回执行事实，页面数据走投影；`stop` 停止新的执行入口，不宣称撤销已进入业务；`close` 报告应用收尾；`released` 报告该后端拥有的资源；可选 `terminate` 是物理能力，不承诺事务回滚。App 自行创建的业务资源仍由 App 管理，不能因增加 backend 就由内核无限兜底。

## 五、机制：正常路径清楚，故障路径才不会隐藏事实

一轮交互开始时，调用端刷新并确认可见投影，形成并采用 Observation，再将它送入模型。模型返回的调用绑定这份原 Observation；interaction 校验资格与来源后分派，Session 检查当前实例与绑定，再运行当前 handler；执行终态与后续投影分别送回。**这不是每次执行工具前重新采用观察**：执行前即使刷新状态以核验当前资格，也不能替换调用的原来源。调用端不根据“handler 成功”猜一份尚未发布的页面。[现有刷新与分派](../../runtime/src/engine/app/worker-host.ts)、[Worker 消息处理](../../runtime/src/worker-runtime/index.ts)

正常关闭时，调用端先停新分派、撤销相应资格，Session 停新入口；已进入的工作等待真实终态，若失去证据则保留未知。可释放的观察持有可以收回，在途持有仍保留到其真实责任终点；应用及启用的持久化收尾、观察持有释放、物理资源退出分别确认。超时可以请求强制终止，但不能把尚未确认的资源写成已释放。当前 `close()`、`terminate()`、`waitForResourceRelease()` 的相关区分应被保留。

[Microsoft StreamJsonRpc 的故障说明](https://microsoft.github.io/vs-streamjsonrpc/docs/resiliency.html) 同样区分断连和已经开始的方法继续执行；此处只借鉴故障原则，并未选用其实现。位置透明不等于故障透明，所以超时不自动变成“未执行”，无终态不自动重试，重新启动也不自动恢复旧实例资格。

默认 Node Worker 执行可信应用代码，是执行与生命周期边界；它不是文件、网络权限意义上的安全沙箱。这是 [Runtime README](../../runtime/README.md) 已明确的边界。替换后端不会自动增加安全能力，也不要求引入一般任务调度器。

### 评审补充：函数终态与外部业务效果要分别解释

[Review 04](REVIEW-2026-11-18.md#review-04) 提出的一个例子有价值：IDE 向远端提交写入，远端没有返回确认，handler 捕获异常并返回 `success: false`。框架已经知道 handler 返回，App 却仍可能无法确认远端到底有没有写入。此时框架的终态确定与业务效果未知可以同时成立。

| 当前证据 | 可以说什么 | 不可以直接推出什么 |
| --- | --- | --- |
| 分派前拒绝，handler 未进入 | 此次 handler 没有执行 | App 的外部对象永远未被其他来源改变 |
| 已分派但没有可信终态 | 框架尚无法确认这次执行结果 | 超时等于未执行，可以直接重做 |
| handler 已返回业务错误 | 函数终态已知，保留 App 的错误与恢复信息 | 所有外部副作用都没发生，或业务一定可重试 |
| handler 报告业务成功，但投影失败 | 已知业务结果与呈现故障分别记录 | 需要再执行一次业务操作才能修复页面 |

源码中 [`mapExecutionFact`](../../runtime/src/core/invocation/invocation-outcome.ts) 会将 handler 返回的失败结果包装为 `failed / TOOL_FAILED`，原始结果继续放在 details。这支持“不能只凭顶层状态安排重试”的解释，但不证明默认模型输出丢失了应用错误。直接消费者的 [`semanticToolResult`](../../agent-driver-adapter/src/semantic-aotui-driven-source.ts) 已取出 `details.result`，保留 App 的 `error.code/message` 和 `data`；对应行为已有[适配器测试](../../agent-driver-adapter/src/semantic-aotui-driven-source.test.ts)。本轮只核对这个直接边界，没有扩展其他模块的设计范围。

仍需明确的是：必须给 Agent 的业务恢复信息究竟通过现有 `data` 还是 `error.context` 表达，执行阶段在何种场景应当可见。当前 normalizer 并不完整透传 `error.context` 或 `executionPhase`。先固定这些既有字段的语义与呈现测试；不新增 `effects` 分类，不让 Runtime 推断业务可重试性，也不把“handler 返回业务未知”改成一个永远不结束的框架调用。

第五批把两个边界并排验证。已发送模型请求的会话销毁后，完整回包在 Driver 被截住，Worker 尚无执行责任。对于真实已分派的调用，复跑定点 Worker 用例确认等待超时、新观察采用后，仍持有原 Snapshot 并等待匹配的终态。迟到结果保留原 Snapshot ID，按原观察和调用 ID 可读收据；终态后执行持有清零，旧观察的新调用已拒绝。这个 Worker 用例通过独立 App 实例的有界交互运行，收据查询以实例和保留边界为准。[实际 POST 证据的范围](01-messages-facts-and-memory.md#已发送的轮次如何收尾)、[Worker 定点证据](../../runtime/src/engine/app/worker-host.scoped-interaction-e2e.test.ts)

### 启动失败的清理责任继续归实际分配者

本篇采用 Review 的责任建议作为当前推荐：后端已经分配的线程、通道与加载资源，启动失败后继续由后端负责清理和登记，直到有真实释放证据。调用者可以收到失败与清理进度事实，但不应被迫接手一份半初始化资源来补写底层清理协议。

这不保证清理立即成功，也不新增自动重试平台。错误报告、既有资源计数与可等待释放通道应表达尚未完成的责任；App 自己创建的业务资源仍先按 App 的清理合同处理。具体端口表达继续待讨论。

### 模型指令和后端能力需要一致

原内置模型指令用 `Worker-Isolated` 概括安全性，容易让 Agent 把线程边界理解成权限边界。本批改为“默认 Node Host 在 Worker 线程中运行受信 App，它具有宿主授予的系统访问权限”。真实包消费检查从默认指令入口取值，并确认终端 HTTP 请求包含这段文字。宿主自定义指令仍由宿主管理。请求中出现的文字会改变，执行权限、工具名、Schema 和收据格式都沿用既有合同。[内置提示](../../runtime/src/adapters/system-instruction.ts) · [Runtime README](../../runtime/README.md) · [请求实证](../../sdk/tests/fixtures/assembly-consumer.mjs)

未来同进程后端还须继承 [06](06-preact-semantic-bridge.md) 已有的多根提交隔离证据，并另核对共享 `document/window`、事件作用域和关闭行为。已有多根提交测试不等于完整的环境隔离证明；这些验证也不构成立即增加第二后端的决定。

## 六、三个方案的收益、成本与使用条件

比较仍以语义是否守住、owner / 公共组合是否减少、Agent 正确开发成本、长期移植兼容成本与眼前证据为准，不用抽象的可扩展性打分。这里的 **Minimalist** 是为真实执行边界建立最少必要端口，同时保留故障事实，不预建所有未来环境的适配平台。

| 方案 | 收益与作者 / Host 责任 | 即时成本与长期成本 | 使用条件 |
| --- | --- | --- | --- |
| A. 保留现有 Node Worker 托管 | App 作者继续使用默认 SDK；Host 接受当前运行位置与部署条件 | 现在最省事；以后每种非 Worker 场景都需绕过托管或另做组合 | Node Worker 已满足所有真实部署 |
| B. 注入 Worker 创建工厂 | Host 可控制脚本、实例与测试故障；App 语义不动 | 改动小；依然绑定 Worker，不应宣称已实现环境无关 | 需求只是测试/部署 Worker，没有第二执行模型 |
| C. 共用 Session，现有 Worker 实现一个最小执行端口 | App 作者不用重写生命周期；Host 对接完整运行实例，环境故障由 backend 报告 | 要整理类内责任与故障报告；长期能替换位置而不复制应用语义 | 已有可信第二场景，或内部职责拆分本身能减少重复状态 |

**首批选 A。** 两种测试装配已经共同消费同一 App，也暴露了组帧这一处可安全复用的接线。B 适合只想控制 Worker 创建的 Host。只有当第三方需要负责另一种执行环境，才有理由承担 C 的启动、交付、关闭与版本支持成本。

## 七、当前最小步骤与后续证据门槛

现有责任已经落到可核查的位置。执行端 AppKernel 管初始化、停止接新工作和 App 清理，interaction 管资格与在途来源，Worker Host 管通道和线程退出。组帧共用投影协调器。此轮没有可从这一拆分中整体移交出去的独立 Session 状态。[03 的所有权表](03-core-assembly.md)

本轮同进程实验只服务一个已知的串行工厂，可以检查普通帧与原观察资格。默认路径最终从实际 shutdown 报告取得 `resourcesReleased`，同时检查 interaction 的保留操作数与字节数归零。独立路径另外检查自身的快照持有、registry 绑定与逻辑字节。后者的三个计数没有证明任意同进程代码均可强制终止。[同一 App 的两条路径](../../sdk/tests/fixtures/assembly-consumer.mjs)

未来若选 C，须让部分初始化失败的资源仍有 owner，断连且未收到终态的调用仍能准确表达未知，并能区分 App 清理结束、来源持有释放和物理退出。本轮复用了两条 Worker Host 用例，分别覆盖原执行跨过等待超时与新采用后才收到迟到终态，以及强制关闭直到 Worker 退出。SDK 工厂以外的新后端实现尚待真实集成场景。[Worker Host 用例](../../runtime/src/engine/app/worker-host.scoped-interaction-e2e.test.ts) · [包消费门禁](../../runtime/tests/verify-installed-contracts.mjs)

跨文档依赖：[03](03-core-assembly.md) 管装配 owner，[05](05-compatibility-and-distribution.md) 管稳定合同，[01](01-messages-facts-and-memory.md) / [02](02-view-page-semantics.md) / [11](11-ref-address-contract.md) 的语义保持；本篇不重新设计开页准入或 rollback。

## 待定问题

1. 是否已有值得支持的第二执行场景，还是先用内部验证实现检验边界？
2. `start` 部分失败后，如何复用现有报告表达 backend 仍在负责清理，避免让调用者接手资源或增加第二套生命周期状态？
3. 哪些现有投影确认与资源报告可直接收窄复用，而无需引入新版本或状态？

## 决策日志

| 日期 | 状态 | 记录 |
| --- | --- | --- |
| 2026-11-18 | 提案，待讨论 | 借鉴成熟宿主与端口适配原则，推荐共同 AppExecutionSession 和单一执行后端边界；保留故障可见性与真实资源释放；不建设通用 RPC 平台，不实施代码变更。 |
| 2026-11-18 | 文档修订 0.2；提案仍待讨论 | 以 IDE 换执行位置和回执丢失解释问题；比较维持现状、Worker 工厂与最小执行端口；将第二后端/公共后端 API 改为证据驱动的后续步骤，保留成熟实践来源。 |
| 2026-11-18 | 文档修订 0.3；提案仍待讨论 | 采纳 Review 对业务未知、启动失败清理与指令措辞的提醒；核实默认 adapter 已保留 App 错误码及 data，收窄剩余问题；未改收据、指令或后端实现。 |
| 2026-11-18 | 修订 0.4，提示已实施，后端选型待定 | 默认指令已与可信 Node Worker 能力对齐，并在 provider 请求中查验。首批保留 A，把完整 Session 的条件交回 03 的实际集成对象。 |
| 2026-11-18 | 修订 0.5，定点验证通过 | 已发模型请求放弃与真实已分派调用的责任分开复验。分别以 Driver 的分派和 Worker 的匹配终态、旧收据为证。 |
