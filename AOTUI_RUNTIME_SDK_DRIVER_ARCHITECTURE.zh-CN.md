# AOTUI 三层架构深读：Runtime、SDK 与 Agent Driver

> 视角：框架架构师（Framework Architect）  
> 日期：2026-10-28（Asia/Shanghai）  
> 范围：当前工作树，W10 之后；包含 legacy 产品面与 semantic Core 两条路径  
> 方法：读根目录文档、`runtime/docs`、`sdk/docs`、Agent Driver README 与迁移文档；读 core / engine / worker / sdk / driver 源码；跑 SDK、Driver、Runtime 测试；追踪 TUI IDE 的 legacy 与 scoped 两条入口。

---

## 0. 先给结论

如果只记三句话：

1. **Runtime 已经不是一个“Worker 运行时”，而是“双平面运行时”**：legacy 产品面负责今天的 Agentina 和默认 IDE；semantic Core 负责 scoped IDE 和受信 Controller。两套语义同时存在，这是理解当前系统的第一把钥匙。
2. **SDK 的边界是“声明与提交”，不是执行与授权**：它把 Preact 组件、View、View-local Tool、Ref、Persistence、Lifecycle 声明成 Runtime 可消费的投影；它不创建 Worker、不聚合快照、不做授权。
3. **Agent Driver 的边界是“上下文组装 + 单循环 + 工具路由”**；它仍然消费 legacy `AOTUIDrivenSource`，没有接入 Core 的 observation/binding。**这是当前系统最大的架构断点**：新的语义保证停在 Controller，没有到达模型。

先把职责矩阵放在一张表里：

| 关注点 | Runtime | SDK | Agent Driver | App | Host |
|---|---|---|---|---|---|
| 进程 / Worker 生命周期 | **拥有** | 不涉及 | 不涉及 | 不涉及 | 触发 |
| App 实例身份 | **拥有** | 声明 app_name | 消费 app 工具 | 提供业务 | 安装 |
| View 身份与注册 | **拥有**（viewId + viewInstanceId） | **声明** | 消费快照 | 提供内容 | 不涉及 |
| Tool 定义 | 消费注册 | **声明** | 消费 / 路由 | 实现 handler | 不涉及 |
| Tool 绑定与目标 | **拥有**（target + bindingVersion） | 声明 View-local | 消费工具名 | 校验业务目标 | 不涉及 |
| 授权 / Policy | **执行**（Host 提供 policy） | 不涉及 | 不涉及 | 业务条件 | **制定** |
| 快照 / Observation | **拥有** | 提交投影 | **组装上下文** | 不涉及 | 不涉及 |
| 业务版本 / 文件一致性 | 不拥有 | 不拥有 | 不拥有 | **拥有** | 不涉及 |
| 模型调用 / 循环 | 不涉及 | 不涉及 | **拥有** | 不涉及 | 配置 |
| 会话历史 / 持久化 | App state session | 提供 Hook | 消费 source | 业务持久化 | **拥有** |
| 人类 GUI | 不涉及 | Preact 投影 | 不涉及 | 不涉及 | **拥有** |
| 不可信代码权限隔离 | **不提供**（Worker 非安全沙箱） | 不提供 | 不提供 | 不提供 | 需另做 |

这张表会在后文逐层展开。

### 0.1 三个问题的短答案

**① Runtime 如何支撑 TUI IDE？**

Runtime 不运行“IDE 业务”，它运行“App 实例”：

- `installDynamicWorkerApp()` 启动 Worker，Worker 里加载 IDE 模块并渲染 Preact；
- SDK 的 `<View>` 把界面注册成 View，`useViewTypeTool` 把动作注册成 Tool；
- Worker 把 DOM / 组件状态投影成 snapshot（legacy）或 V2 draft（semantic）；
- Runtime 保存 snapshot / observation，执行时把调用路由回正确的 App / View / Tool binding；
- 关闭时按“停止受理 → flush → unmount → 等 App cleanup → 释放 Worker / 存储 / lease”的顺序回收。

Legacy 路径用 `Kernel.acquireSnapshot → SnapshotFormatter → AOTUIDrivenSource`；scoped 路径用 `SnapshotCore → Observation → ScopedInteraction → WorkerHost → ViewOwnedTools`。

**② SDK 如何构建 IDE？**

SDK 提供四层声明：

- `createTUIApp({ app_name, component, experimentalAppLifecycle? })` 把 Preact 根组件包装成 Runtime 可加载的 factory；
- `<View id type name>` 声明界面单元，mount 时分配 `viewInstanceId`；
- `useViewTypeTool`（3 参）声明 View-local Tool，目标由父 View 绑定；4 参是 legacy type-wide；
- `usePersistentState` / `experimental_useAppLifecycle` / `useAppConfig` / `useDataRef` 提供状态、生命周期、配置、引用。

Scoped IDE 的写法是：`IDESession` 做业务 owner；`ScopedIDEApp` 用 Root View 写指令，用 Workspace / FileDetail / SearchResult View 呈现状态，用 `IDETool` 把工具 contract 绑定到当前 View，用 `experimental_useAppLifecycle` 清理 LSP / search / persistence。

**③ Agent Driver 如何构建上下文、驱动 LLM？**

它从多个 `IDrivenSource` 收集消息和工具：

- `SystemPromptSource`（timestamp 0，system）
- `AOTUIDrivenSource`（static instruction + dynamic desktop/view states）
- `HostDrivenSourceV2`（session history + `context_compact`）
- Skill / MCP / IM sources

`assembleContextRegions` 把消息分成 `static / session / dynamic / active tail`，`collectMessages` 再做 assistant/tool 协议修复；`LLMClient` 用 AI SDK `streamText` 调模型，流式推送 text/reasoning，收集 tool calls / usage；`run()` 执行 tool calls，把结果写回 source，然后回到 idle 等 source 更新。

它的关键缺口是：**它消费的是 legacy AOTUI snapshot，而不是 Core 的 observation/binding。** 所以“对象身份、版本、五态结果”这些语义没有到达模型。

### 0.2 怎么读这份文档

- 只想看结论：读 §0、§5。
- 想看 Runtime：读 §1、附录 A.2。
- 想看 SDK 如何构建 IDE：读 §2.3、§2.4、§2.5。
- 想看 Driver 如何构建上下文：读 §3.2、§3.3、§3.5。
- 想看框架级判断：读 §4。

---

## 1. Runtime：身份、绑定、授权、资源所有权

### 1.1 两层 Runtime

当前 Runtime 有两个平面，共享 Desktop / AppManager / Worker 基础设施，但语义不同。

```text
Legacy plane（默认产品面）
  Host / AgentDriver
        │
        ▼
  Kernel.acquireSnapshot(desktopId)
        │  Desktop.getSnapshotFragments()
        ▼
  SnapshotFormatter  →  markup + indexMap + structured
        │
        ▼
  AOTUIDrivenSource  →  messages / tools / executeTool
        │
        ▼
  Kernel.execute → Dispatcher → Desktop → WorkerHost → Worker → AppKernel

Semantic plane（scoped 显式入口）
  Trusted Controller
        │
        ▼
  ScopeClient.observe / invoke
        │
        ▼
  ScopedInteraction → ObservationRegistry → SnapshotCore
        │
        ▼
  ExecutionResolver → WorkerHost → Worker(VIEW_TOOL_INVOKE_*) → AppKernel
        │
        ▼
  ViewOwnedTools → safe invoker → App handler → ExecutionFact → Receipt
```

两层并不是“新旧目录”那么简单：

- **Legacy plane 的权威是 `Kernel` + `SnapshotFormatter` + `CachedSnapshot` + `indexMap`**。它是 pull-based：每次 `getMessages` / `getTools` / `executeTool` 各自取一份快照。
- **Semantic plane 的权威是 `SnapshotCore` + `ViewOwnedTools` + `ScopedInteraction`**。它是 pinned-observation：`observe` 固定一个 snapshot revision 和一组 binding，`invoke` 只能使用这个 observation 里的 binding。

当前默认 IDE 和 Agentina 走 legacy；`demo-apps/aotui-ide/scoped.ts` 走 semantic。`SCOPED_IDE.md` 明确写了：**package default and generated aoapp remain legacy**（`demo-apps/aotui-ide/SCOPED_IDE.md:3`），`run` 是“no model, Agent Driver, home registry or Electron Host”的受信本地 Controller（同文件 `:136`）。

### 1.2 Runtime 拥有什么

Runtime 的职责可以用四个词概括：**身份、绑定、授权、资源**。

**① App 实例生命周期。**

`createRuntime()` 创建 `Kernel`；`Kernel.createDesktop()` 让 `DesktopManager` 创建 `Desktop`；`Desktop.installDynamicWorkerApp()` 让 `AppManager` 创建 `WorkerSandbox`，再创建 `AppWorkerHost`，从 `WorkerPool` 借一个物理 Worker。Worker 里运行 `runtime/src/worker-runtime/index.ts`，动态 `import()` App 模块，调用 `createTUIApp().initializeComponent()`。

关键点在 `runtime/src/engine/app/worker-host.ts` 和 `runtime/src/engine/app/worker-sandbox.ts`：

- 一个 `AppWorkerHost` 绑定一个逻辑 App 实例；物理 Worker 可以来自池，可以被复用，但 **AppInstanceId 不能复用**。
- `INIT` 消息携带 `appInstanceId`、`snapshotShadow`、`experimentalReadOnlyViewTools`、`requestedCapabilities`。
- 关闭顺序是：停止受理 → flush / seal 持久化 → unmount → 等 App cleanup → 等 Worker / storage / lease 真实释放。`runtime/docs/worker-lifecycle.md` 和 `runtime/docs/runtime-shutdown.md` 把这套所有权写得很细。

**② View 身份与 Tool 绑定。**

Legacy plane 用 `viewRegistry` 管理 `IView`，View 的 `id` 是开发者提供的 2–15 位字符串；Semantic plane 用 `ViewOwnedTools` 管理 `viewInstanceId`：

- `View` mount 时分配 `viewInstanceId`（`vi:v1:...`），并把 `data-view-instance-id` 写到 DOM。
- 每个 Tool 注册都有 `bindingVersion`；View 卸载、Tool 重注册、enable/disable 都会改变绑定。
- Observation 捕获 `target = { viewId, viewInstanceId, bindingVersion }`；执行时 `ViewOwnedTools.validate` 会逐一校验：App 实例、Tool 来源、View 实例、bindingVersion、canonical ToolSpec。任何一项不匹配就拒绝，不会“猜一个”。

这是整个系统最像“框架”的地方：**它把“对象身份”从模型手里的字符串，提升为运行时持有的结构化身份。**

**③ Snapshot / Observation。**

Semantic plane 的 `SnapshotCore` 是纯语义层：不依赖 DOM、Worker、Node、模型 SDK（`runtime/src/core/snapshot/types.ts` 顶部注释）。它维护：

- 每个 App 的 `AppSnapshotV2`：views、refs、tools、revision、sourceEpoch、contentDigest；
- current / history / lease / capacity；
- 同步提交（`committer.accept` 的指针交换没有 `await` 插入）；
- `viewInstanceId` 与 `bindingVersion` 的失效语义。

`ObservationRegistry` 在其上做“选择”：

- `observe({ viewIds })` 只能选择当前快照中真实存在的 View；
- `ScopePolicy.project` 决定暴露哪些 views / refs / targets / content；
- 返回的 `Observation` 固定 `source.snapshotId`、`revision`、`views`、`refs`、`tools`、`bindings`；
- 旧 observation 不会因为新发布而改指新对象；它要么继续固定旧 revision，要么因 TTL / close / binding 失效而拒绝。

**④ 授权与调用。**

`ScopedInteraction` 是 semantic plane 的执行协调器：

- `ScopePolicy.authorize(context)` 是 Host 提供的授权钩子；它可以在参数验证之后、进入 handler 之前拒绝。
- `ExecutionBinding.validateInput`、`isLive`、`execute` 是 WorkerHost 提供的执行适配器。
- `invoke` 的结果是五态 `Receipt`：`succeeded / rejected / failed / accepted / unknown`。
- 相同 `invocationId` + 相同请求复用结果；相同 ID + 不同请求报冲突；容量不足拒绝新调用，不淘汰仍在承担去重责任的记录。
- `canReadReceipt` 控制回执可见性。

这部分在 `runtime/src/core/invocation/scoped-interaction.ts`；`runtime/docs/core-public-entry.md` 给了完整例子。

**⑤ 持久化与关闭。**

`state-session-v1` 由 Runtime 的 App 实例端口管理：bind / recovery / confirm / update / flush / clear / seal / dispose；Host 负责文件系统和资源所有权。SDK 的 `usePersistentState` 只是这个端口的声明式外壳。关闭报告把“业务结果、Worker 物理退出、存储 I/O 真实结束”分成三个事实，不把 `terminate()` 返回当成资源释放。

### 1.3 Runtime 不拥有什么

这是框架边界最重要的部分：

- **不拥有业务语义。** 文件路径是否在授权工作区、文件版本是否仍是期望版本、LSP 结果是否属于当前文档、工单是否已被别人改过——这些由 App 负责。Runtime 的 `validate` 只证明“这个 binding 仍属于这个 App/View/Tool 实例”，不证明“这个业务目标仍然有效”。`SCOPED_IDE.md:74-76` 说得很清楚：Runtime routes an authorized call, does not validate the meaning of a path/version/result。
- **不拥有模型循环。** Runtime 不知道 Agent Driver、prompt、上下文窗口、token 预算；它只提供 snapshot / observation。
- **不拥有 UI。** Runtime 产出 markup / view fragments；Preact 和 SDK 负责组件与 DOM；Host 负责人类 GUI。
- **不拥有安全沙箱。** Worker Thread 是执行上下文隔离，不是权限隔离。App 仍可以调用 Node 能力；对可信 App 够用，对不可信插件不够。`runtime/docs/worker-lifecycle.md` 也明确“它不提供文件系统访问隔离”。
- **不拥有跨进程 exactly-once。** `invocationId` 去重只在单个 Session / 进程内；跨进程重启、远端服务的幂等性尚未实现。
- **不拥有 Agent 的“当前世界”本身。** Runtime 维护投影；模型是否看到、看到哪一份，由 Driver / Source 决定。

### 1.4 Legacy 路径：IDE 是怎么被跑起来的

以默认 `SystemIDEApp` 为例：

```text
Host / scoped-ide controller
  → runtime.createDesktop()
  → runtime.installDynamicWorkerApp(desktopId, ideEntryForRoute('legacy').href)
  → AppManager → WorkerSandbox → AppWorkerHost → WorkerPool.acquireLease()
  → Worker INIT
  → import('@agentina/aotui-ide/dist/tui/index.js')
  → createTUIApp(...).initializeComponent(container, context)
  → Preact render <View id="root" type="Root"> / <View id="workspace" type="Workspace"> / ...
  → View 的 useLayoutEffect：registerView + onMount
  → useViewTypeTool（4 参 legacy）：registerTypeTool
  → MutationObserver → pushSnapshotFragment()
  → transformElement() → markup + indexMap + view fragments
  → SNAPSHOT_FRAGMENT → AppWorkerHost 缓存
  → Desktop.getSnapshotFragments() → Kernel.acquireSnapshot()
  → SnapshotFormatter → CachedSnapshot(structured)
  → AOTUIDrivenSource.getMessages()/getTools()
  → AgentDriverV2 → LLM
  → tool call → AOTUIDrivenSource.executeTool()
  → Kernel.execute() → Dispatcher → Desktop.dispatchOperation()
  → Worker VIEW_OPERATION → AppKernel.onOperation()
  → View/Operation handler → 业务服务 → setState → Preact render
  → 新快照 → 下一轮
```

Legacy IDE 的关键特征：

- `SystemIDEApp` 用 `usePersistentState` 保存 `activeFiles` / `expandedDirs`，用 `useAppEnv('projectPath')` 读启动路径，用 `persistenceService`（LowDB）保存工作区，用 `lspService` 管理语言服务器，用 `fileSystemService` 做文件操作。
- `RootView.tsx` 是“工具与指令中心”：它在根 View 上注册 4 参 type-wide 工具（`lsp_hover`、`write_file` 等），工具参数里显式带 `file_path` / `view_id`，描述里动态拼接 `availableFileDetailViews`。这是 legacy 的典型写法：**目标选择靠应用自己维护的提示词和参数。**
- `FileDetailContent` 是 View，直接用 `useState` 管理文件内容、LSP 结果、诊断、操作日志；它通过 `eventBus` 接收 LSP 异步结果，再 setState。
- `WorkspaceContent` 是固定 View，读取目录树并渲染 `<pre>`。
- `SearchResultView` 按需挂载。
- `View` 的 `id` 由 `reconcileFileViewIds` 保持稳定：它用 `Map<path, id>` 分配 `fd_N`，不会因为数组下标变化而改 ID。这是一个很实用的修复，但它是 App 层做的，不是 Runtime 强制的。

Legacy 的语义后果：

- `AOTUIDrivenSource.getMessages()`、`getTools()`、`executeTool()` **各自 acquire 一次快照**。模型看到的视图、工具表、执行目标可能来自不同 revision。
- 4 参 type-wide 工具把“目标选择”交给模型和应用：模型要传 `view_id` / `file_path`；App 要自己校验。Runtime 只负责把操作路由到 `viewId=viewType` 的 type tool。
- `AppKernel.callTypeTool` 现在会保留业务 `success:false`（不再外层包 `success:true`），这是相比早期版本的改进；但引用解析仍是 legacy 的 `resolveTypeToolArgs` / `resolveRefId`，位置型数组引用仍有风险。
- Snapshot 是 pull-based；没有 observationId / bindingId / 五态 receipt；错误语义仍以 `OperationResult` 为主。

### 1.5 Semantic 路径：scoped IDE 是怎么被跑起来的

scoped IDE 的入口是 `demo-apps/aotui-ide/src/scoped.ts`：

```ts
export default createTUIApp({
  app_name: 'system_ide',
  component: ScopedIDEApp,
  experimentalAppLifecycle: true,
  ...
});
```

Host 安装时需要显式打开能力：

```ts
runtime.installDynamicWorkerApp(desktopId, ideEntryForRoute('scoped').href, {
  appId: 'local-ide',
  experimentalInteractionModes: ['ordinary-v2', 'ordinary-v1', 'create-if-absent-v1'],
  config: {
    ideToolRoute: 'scoped',
    projectPath,
    ideSessionKey: session,
    ideHistoryPath: path.join(data, 'history.json'),
    AOTUI_DATA_DIR: path.join(data, 'state'),
    enableDiagnosticsRead: true,
    enableWorkspaceCreate: true,
  },
});
```

安装后，`WorkerSandbox` 把 `snapshotShadow` 和 `experimentalReadOnlyViewTools` 传给 Worker；Worker 协商能力，启动 `DomSnapshotShadowProducer`。SDK 的 `View` 在 mount 时分配 `viewInstanceId`；`useViewTypeTool` 的 3 参形式把工具注册到当前 View 的 `viewInstanceId` 上，并生成 safe invoker。

完整链路：

```text
Worker:
  Preact render → View mount → viewTools.mount() → viewInstanceId
  useViewTypeTool(3 参) → viewTools.registerTool(viewInstanceId, ...)
  MutationObserver / registry mutation → projection epoch++
  pushSnapshotFragment():
    1) transformElement → legacy markup + indexMap
    2) projectionBefore = token()
    3) DomSnapshotShadowProducer.captureV2()
       - views: viewId + viewInstanceId + type + name + content
       - refs: ownerViewId + ownerViewInstanceId + payload
       - tools: id + name + viewType + inputSchema + targets[{viewId, viewInstanceId, bindingVersion}]
    4) projectionAfter = token(); epoch 必须一致，否则 SNAPSHOT_PREPARE_FAILED
    5) postMessage SNAPSHOT_PREPARED
Main:
  SnapshotShadowReceiver.acceptPrepared()
    → SnapshotCore.committer.accept()
    → revision / current snapshot
Controller:
  runtime.experimentalCreateAppScope(desktopId, appId, policy)
    → WorkerSandbox.experimentalCreateAppScope()
    → AppWorkerHost.createInteractionScope(policy, resolveInteractionSource)
    → ScopedInteraction.createScope()
Controller:
  client.observe({ viewIds: ['root', 'workspace'] })
    → ObservationRegistry.begin/complete()
    → policy.project() → grant
    → Observation { observationId, source, views, refs, tools, bindings, expiresAt }
Controller:
  client.invoke({ invocationId, observationId, bindingId, input })
    → ScopedInteraction.invoke()
    → ObservationRegistry.resolveBinding()
    → acquire pinned snapshot revision
    → ExecutionResolver.resolve(source)
    → ExecutionBinding.validateInput / isLive / authorize
    → WorkerHost.sendRequest(VIEW_TOOL_INVOKE_ORDINARY_V2)
Worker:
  handle VIEW_TOOL_INVOKE_ORDINARY_V2
    → AppKernel.validateBoundViewTool()
    → AppKernel.validateBoundOrdinaryParametersViewTool()
    → ViewOwnedTools.invokeOrdinaryParameters()
    → safe invoker → SDK helper → IDESession handler
    → ExecutionFact / OperationResult
Main:
  Receipt { succeeded | rejected | failed | accepted | unknown }
```

关键一致性机制：

- **projection epoch**：DOM 变更和 registry 变更都会递增 `SemanticProjectionCoordinator` 的 epoch；capture 前后必须一致，否则不发布 V2 draft。这避免“DOM 是新的、Tool 是旧的”这种混合版本。
- **viewInstanceId**：不是开发者写的 `viewId`，而是 Runtime 在 mount 时分配的内部身份。同 ID 重新挂载会产生新 `viewInstanceId`；旧 binding 不会复活。
- **bindingVersion**：Tool 每次注册 / enable / disable 都会改变；Observation 捕获它，执行时校验。
- **SnapshotCore 同步提交**：`committer.accept` 是同步指针交换，没有 `await` 可以插入；current / history / lease 的预算在提交时计算。
- **Observation pinned source**：`resolveBinding` 用 observation 的 source revision 重新 `acquireToolSource`，而不是用 latest；旧 observation 不会重定向到新对象。
- **Receipt 五态**：`succeeded / rejected / failed / accepted / unknown`；不会把未知结果自动当成未执行，也不会自动重试。

一个必须说清楚的边界：`SnapshotShadowReceiver` 的报告固定是 `mode:'shadow'`、`producerConsistency:'unverified'`、`strictEligible:false`（`runtime/src/adapters/snapshot/shadow-receiver.ts` 顶部接口）；`DomSnapshotShadowProducer` 自己也注明它不是 strict Producer。也就是说：

> **执行语义是严格的（binding / observation / receipt），但投影的原子性仍是 best-effort。**
> projection epoch 减少了“DOM 是新的、Tool 是旧的”这种混合版本，但不能证明 Preact 的所有 passive effects 都在 capture 前完成。

这个区别很重要：Core 的保证是“来源、绑定、执行”的保证，不是“DOM 一定完整”的保证。真正要证明“当前视图完整”，还需要 SDK 的 commit barrier + strict producer + 真实渲染测试。

### 1.6 Runtime 的关键边界数字

这些数字来自 `runtime/docs` 和 `SCOPED_IDE.md`，它们不是产品 SLA，但是框架契约的一部分：

| 资源 | 限制 |
|---|---|
| Snapshot Core current | 默认 32 MiB、1,024 App 记录、65,536 instanceId |
| Snapshot history | 默认 64 项 / 32 MiB / 10 分钟 |
| Observation | 每个 Scope 默认 8 个、30 秒 TTL、10 分钟 Scope |
| Observation 选择 | 256 KiB / 256 bindings |
| Invocation | 默认 64 MiB interaction 预算（分项） |
| Worker Pool | 默认 initial 2 / max 10 / idle 60s（可配置 0–100 / 1–100 / 5–600s） |
| IDE 文件 | 单文件 ≤4 MiB、页 ≤256 KiB、树 ≤10,000 项 / 200 KiB、FileDetail ≤512 KiB |
| IDE LSP | 8 个客户端、每客户端 64 文档、每 App 4 个 pending query、30s query / 45s initialize |
| IDE 搜索 | 独立 Worker、10,000 候选、500 结果、5s deadline |

这些限制的意义是：Runtime 不是“无限资源”的抽象，它明确拒绝超限，而不是悄悄截断或降级。这是框架成熟度的重要标志。

### 1.7 Runtime 的架构评价

**做得对的：**

- **IoC / DIP**：`Kernel` 只依赖 `IDesktopManager`、`IRegistry`、`ITransformer`、`IDispatcher`、`ISystemOperationRegistry`；`createKernel` 注入实现。`WorkerHost` 通过 `ExecutionResolver` 把 Core 和 Worker 解耦。这是合格的框架骨架。
- **Micro-kernel**：`@aotui/runtime/core` 是纯语义内核，不依赖 DOM / Node / Worker / 模型 SDK；`@aotui/runtime` 根入口才是 Node 宿主。这个分层是正确的。
- **资源所有权**：WorkerPool lease、Sandbox close report、App cleanup、persistence flush、lease release，每一层都有明确的“谁拥有、谁等待、谁报告”。这比大多数 Agent 框架认真。
- **一致性**：projection epoch、SnapshotCore 同步提交、viewInstanceId / bindingVersion、observation pinned source，这些是真正的“状态维护”机制，不是概念包装。
- **显式能力协商**：模式、capability、错误码、精确 tarball，避免“能 import 就以为能跑”。

**做得不够的：**

- **双平面没有收敛**：legacy 仍是默认产品面，semantic 仍是显式可选。两套权威、两套错误语义、两套工具路径。框架最怕“两个真相”，因为它会让文档、测试、用户预期都分叉。
- **概念密度过高**：AppInstance、viewInstanceId、bindingVersion、observation、scope、policy、interaction mode、capability、receipt、projection epoch……这些概念对框架作者是必要的，对应用开发者是负担。低门槛还没有真正建立。
- **legacy 的 observation 一致性缺口**：`AOTUIDrivenSource` 三次 acquire 快照，模型看到的 messages / tools / 执行目标可能不一致。semantic plane 解决了，但默认路径没有。
- **Worker 不是安全边界**：文档已经说明，但对外叙事必须一致；否则会被误解为“可以跑不可信插件”。
- **性能 / RSS 不是产品保证**：文档明确说预算只是工程门槛；真实产品需要独立测量。
- **构建/分发漂移**：当前工作树的 `dist` 明显落后于源码（SDK `dist` 没有 `CreateIfAbsentOutcome`，导致 IDE 测试编译失败；Runtime 的 emitted Host/Worker 测试出现 `APP_INIT_ACK_INVALID` / `legacy-unverified`）。这不是语义失败，但它说明“从源码到可验证产物”的路径还没有自动化到可信。

---

## 2. SDK：声明与提交，而不是执行

### 2.1 SDK 在架构中的位置

SDK 是 Runtime 的“开发者界面”，但它不是 Runtime 的替代品。它的核心工作是：

1. **声明 App**：`createTUIApp({ app_name, component, experimentalAppLifecycle? })`。
2. **声明 View**：`<View id type name>`，在 mount 时向 Runtime 注册身份。
3. **声明 Tool**：3 参 View-local `useViewTypeTool`、4 参 legacy type-wide、`experimental_useReadOnlyTool`、`experimental_useCreateIfAbsentTool`。
4. **声明 Ref**：`useDataRef`、`useArrayRef`、`useEntityRef`。
5. **声明状态**：`usePersistentState`。
6. **声明生命周期**：`experimental_useAppLifecycle`。
7. **读取配置 / 宿主事件**：`useAppConfig`、`useAppEnv`、`useLLMOutputChannel`、`useLLMOutputHistory`。

SDK 不做的：

- 不创建 Worker / Desktop / App 实例；
- 不聚合快照、不生成 markup / indexMap；
- 不做 policy / authorization；
- 不调用模型；
- 不拥有业务文件、LSP、数据库；
- 不保证“工具声明 = 执行许可”。`sdk/docs/api-status.md` 反复强调：export 存在不等于可用，声明不等于授权。

SDK 与 Runtime 的接口是 `AppRuntimeContext` 和 `ViewRuntimeContext`：

```text
AppRuntimeContext
  appId, desktopId, launchConfig
  allocateViewId, registerView, unregisterView
  refExporter
  typeTools       // 4 参 legacy
  viewTools       // 3 参 / experimental
  projection      // commit barrier
  persistence     // state-session-v1
  appLifecycle    // app-lifecycle-v2
  markDirty
```

`createTUIApp.initializeComponent` 把这些 port 注入 Preact 树；`View` 和 hooks 再从 context 里取。这个设计是干净的：SDK 只依赖 SPI 形状，不依赖 Worker / Kernel 具体类。

### 2.2 SDK 的 API 分层与成熟度

`sdk/docs/api-status.md` 把“值 export 的状态”分成了 `supported-existing / experimental / legacy-compatible / static-export / not-verified`。这是很好的诚实性设计，但也暴露了当前 API 面的广度。

| API | 成熟度 | 关键条件 |
|---|---|---|
| `createTUIApp`、`View`、`AppRuntimeContext` | supported-existing | Preact 组件 Runtime；`app_name` 必填；Runtime 调用 `initializeComponent` |
| `useState` 等 Preact hooks | supported-existing | Preact 规则 |
| `useAppRuntimeContext`、`useViewContext`、`useAppConfig`、`useAppEnv`、`useRefRegistry` | supported-existing | 组件 Context |
| `useDataRef`、`useArrayRef` | supported-existing | 组件 View 内注册；发布 Ref 不授予执行许可 |
| `useViewTypeTool` 3 参 | experimental（View-local） | 需要 `viewTools` port；普通参数/写操作走 `ordinary-v2` |
| `useViewTypeTool` 4 参 | legacy-compatible | 需要 `typeTools`；旧的 type-wide 语义 |
| `experimental_useReadOnlyTool` | experimental | `ordinary-v2` 或 `snapshot-value-v2` + 私有资格 + Scope |
| `experimental_useCreateIfAbsentTool` | experimental | `create-if-absent-v1` + 受信 Controller / 资源前置条件 |
| `experimental_useAppLifecycle` | experimental | factory opt-in；`app-lifecycle-v2` |
| `useEntityRef` | experimental | 版本化实体 Ref；不授权修改 |
| `usePersistentState` | experimental | `state-session-v1` + 实例端口 |
| `persistenceManager` | deprecated / migration-required | 全部 `PERSISTENCE_SCOPE_REQUIRED` |
| `useLLMOutputChannel`、`useLLMOutputHistory` | supported-existing（环境条件） | 实际 Provider 或 document 事件；没有 Provider 时明确拒绝 |
| `useMountableViewRegistry`、`useDynamicViewRegistry` | 环境条件 / 不可用 | 组件模式 5 个方法明确抛错 |
| `defineParams` | legacy-compatible | 旧 ParamDef 声明与旧校验 |
| `useResourceRef` | deprecated alias | 迁移到 `useDataRef` |

这张表本身就是架构评价：**核心组件 API 是稳定的，新的语义执行 API 几乎都是 experimental。** 这符合“先把契约跑通，再稳定”的策略，但也意味着外部开发者现在很难判断该用哪一套。

### 2.3 如何用 SDK 构建 IDE（legacy）

Legacy IDE 的结构是：

```text
SystemIDEApp (createTUIApp)
├── View id="root" type="Root"
│   └── RootView
│       ├── useViewTypeTool('FileDetail', 'lsp_hover', ...)       // 4 参
│       ├── useViewTypeTool('FileDetail', 'lsp_goto_definition')  // 4 参
│       ├── useViewTypeTool('Workspace', 'search_files_by_pattern')
│       ├── useViewTypeTool('Workspace', 'write_file')
│       └── ...
├── View id="workspace" type="Workspace"
│   └── WorkspaceContent   // 目录树 <pre>
├── FileDetailView id={fd_N} type="FileDetail"
│   └── FileDetailContent  // 文件页、LSP 面板、诊断、操作日志
└── View id="search" type="SearchResult"  (conditional)
    └── SearchResultView
```

关键点：

- `SystemIDEApp` 用 `usePersistentState('activeFiles')`、`usePersistentState('expandedDirs')`，用 `useAppEnv('projectPath')` 初始化工作区；它还维护 `eventBus`、`lspService`、`persistenceService`。
- `RootView` 是真正的“工具中心”：所有 4 参 type-wide 工具在这里注册。因为工具是 type-wide 的，模型必须显式传 `file_path` / `view_id`；`RootView` 还把 `availableFileDetailViews` 拼进工具描述，告诉模型当前有哪些 `fd_N`。
- `FileDetailContent` 自己管理文件内容、LSP 结果、诊断、操作日志；它不通过 SDK 的 View-local tool 机制，而是通过 `eventBus` 接收异步 LSP 结果，再 setState。
- `reconcileFileViewIds` 保证 `fd_N` 与路径的映射稳定，不随数组下标变化；这是对“位置型 View ID”的一个应用层修复。
- 持久化有两套：`usePersistentState`（Runtime 的 App state）和 `persistenceService`（LowDB，业务历史）。这是 legacy 的典型“双持久化”结构。

这个写法的 DX 问题：

- RootView 会变得巨大（工具描述 + 目标列表 + 参数 + handler 全在一个文件）。
- 目标选择靠模型传 `view_id` / `file_path`，Runtime 不校验业务目标。
- 工具定义数量与 View 实例数量绑定在“描述”里，而不是绑定在运行时身份上。
- `availableFileDetailViews` 是动态字符串，时有时无，容易与真实 View 状态失配。

### 2.4 如何用 SDK 构建 IDE（scoped）

Scoped IDE 的结构更接近“框架推荐的写法”：

```text
scoped.ts
└── createTUIApp({ app_name:'system_ide', component: ScopedIDEApp, experimentalAppLifecycle:true })

ScopedIDEApp
├── useAppRuntimeContext() → launchConfig / persistence
├── useMemo(() => new IDESession(persistence, options, render), [])
├── experimental_useAppLifecycle({ stop: () => owner.stop(), close: () => owner.close() })
├── useEffect(() => { owner.start() }, [owner])
└── render:
    ├── View id="root" type="Root" name="IDE"
    │   └── <section data-role="application-instruction"> ... </section>
    ├── View id="workspace" type="Workspace"
    │   └── <Workspace owner> ... <IDETool contract={workspaceTools} .../> ...
    ├── View id={file.viewId} type="FileDetail"  (dynamic)
    │   └── <FileDetail owner file> ... <IDETool contract={fileTools} .../> ...
    ├── View id="search" type="SearchResult"      (conditional)
    │   └── <Search owner> ... <IDETool contract={searchTools} .../> ...
    └── View id={'create_' + index} type="WorkspaceCreate"  (optional)
        └── WorkspaceCreateView → experimental_useCreateIfAbsentTool('create_file_if_absent')
```

`IDETool` 是核心复用单元：

```tsx
function IDETool({ owner, viewId, contract }: { owner: IDESession; viewId: string; contract: IDEToolContract }) {
    const [Tool] = useViewTypeTool(
        contract.name,
        { description: contract.description, params: contract.params, isMutating: true },
        args => owner.invoke(contract.name, args, viewId),
        { enabled: owner.live && owner.ready && (...) }
    );
    return <li><Tool /></li>;
}
```

它体现了四件事：

1. **3 参 View-local 工具**：目标由父 View 绑定，模型不需要传 `view_id` 去选实例。
2. **`enabled` 条件注册**：只有 session ready / 有 root / 有文件等条件满足时才暴露工具；工具随状态出现和消失。
3. **handler 委托给业务 owner**：`IDESession.invoke` 负责路径、版本、文件记录、LSP、搜索等业务校验；SDK 只负责把调用送到正确的 View/Tool binding。
4. **View 是结果呈现**：`Workspace` / `FileDetail` / `Search` 渲染当前状态；工具返回简洁结果，细节在 View 里。

Root View 是“应用指令的单一来源”。Scoped IDE 的实现是：

```tsx
<View id="root" type="Root" name="IDE">
  <section data-role="application-instruction">
    <h1>IDE Application Instruction</h1>
    <h2>What it is</h2>...
    <h2>How to use</h2>...
    <h2>Views</h2>...
    {owner.files.size > 0 && <p>Each FileDetail shows a loaded file...</p>}
    {owner.search && <p>SearchResult shows the latest successful search...</p>}
  </section>
</View>
```

这个 `data-role="application-instruction"` 不是装饰：

- Worker 的 `classifyViewFragment` 会把带 `data-role` 的 View 分类为 `application-instruction`；
- 在 legacy 路径，`SnapshotFormatter` 把它放进 `applicationInstructions`，`AOTUIDrivenSource` 把它放在 `static` 区域，和动态 `viewStates` 分开；
- 在 scoped 路径，`DomSnapshotShadowProducer.captureV2` 把它写成 `kind:'instruction'` 的 View，Controller 观察时仍能区分“指令”和“状态”；
- Root View 里的条件段落（`owner.files.size > 0`、`owner.search`）实现渐进披露：没有 FileDetail 时就不提 FileDetail。

这就是“SDK 的声明”如何一路影响到“模型 / Controller 看到的世界”的例子。它不是一个纯 UI 约定，而是运行时语义的一部分。

`IDESession` 是 scoped IDE 的“业务内核”：

- 用 `persistence.bind(...)` 绑定 `workspaceFolders` / `activeFiles` / `expandedDirs`，并处理恢复、初始化确认、flush；
- 用 `ObservedFile` 记录 file/root/parent identity、content version；
- 用 `createWorkspaceFileCreator` 做条件创建（`create_file_if_absent`）；
- 用 `ScopedLSP` / `ScopedSearch` 管理子进程和 Worker；
- `invoke(name, args, viewId)` 是工具入口，所有业务校验在 `execute` / `executeView` 里；
- `stop()` / `close()` 由 `experimental_useAppLifecycle` 调用；`close()` 释放 persistence bindings、LSP、search、history，并等待 pending 工作。

这里有一个很重要的“框架边界”示范：

> **Runtime 绑定“哪个 View 的哪个 Tool”，App 绑定“这个 View 当前是哪个文件/哪个版本”。**
> `IDESession.executeView` 会校验 `args.file_path === record.observed.path`、`args.view_id === viewId`；Runtime 不替它做这个业务判断。

这就是“框架负责身份/绑定，应用负责业务事实”的正确分工。

### 2.5 SDK 的几个关键设计细节

**① View mount 的身份分配。**

`View` 不把开发者写的 `id` 直接当内部身份。它在 ref callback 里调用 `viewTools.mount(viewId, viewType)`，拿到 `viewInstanceId`，写到 DOM 的 `data-view-instance-id`。这个 callback 在子组件 layout effect 之前执行，所以 View-local Tool 可以在同一个 commit 里注册，不会出现“工具先注册、View 还没 mount”的竞态。

**② Commit barrier。**

`createTUIApp` 的初始 render 和后续 commit 都通过 `projection.beginCommit()` / `endCommit()` 包起来；`ViewOwnedTools` 的 register/unmount 也 `recordMutation`。`SemanticProjectionCoordinator` 用 epoch 记录变更；Worker 的 `pushSnapshotFragment` 在 capture 前后检查 epoch，保证 V2 draft 不是混合版本。

**③ 工具注册的“声明-提交”模型。**

`useViewTypeTool` 的 3 参路径：

- 如果参数非空或 `isMutating`，走 `ordinary-v2`；注册 `safeOrdinaryParametersInvocationMode` 和 `createSafeOrdinaryParametersInvoker`；
- 如果空参数 + `isMutating:false`，走 `ordinary-v1`；
- 如果声明了 `reference`，走 `snapshot-value-v1/v2`，需要 `safeSnapshotValueParametersInvocationSupport`；
- 注册时用 fingerprint 判断声明是否变化；变化则 release + re-register，`bindingVersion` 改变；
- `enabled:false` 会释放绑定，旧 observation 的 binding 失效。

这是一个“声明式注册 + 显式失效”的好模型。它把 React 的 render 语义和 Runtime 的 binding 语义对齐了。

**④ Persistence 的提交边界。**

`usePersistentState` 不是“localStorage 替代品”：

- 需要 `persistence` port（`state-session-v1`）；没有就 `PERSISTENCE_UNAVAILABLE`；
- `bind` 在 layout effect 里发生；初始 setter 在 bind 前会走 `captureValue` 暂存；
- 恢复、初始化确认、setter、flush、clear 都是显式阶段；
- 没有 debounce 定时器；保存是显式 `flush()` 或关闭时 managed flush；
- 失败/unknown 不会被包装成成功；serializer 失败会记录，不会悄悄保存旧值。

这套语义对“Agent 应用”是合理的：状态保存必须可检查，不能靠“过一会儿应该写了”。

**⑤ App lifecycle。**

`experimental_useAppLifecycle({ stop, close })` 只在 `app-lifecycle-v2` 下可用；stop 同步停止新工作，close 可等待真实资源；无回调是正常关闭；每个 App 实例最多登记一次。`close` 的顺序是“撤销调用 → flush → 等待初始化 → unmount → await app close → dispose”。这对 IDE 很重要：LSP 子进程和搜索 Worker 不是 Runtime 的资源，必须由 App 自己清理。

### 2.6 SDK 的 DX 评价

**做得对的：**

- **低门槛的“最小应用”**：一个 `createTUIApp` + 一个 `View` 就能跑；`sdk/README.md` 给了完整最小例子。
- **3 参 View-local tool**：这是真正的 DX 改进，消除了“每个工具都要传 view_id”的泄漏。
- **显式错误**：`SDK_TYPE_TOOLS_UNAVAILABLE`、`REF_CONTRACT_UNSUPPORTED`、`ORDINARY_PARAMETERS_UNSUPPORTED`、`APP_LIFECYCLE_UNSUPPORTED`、`PERSISTENCE_UNAVAILABLE` 等；没有静默降级。
- **渐进披露**：Root View instruction → View → View-local tool → optional read-only/create-if-absent；能力按需出现。
- **Dogfooding**：IDE 本身是 SDK 的重度用户，暴露了真实问题（稳定 View ID、persistence、lifecycle、LSP 清理）。
- **文档诚实**：`api-status.md` 明确区分“导出存在”和“实际可用”，这在框架里很少见。

**还不够好的：**

- **低门槛没有贯穿到“scoped app”**。要构建 scoped IDE，需要理解 AppInstance、InteractionMode、snapshotShadow、ordinary-v2、Scope、Observation、Binding、Policy、Persistence、Lifecycle。最小例子只覆盖了组件/View，没有覆盖“如何被 Agent 观察和调用”。
- **API 面太宽**：3 参/4 参、`useViewTypeTool` / `experimental_useReadOnlyTool` / `experimental_useCreateIfAbsentTool`、`useDataRef` / `useArrayRef` / `useEntityRef` / deprecated `useResourceRef`、`persistenceManager` deprecated、`mountable/dynamic` 不可用。新用户很难判断“我该用哪个”。
- **`view_id` / `file_path` 仍在业务工具参数里**。View-local 工具已经由 Runtime 绑定目标，但 IDE 的 `lsp_hover` 仍要求 `file_path`，`close_file_detail` 仍要求 `view_id`。这既是业务校验，也是目标重复；对模型来说，多一个可能填错的参数。
- **`useArrayRef` 仍是位置型**。Semantic plane 用 viewInstanceId/bindingVersion 解决了 View/Tool 身份，但数组项仍是 `refId[idx]`；列表重排后旧引用可能指向新对象。IDE 用稳定 `fd_N` 规避了这个问题，但 SDK 没有强制。
- **错误信息有 code，但缺少 hint / docsUrl / 上下文**。例如 `REF_CONTRACT_UNSUPPORTED` 只说明不支持，没有告诉开发者“改用 View-local tool 或去掉 Ref 声明”。
- **构建/分发漂移**：源码里的 `experimental_useCreateIfAbsentTool` 导出了 `CreateIfAbsentOutcome`，但本地 `sdk/dist` 没有，导致 IDE 测试编译失败。这是 release engineering 问题，不是 API 设计问题，但会直接影响 DX。
- **注释与实现漂移**：`View.tsx` 顶部还写着“渲染为 `<div id="fd_0" data-view-type="FileDetail">`”，但当前实现还有 `data-view-instance-id`、`viewTools.mount`、`projection` 等；`createTUIApp` 示例仍用旧模式。文档债会变成理解债。

**如果我是 SDK 的负责人，我会：**

1. 把 3 参 View-local 作为唯一推荐入口；4 参 legacy 冻结并在文档中标记“仅兼容”。
2. 把 `experimental_useReadOnlyTool` / `useCreateIfAbsentTool` 合并到一个 `useTool` 的 `mode` 选项，或者至少统一参数形状。
3. 从业务工具参数里移除 `view_id` / `file_path` 这类“目标重复”；业务校验在 handler 内部做，目标由 Runtime binding 提供。
4. 给 `useArrayRef` 增加稳定 key 选项，或明确 deprecated；新应用优先 `useDataRef` + 稳定对象 ID。
5. 给每个错误码加 `hint` / `docsUrl` / `nextAction`；错误是 API 的一部分。
6. 提供一个“scoped hello world”：一个 View、一个 View-local tool、一个 `observe`/`invoke` 的 Controller 示例，10 分钟跑通。
7. 清理 public exports：`mountable/dynamic` 要么实现，要么从根入口移除；deprecated alias 只保留一个迁移周期。

---

## 3. Agent Driver：上下文组装器与单循环

### 3.1 定位与边界

Agent Driver 是“模型执行层”，但它不是“应用运行时”。它的职责是：

- 从多个 `IDrivenSource` 收集消息和工具；
- 按时间戳 / 区域组装成 AI SDK 的 `ModelMessage[]`；
- 修复 assistant/tool 协议；
- 调用 LLM；
- 把 tool call 路由回拥有它的 source；
- 把 assistant / tool / streaming / usage 事件发给 Host。

它不负责：

- 会话持久化（Host 的 MessageService）；
- App 状态 / 文件 / 业务；
- 授权 / policy；
- UI；
- 多 Agent 编排；
- 上下文预算 / 压缩策略（Host source 提供 `context_compact` 工具，Driver 只是路由）；
- provider-specific schema 适配（除 OpenRouter fallback）。

`IDrivenSource` 是它的核心抽象：

```ts
interface IDrivenSource {
  readonly name: string;
  getMessages(): Promise<MessageWithTimestamp[]>;
  getTools(): Promise<Record<string, Tool>>;
  executeTool(toolName, args, toolCallId): Promise<ToolResult | undefined>;
  onUpdate(callback): () => void;
}
```

这个接口的好处是简单、可测试、可替换；坏处是**它没有 observation / binding / revision 的概念**。Source 只给“消息”和“工具名”，Driver 只按工具名路由。对 legacy 够用，对 semantic 不够。

当前 Host 的 source 装配（`host/src/core/session-manager-v3.ts:458`）：

```text
SystemPromptSource   timestamp 0   static   system prompt
AOTUIDrivenSource    timestamp 1   static   AOTUI instruction
                     + dynamic     desktop state + view states
HostDrivenSourceV2   timestamp now session  conversation history + context_compact
SkillDrivenSource    session       skills tools
McpDrivenSource      session       MCP tools
```

IM source 在 IM 场景使用。每个 source 自己负责去重和更新信号。

### 3.2 上下文构建：一条消息流水线

`AgentDriverV2.collectMessages()` 是整条流水线：

```text
1. 遍历 active sources，调用 getMessages()
2. 拼接所有 MessageWithTimestamp
3. 规范化 assistant content（JSON 字符串 → parts 数组；空内容丢弃）
4. 规范化 tool content（tool-result output → {type:'json'|'error-json'}）
5. assembleContextRegions()
   - static  → 按 timestamp 排序
   - session → 按 timestamp 排序，再 splitActiveTail()
   - dynamic → 按 timestamp 排序
   - 拼接顺序：static + compacted session + dynamic + active tail
6. 修复协议：
   - 把 tool message 吸附到匹配的 assistant tool-call 后面
   - 丢弃 orphan tool message
   - 只保留匹配 pendingToolCallIds 的 tool-result parts
7. 返回 ModelMessage[]
```

`assembleContextRegions` 的顺序（`agent-driver-v2/src/core/context-regions.ts:130`）是：

```text
[static] [session 主体] [dynamic 当前视图] [active tail 最后一段工具往返]
```

为什么这样排？

- **static 在前**：系统提示词、AOTUI 指令、应用指令稳定，利于 provider 的 prompt cache。
- **session 主体在中**：历史可压缩（Host 可以丢掉中间部分，保留摘要）。
- **dynamic 在尾部**：当前世界是每轮变化的，放在后面，不污染稳定前缀。
- **active tail 最后**：保留最后一次 assistant tool-call / tool-result 配对，避免 AI SDK 协议断裂。

这个设计是合理的，也是 AOTUI README 里“上下文分区”的工程实现。它不是“把整个桌面塞进 system prompt”，而是把稳定说明、历史、当前状态、当前执行尾部分开。

但要注意：**这不是“模型每轮只看到当前状态”**。它每轮仍然发送 static + session + dynamic + tail；dynamic 是当前视图，但 session 里的历史仍然存在（除非 Host 压缩）。所以 README 里“用当前世界替代历史”是方向，不是字面事实。

### 3.3 工具收集与路由

`collectTools()` 遍历 sources，`Object.assign` 合并到一个 `Record<string, Tool>`；`updateToolMapping()` 再遍历一次，建立 `toolName → source` 映射。

这里有两个值得注意的问题：

1. **同名工具 last-writer-wins。** `Object.assign` 不检测冲突；如果 AOTUI、MCP、Skill 都暴露同名工具，最后一个 source 覆盖前面的。框架应该在注册时拒绝冲突，而不是静默覆盖。
2. **`getTools()` 被调用两次。** `collectTools()` 一次，`updateToolMapping()` 一次；对动态 source（如 AOTUI 每次 acquire 新快照）来说，两次返回的工具集合可能不同。模型看到的工具和实际路由的工具可能不一致。

`buildInputSignature()` 用消息内容哈希 + 工具名列表生成签名，用于跳过重复 LLM 调用。它只包含工具名，不包含工具 schema；如果 schema 变了但名字没变，签名不变，LLM 调用会被跳过。这是一个真实的一致性缺口。

### 3.4 LLM 调用：Provider 抽象与流式

`LLMClient` 的职责：

- 解析 `model` 字符串：`provider:model`、`provider/model`、纯 model 名推断；
- 读取 API key（config 或环境变量）；
- 构造 provider：OpenAI、Anthropic、Google、xAI、DeepSeek、OpenRouter、OpenAI-compatible；
- 调用 `streamText({ model, messages, tools, temperature })`；
- 流式消费 `fullStream`：`text-delta` → `onTextDelta`，`reasoning-delta` → `onReasoningDelta`；
- 收集 `toolCalls`、`finishReason`、`usage`；
- 构造 `assistantMessage`（reasoning + text + tool-call parts）；
- OpenRouter 工具兼容错误时，重试“无工具”一次；
- 输入能力 guard：模型不支持 image/pdf 时，把附件替换成错误文本。

优点：

- Provider 抽象集中在一个文件，Host 不需要知道具体厂商；
- 流式与 reasoning 处理考虑到了 AI SDK 的 Promise 消费顺序（先 `fullStream`，再 `toolCalls` / `finishReason` / `usage`）；
- 输入能力 guard 避免“模型不支持图片却收到图片”的硬失败；
- OpenRouter fallback 是一个务实的兼容补丁。

问题：

- **Usage 映射错误。** AI SDK v6 的 `LanguageModelUsage` 使用 `inputTokens` / `outputTokens`（见 `agent-driver-v2/node_modules/ai/dist/index.d.ts:267`），但代码读取 `promptTokens` / `completionTokens`（`llm-client.ts:324-325`）。按当前类型，usage 会变成 0。这不是小问题：成本统计、上下文预算、性能评估都会失真。
- **没有 AbortSignal。** `streamText` 没有传 `abortSignal`；`AgentDriverV2.stop()` 只设置 `running=false`，不会取消已经在途的 LLM 调用；`dispose()` 只取消订阅。对长任务/关闭场景，这是一个真实的资源边界缺口。
- **Console.log 噪音。** `LLMClient.call` 打印完整 messages / tools / response；`AgentDriver.run` 打印 assistant message。生产环境会泄漏上下文，也会淹没日志。框架应该用带级别/脱敏的 Logger，而不是 console。
- **`maxSteps` 未使用。** `LLMConfig.maxSteps` 在 interface 里，但 Driver 的循环是“一轮 LLM + 工具执行，然后等 source update”；没有强制 step 上限。Host 通过 source update 驱动下一轮，`maxSteps` 目前是装饰性的。
- **`toolCallTimeoutMs` 未使用。** `AgentDriverV2Config.workLoop.toolCallTimeoutMs` 只出现在 interface；`executeToolCalls` 没有 timeout。一个挂起的工具会卡住整个 run。

### 3.5 工作循环：状态机与信号

`AgentDriverV2` 的状态机：

```text
idle → thinking → executing → idle
```

- `onUpdate` 来自 source；debounce（默认 300ms）后 `requestRun()`。
- `requestRun()` 设置 `pending=true`；如果正在 run，直接返回；`drainPendingRuns()` 用单飞行 Promise 保证非重入。
- `run()`：
  1. `collectMessages()` + `collectTools()` + `updateToolMapping()`；
  2. `buildInputSignature()`；与上次相同则跳过；
  3. `LLMClient.call()`；
  4. `onAssistantMessage` / usage / streaming；
  5. 如果有 tool calls：`setState('executing')` → `executeToolCalls()`（顺序 `for...of await`）→ `onToolResult`；
  6. `setState('idle')`；**不立即再次调用 LLM**，而是等 source 更新信号；
  7. 如果工具失败，`toolFailureStreak++`；<3 时 `pending=true` 自动重试；>=3 停止自动重试。
- `pause()` / `resume()`：pause 阻止新的 drain，但保留 pending；resume 触发 drain。
- `trigger()`：手动请求一次 run。
- `stop()`：只设置 `running=false`；`dispose()` 取消 source 订阅。

这个循环的“等待 source 更新”是一个重要设计：它假设工具执行后，source 会发布新状态，Driver 再进入下一轮。好处是模型总能看到最新状态；坏处是：

- 如果 source 不发布更新（例如工具只改了一个非 View 的业务表，没有触发 snapshot），循环会停住。
- 如果 source 在工具结果持久化之前就发布更新，可能出现“模型看到工具结果之前就进入下一轮”的竞态。
- 工具执行是顺序的，但系统提示词鼓励“并行调用独立工具”；两者不一致。

### 3.6 Agent Driver 的边界与缺口

**边界：**

- 不拥有 App 状态、业务语义、授权、持久化、UI。
- 不拥有“当前世界”的维护；它只是把 source 给的消息组装起来。
- 不拥有工具执行；`executeTool` 由 source 实现。
- 不拥有上下文预算；Host 的 `context_compact` 是模型主动调用的工具，不是 Driver 的自动策略。

**缺口（按影响排序）：**

1. **没有接入 Core 的 observation/binding。** 这是最大的断点。模型仍然拿工具名和参数；`executeTool` 重新 acquire 快照；没有 observationId / bindingId / revision / 五态 receipt。Semantic Core 的身份和版本保证没有到达模型。
2. **同轮上下文不一致。** `getMessages` / `getTools` / `executeTool` 各自 acquire 快照；模型看到的 View、工具表、执行目标可能来自不同 revision。
3. **Usage 映射错误。** 成本/预算数据为 0。
4. **没有超时 / 取消。** `toolCallTimeoutMs` 未使用；`streamText` 没有 abortSignal；`stop()` 不取消在途调用。
5. **签名逻辑会误跳过。** `lastInputSignature` 在 LLM 调用前赋值，失败后不清空；相同输入的重试会被跳过。签名不含工具 schema；schema 变化不会触发新调用。
6. **工具冲突静默覆盖。** `Object.assign` last-writer-wins；没有冲突检测。
7. **工具收集两次。** 模型看到的工具和路由映射可能不一致。
8. **source 错误被吞掉。** `getMessages` / `getTools` 失败只 log，run 继续用不完整上下文；模型/用户不会知道。
9. **协议修复可能丢消息。** orphan tool message 被丢弃；如果多 source 时间戳/顺序异常，可能丢掉有效历史。
10. **顺序执行工具。** 与提示词的“并行调用”矛盾；延迟高。
11. **Console.log 泄漏上下文。** 生产不可接受。
12. **没有 trace / inspector。** 一次 run 的消息、工具、结果、usage 没有结构化记录，调试靠 console。
13. **静态指令以 `user` 消息注入。** `SystemPromptSource` 是 `role:'system'`，但 AOTUI instruction / application instruction 是 `role:'user'`（timestamp 1 / static）。这不是错误，AI SDK 允许多条 user 消息；但它会削弱指令的优先级，也让 provider 的 message cache 分层不够清晰。更干净的做法是把静态指令归一到 system 或明确的 instruction 区域。

### 3.7 如果我是 Driver 的负责人

我会把 Driver 的边界收紧成两件事：**上下文组装** + **循环**，然后把“语义来源”作为可插拔的 Source 实现。

**第一步：实现 `ScopedAOTUIDrivenSource`。**

它不应该再返回 legacy snapshot，而是：

```ts
class ScopedAOTUIDrivenSource implements IDrivenSource {
  // per turn
  getMessages(): MessageWithTimestamp[] {
    // 1. observe selected views
    // 2. render current views + instructions into a stable prompt
    // 3. include observationId + selected view/binding metadata (text or tool schema)
  }

  getTools(): Record<string, Tool> {
    // Option A: one generic `aotui_invoke` tool:
    //   input: { observationId, bindingId, input }
    //   schema from observation; bindingId enumerates valid targets
    // Option B: per-binding tools with stable names + bindingId in description
    // Do NOT expose all tools globally; only observation-selected tools.
  }

  executeTool(toolName, args, toolCallId): ToolResult {
    // call ScopeClient.invoke({ observationId, bindingId, input })
    // map five-state receipt to ToolResult
  }

  onUpdate(callback): () => void {
    // new observation available
  }
}
```

**第二步：让 Driver 只收集一次工具。**

`collectTools()` 返回 `{ tools, mapping }`，`updateToolMapping` 复用同一个结果；遇到同名工具直接抛 `TOOL_NAME_COLLISION`，不静默覆盖。

**第三步：修执行边界。**

- `LLMClient.call` 接受 `AbortSignal`；`run` 持有一个 controller；`stop()` / `dispose()` abort。
- `executeToolCalls` 加 per-tool timeout，超时返回 `unknown` 或 `failed`，不要挂死。
- `lastInputSignature` 只在成功调用后设置；失败/取消时清空。
- 签名包含工具 schema（或 source 提供的 contract version），不只名字。
- usage 映射改用 `inputTokens` / `outputTokens`，并保留 cache read/write 明细。
- 去掉 console.log，换结构化 Logger + 可选 trace。

**第四步：让 source 错误可见。**

`collectMessages` / `collectTools` 失败时，不要静默继续；要么给模型一个 `source_error` 消息，要么让 run 失败并通知 Host。框架不能假装上下文完整。

**第五步：统一并行策略。**

要么真正并行执行独立工具（Promise.all + 并发上限），要么在系统提示词里明确“顺序执行”，不要让提示词和行为矛盾。

---

## 4. 系统级评价：这是一个“有正确骨架、但还没收口”的框架

### 4.1 框架级正确的地方

1. **IoC 是彻底的。** Kernel 依赖接口；WorkerHost 依赖 ExecutionResolver；SDK 依赖 SPI port；Driver 依赖 IDrivenSource。每一层都可以替换，不是“继承一个大基类”。
2. **Micro-kernel 是认真的。** `@aotui/runtime/core` 无 DOM/Node/Worker/模型依赖，可以独立消费；`@aotui/runtime` 才是 Node 宿主；SDK 是组件层。这个分层让“语义”可以脱离“宿主”存在。
3. **资源所有权是明确的。** Worker lease、Sandbox close report、persistence flush、App cleanup、Scope close、whenClosed，都有“谁拥有、谁等待、谁报告”。这在 Agent 框架里很少见。
4. **一致性机制是真实的。** projection epoch、SnapshotCore 同步提交、viewInstanceId / bindingVersion、pinned observation，不是概念包装。
5. **渐进披露是产品级的。** App catalog → instruction → View → conditional tools → context regions；这既服务于模型，也服务于开发者理解。
6. **Dogfooding 是彻底的。** IDE 不是玩具，它用到了文件、LSP、搜索、持久化、动态 View、生命周期、条件创建；这些真实需求反过来推动了 Core 的契约。

### 4.2 框架级风险

1. **双平面。** 这是最大的风险。legacy 和 semantic 两套权威同时存在；默认产品走 legacy，scoped 走 semantic；文档、测试、用户预期都会分叉。框架必须在一个 App 实例内选一个平面，并尽快在一个产品切片内只保留一个平面。
2. **概念密度。** AppInstance、viewInstanceId、bindingVersion、observation、scope、policy、interaction mode、capability、receipt、projection epoch……这些对框架作者是必要的，对应用开发者是认知负担。低门槛需要“默认隐藏 80% 概念”。
3. **API 面太宽。** 3 参/4 参、多个 hook、deprecated alias、不可用但导出的 API。新用户无法判断“推荐路径”。框架的“魔法比例”目前偏向“高天花板”，但“低门槛”不足。
4. **错误处理不统一。** Core 有结构化错误；SDK 有 code；Driver 有 log + throw；legacy 有 `OperationResult`；关闭有 report。每一层都能工作，但开发者需要学四套错误语义。
5. **构建/分发漂移。** 精确 tarball、版本号不等于兼容、本地 dist 落后于源码。这些是 release engineering 问题，但会直接破坏“可复现”的框架承诺。
6. **模型循环没有接上 Core。** 这是最关键的架构断点。Core 的身份/版本/五态结果只到达 Controller，没有到达模型。没有这一步，AOTUI 的“工作层”就只是控制器的能力，不是 Agent 的能力。
7. **文档/实现漂移。** 部分注释、示例、README 还停留在旧 API；`View.tsx` 顶部注释、`createTUIApp` 示例、`AOTUIDrivenSource` 的旧描述都需要更新。RDD 要求文档先行，但文档必须与实现同步。

### 4.3 如果我来排优先级

**P0（不做就无法证明架构）：**

1. **一个 App 实例只用一个平面。** scoped 入口只走 Core；legacy 入口明确标记“legacy，不支持 observation/binding”。不要在同一实例混用。
2. **接上 Driver。** 实现 `ScopedAOTUIDrivenSource`，让模型看到 observationId / bindingId，执行走 `ScopeClient.invoke`。这是“工作层”从 Controller 走向 Agent 的唯一路径。
3. **让 build/test 可信。** 统一 workspace、changesets、lockstep 版本；`pnpm install && pnpm build && pnpm test` 从干净 checkout 全绿；不再依赖手工 tarball。
4. **修执行边界。** AbortSignal、tool timeout、usage 映射、signature 清空、工具冲突检测。这些是“框架可信度”的底线。

**P1（让开发者能用）：**

5. **收口 API。** 3 参 View-local 作为唯一推荐；4 参冻结；删除/隐藏 `mountable/dynamic`；deprecated alias 设定移除版本。
6. **错误目录。** 每个 code 有 message / hint / docsUrl / nextAction；SDK 和 Runtime 使用同一套。
7. **一个 scoped hello world。** 一个 View、一个 View-local tool、一个 Controller 的 `observe`/`invoke`，10 分钟跑通；这是最低门槛的证明。
8. **稳定数组引用。** `useArrayRef` 增加稳定 key 或 deprecated；新应用用稳定对象 ID。

**P2（让框架可运营）：**

9. **Inspector / trace。** 结构化记录一次 run 的 messages、tools、observations、invocations、receipts、usage；替代 console.log。
10. **性能 / RSS 预算。** 真实工作负载、p50/p95、内存曲线；文档里的数字要能复现。
11. **第二个 Producer / Host。** 证明 Core 不是只服务于一个 IDE；这是“框架”而不是“产品内部库”的门槛。

### 4.4 五个能证明架构的测试

如果只能做五个测试，我会选：

1. **旧 observation 不会重定向。** 模型看到 A；外部/应用改成 B；用 A 的 binding 调用必须拒绝；重新 observe 后 B 成功。证明“对象身份 + 版本”。
2. **重排 / 卸载 / 重开不复活旧 binding。** 列表重排、View 关闭、同 ID 重开；旧 binding 永远拒绝，新 binding 正常。证明“身份生命周期”。
3. **相同 invocationId 幂等，不同 input 冲突。** 证明“执行去重 + 不重复副作用”。
4. **取消 / 关闭返回 unknown，不自动重试。** 证明“五态结果 + 外部副作用边界”。
5. **完整 IDE 工作流经模型 + Core 跑通。** 打开文件、搜索、编辑、LSP；用业务后置条件判定成功；统计错误对象操作率、token、延迟。证明“模型真的受益”。

如果第 5 个测试能相对 baseline 显著降低“错误对象操作率”或“恢复轮数”，AOTUI 的架构就成立了；如果不能，框架仍然有价值，但价值在“设计/参考实现”，不在“运行时基础设施”。

---

## 5. 结论

把三层放在一起看：

- **Runtime** 是这套系统里最成熟的部分：它有身份、绑定、授权、快照、资源、关闭的完整契约；`semantic Core` 是真正的框架级资产。但它有双平面、概念密度、构建漂移的问题。
- **SDK** 是这套系统里最接近开发者的部分：3 参 View-local tool、View 生命周期、Persistence、Lifecycle 都是正确的方向；但 API 面太宽、低门槛不足、错误信息不够“可行动”。
- **Agent Driver** 是这套系统里最薄弱的一环：它的 `IDrivenSource` 抽象和上下文分区是好的，但它仍然消费 legacy snapshot，没有接入 Core 的 observation/binding；它是“上下文组装器”，还不是“语义执行循环”。

一句话总结：

> **AOTUI 已经证明了“运行时可以维护身份、绑定和状态”，但还没有证明“模型能通过这个运行时更可靠地工作”。**
> 前一半靠 Core 和 IDE 的 scoped 切片；后一半要靠 Driver 接上 Core，并用真实任务对照证明。

如果我是这个框架的架构师，我下一步不会再加一个 App、一个 Host 功能或一个抽象层；我会做三件事：

1. **让一个 scoped App 从模型到 Runtime 全链路跑通**（Driver + Core + IDE）。
2. **让一个干净 checkout 能一键构建、测试、运行**（release engineering）。
3. **让一个外部开发者能在一天内写出并调试一个 scoped App**（DX）。

这三件事做完，AOTUI 才从“优秀的架构探索”变成“可被采用的框架”。

---

## 附录 A：两条链路的时序图

### A.1 Legacy

```text
Host                  Runtime(Kernel)        Worker(AppKernel)        AgentDriver
 │                         │                       │                       │
 │ installDynamicWorkerApp │                       │                       │
 ├────────────────────────>│                       │                       │
 │                         ├── acquire Worker ────>│                       │
 │                         │    INIT               │                       │
 │                         │                       ├─ import App           │
 │                         │                       ├─ createTUIApp         │
 │                         │                       ├─ Preact render        │
 │                         │                       ├─ View register        │
 │                         │                       ├─ Tool register        │
 │                         │<── SNAPSHOT_FRAGMENT ─┤                       │
 │                         │                       │                       │
 │ acquireSnapshot         │                       │                       │
 ├────────────────────────>│                       │                       │
 │                         ├─ SnapshotFormatter    │                       │
 │<── CachedSnapshot ──────┤                       │                       │
 │                                                                         │
 │ getMessages / getTools                                                  │
 ├────────────────────────────────────────────────────────────────────────>│
 │                         │                       │                       ├─ collect
 │                         │                       │                       ├─ assemble regions
 │                         │                       │                       ├─ LLM call
 │                         │                       │                       ├─ tool call
 │ executeTool             │                       │                       │
 │<────────────────────────────────────────────────────────────────────────┤
 ├────────────────────────>│ execute               │                       │
 │                         ├── dispatch ──────────>│                       │
 │                         │                       ├─ handler              │
 │                         │                       ├─ setState             │
 │                         │<── new snapshot ──────┤                       │
 │                         │                       │                       │
```

### A.2 Scoped

```text
Controller              Runtime(WorkerHost)      Worker(AppKernel/SDK)     App(IDESession)
 │                         │                       │                       │
 │ install(scoped)         │                       │                       │
 ├────────────────────────>│                       │                       │
 │                         ├── INIT + capabilities>│                       │
 │                         │                       ├─ View mount           │
 │                         │                       ├─ viewInstanceId       │
 │                         │                       ├─ Tool register        │
 │                         │<── SNAPSHOT_PREPARED ─┤                       │
 │                         ├─ SnapshotCore.accept  │                       │
 │                         │                       │                       │
 │ createAppScope(policy)  │                       │                       │
 ├────────────────────────>│                       │                       │
 │<── ScopeClient ─────────┤                       │                       │
 │                         │                       │                       │
 │ observe({viewIds})      │                       │                       │
 ├────────────────────────>│                       │                       │
 │                         ├─ ObservationRegistry │                       │
 │<── Observation ─────────┤                       │                       │
 │                         │                       │                       │
 │ invoke(obsId,binding)   │                       │                       │
 ├────────────────────────>│                       │                       │
 │                         ├─ resolve binding      │                       │
 │                         ├─ validate / authorize │                       │
 │                         ├── VIEW_TOOL_INVOKE ──>│                       │
 │                         │                       ├─ ViewOwnedTools       │
 │                         │                       ├─ safe invoker         │
 │                         │                       ├─ handler ────────────>│
 │                         │                       │<── OperationResult ───┤
 │                         │<── ExecutionFact ─────┤                       │
 │<── Receipt ─────────────┤                       │                       │
 │                         │                       │                       │
 │ new snapshot            │                       │                       │
 │<── SNAPSHOT_PREPARED ───┤                       │                       │
```

---

## 附录 B：关键文件索引

| 主题 | 文件 |
|---|---|
| Runtime 入口 / facade | `runtime/src/index.ts`、`runtime/src/facades/facades.ts` |
| Kernel | `runtime/src/kernel/index.ts`、`runtime/src/spi/runtime/kernel.interface.ts` |
| App / Worker | `runtime/src/engine/app/manager.ts`、`worker-sandbox.ts`、`worker-host.ts`、`worker-pool.ts` |
| Worker Runtime | `runtime/src/worker-runtime/index.ts`、`app-kernel/AppKernel.ts` |
| 语义 Core | `runtime/src/core/snapshot/`、`runtime/src/core/tool/`、`runtime/src/core/invocation/` |
| Snapshot / Observation | `runtime/src/core/snapshot/store.ts`、`runtime/src/core/invocation/observation-registry.ts` |
| Scoped Interaction | `runtime/src/core/invocation/scoped-interaction.ts` |
| Projection | `runtime/src/core/projection/coordinator.ts`、`runtime/src/worker-runtime/dom-snapshot-producer.ts` |
| Shadow Receiver | `runtime/src/adapters/snapshot/shadow-receiver.ts` |
| 旧 AOTUI Source | `runtime/src/adapters/aotui-driven-source.ts` |
| Runtime 文档 | `runtime/docs/core-public-entry.md`、`runtime-app-interaction.md`、`worker-lifecycle.md`、`tool-lifecycle.md`、`persistence.md`、`runtime-shutdown.md` |
| SDK 入口 | `sdk/src/index.ts`、`sdk/src/app-factory/createTUIApp.ts`、`sdk/src/components/View.tsx` |
| SDK 工具 | `sdk/src/hooks/useViewTypeTool.ts`、`useReadOnlyTool.ts`、`useCreateIfAbsentTool.ts` |
| SDK 状态 / 生命周期 | `sdk/src/hooks/usePersistentState.ts`、`useAppLifecycle.ts` |
| SDK 文档 | `sdk/README.md`、`sdk/docs/api-status.md`、`ordinary-v2.md`、`readonly-ref-v2.md`、`tool-lifecycle.md`、`persistence.md`、`runtime-compatibility.md`、`migration.md` |
| IDE legacy | `demo-apps/aotui-ide/src/tui/SystemIDEApp.tsx`、`RootView.tsx`、`WorkspaceContent.tsx`、`FileDetailContent.tsx` |
| IDE scoped | `demo-apps/aotui-ide/src/scoped.ts`、`tui/ScopedIDEApp.tsx`、`core/ide-session.ts`、`tui/ide-tool-contracts.ts` |
| IDE 文档 | `demo-apps/aotui-ide/SCOPED_IDE.md` |
| Agent Driver | `agent-driver-v2/src/core/agent-driver-v2.ts`、`context-regions.ts`、`llm-client.ts`、`provider-factory.ts`、`interfaces.ts` |
| Agent Driver 文档 | `agent-driver-v2/README.md`、`docs/agent-driver-migration/01-feature-overview.md`、`03-module-map.md`、`04-data-flow.md` |
| Host 装配 | `host/src/core/session-manager-v3.ts`、`host/src/adapters/host-driven-source.ts`、`system-prompt-source.ts` |

## 附录 C：本次测试状态（本地，2026-10-28）

| 包 / 范围 | 结果 |
|---|---|
| SDK（`vitest run`） | 25 个文件，429 项通过 |
| Agent Driver（`vitest run`） | 3 个文件，19 项通过、1 项跳过 |
| Runtime（`vitest run --exclude '**/*e2e*'`） | 144 个文件通过，2 个文件 31 项失败；2,628 项通过、50 跳过、7 todo |
| Runtime（全量，含 e2e） | 148 个文件通过，16 个文件 162 项失败；2,644 项通过、118 跳过、7 todo |
| IDE（`jest`） | 6 个 suite 通过、2 个 suite 编译失败；28 项通过 |

失败集中在 `worker-host.ordinary-v2.test.ts`、`worker-host.ref-v2.test.ts` 等 explicitly emitted SDK / Host / Worker 的场景：`APP_INIT_ACK_INVALID`、`legacy-unverified`、`acceptedCapabilities` 不匹配；IDE 的两个 suite 是因为本地 `sdk/dist` 没有 `CreateIfAbsentOutcome`（源码 `sdk/src/index.ts:186` 已导出）。这证明的是**当前工作树的 dist 与源码不同步**，而不是 semantic Core 的单测失败。Runtime 的纯 core / invocation / snapshot 单测是绿的；要得到可信的 e2e 结论，需要按仓库文档重建三包 / 安装精确 tarball。

> 这个测试状态本身就是一个框架级发现：**一个框架如果要求“版本号相同不足以证明兼容”，那它必须同时提供一条一键、可复现、从干净 checkout 到全绿的构建路径。** 否则“精确产物”会变成使用者的负担。

## 附录 D：术语表

| 术语 | 含义 |
|---|---|
| AppInstance | Runtime 为一个 App 逻辑实例分配的运行身份；不能跨重启复用 |
| View / ViewInstance | `View` 是开发者声明的界面单元；`ViewInstance` 是 Runtime 在 mount 时分配的内部身份 |
| Binding / bindingVersion | Tool 与 ViewInstance 的绑定；注册/启用/禁用会改变版本 |
| Observation | 一次 pinned 的快照选择，含 views / refs / tools / bindings / source revision |
| Scope | 一个受信 Controller 与一个 AppInstance 的交互会话；有 TTL / 容量 |
| Policy | Host 制定的 project / authorize / canReadReceipt 策略 |
| Receipt | 一次 invoke 的结果：succeeded / rejected / failed / accepted / unknown |
| Context Region | static / session / dynamic / active tail 四段上下文 |
| DrivenSource | Agent Driver 的数据源接口：messages / tools / execute / update |
| Projection Epoch | SDK/Worker 的语义投影版本；用于防止发布混合版本快照 |
| Legacy plane | Kernel + SnapshotFormatter + AOTUIDrivenSource 的旧路径 |
| Semantic plane | SnapshotCore + ViewOwnedTools + ScopedInteraction 的新路径 |

---

*本文基于 2026-10-28 的工作树。项目仍在快速演进，具体行号和测试数字会变化；但“Runtime 的双平面、SDK 的声明边界、Driver 的上下文组装”这三个结构性判断，在短期内不会变。*
