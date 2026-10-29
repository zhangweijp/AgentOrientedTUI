# AOTUI SDK / Runtime 评审：从“可运行原型”到“可复用 Infra”

> 视角：系统 / 框架架构师  
> 日期：2026-10-28（Asia/Shanghai）  
> 范围：SDK 与 Runtime；Agent Driver 只作为消费端契约讨论  
> 方法：读根目录文档、`runtime/docs`、`sdk/docs`、`SCOPED_IDE.md` 与 RFC 0003；读 core / engine / worker / sdk 源码；跑 SDK、Runtime、IDE 测试；用“打开 test.txt → 出现 edit tool → 编辑 → 只保留最新 View → 关闭 → 旧 binding 失效”这条规范示例逐层核对。

---

## 0. 评审结论

### 0.1 一句话

> **这个项目最有价值的是 Core 的“身份 / 绑定 / 观察 / 回执 / 资源”语义；最薄弱的不是实现能力，而是模型侧的公开契约和 SDK 的 authoring 模型。**
>
> 我不建议推倒 Core；我建议推倒 **model-facing layer** 和 **legacy plane**，在 Core 之上重做一层更小、更严格的 v2 契约。

### 0.2 相对目标的评分（主观）

| 维度 | 当前 | 判断 |
|---|---:|---|
| 概念设计 | 6/10 | View / Tool / Receipt / Binding 的方向是对的；CQRS、动态 Tool、View 能力面没有真正闭环 |
| 系统设计 | 5/10 | Core 很强，但双平面、包边界、上下文投影和发布时序没有收口 |
| 代码实现 | 6/10 | 关键机制真实存在；但旧的全局 Tool、tool-ref、data in result、dist 漂移拖累 |
| Infra 可复用性 | 4/10 | `@aotui/runtime/core` 语义上可复用，但包依赖仍包含 AI SDK / Preact / DOM |
| Agent 作为 SDK 开发者 | 3/10 | 文档、API 面、Preact hook 规则、experimental 模式对 Agent 都不友好 |

### 0.3 最关键的十个问题

| # | 问题 | 层 | 严重度 | 一句话 |
|---|---|---|---|---|
| 1 | Tool result 仍然承载业务数据 | 概念 / 代码 | **P0** | 违反 CQRS；旧数据会进入 Messages 历史，View 不是唯一真相 |
| 2 | View 没有真正承载“可用 Tool” | 概念 / 代码 | **P0** | `tool-ref` 只是纯文本；Tool 注册与 View 内容分离；模型看到的是全局工具表 |
| 3 | 没有 publish / observe barrier | 概念 / 系统 | **P0** | handler 返回时 View 可能还没提交；receipt 与 View 可见性没有契约 |
| 4 | 原生 Tool 的目标身份不成立 | 概念 | **P0** | 同一 View Type 多实例时，一个 Tool 名无法表达“操作哪个 View” |
| 5 | 动态 Tool 暴露没有成为框架不变量 | 系统 / 代码 | **P0** | legacy type-wide Tool 全部导出；IDE 的 `edit_file` 在无文件时仍暴露 |
| 6 | 上下文投影没有显式 View slot | 系统 | P1 | 依赖 source 重新生成 + timestamp 排序；View 更新会改变顺序，cache 抖动 |
| 7 | SDK 不是 Agent-first | 概念 / 系统 | P1 | Preact/hook/experimental API 对 Agent 生成不友好；没有单一声明和 conformance |
| 8 | Runtime 包不是干净的 Infra 包 | 系统 | P1 | root 依赖 AI SDK / Preact / happy-dom / linkedom / agent-driver |
| 9 | 术语、模式、版本膨胀 | 概念 / 系统 | P1 | Tool/Action/Operation/ViewTool、5 种 mode、3/4 参重载、V1/V2 |
| 10 | build / test / docs 漂移 | 代码 | P1 | dist 落后源码；默认 system instruction 描述的输出格式与实际不一致 |

这张表会在下文展开。先给三条最重要的判断：

1. **Tool result 不是 View 的第二个数据通道。** 如果 Tool 还能返回业务数据，CQRS 只是命名，不是约束；Messages 里会长期保留旧数据。
2. **View 必须是 Tool 的唯一能力来源。** 如果 Tool 仍然由全局注册表决定，View 只是文本，充血模型没有落地；动态 Tool 只是“全局工具表变长变短”。
3. **没有 publish / observe barrier，CQRS 和动态 Tool 都不成立。** 模型可能在 Tool 返回后看到旧的 View，或者在下一次观察中拿不到刚刚承诺的更新。

### 0.4 先说做得对的

这不是一份“否定式”评审。以下设计是继续投入的理由：

- **3 参 View-local Tool 是正确方向。** 目标由父 View 绑定，模型不需要传 `view_id`；它把“Tool 定义”从“View 实例数量”里解耦出来。
- **`viewInstanceId` / `bindingVersion` 是真正的对象身份。** 它不是字符串约定，而是运行时持有的结构化身份；关闭/重开/重注册都有明确失效语义。
- **`SnapshotCore` / `Observation` / `Receipt` 的方向是对的。** 不可变快照、pinned observation、五态结果、幂等、容量、lease，这些都是 Infra 级语义。
- **`projection` epoch 是真实的提交屏障。** 它把 DOM 变更、View 注册、Tool 注册纳入同一个版本，避免发布混合快照。
- **IDE 是彻底的 dogfooding。** 文件、LSP、搜索、动态 View、持久化、生命周期、条件创建都真实用到了 SDK/Runtime；这比任何 Demo 都有说服力。

问题不在于“这些机制不存在”，而在于 **它们还没有成为公开的、默认的、模型能感受到的契约**。下文批评的目的，是把这些机制从“实现细节”提升为“产品语义”。

---

## 1. 先定义不变量：Infra 到底要保证什么

从你给的目标和示例，我提炼出十条不变量。它们不是实现细节，而是任何宿主、任何渲染技术、任何模型都必须满足的语义。

| # | 不变量 | 当前状态 |
|---|---|---|
| I1 | 同一个逻辑 View 在当前上下文中只有一份最新快照；更新是替换，不是追加 | **部分**：依赖 source 重新生成；没有显式 slot；timestamp 会改变顺序 |
| I2 | View 消息与应用工作记忆有明确所有权；动态 View 不被持久化；真实用户消息、receipt、审计历史分开 | **部分**：`region` 只是 hint；Host 未强制 |
| I3 | Tool 可用性来自当前 View / 对象上下文；Tool 隐藏不等于授权，执行时仍要校验 | **部分**：scoped 路径接近；legacy 路径不满足 |
| I4 | Tool 只返回操作收据 / 提示 / 恢复信息；业务数据只在 View 中 | **不满足**：`OperationResult.data`、`ActionResult.value`、IDE 的 search/LSP 返回 data |
| I5 | 操作完成、View 提交、下一次观察可见之间有明确顺序保证 | **不满足**：没有 publish barrier；receipt 可能先于 View 提交 |
| I6 | 对象身份稳定；View 关闭 / 重开后旧 binding 失效；不会误操作新对象 | **部分**：Core 有 `viewInstanceId` / `bindingVersion`；模型侧看不到 binding |
| I7 | 一次观察得到的 View、Tool、目标来自同一已提交状态 | **不满足**：legacy `getMessages` / `getTools` / `executeTool` 各取一次快照；semantic 有 observation，但 model source 未接入 |
| I8 | 上下文有界、顺序稳定；View 更新不导致无关前缀抖动 | **部分**：有容量限制；排序按 timestamp，会抖动 |
| I9 | SDK 用一份声明同时得到 View 内容、对象引用、可用 Tool、输入校验；Agent 能据此生成正确应用 | **不满足**：View、Tool、params、enabled 分开声明；tool-ref 不是语义动作 |
| I10 | Runtime Core 与宿主 / 渲染 / 模型厂商解耦；不同宿主可实现同一组不变量 | **部分**：`@aotui/runtime/core` 是纯的；但 root 包依赖 AI SDK / Preact / DOM |

这十条里，I1、I3、I4、I5、I7、I9 是当前最需要补的。它们不是“再加一个功能”，而是**公开契约应该长什么样**。

### 1.1 职责矩阵：SDK / Runtime 不替 App 兜底

按你的约束 6“应用层自己的职责，SDK 和 Runtime 不应兜底”，我建议把边界写成下面这张表。它是后文所有建议的基准。

| 关注点 | SDK | Runtime | App | Host |
|---|---|---|---|---|
| View 内容 / 结构 | **声明**（View/组件/渲染函数） | 投影为 ViewMessage；不解释业务 | **实现**内容与业务状态 | 展示 / 序列化 |
| View 生命周期 | 声明 mount/unmount 语义 | 分配 `viewInstanceId`；失效 binding | **决定** open/close/update | 触发 / 展示 |
| Tool 声明 / 输入 schema | **声明** | 校验、注册、binding | 实现 handler | 不涉及 |
| Tool 可用性 | 声明在哪个 View 内 | **从当前 View 实例派生** | 业务前置条件 | policy 收窄 |
| 业务数据 | 不拥有 | 不拥有 | **拥有** | 不拥有 |
| 业务版本 / 条件写入 | 不拥有 | 不拥有 | **拥有** | 不拥有 |
| 操作结果 | 定义 Receipt 形状 | 校验 / 记录 / 去重 | **产生 Receipt** | 持久化 / 展示 |
| View → Message 投影 | 提供 content | 提供 observation / binding | 不拥有 | **ContextProjector** |
| 授权 | 不拥有 | **执行** binding / policy | 业务条件 | **制定 policy** |
| 资源 / 进程 | 不拥有 | **拥有** Worker / pool / close | 清理自己的外部资源 | 配置 / 观测 |
| 模型循环 | 不拥有 | 不拥有 | 不拥有 | **拥有**（Driver/Host） |
| 错误诊断 | 声明期错误 | binding / 执行错误 | 业务错误 | 用户可见错误 |

这张表的关键点是：

- **Runtime 负责“身份、绑定、授权、资源”，不负责“业务是否正确”。**
- **SDK 负责“声明与提交”，不负责“执行与授权”。**
- **App 负责“业务事实与业务版本”，不要求 Runtime 替它判断文件/LSP/工单。**
- **Host 负责“上下文投影、模型循环、持久化、策略”。**

后文的批评，基本都是这张表里某一行没有被公开契约兑现。

---

## 2. 概念设计问题

### 2.1 CQRS 没有真正落地：Tool result 仍在承载数据

你的约束写得很清楚：

> Tool 只是发起某个操作，具体的数据变化体现在 View；Tool 返回操作结果、必要提示及恢复信息。

但当前公开类型不是这样：

```ts
// runtime/src/spi/core/operations.ts:94
export interface OperationResult {
    success: boolean;
    data?: Record<string, unknown>;   // ← 业务数据仍然可以从 Tool 返回
    error?: OperationError;
    effects?: 'none' | 'partial';
}
```

`AOTUIDrivenSource.executeTool` 直接把 `result.data` 放进 ToolResult：

```ts
// runtime/src/adapters/aotui-driven-source.ts:536
result: result.data || { success: true }
```

semantic Core 也一样：`mapExecutionFact` 把成功的 `OperationResult` 映射为 `succeeded`，并把整个 result 放进 `value`：

```ts
// runtime/src/core/invocation/invocation-outcome.ts
if (result.success) return {
  executionPhase: phase,
  queryTerminal: true,
  outcome: Object.freeze({ status: 'succeeded', value: result })
};
```

`experiments/semantic-kernel` 的 `ActionResult` 也有 `succeeded.value`。这意味着 **Core 本身没有区分“收据”与“业务数据”**；它只是一个通用 action 结果通道。对 AOTUI 的 CQRS 目标来说，这是根本性的概念冲突。

更具体地看 scoped IDE：

- `IDESession` 的 search 返回 `success(result)`，`result` 里是 `paths`；`Search` View 又渲染 `search.paths`。**同一份搜索结果在两处出现。**
- `lsp_hover` / `lsp_find_references` 返回 `success(result)`，`FileDetail` View 又渲染 `panels[kind]`。**同一份 LSP 结果在两处出现。**
- Host 会把 ToolResult 存进会话历史；这些数据会长期留在 Messages 里。于是“只保留最新 View”被 ToolResult 里的旧数据破坏了。

这不是小问题。它直接导致：

- 模型看到两份“当前数据”，一份在 ToolResult，一份在 View；
- 旧数据不会随 View 关闭而消失；
- 上下文成本增加，CQRS 的收益消失；
- App 作者没有一个强制的“数据放哪里”的边界，只能靠自觉。

**我的判断：**

> AOTUI 的公开 Tool 结果必须是 **Receipt-only**。Receipt 可以包含 `status / message / viewId / viewRevision / effects / operationId`，但不能包含任意业务 `data`。
> 如果某个 Tool 需要返回数据，它应该创建或更新一个 View，并在 Receipt 中指向那个 View 的 revision。

这将是最大的 Breaking Change，但也是让 CQRS 从“文档约束”变成“类型约束”的唯一办法。

### 2.2 View 没有真正承载可用 Tool

你的目标是“充血模型”：View 不仅是数据，还承载当前工作对象和可用操作。当前实现只完成了一半。

**① `tool-ref` 没有 Transformer visitor。**

SDK 的 `useViewTypeTool` / `useReadOnlyTool` 渲染：

```tsx
h('tool-ref', {
  'view-type': viewType,
  'tool-name': toolName,
  desc: description,
}, children || toolName)
```

但 `runtime/src/engine/view/transformer/visitors/` 里没有 `tool-ref` visitor；它会落到 HTML fallback，最后只是把 children 拼成文本。也就是说：

- View 里出现的是 “Run Web Search” 这样的纯文本；
- `view-type`、`tool-name`、`desc` 这些属性全部丢失；
- 模型无法从 View 里知道“这是一个可调用的 Tool、它的名字是什么、输入是什么”；
- Tool 的真实定义仍然在全局工具表里。

**② View 内容和 Tool 注册是两套声明。**

`ScopedIDEApp` 里：

```tsx
<ul>{workspaceTools.map(contract => <IDETool ... />)}</ul>
```

`IDETool` 内部又调用 `useViewTypeTool` 注册 Tool。View 的列表和 Tool 的注册是同一个循环，但仍然是两个机制：一个渲染 label，一个注册 schema。它们可以不一致：

- `enabled:false` 时 Tool 不注册，但 `<li><Tool/></li>` 可能仍渲染一个空项；
- Tool 描述里有参数，View 里只有名字；
- Tool 是 type-wide 的，View 是实例级的，二者没有共享的 binding identity；
- `experimental_useCreateIfAbsentTool` 甚至不返回 UI：`WorkspaceCreateView` 的 View 内容里没有对应的 Tool 标记，Tool 只存在于全局工具表。

这说明“View 是能力面”目前只是约定，不是类型/运行时保证。

**③ 实际模型看到的是全局工具表，不是 View 的能力面。**

Legacy 路径的 `worker-runtime` 会把 **所有** type tools 写进 `indexMap`，没有按 mounted View 过滤：

```ts
// runtime/src/worker-runtime/index.ts:997
const allTypeTools = kernel.getAllTypeTools();
for (const [viewType, tools] of allTypeTools) {
  for (const tool of tools) {
    finalIndexMap[`tool:${semanticAppName}-${viewType}-${tool.name}`] = { ... };
  }
}
```

`AOTUIDrivenSource.getTools` 再把这些全部转成 LLM tools，只按 app 是否禁用过滤，不按 View 是否打开过滤。于是：

- 没有打开文件时，`lsp_hover` / `edit_file` 仍可能在工具表里（取决于 app 的 `enabled` 条件）；
- View 里写着“可用操作”，工具表里却是全集；
- 模型无法把“这个按钮”与“那个 View 实例”绑定。

**我的判断：**

> View 应该是 Tool 的唯一能力来源：SDK 用一份声明生成 View 内容、Tool 描述、输入 schema 和 binding；Runtime 从当前 View 实例派生可用 Tool；LLM 只看到当前观察中的 Tool。
> 全局 Tool 注册表可以作为内部索引，但不能作为模型侧的能力来源。

### 2.3 没有 publish / observe barrier

你的示例要求：

> edit_file 返回操作收据；数据变化体现在 View；下一次呈现时旧快照退出，最新快照进入 Messages。

当前实现没有定义“操作完成”和“View 可见”之间的顺序：

- `ViewOwnedTools.invokeOrdinaryParameters` 调用 SDK safe invoker；handler 更新 React state；
- Preact 渲染后，Worker 的 `MutationObserver` 在 16ms 节流后 `pushSnapshotFragment`；
- `SnapshotShadowReceiver` 提交新的 V2 snapshot；
- 但 `invoke` 的 receipt 在 handler 返回时就已产生，**不等 View 提交**。

结果是：

- Controller 可以立刻 `observe`，看到旧的 View；
- Agent Driver 可以因为 ToolResult / 其他 source 更新而进入下一轮，看到旧 View；
- Receipt 说 succeeded，View 还是旧内容；
- 模型无法知道“现在看到的是不是操作后的状态”。

Legacy 的 `AOTUIDrivenSource` 更明显：`executeTool` 返回后，Worker 的 DOM 更新是异步的；Driver 的“执行完 Tool 后回到 idle，等 source 更新”是一个 workaround，但不是契约。

**我的判断：**

> 一个 AOTUI 操作必须定义 `receipt` 与 `view commit` 的顺序。最干净的契约是：
> - Receipt 包含 `viewId` / `viewRevision`，或者 `status: accepted` + `operationId`；
> - Runtime 保证 `succeeded` 的 receipt 对应的 View revision 已经提交，或明确返回 `accepted` 让 Host 等下一次观察；
> - `observe` 支持 `afterRevision` / `waitForViewRevision`，让 Host 可以等到操作后的 View。

没有这个契约，CQRS、动态 Tool、长任务都只能“大概能跑”。

### 2.4 没有显式的 View → Message 投影契约

你的目标是“Agent 通过应用对 Messages 做 CRUD”。当前实现的效果是：

- `AOTUIDrivenSource.getMessages` 每轮重新生成 static + desktop + view messages；
- 旧的动态消息不在 Host 历史里（因为 Host 只存 user/assistant/tool），所以不会重复；
- 但这依赖 Host 的实现细节，而不是一个显式的“View 消息所有权”契约。

具体问题：

**① 没有 slot，只有 timestamp。**

`ViewFragmentExtractor` 在内容变化时更新 timestamp：

```ts
if (prevDigest !== digest) {
  viewDigestCache.set(key, digest);
  viewTimestampCache.set(key, now);
}
```

`AOTUIDrivenSource` 用这个 timestamp 作为动态消息时间；`assembleContextRegions` 按 timestamp 排序。于是：

- 打开/编辑一个文件会改变它的 timestamp，把它移到 dynamic 区域的末尾；
- 多 View 时，一次更新会改变 View 之间的顺序；
- View 顺序变化会改变上下文，影响缓存和模型理解；
- “替换同一个 slot”在文本上表现为“移动 + 内容变化”，不是稳定的 in-place update。

**② `region` 只是 hint，不是强类型。**

`MessageWithTimestamp.region?: 'static' | 'session' | 'dynamic'` 是可选字段；Host 可以忽略；没有 `view` / `receipt` 的区分。框架不能保证动态 View 不被持久化。

**③ 模型看不到 revision / instance。**

`buildViewMessageMarkup` 只写：

```text
id / type / name / app_id / app_name
```

没有 `viewInstanceId`、`revision`、`updatedAt`。模型无法判断：

- 这是同一个 View 的新快照，还是另一个同名 View；
- 旧消息里的 View 是否已经关闭；
- 这次更新的版本号是什么。

**我的判断：**

> 需要一个显式的 `ViewMessage` 契约：
> - 每个逻辑 View 一个稳定 slot；
> - 更新替换 slot 内容，不改变顺序；
> - 关闭删除 slot；
> - 动态 View 不持久化，receipt 持久化；
> - 可选地带 `revision` / `updatedAt`，让模型知道新旧。
>
> 这不一定要求 Runtime 直接修改 Messages 数组；Host 可以在每次请求组装时按 slot 投影。但契约必须是显式的、可测试的。

### 2.5 动态 Tool 暴露没有成为框架不变量

你的示例：

> 没有打开文件时，不暴露 edit_file；打开 test.txt 后，edit_file 暴露。

当前实现有两个问题：

**① Legacy 路径把 type-wide Tool 全部导出。**

`worker-runtime` 把 `getAllTypeTools()` 全部写入 indexMap；`AOTUIDrivenSource` 全部转成 LLM tools。即使 SDK 的 `enabled:false` 会 unregister，条件是 App 自己写的。框架没有“按 mounted View 过滤”的不变量。

**② IDE 的 `edit_file` 在无文件时仍然暴露。**

Legacy `RootView` 的 `write_file` / `edit_file` / `delete_file` / `rename_file` / `batch_edit` 的 enabled 条件是：

```ts
{ enabled: workspaceFolders.length > 0 }
```

不是 `activeFiles.length > 0`。所以只要工作区存在，`edit_file` 就在工具表里；模型可以调用，然后得到失败（例如 “file not loaded”）。这不符合“未打开文件不暴露编辑能力”。

Scoped IDE 稍好：`lsp_*` / `close_file_detail` 在 FileDetail View 内，只有文件打开才渲染。但 `workspaceTools` 仍包含 `edit_file` / `write_file` / `delete_file` / `rename_file`，`IDETool` 的 enabled 条件仍是 `owner.roots.length > 0`。因此即使 scoped，`edit_file` 仍然会在没有打开文件时暴露，只是 handler 会 `IDE_FILE_NOT_LOADED`。

**我的判断：**

> 动态 Tool 暴露必须是框架不变量，不是 App 的自觉：
> - Tool 声明在 View 内，Tool 的可见性由 View 实例的 mount 状态决定；
> - view-specific Tool（edit/delete/rename/LSP/close）不应声明在 Workspace View；
> - Runtime 从当前观察的 View 集合派生 Tool 集合；
> - 隐藏 Tool 之后，执行时仍要做 binding / business 校验。

这不是“再加一个 filter”，而是把 Tool 的声明位置和可见性绑定起来。

### 2.6 原生 Tool 的目标身份不成立

这是我认为最值得你重新思考的概念问题。

当同一个 View Type 有两个实例（两个 FileDetail，`fd_0` / `fd_1`），SDK 的 View-local Tool：

- 在 `ViewOwnedTools` 里注册为同一个 tool ID（`[appId, viewType, toolName]`）；
- 有两个 targets（两个 `viewInstanceId`）；
- 模型侧的工具表里只有一个 `edit_file`；
- 模型调用时没有 target 参数（3 参 View-local Tool 不需要 `view_id`）；
- 那 Runtime 应该操作哪个 View？

当前 scoped 路径的答案是：Controller 从 Observation 里选一个 binding，然后 `invoke({ bindingId })`。但 Controller 是本地脚本；如果接入模型，模型看不到 `bindingId`，也看不到 `viewInstanceId`，它只有一个工具名。于是必须有人替它选：

- 要么 Host 用“最后聚焦的 View”之类的隐式状态；
- 要么模型显式传 `view_id` / `file_path`（legacy 的做法）；
- 要么每个 binding 一个唯一工具名（工具表膨胀）；
- 要么提供一个通用 `invoke(bindingId, input)` 工具。

这是一个根本性的交互设计问题，不是实现细节。**“Tool 随 View 出现”在原生 Tool Calling 里没有天然的“这个调用来自这个 View”的信号。** 原生 Tool Calling 的调用只有 `name + arguments`，没有 `view instance` 上下文。

你的示例是单文件，所以不暴露这个问题；但一旦多文件、多终端、多搜索结果，它就会出现。

**可选方案对比：**

| 方案 | 目标身份 | 工具表 | 模型可靠性 | 缓存 | 评价 |
|---|---|---|---|---|---|
| 每个 View 实例一个唯一 Tool 名 | 强 | 爆炸 | 高 | 差 | 不适合多实例 |
| 每个 Tool 名 + 显式 `view_id` / target 参数 | 强 | 稳定 | 中 | 中 | legacy 的做法；目标泄漏，模型易填错 |
| 通用 `invoke(bindingId, input)` | 强 | 稳定（一个工具） | 中 | 好 | **最符合 View/Tool/CQRS 语义**；需要 benchmark |
| CLI 子命令 | 弱（还要传 target） | 稳定 | 依赖模型 shell 能力 | 好 | 可作为 adapter，不适合作为核心 |

**我的判断：**

> CLI 不是更好的核心方案；它只是“通用 invoke”的一种 transport。真正的选择是 **native per-action tools** 还是 **generic invoke**。
> 对 AOTUI 这种“View 承载能力”的模型，generic invoke + View 中的 Tool binding 更自然：工具表稳定，能力在 View 里动态变化，目标身份由 binding 保证。
> 但 native tool calling 的模型可靠性更高；建议用一个真实任务做 A/B，不要先验决定。

换句话说：**不要用 CLI 替代 Tool；把 Tool 调用抽象成 binding invoke，然后 native tool 和 CLI 都只是它的 adapter。** 这样既保留结构化校验和 binding，又能让 Agent 选择自己擅长的入口。

### 2.7 Agent-first SDK 还没有成为一等公民

你的目标 2 是：

> SDK 服务的核心开发者也是 Agent；Agent 可以基于 SDK 开发合适的 AOTUI App。

当前 SDK 更像“给熟悉 Preact 的人类开发者用的框架”：

- 默认 authoring 是 Preact 组件 + hooks；
- 需要理解 `View` / `useViewTypeTool` 3 参 vs 4 参、`experimental_useReadOnlyTool`、`experimental_useCreateIfAbsentTool`、`experimental_useAppLifecycle`、`usePersistentState`、`AppRuntimeContext`；
- 文档很长，且很多是“能力条件”和“兼容说明”；
- 错误码有，但缺少 `hint` / `docsUrl` / 修复建议；
- 没有面向 Agent 的单一声明格式；
- 没有 conformance suite，Agent 无法自证“我生成的应用符合契约”。

几个具体的“不可行动错误”：

- `SDK_TYPE_TOOLS_UNAVAILABLE` 只说“需要 typeTools”；没有说“改用 3 参 View-local Tool”。
- `REF_CONTRACT_UNSUPPORTED` 只说“不能保留 Ref 声明”；没有说“移除 `reference` 参数，或改用 `experimental_useReadOnlyTool` + snapshot-value-v2”。
- `ORDINARY_PARAMETERS_UNSUPPORTED` 没有列出当前 Runtime 支持哪些 mode。
- `APP_LIFECYCLE_UNSUPPORTED` 没有说“在 `createTUIApp` 加 `experimentalAppLifecycle:true`，并使用 app-lifecycle-v2 Runtime”。
- `PERSISTENCE_UNAVAILABLE` 没有说“换 managed Runtime，或去掉 `usePersistentState`”。

对 Agent 来说，错误信息就是 API 的一部分；没有修复建议，就会多一轮试错。

对 Agent 来说，最难的往往不是写 JSX，而是：

- 记住 hook 必须放在哪个 View 内；
- 区分 3 参/4 参；
- 知道 `enabled` 是可见性，不是授权；
- 知道 `usePersistentState` 需要 managed runtime；
- 知道 `tool-ref` 不是实际 Tool 注册；
- 知道 View/Tool/params 要同步。

这些都不是 Agent 擅长的“从类型和报错中自我修复”的问题。

**我的判断：**

> 需要一个 **Agent-first 的 SDK 入口**，但不一定要推翻 Preact：
> - 提供一个 plain TypeScript / 对象式 `defineApp` / `defineView` / `defineTool`，作为简单应用和 Agent 生成的默认入口；
> - Preact SDK 保留为复杂 UI 的适配器；
> - 两者生成同一份 `View` / `Tool` / `Receipt` 契约；
> - 提供 `aotui check` 静态校验和 `aotui test` 行为校验；
> - 文档从“人类教程”变成“Agent 可执行的契约 + 示例 + 错误修复表”。

这符合 RFC 0003 的“复用 Core、保留 Preact 默认、双 Producer 验证”的路线：不是替换 Preact，而是把 plain TS Producer 从验证切片提升为一等 authoring 入口。

### 2.8 术语、模式、版本膨胀

当前公开概念至少有：

- `Tool` / `Operation` / `Action` / `ViewTypeTool` / `TypeTool` / `ViewTool`；
- `OperationResult` / `ActionResult` / `ExecutionFact` / `InvocationOutcome` / `Receipt`；
- `ordinary-v1` / `ordinary-v2` / `snapshot-value-v1` / `snapshot-value-v2` / `create-if-absent-v1`；
- 3 参 / 4 参 `useViewTypeTool`；
- `ViewSnapshot V1/V2`、`RefDescriptor V1/V2`、`ToolDescriptor V1/V2`；
- `legacy` / `scoped` / `semantic` / `shadow`。

对框架作者，这些是必要的区分；对应用开发者（尤其是 Agent），这是认知灾难。Agent 很容易选错 API，然后得到 `SDK_TYPE_TOOLS_UNAVAILABLE` 或 `REF_CONTRACT_UNSUPPORTED`。

**我的判断：**

> 面向 1.0 Infra，公开面应该收敛为：
> - `App` / `View` / `Tool` / `Receipt` / `Observation` / `Binding`；
> - 一个普通 Tool 模式 + 一个可选 Ref 模式；
> - 一个 `useTool` / `defineTool` 入口；
> - 一个 `invoke` 入口（native 或 generic）；
> - 其余模式、V1/V2、安全包装、能力协商都放到内部或适配器。
>
> “简单”不是少写代码，而是少让使用者做选择。

### 2.9 默认 system instruction 与实际 wire format 漂移

`runtime/src/adapters/system-instruction.ts` 里的默认指令教模型：

```md
(Fix login bug)[todo:pending[0]]
```

并描述每个 View 包含：

```md
## Application Instruction
## Content
## Available Tools
```

但实际 transformer / SDK 的输出是：

- `useArrayRef` 生成 `[content](Type:items[0])`；
- `useViewTypeTool` 生成的是 `<tool-ref>` 纯文本；
- View 不保证有 `## Available Tools`；
- `operation` visitor 生成 `[label](tool:...)`，但新 Tool 不走它。

这会造成两个问题：

1. **模型被教了错误的格式**，可能去寻找不存在的结构；
2. **system instruction 与真实 wire format 没有 conformance test**，每次改 transformer 都可能漂移。

再加上默认指令还写着：

- “Worker-Isolated ... for safety”（Worker 不是安全沙箱）；
- “Each operation is atomic”（未知结果不等于原子成功）；
- “Value-Driven ... via ref_id”（新 Core 用 binding，不是 ref_id）。

这些都会削弱模型对系统的正确理解。

**我的判断：**

> 应该有一个 **版本化的 View Message wire spec**，system instruction 从 spec 生成，并用测试保证“runtime 实际输出 == spec 示例”。
> 默认指令要短、准确、只描述真实存在的东西；不要把 Worker 隔离说成安全沙箱。

### 2.10 多 App / Desktop 与单 App Core 的边界未定

Legacy plane 是 Desktop-scoped：有 app catalog、open/close app、多个 app 的 views、system tools。

Semantic plane 是 App-scoped：一个 `ScopedInteraction` 绑定一个 AppInstance；`Observation` 的 source 是一个 App；没有 app catalog、没有 open/close app、没有跨 App 的 observation。

如果你的产品是“一个桌面上的多个 AOTUI App”，那么 semantic plane 目前只覆盖了“一个 App 的运行时”，没有覆盖“桌面/工作区”。Host 必须：

- 为每个 App 创建一个 Scope；
- 合并多个 Observation；
- 自己排序、自己处理 app catalog、自己处理 open/close app；
- 自己定义跨 App 的 Tool 名称/绑定。

这不是“Driver 接一下”就能解决的；它需要一个 **Workspace / Desktop-level 契约**，或者明确声明 “Core 只做单 App，桌面是宿主的事”。

**我的判断：**

> 如果目标是被不同 LLM Agent 系统复用，**建议把 Core 定位为单 App 语义内核，桌面/工作区交给 Host 适配器**。
> 这样 Core 更小、更可复用；Desktop 的 app catalog / open/close / 多 App 合并由 Host 定义。
> 如果坚持 Core 覆盖 Desktop，就必须补 WorkspaceObservation / DesktopAction，否则 semantic plane 永远只是单 App demo。

---

## 3. 系统设计问题

### 3.1 双平面没有收敛

这是最大的系统风险：

- Legacy plane 是默认产品面，有 Agent Driver、Agentina、默认 IDE；
- Semantic plane 是显式 scoped 入口，有 Core、Observation、Binding、Receipt；
- 两套权威、两套错误语义、两套工具路径；
- 默认 IDE 和 scoped IDE 是两套代码（`SystemIDEApp` vs `ScopedIDEApp`）；
- 默认 system instruction 描述的是 legacy；
- `SCOPED_IDE.md` 明确说 package default remains legacy。

后果：

- 用户/Agent 不知道该相信哪套语义；
- 测试、文档、兼容矩阵翻倍；
- 新能力只在 scoped 生效，默认产品享受不到；
- 核心价值（Observation/Binding/Receipt）无法到达模型。

**建议：**

- 一个 App 实例只用一个平面；scoped 只走 Core，legacy 明确标记“兼容，不支持新语义”；
- 尽快让一个产品切片（IDE）在模型链路中只走 Core；
- 删除或冻结 legacy 的默认地位，而不是长期双写。

### 3.2 包边界 / 依赖边界不干净

`runtime/package.json` 的 dependencies 包含：

```text
@aotui/agent-driver-v2, ai, preact, preact-render-to-string, happy-dom, linkedom, zod
```

即使你只使用 `@aotui/runtime/core`，安装 runtime 也会拉入 AI SDK、Preact、DOM 模拟库和 Agent Driver。原因很简单：`@aotui/runtime/core` 是同一个包的子路径，不是独立包。

对一个想被不同 LLM Agent 系统复用的 Infra，这是严重问题：

- 宿主可能不用 AI SDK / Preact；
- 安装体积、依赖冲突、供应链面都变大；
- “Core 无 DOM/模型依赖”只是源码层事实，不是分发层事实；
- SDK 依赖 runtime，进一步把 Preact/DOM 带入。

**建议：**

```text
@aotui/core            纯语义：snapshot / view-owned tools / observation / receipt / state session
@aotui/runtime-node    Worker / DOM / Node 宿主
@aotui/runtime-browser 可选
@aotui/sdk             作者层（Preact 适配）
@aotui/sdk-plain       作者层（plain TS / Agent-first）
@aotui/adapter-ai-sdk  Agent Driver / AI SDK 适配
@aotui/adapter-mcp     MCP 适配
@aotui/wire            ViewMessage / Receipt / Observation 序列化
@aotui/cli             脚手架 / check / test
```

`@aotui/core` 的依赖应该接近零；`ai`、`preact`、`happy-dom`、`linkedom` 不应出现在 core 的依赖里。

### 3.3 公共 API 与 experimental 模式太多

`runtime/src/index.ts` 从 root 导出：

- facades、SPI、Kernel、AppRegistry、CLI catalog、npm installer；
- 而 `@aotui/runtime/core` 只是子路径。

`sdk/src/index.ts` 从 root 导出：

- `createTUIApp`、`View`、`useViewTypeTool`（3/4 参）、`experimental_useReadOnlyTool`、`experimental_useCreateIfAbsentTool`、`experimental_useAppLifecycle`、`usePersistentState`、`useEntityRef`、`persistenceManager`（deprecated）、`useMountableViewRegistry`（不可用）、`useDynamicViewRegistry`（不可用）、`useResourceRef`（deprecated）……

对 Agent 来说，这个 export 列表本身就是噪音。它无法判断：

- 哪个是推荐路径；
- 哪个是 legacy；
- 哪个需要特殊 Runtime；
- 哪个会抛错。

**建议：**

- root 只导出稳定 API；experimental 放子路径（`@aotui/sdk/experimental`）；
- 删除“导出了但运行时抛不可用”的 API，或实现它；
- 冻结 4 参 legacy，文档只保留 3 参；
- 用 `@deprecated` + 移除版本，而不是长期共存。

### 3.4 上下文投影不是独立组件

现在的上下文投影分散在：

- `AOTUIDrivenSource.getMessages`：static / dynamic / view 消息；
- `assembleContextRegions`：static / session / dynamic / active tail；
- `HostDrivenSource`：session history；
- `Host`：消息持久化、压缩；
- `system-instruction`：告诉模型格式。

没有一个组件拥有“View slot / 替换 / 关闭 / 顺序 / 预算”的完整规则。结果是：

- View 排序按 timestamp，更新会移动；
- View 消息没有 revision；
- Host 可能持久化 dynamic 消息；
- 不同 Host 很难实现同一组不变量。

**建议：**

新增 `ContextProjector`（可以在 `@aotui/wire` 或 Host adapter）：

```ts
interface ViewMessage {
  key: string;                 // 逻辑 View 的稳定 slot key
  viewId: string;
  viewType: string;
  revision?: number;
  content: string;             // XML + Markdown
  tools: ToolRef[];            // 当前可用 Tool 的 binding/name/input
}

interface ContextProjector {
  project(input: {
    static: Message[];
    session: Message[];        // 真实用户 / assistant / receipt
    views: ViewMessage[];      // 当前 View slots
    tail: Message[];           // 当前执行尾部
  }): ModelMessage[];
}
```

规则：

- 一个 `ViewInstance` 一个 slot；
- 更新替换 slot 内容，不改变 slot 顺序；
- 关闭删除 slot；
- slot 顺序稳定（app / view type / view ID），不按 timestamp；
- `view` 消息不持久化；`receipt` 消息持久化且无业务数据；
- 超出预算时按明确规则摘要/驱逐，而不是静默截断。

### 3.5 Observation / Tool / Message 不一致

Legacy 路径：

- `AOTUIDrivenSource.getMessages` 取一次 snapshot；
- `getTools` 取一次 snapshot；
- `executeTool` 再取一次 snapshot。

三次可能不同。模型看到的 View、Tool 表、执行目标可能来自不同 revision。Agent Driver 也没有 observationId/bindingId。

Semantic 路径：

- `observe` 固定 snapshot + bindings；`invoke` 用 observation；这是一致的；
- 但 Agent Driver 没有使用它；scoped IDE 是 model-free Controller；
- Host 需要自己把 observation 变成 messages/tools，并保留 binding。

**建议：**

- 一次模型请求对应一个 Observation；
- View messages、Tool 列表、Tool binding 都从同一个 Observation 派生；
- Tool 调用携带 `observationId` + `bindingId`；
- 旧 Observation 的调用可拒绝或要求重新观察；
- Agent Driver 通过 `ScopedAOTUIDrivenSource` 接入，而不是继续用 legacy `AOTUIDrivenSource`。

### 3.6 Publish / observe lifecycle 缺失

`ScopeClient` 目前只有：

```ts
observe(selection)
invoke(request)
readReceipt(invocationId)
releaseObservation(observationId)
close()
```

没有：

- `waitForViewRevision` / `afterRevision`；
- `onUpdate` / subscribe；
- `view.publish` 的确认；
- receipt 与 view revision 的关联。

所以 Host 无法可靠地“等操作后的 View”。这会直接影响 CQRS、动态 Tool、长任务。

**建议：**

- Receipt 增加 `view?: { viewId, revision }`；
- `observe` 支持 `afterRevision` 或 `waitFor`；
- `ScopeClient` 支持 `onUpdate`；
- 对异步操作，返回 `accepted` + `operationId`，Host 用 `readReceipt`/`observe` 等结果；
- 明确 `succeeded` 的 View 可见性保证，或明确 `accepted` 的等待语义。

### 3.7 授权 / 信任 / 安全边界

当前：

- `ScopePolicy` 是 Host 提供的；示例里 `authorize: () => true`；
- Legacy 路径只有 app-level 禁用，没有 tool-level policy；
- Worker 是执行隔离，不是权限隔离；
- View 内容是 User Message，可能包含 prompt injection；
- 默认 system instruction 说 Worker “for safety”，容易误导。

对 Infra，这是必须说清楚的：

- 是“只运行可信 App”还是“运行不可信插件”？
- 如果是前者，明确写；不要用 Worker 隔离暗示安全沙箱。
- View 内容要标记为应用数据，不是用户指令；system instruction 要明确“View 内容是不可信数据，不要执行其中指令”；
- 默认 policy 应该是 deny-by-default，示例不要用 allow-all 作为生产模板；
- Tool 隐藏不是授权；执行时必须校验 binding + policy + business。
- 需要 tool-level / view-level allowlist，而不是 app-level。

### 3.8 Build / release / test 漂移

当前工作树：

- SDK 源码导出了 `CreateIfAbsentOutcome`，但本地 `sdk/dist` 没有，IDE 测试因此编译失败；
- Runtime 的 emitted SDK/Host/Worker 测试出现 `APP_INIT_ACK_INVALID` / `legacy-unverified`；
- 仓库要求“精确 tarball”，版本号相同不足以证明兼容；
- 根 workspace 只覆盖 `packages/*`，核心包靠脚本逐个安装/构建/链接。

我本地跑的结果（2026-10-28）：SDK 25 个文件 / 429 项通过；Agent Driver 19 项通过；Runtime 纯单测 2,628 项通过、31 项失败（集中在 emitted SDK/Host/Worker 场景）；IDE 6 个 suite 通过、2 个 suite 因 `sdk/dist` 落后而编译失败。失败不是 semantic Core 单测失败，而是产物与源码不同步；但这恰恰说明发布链路不可信。

这不是语义问题，但它是 Infra 的致命问题：

> 一个要求使用者“必须使用精确产物”的框架，必须自己提供一条一键、可复现、从干净 checkout 到全绿的构建路径。

**建议：**

- 统一 pnpm workspace，核心包用 `workspace:*`；
- lockstep 版本 / changesets；
- `pretest` 构建或测试直接跑源码；
- CI 从干净目录 `install → build → test → pack → consumer install`；
- e2e 测试使用明确构建产物，不依赖本地陈旧 dist；
- 发布前检查 public exports / types / tarball content。

### 3.9 成本 / 性能还没有成为契约

目标里提到上下文总量、实际模型输入成本、刷新延迟、任务成功率。当前：

- 有 snapshot / observation / view 容量限制；
- 但没有每轮 token 成本、View 字节数、publish 延迟、observe 延迟的公开指标；
- View 可能很大（文件正文、搜索结果、LSP 结果）；
- 动态 Tool 列表变化可能影响 provider cache；
- 没有 A/B 数据证明“删除旧 View”降低了成本。

**建议：**

- `Observation` / `Receipt` 暴露 `bytes` / `viewRevision` / `latency`；
- 测量每轮 context tokens、cache hit、publish latency、tool latency；
- 对 View 内容提供可选的预算 helper（分页/摘要），但业务内容仍由 App 决定；
- 用真实任务比较 native tools vs generic invoke vs CLI。

### 3.10 Agent authoring / Agent using 两类评测缺失

现在的测试主要验证 Runtime 语义和 IDE 行为，但没有：

- 一个 Agent 只读 SDK 文档能否生成正确应用；
- 生成应用的 contract conformance、修复轮次、私有 API 使用率；
- Agent 使用应用完成任务的 wrong-object rate、recovery rounds、token cost。

**建议：**

- 建立两个 benchmark：
  1. **Authoring benchmark**：给 Agent SDK 文档 + 任务，生成 App；用 `aotui check` + 行为测试评分。
  2. **Usage benchmark**：给 Agent 一个 App + 任务，比较 legacy / semantic / generic invoke / CLI。
- 这两个 benchmark 比再加一个 Demo App 更能证明 Infra 价值。

---

## 4. 代码实现问题（证据表）

| # | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | `runtime/src/spi/core/operations.ts:94` | `OperationResult.data` | Tool 可返回业务数据，违反 CQRS | 引入 `Receipt`，移除 `data` |
| 2 | `runtime/src/adapters/aotui-driven-source.ts:536` | ToolResult = `result.data` | 数据进入 Messages 历史，旧数据累积 | Receipt-only；ToolResult 只带状态/提示/view 引用 |
| 3 | `runtime/src/core/invocation/invocation-outcome.ts` | `succeeded.value = result` | Core 本身把业务数据放进 receipt | `succeeded` 只带 view revision / metadata；业务数据在 View |
| 4 | `demo-apps/aotui-ide/src/core/ide-session.ts:335,444` | search/LSP 返回 `result` | 与 View 重复；旧数据持久化 | 返回 `{ message, view_id }`；数据只在 View |
| 5 | `runtime/src/adapters/aotui-driven-source.ts:270,402,471` | 三次 acquire snapshot | messages/tools/execute 可能不同 revision | 一 observation 一请求；Scoped source |
| 6 | `runtime/src/worker-runtime/index.ts:997` | 所有 type tools 写入 indexMap | legacy Tool 不按 View 过滤 | 从 mounted View 派生；legacy 冻结 |
| 7 | `demo-apps/aotui-ide/src/tui/RootView.tsx`（write/edit/delete/rename 的 enabled） | 只以 workspace 为条件 | 无文件时 `edit_file` 仍暴露 | 移到 FileDetail View；workspace 只保留 create/open/search |
| 8 | `sdk/src/hooks/useViewTypeTool.ts:310` | `tool-ref` 无 visitor | View 里只有纯文本，无 Tool 语义 | 增加 `tool-ref` visitor 或改为通用 `invoke` binding |
| 9 | `runtime/src/adapters/aotui-driven-source.ts:148` | View 包装只有 id/type/name/app | 模型看不到 revision/instance | 增加 `revision` / `viewInstance`（可选/紧凑） |
| 10 | `runtime/src/worker-runtime/view-fragment-extractor.ts:70` + `context-regions.ts:141` | timestamp 变化导致动态消息重排 | View 更新会改变顺序，cache 抖动 | 稳定 slot 顺序；timestamp 只做元数据 |
| 11 | `sdk/src/hooks/useViewTypeTool.ts:86-123` | 3/4/5 参重载 | Agent 容易选错；API 面大 | 3 参为唯一推荐；4 参冻结 |
| 12 | `sdk/src/hooks/useArrayRef.ts:96` | `refId[idx]` 位置型 | 重排后旧引用可能指新对象 | 稳定 key / deprecate；新应用用 `useDataRef` |
| 13 | `runtime/src/core/invocation/scoped-interaction-types.ts`（ScopeClient） | 无 wait/update | 无法等 View 提交；CQRS 不可靠 | 增加 `afterRevision` / `onUpdate` |
| 14 | `runtime/src/core/tool/create-if-absent-contract.ts` | 只有 succeeded/failed/unknown | SDK 无法表达 `accepted` | 统一 `Receipt` 五态；普通 Tool 也可 accepted/unknown |
| 15 | `runtime/package.json` | root 依赖 `ai` / Preact / happy-dom / linkedom / agent-driver | Core 不可独立分发 | 拆包；core 零/少依赖 |
| 16 | `runtime/src/adapters/aotui-driven-source.ts` | 同文件混合 instruction、snapshot、tool、execute | 适配器职责过多；依赖 AI SDK | 拆分 `ViewMessage` / `ToolProjection` / `execute` 适配器 |
| 17 | `runtime/src/adapters/system-instruction.ts` | 描述 `(content)[type:ref_id]` / `Available Tools`，实际不同 | 模型被教错格式；prompt injection | 版本化 wire spec；生成 instruction；测试一致性 |
| 18 | `sdk/dist` / tests | dist 落后源码 | IDE 测试编译失败；e2e 误报 | workspace + pretest build + CI |

这些不是“代码风格”问题；它们直接影响 I1–I10 的成立。

---

## 5. Breaking Change / v2 提案

### 5.1 保留什么

不要推倒：

- `SnapshotCore` 的 identity / revision / lease / capacity；
- `ViewOwnedTools` 的 `viewInstanceId` / `bindingVersion`；
- `Observation` / `Scope` / `Policy` / `Receipt` 的五态语义；
- `projection` epoch 的 commit barrier；
- `state-session` / App lifecycle / close report；
- IDE 作为真实 conformance app。

这些是项目的长期资产。

### 5.2 建议推翻什么

**BC1：Tool 结果改为 Receipt-only。**

```ts
type Receipt =
  | { status: 'succeeded'; message: string; view?: ViewRef; }
  | { status: 'rejected'; code: string; message: string; view?: ViewRef; }
  | { status: 'failed'; code: string; message: string; effects: 'none' | 'partial'; view?: ViewRef; }
  | { status: 'accepted'; operationId: string; view?: ViewRef; }
  | { status: 'unknown'; code: string; message: string; view?: ViewRef; };

interface ViewRef { viewId: string; revision: number }
```

- Remove `data` from public Tool result.
- `succeeded` means "the operation completed and the referenced View revision is committed" (or `view` absent for non-View operations).
- If the View is not ready, return `accepted` with `operationId`; Host observes later.
- Legacy `OperationResult` converted by adapter, not used by new SDK.

**BC2：View 承载 Tool binding；模型侧用通用 `invoke`。**

- SDK 的 `View` 声明里包含 `tools`（name/description/input/execute/visible）。
- Runtime 为每个 ViewInstance 生成 binding；View 消息里展示当前可用 Tool 的 compact manifest（name + binding + required params）。
- 模型侧提供稳定的 `invoke({ bindingId, input })` 工具；bindingId 来自 View。
- 可选：Host 为单实例/高频 Tool 生成 native tool 投影；但语义来源仍是 View binding。
- 删除 4 参 type-wide、全局 Tool 注册、`tool-ref` 纯文本。

**BC3：`ViewMessage` + `ContextProjector`。**

- 一个 `ViewInstance` 一个 slot；更新替换内容；关闭删除；顺序稳定。
- `view` 消息不持久化；`receipt` 消息持久化且无业务数据。
- `ContextProjector` 独立于 Runtime/SDK；Host 可替换。
- View 包装包含 `revision` / `updatedAt`（可选）；不强制 `viewInstanceId` 暴露给模型。

```ts
interface ViewMessage {
  key: string;                 // 逻辑 View 的稳定 slot key
  viewId: string;
  viewType: string;
  name: string;
  revision: number;
  content: string;             // XML + Markdown
  tools: ReadonlyArray<{
    name: string;
    bindingId: string;         // 模型/宿主用来 invoke
    inputSummary: string;      // 紧凑参数说明；完整 schema 可按需查询
  }>;
}
```

**BC4：一次观察 = 一次模型请求。**

- `observe` 返回 views + tools + bindings + source revision。
- View 消息、Tool 列表、Tool 调用都来自同一个 observation。
- `invoke` 必须携带 `observationId` + `bindingId`；旧 observation 的调用按契约拒绝或要求重新观察。
- Agent Driver 用 `ScopedAOTUIDrivenSource` 接入；legacy source 只做兼容。

**BC5：Agent-first SDK v2。**

- `defineApp({ name, views })`；`defineView({ id, type, render, tools })`；`defineTool({ input, execute })`。
- 一份声明同时生成 View 内容、Tool schema、binding、输入校验；不再要求 View/Tool/params/enabled 手工同步。
- plain TS 是 Agent 生成应用的默认入口；Preact SDK 作为复杂 UI 适配器。
- `aotui check` 静态校验：View ID 唯一、Tool 名唯一、Tool 必须在 View 内、无 `data` 返回、无 `view_id` 参数、无未声明 Tool。
- `aotui test` 行为校验：open/update/close、Tool 可见性、receipt、旧 binding 失效。
- 错误带 `code / path / expected / hint / docsUrl`。

```ts
const app = defineApp({
  name: 'file_ide',
  views: {
    workspace: defineView({
      type: 'Workspace',
      render: ctx => renderWorkspace(ctx),
      tools: {
        openFile: defineTool({
          input: z.object({ path: z.string() }),
          execute: async (ctx, input) => {
            const file = await ctx.app.open(input.path);
            return { status: 'succeeded', message: 'opened', view: file.view };
          },
        }),
      },
    }),
    file: defineView({
      type: 'FileDetail',
      render: ctx => renderFile(ctx),
      tools: {
        edit: defineTool({
          input: z.object({ oldString: z.string(), newString: z.string() }),
          execute: async (ctx, input) => {
            await ctx.app.edit(ctx.view, input);
            return { status: 'succeeded', message: 'edited', view: ctx.view };
          },
        }),
      },
    }),
  },
});
```

这里的关键不是“换一个 DSL”，而是：`edit` 只存在于 FileDetail View；它的 schema、binding、可见性、执行都是同一份声明；Receipt 只指向 View，不携带正文。

**BC6：包拆分。**

- `@aotui/core`：纯语义，零/少依赖；
- `@aotui/runtime-node`：Worker/DOM/Node；
- `@aotui/sdk`：Preact 适配；
- `@aotui/sdk-plain`：Agent-first；
- `@aotui/adapter-ai-sdk`、`@aotui/adapter-mcp`、`@aotui/wire`、`@aotui/cli`。
- `@aotui/core` 不依赖 `ai`、`preact`、`happy-dom`、`linkedom`、`agent-driver`。

**BC7：一个普通 Tool 模式 + 一个可选 Ref 模式。**

- 删除公开的 5 种 interaction mode；内部实现可以保留，但不暴露给 App 作者。
- `ordinary-v1/v2` 合并为一个 `tool-v1`；`snapshot-value` 合并为一个 `ref-v1`。
- 删除 `create-if-absent-v1` 作为框架模式；它只是一个业务 Tool。
- V1 snapshot 冻结/兼容；新应用只用 V2。
- 协议版本与包版本分离：`ViewMessage` / `Receipt` / `Observation` 有 `schemaVersion`，Host 启动时协商。
- 1.0 公共 API：`createRuntime` / `install` / `observe` / `invoke` / `close`。

**BC8：Publish barrier / observe wait。**

- Receipt 带 `viewRevision`；`succeeded` 与 View 可见性绑定。
- `observe({ afterRevision })` 或 `waitForViewRevision`。
- `ScopeClient.onUpdate`。
- 异步操作 `accepted` + `operationId`；Host 可等。

**BC9：信任模型显式化。**

- “可信 App” vs “不可信插件”明确写；
- Worker 不是安全沙箱；
- View 内容是不可信数据；system instruction 明确；
- 默认 policy deny-by-default；示例不用 allow-all 作为生产模板。

### 5.3 迁移路径

不要 big bang：

1. **冻结**：legacy API 标记；4 参/旧 Hook/旧 source 进入兼容层。
2. **加 Core 包**：`@aotui/core` 从现有 core 抽离；runtime root 依赖它。
3. **v2 契约**：Receipt-only / ViewMessage / ContextProjector / generic invoke；先在一个 App（IDE 或更小 FileApp）验证。
4. **接 Driver**：`ScopedAOTUIDrivenSource`；一次 observation；真实模型 A/B。
5. **Agent SDK**：`sdk-plain` + `aotui check`；用一个 Agent 生成 App 的 benchmark 验证。
6. **切换默认**：一个 App 实例一个平面；默认走 v2；legacy 只做兼容。
7. **删除**：旧 4 参、5 modes、V1、deprecated exports、tool-ref 纯文本、legacy source。

每一步都要有“旧行为不退化”的测试；但不要为了兼容而保留两套新语义。

### 5.4 我不会做什么

长期主义也包括克制。以下是我**不会**建议做的：

- **不会推倒 Core。** `SnapshotCore` / `ViewOwnedTools` / `Observation` / `Receipt` / close report 是项目最值钱的部分；问题在公开层，不在语义内核。
- **不会把业务版本、文件路径、LSP 结果搬进 Runtime。** 这些是 App 的职责；Runtime 只提供观察、binding、收据和资源边界。
- **不会为了“统一”强制所有 App 用 generic invoke。** Native tool 投影可以保留；generic invoke 是语义基础，native tools 是性能/可靠性优化。
- **不会在没有第二个 Host 之前做通用插件、权限、多租户平台。** 先把单 App Core 做干净；信任模型先明确“可信 App”。
- **不会继续维护两套新语义。** Legacy 可以兼容，但不能和 v2 同时作为“当前推荐”。
- **不会用“更多 Demo App”证明 Infra。** 一个外部开发者/Agent 能在一天内构建并验证一个 App，比五个 Demo 更有说服力。

---

## 6. 优先级 / 30-60-90 天

### P0（先做，否则架构不成立）

1. **Receipt-only + View publish**：从 IDE 的 search/LSP 开始，去掉 ToolResult data；加 `view` / `revision`。
2. **ContextProjector + ViewMessage**：稳定 slot / 顺序 / 替换 / 关闭；Host 不持久化 view。
3. **Observation-derived Tool set**：一次 observe 得到 views + tools + bindings；旧 observation 拒绝。
4. **动态 Tool 暴露**：把 edit/delete/rename/LSP 移到 FileDetail View；workspace 只留 open/search/create。
5. **Clean build/test**：workspace、pretest build、CI 从干净 checkout 全绿。

### P1（1–3 个月）

6. **Generic invoke vs native tools A/B**：用一个真实任务测量成功率、wrong-target、token、latency、cache。
7. **Agent-first SDK**：`defineApp/defineView/defineTool`、`aotui check`、conformance suite、Agent authoring benchmark。
8. **包拆分 / 1.0 API**：core/runtime-node/sdk/sdk-plain/adapters；删除 5 modes/4 参/deprecated。
9. **Publish/observe lifecycle**：`afterRevision`、`onUpdate`、accepted/unknown。
10. **Trust model + docs**：可信 App、View 内容不可信、deny-by-default policy。

### P2（3–6 个月）

11. **性能/成本**：context tokens、view bytes、publish latency、cache hit；真实任务 benchmark。
12. **第二 Host / 第二 Producer**：证明 Core 可复用。
13. **CLI adapter**：作为 generic invoke 的一个 transport，不作为核心。
14. **安全**：如果需要不可信插件，再做沙箱/权限，不要用 Worker 假装。

---

## 7. 评估与验收

### 7.1 六个必测场景（对应你的规范示例）

1. 打开 App：只有 workspace 级 Tool；没有针对未打开文件的 edit/delete/rename。
2. 打开 `test.txt`：FileDetail View 出现；edit Tool 的 binding 出现；View 只出现一份。
3. 编辑 `test.txt`：Receipt 返回；下一次观察只显示最新 FileDetail；没有第二份“当前”快照；ToolResult 不含正文。
4. 关闭 `test.txt`：View 消失；旧 binding 调用被拒绝；不会误操作新打开的同名文件。
5. 外部修改：下一次观察显示新内容或明确 stale；旧 binding / 旧版本按契约处理。
6. 长任务：View 数量/字节有界；旧 View 退出；失败/未知可恢复；没有重复的当前快照。

### 7.2 Agent authoring benchmark

- 给 Agent SDK 文档 + 一个任务（例如“做一个 todo app，支持打开详情、编辑、关闭”）；
- 评分：
  - 首次编译通过率；
  - contract conformance（View/Tool/Receipt/visibility）；
  - 修复轮次；
  - 私有 API 使用率；
  - 迁移成功率；
  - 是否产生“ToolResult 里的数据”或“无 View 的 Tool”。

### 7.3 Agent using benchmark

- 同一个 App、同一个任务、同一个模型；
- 比较：
  - legacy tools；
  - semantic observation + native tools；
  - semantic observation + generic invoke；
  - CLI adapter；
- 指标：任务成功率、wrong-object rate、stale-action rate、recovery rounds、tokens、latency、cache hit。

### 7.4 Infra readiness

- 第二个 Host 接入时间；
- 第二个 Producer（plain TS）通过同一契约；
- 干净安装 / tarball 消费；
- 版本兼容矩阵；
- Core 依赖数量 / 安装体积。

---

## 8. 结论

### 8.1 三句话

1. **Core 是对的，公开层不对。** 身份、binding、observation、receipt、资源所有权都值得保留；但 model-facing 的 Tool/View/Message 契约还没有体现这些语义。
2. **最大的概念错误是把 Tool result 当成 View 之外的第二个数据通道。** 这让 CQRS 失效、旧数据进入 Messages、View 不是唯一真相。
3. **最大的系统风险是双平面 + 包耦合。** 默认产品走 legacy，语义 Core 只在 scoped 路径；Core 又被打包在依赖 AI SDK/Preact 的 runtime 里。Infra 需要反过来：Core 小、纯、可复用；Host/Adapter 大。

### 8.2 我的建议

> **不要推倒 Core；推倒 “ToolResult 数据通道 + 全局 Tool + legacy 默认”。**
> 用 Receipt-only、View Tool manifest、ContextProjector、一次 Observation、Agent-first SDK、包拆分，构建一个更小但更严格的 1.0。
> 这不是“重写项目”，而是“把项目最有价值的部分从产品壳里取出来”。

### 8.3 一句话留给这个项目

> **AOTUI 的价值不在 Tool 更多，而在 View / Receipt / Binding 的语义。**
> 如果公开层继续让 Tool 返回数据、让 View 只是文本、让 Tool 全局注册，那么 Core 再强，Agent 也感受不到；
> 反过来，如果 View 成为唯一能力面、Receipt 成为唯一操作结果、Observation 成为唯一事实来源，AOTUI 才有机会成为 LLM Agent 领域的 Infra。

---

## 附录 A：需要项目所有者拍板的五个问题

1. **Core 是单 App 还是 Desktop？** 如果是单 App，Desktop/多 App 合并交给 Host；如果是 Desktop，需要 WorkspaceObservation / DesktopAction。
2. **CQRS 是硬约束还是建议？** 如果是硬约束，`OperationResult.data` / `ActionResult.value` 必须改。
3. **主要 SDK 开发者是 Agent 还是人类？** 如果是 Agent，plain TS / schema / check 应成为默认；Preact 保留为复杂 UI。
4. **模型侧主入口是 native tools 还是 generic invoke？** 需要 A/B，不能先验决定。
5. **Worker 是安全边界吗？** 如果不是，明确“可信 App”；如果是，需要真正的权限/沙箱设计。

## 附录 B：证据索引

| 主题 | 文件 |
|---|---|
| SDK 入口 / API 状态 | `sdk/src/index.ts`、`sdk/README.md`、`sdk/docs/api-status.md` |
| SDK View / Tool | `sdk/src/components/View.tsx`、`sdk/src/hooks/useViewTypeTool.ts`、`sdk/src/hooks/useReadOnlyTool.ts`、`sdk/src/hooks/useCreateIfAbsentTool.ts` |
| SDK 持久化 / 生命周期 | `sdk/src/hooks/usePersistentState.ts`、`sdk/src/hooks/useAppLifecycle.ts` |
| Runtime 公共入口 | `runtime/src/index.ts`、`runtime/src/facades/facades.ts`、`runtime/package.json` |
| Runtime Core | `runtime/src/core/snapshot/`、`runtime/src/core/tool/`、`runtime/src/core/invocation/` |
| Legacy 投影 | `runtime/src/adapters/aotui-driven-source.ts`、`runtime/src/engine/view/snapshot/formatter.ts`、`runtime/src/worker-runtime/index.ts` |
| 上下文分区 | `agent-driver-v2/src/core/context-regions.ts` |
| IDE legacy | `demo-apps/aotui-ide/src/tui/SystemIDEApp.tsx`、`RootView.tsx` |
| IDE scoped | `demo-apps/aotui-ide/src/scoped.ts`、`tui/ScopedIDEApp.tsx`、`core/ide-session.ts`、`tui/ide-tool-contracts.ts` |
| 集成契约 | `demo-apps/aotui-ide/SCOPED_IDE.md`、`rfcs/0003-sdk-runtime-architecture-route.zh-CN.md`、`runtime/docs/core-public-entry.md` |
| 默认模型指令 | `runtime/src/adapters/system-instruction.ts` |

---

*本文是架构评审，不是实现计划。Breaking Change 的优先级取决于你对“单 App Core / 双 App Desktop”“CQRS 硬约束”“Agent 作为主要 SDK 开发者”这三个问题的选择。*
