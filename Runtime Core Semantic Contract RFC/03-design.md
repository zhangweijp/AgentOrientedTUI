# RCSC-03 — 详细技术方案：Runtime-owned Transactional AppSnapshot

- **状态**：Draft / Protocol Proposal，尚未编码
- **关联**：[目标与约束](./00-charter.md) · [可行性](./01-feasibility.md) · [影响面](./02-impact.md) · [开发计划](./04-plan.md) · [测试计划](./05-tests.md)
- **实施基线**：本地代码 HEAD 789ef07 + 未提交变更，不以旧文档内容推定现状
- **术语**：App / View / Ref / Tool。SDK 的 Tool 声明 API 称 ViewTypeTool；历史 TS 代码中的 Operation/Action 名称不作为本 RFC 规范 API。

## 1. 核心方案与权威边界

**路线 C 的精确定义**：App 侧 SnapshotProducer 产生来源一致、可转移的 PreparedAppSnapshotDraft；Runtime Core 的 SnapshotCommitter 对 Draft 做最终验证、深度复制、指纹判等、Revision 分配和原子发布；SnapshotStore 保存当前不可变指针及有界历史。

当前部署中，Producer 位于 Worker，**权威 Committer/Store 位于 Runtime 主线程**（它属于 Runtime Core，不属于产品 Host 的业务层）。将来执行环境变化不改变这条职责分离。

~~~text
App 业务状态 + SDK View/Ref/ViewTypeTool Registry
       │
       ▼
[Current DOM Producer]  -- capture boundary / mutationEpoch
       │
       ▼
PreparedAppSnapshotDraft (IPC，结构化可序列化值)
       │
       ▼
Runtime Core SnapshotCommitter
  validate sender + incarnation + producerSeq
  clone/normalize + validate + semantic fingerprint
  CAS(lastAcceptedProducerSeq)
  assign committed revision, atomically swap pointer
       │
       ▼
SnapshotStore.current[appId] ---> published AppSnapshot
       │
       ├── readLatest / getById / lease / resolveRef
       └── notify SnapshotPublished (遵循 signalPolicy)
       │
       ▼
WorkspaceSnapshot = vector of committed AppSnapshot IDs
~~~

Committer 是唯一拥有成功提交 Revision 和 Published AppSnapshot ID 权限的模块；Producer 仅有 input sourceEpoch / producerSeq，不允许自行宣称已提交 Revision。失败或重复 Draft 不提高成功提交 Revision。

## 2. 对外语义对象与内部 Wire 对象

下列为设计性 TS 草案。实现时必须为所有 wire 字段定义严格序列化 Schema；TS readonly 只是编译期防线。

~~~ts
type Json = null | boolean | string | number | Json[] | { [key: string]: Json };

type AppSnapshotId = string;   // opaque；至少由实例世代 + committed revision 唯一决定
type InstanceId = string;      // 每次启动 / Worker 重新初始化分配新世代
type ViewId = string;
type ViewType = string;
type RefId = string;
type ToolId = string;

interface ViewSnapshot {
  id: ViewId;
  generation: string;       // 每次挂载的新实例令牌；重开同 id 不等于原 View
  type: ViewType;
  name: string;
  kind: 'instruction' | 'state';
  content: { format: 'markdown-v1' | 'semantic-v1'; value: Json };
  // content 可以存 markdown string 或未来的结构化 AST，不含 DOM/HTMLElement。
}

interface RefDescriptor {
  id: RefId;
  ownerViewId: ViewId;
  ownerViewGeneration: string;
  refType: string;
  target:
    | { kind: 'snapshot-value'; payload: Json }
    | { kind: 'entity'; entityType: string; entityId: string; entityVersion?: string };
}

interface ToolDescriptor {
  id: ToolId;             // 内部唯一，不以碰撞后缀作为身份策略
  name: string;
  viewType: ViewType;    // Tool 作用于哪些 View Type
  declaredByViewId?: ViewId; // 声明位置可为 Root；不同于执行目标
  declaredByViewGeneration?: string; // Root 被重新挂载时不能继承旧注册 owner
  description: string;
  inputSchema: Json;
  visible: boolean;     // 这份快照所描述的可见性
  isMutating: boolean;  // 默认 true；只读声明须开发者显式承担
}

interface AppSnapshot {
  schemaVersion: 1;
  id: AppSnapshotId;
  appId: string;
  instanceId: InstanceId;
  revision: number;
  createdAt: number;
  views: readonly ViewSnapshot[];
  refs: Readonly<Record<string, RefDescriptor>>;
  tools: Readonly<Record<string, ToolDescriptor>>;
  contentDigest: string;   // 整体语义内容指纹，不含时间与 id
}
~~~

ToolDescriptor 仅有描述，不含 JavaScript Handler/闭包；Handler 保留在 App 实例的活态执行 Registry。**refs Record 的键必须由 ownerViewId + ownerViewGeneration + refId 无歧义编码构成，不能直接以 refId 为全局键**；tools Record 则以内部唯一 toolId 为键。内存中的 Record 必须为安全、独立复制的纯数据；跨 IPC 必须使用规范化 wire schema。不可通过 shallow freeze 或共享对象引用假装不可变。

## 3. 准备态 Draft 与 IPC 协议

~~~ts
interface PreparedAppSnapshotDraft {
  schemaVersion: 1;
  appId: string;
  instanceId: string;
  producerSeq: number; // 当前 Producer 实例内每次准备尝试严格递增
  sourceEpoch: number;  // 捕获所依据的 SDK/Producer 变更世代
  capturedAt: number;   // 诊断性时间，不用于排序
  views: ViewSnapshot[];
  refs: Record<string, RefDescriptor>;
  tools: Record<string, ToolDescriptor>;
}

type SnapshotProducerMessage =
  | { type: 'SNAPSHOT_PREPARED'; draft: PreparedAppSnapshotDraft; suppressSignal: boolean }
  | { type: 'SNAPSHOT_PREPARE_FAILED'; appId: string; instanceId: string;
      sourceEpoch: number; code: string; message: string };
~~~

不得把旧 SNAPSHOT_FRAGMENT 中的 timestamp/version? 直接当作 committed revision。

生产端变化的最小规则：
- 每个运行实例的 instanceId 唯一；Host 在 App 启动/WorkerPool 获取新逻辑实例时注入并校验。
- producerSeq 在 Worker 中单调递增，即便某个草案后来被 Core 拒绝也不回退。
- sourceEpoch 在所有会改变 View、Ref、Tool 的受控变更时推进；Ref 注册即使不改变 DOM，也须触发 dirty。
- 生产端的快照 Draft 包含无函数、无循环、无访问器的结构化数据；不可在 IPC 中传递活 Ref 指针或 Tool Handler。
- schemaVersion 不兼容时拒收；禁止 best-effort 猜字段继续发布。
- Worker 退出或重置后，旧 instanceId 的所有晚到消息均不得覆盖新实例。

## 4. App 级版本、读取与去重语义

**instanceId** 处理重启/重建；**producerSeq** 处理 IPC 传输顺序；**sourceEpoch** 处理投影中途变化；**committedRevision** 处理对外成功发布的语义版本。四者不能合并。

提交时 Core 在同一个不含 await 的同步临界区执行以下最后一步：
1. 校验 App 注册的 instanceId 与来源身份匹配；比较 producerSeq > lastAcceptedProducerSeq。
2. 对 Draft 进行深度安全复制、规范化、总量限制和 INV-01/05/06 校验。
3. 若与当前 committed semantic digest 相同，仅记录已接受的 producerSeq，**复用当前 id/revision**；是否发通知由策略决定。
4. 若发生真实语义变化，分配 revision+1 和新 AppSnapshot ID，建立冻结对象，在一个原子指针交换中替换 current。
5. 只有发布成功后，才向消费者发 SnapshotPublished；用于静默更新的 suppressSignal 只影响通知，不影响提交。
6. 校验、传输或时序失败时返回结构化错误，保留 lastGood 且变为 degraded；不得暗中把旧快照当 current 新鲜状态。

**示例**：app_0 在 instance_X 下 revision=4，读两次均为同一个 snapshotId；纯通知但未改变 View/Ref/Tool 时仍是 revision=4；下一次改变 Ref 绑定即 revision=5；App 重启生成 instance_Y，不能与 instance_X/4 混同。

指纹计算覆盖排序归一后的 View 内容和身份、Ref payload/identity、Tool metadata/Schema/visible、App 语义说明等；不覆盖 createdAt、producerSeq、sourceEpoch。用规范化 JSON + 强哈希可减少比较成本，但正确性不能只依赖存在碰撞风险的短哈希；必要时对比规范化编码或采用经评审的强碰撞抵抗摘要并检测异常。

## 5. Producer 原子捕获屏障

### 5.1 为什么 DOM 已更新不能等于 Snapshot 已就绪

当前 Preact Hook 有不同时序：View 在 useLayoutEffect 注册，useDataRef 在 useEffect 注册，useArrayRef 在 useLayoutEffect 注册，useViewTypeTool 在 useEffect 注册。某次 DOM MutationObserver 报告的视图内容，未必已与 Ref/Tool Registry 对齐。

需要引入 **ProjectionCoordinator**（SDK Adapter 与 Worker Producer 的协作点），而不是单纯调大 DOM 节流时间。

### 5.2 必须满足的行为契约

- 视图提交、Ref 注册/卸载、ViewTypeTool 注册/卸载应以受控投影轮次汇总；拒绝在 render 过程中直接污染已提交 Registry。
- Coordinator 对所有影响 Snapshot 的动作推进 mutationEpoch，并维护 pending projection / registration count。
- flushPendingUpdates() 必须提供可验证的 ready：相关组件提交与注册副作用均已完成，且不再存在此轮应执行的 SDK 注册工作。
- capture() 先读取 epoch，复制 View/Ref/Tool，捕获完成后重新检查 epoch；变化即 abort/retry，且禁止发出旧草案。
- 任何 await 前后都需要重新校验 epoch；一旦 Prepare 成功，后续状态变化通过新的生产消息处理，绝不能修改旧草案。
- 不等待任意业务异步任务（如 LSP 网络请求）完全完成；加载/成功/失败各自可形成有效快照。
- 若反复变更导致无法收敛，按有界重试/时间预算返回 PREPARE_BUSY，而非饿死 CPU 或提交混合版本。

**实现关键未知**：当前 Preact 效果钩子能否提供可靠 flush-ready 保证。M0/SP-01/02 必须先验证；不能证明则在 M3 改 SDK 内部注册路径，strict mode 不提前开启。

### 5.3 参考算法（伪代码，非直接可运行补丁）

~~~ts
async function prepare(producer: SnapshotProducer): Promise<PreparedAppSnapshotDraft> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await producer.flushPendingUpdates();
    const epoch = producer.mutationEpoch;
    const draft = await producer.captureDraft();
    if (producer.mutationEpoch !== epoch || !producer.isReady(epoch)) continue;
    return sealPreparedDraft({ ...draft, sourceEpoch: epoch, producerSeq: producer.nextSeq() });
  }
  throw new ProjectionError('SNAPSHOT_PREPARE_BUSY');
}
~~~

不可只检查 JS event loop 未切换：相同 tick 内 SDK 注册本身也可能发生。捕获就绪定义必须由 Producer/SDK 共同证实，并在集成测试里覆盖。

## 6. Core Committer、Store 和 Health

~~~ts
type SnapshotHealth = 'unready' | 'ready' | 'degraded' | 'stopped';
interface SnapshotIssue { code: string; message: string; sourceEpoch?: number; path?: string }
interface SnapshotLease { snapshot: AppSnapshot; expiresAt: number; release(): void }
type CommitResult =
  | { status: 'published' | 'unchanged'; snapshot: AppSnapshot }
  | { status: 'rejected'; issue: SnapshotIssue };

type SnapshotRead =
  | { readonly status: 'ready'; readonly snapshot: AppSnapshot }
  | { readonly status: 'unready' }
  | { readonly status: 'degraded'; readonly lastGood?: AppSnapshot;
      readonly issue: SnapshotIssue }
  | { readonly status: 'stopped' };

interface SnapshotStore {
  readLatest(appId: string): SnapshotRead;
  getById(snapshotId: string): AppSnapshot | undefined;
  acquire(snapshotId: string): SnapshotLease; // 有界，须 release
  // 最终写指针只允许 Committer 内部持有的 Store mutator；不给一般读者公开。
  markDegraded(appId: string, issue: SnapshotIssue): void;
  stopInstance(appId: string, instanceId: string): void;
}
~~~

- **unready**：启动尚无合法快照；不发布假空结果。
- **ready**：存在可执行条件下的最新 Snapshot。
- **degraded**：生产失败；lastGood 可用于显式诊断读取，默认拒绝基于这份陈旧环境的有副作用 Tool。
- **stopped**：App 卸载/关闭，旧 Tool binding 撤销；历史快照是否仍可只读查看由 retain 策略控制。

current 指针与历史 retain 分开。latest 有固定 Store 所有权，不因普通读者 release 而删除。历史快照的数量、字节、TTL、lease 生命周期受配置限制；缺失/驱逐不得自动 fallback latest 解析。

### 6.1 核心校验器的入库前检验

- D-01：schemaVersion、appId、instanceId、producerSeq/sourceEpoch 合法且来源可信。
- D-02：View ID 在 App 实例范围内唯一，View Type 不为空；View 生命周期已反映到集合。
- D-03：Ref ID 作用域明确、ownerViewId 必须存在且未卸载；Ref target 严格可序列化且稳定身份不模糊。
- D-04：Tool ID、ViewType、公开 Schema 明确；一个 Tool 可在 Root 注册但面向其他 ViewType，**不得把 declaredByViewId 当作作用对象**。
- D-05：若内容使用 SDK 明确标记的 Ref Token，其来源 Ref 必须可解析；对于旧任意 Markdown 文本，只能校验已知 Token，无法假定每个类似链接都是真 Ref。
- D-06：拒绝 getter、循环引用、函数、symbol、NaN/Infinity、无约定的 class instance；支持显式 Codec，禁止无提示静默丢字段。
- D-07：执行 bytes、depth、View/Ref/Tool 数量和单项大小预算；超限抛出带字段路径的结构化错误。
- D-08：同名不同 View 的 Ref 必须在复合键中分别存在；Tool 内部 ID 碰撞拒绝，不依靠 formatter 改名化解。
- D-09：完整 Draft 的 Ref/Tool 变更即使没有 DOM 文本变化，也必须触发语义版本更新。

以上 D-01～D-09 与 05 测试计划建立一一对应的故障注入用例。

## 7. Ref 身份、来源解析与执行时校验

### 7.1 Ref 的完整查找键

~~~text
{appId, instanceId, snapshotId, ownerViewId, ownerViewGeneration, refId}
~~~

RefId 可在单个 View 内重复用于不同提交，但不能脱离 snapshotId 与 View 实例身份独立解释。内部复合索引必须使用结构化键或无歧义的编码，**禁止以末尾字符串相等推断唯一性**。

**Snapshot-value Ref**：保存快照时复制的纯值，历史读取返回观察当时的数据，不向调用方暴露原 App 的活对象。

**Entity Ref**：保存稳定 entityType/entityId/(entityVersion)；执行时由 App 的 resolver 读取当前对象并验证版本与授权。没有业务版本时默认保守拒绝旧版本的写入，不暗中把 refId 重新定位到数组当前位置。

### 7.2 约束粒度

- 读取/展示：只要来源快照仍可读取，就可返回历史值；不得宣称其代表“当前现实”。
- Tool 写入：先验来源 Ref 身份，再检查当前 App instance、View generation、Tool still available 和业务实体版本/权限。
- 来源 AppSnapshot revision 已过时，默认对 mutating Tool 拒绝 SNAPSHOT_CONFLICT；只有具备显式、可验证实体级版本/业务 CAS 策略时才允许粒度优化。
- 若 View 卸载再挂载同 id，generation 必须变化，旧 View 绑定不能复活。
- 删除目标后若同 entityId 重新创建，需要 entityVersion/incarnation（或业务方等价防 ABA 保证）检测，不得仅匹配字符串 ID。
- 拒绝将普通字符串参数自动当作 Ref。新协议通过 input schema 指明 ref 字段；旧参数适配只存在限期 legacy path。

### 7.3 ToolInvocation（内部草案）

~~~ts
interface ToolInvocation {
  sourceSnapshotId: AppSnapshotId;
  appId: string;
  appInstanceId: string;
  toolId: string;
  target?: { viewId: string; viewGeneration: string };
  invocationId: string;
  input: Json;
}

type ToolResult =
  | { success: true; data?: Json }
  | { success: false; error: { code: string; message: string;
      effects?: 'none' | 'partial' | 'unknown' } };

interface ToolExecutionPort {
  executeBound(invocation: ToolInvocation): Promise<ToolResult>;
}
~~~

执行必须顺序经过：
1. 从 Store 获取来源快照且验证 lease/TTL/instance；
2. 验证 Tool 在来源快照中存在且 schema 兼容，输入字段使用声明类型；typed Ref 从来源快照解析；
3. 对当前 App 实例与目标 View generation 做可用性校验；Tool 的**声明位置**与目标 ViewType 分离（例如 Root View 定义 FileDetail Tool）；
4. 根据 mutating/read-only 策略验证当前资源版本；含异步 validate 时须在进入业务 Handler 前再检查一次；
5. 由活态 Tool Handler 执行，并原样保留业务 ToolResult（历史 OperationResult 只能通过兼容适配，不能把业务失败包装成功）；
6. 返回可追踪结果；若请求已经进入外部副作用但结果未知，不自动重试写入。

**边界声明**：Snapshot 解决对象绑定与观察一致性，不能承诺外部系统的事务 CAS；文件写入、数据库权限等最终前置条件仍由对应 App/Capability 完成。本期不建设持久化 exactly-once 执行引擎。

## 8. Tool 身份、可见性与可执行性

- SDK ViewTypeTool 是注册入口；其公开描述在 AppSnapshot 中表达为 ToolDescriptor。
- 内部 Tool ID 在 App instance 内稳定，与 viewType + toolName + tool definition identity 关联；不得让不同 App 的同名 Tool 直接覆盖。
- visible/available 是 Snapshot 时刻的声明，不是执行授权。执行前必须再次验证当前 Handler、可用条件及业务权限。
- 同一 ViewType 多实例共享 Tool 定义，但指定 Ref 或目标 View 时必须有明确实例身份；Root 声明注册点不代表所有操作都针对 Root。
- 同一个 Tool 的 Schema/visibility 即使不改变 DOM 文本，也会改变 AppSnapshot 语义指纹并产生 revision。
- 不合法的 Tool public schema、重名 Tool ID、不可解析的 targetViewType 等进入发布失败/诊断；允许“已定义但当前没有挂载目标 ViewType”的 Tool 以 visible=false 存在，不直接作为执行能力公布。

## 9. WorkspaceSnapshot 与组合读取

~~~ts
type WorkspaceComponent =
  | { appId: string; instanceId: string; health: 'ready';
      appSnapshotId: string; revision: number }
  | { appId: string; instanceId: string; health: 'degraded';
      lastGoodSnapshotId?: string; lastGoodRevision?: number }
  | { appId: string; instanceId: string; health: 'unready' | 'stopped' };

interface WorkspaceSnapshot {
  id: string;
  createdAt: number;
  membershipRevision: number;
  metadataRevision: number; // Desktop/App 列表以外的投影元信息或系统日志发生变化时推进
  components: readonly WorkspaceComponent[];
  // projected markup 为只读派生表示，不参与单 App 原子声明。
}
~~~

在 Runtime Core 所属进程中，Workspace 组合在同一同步读取阶段从 Store 读取每个 App 的已提交 immutable pointer。**只保证 vector 内每个 component 是完整提交，不保证多个 App 的事务原子性或外部数据源同步。**

- App 安装、卸载等组合成员变化推进 membershipRevision；成员 App 的 Snapshot 或 Health 变化由 components vector 表达，相关系统日志/描述变化由 metadataRevision 表达。任一对外可见语义改变均产生新 Workspace ID。
- 若组件 vector + membershipRevision + metadataRevision 无变化，重复读取同一工作环境可复用现有 WorkspaceSnapshot ID；系统日志/工作环境说明若参与最终投影，也必须通过 metadataRevision 进入指纹，不得改变内容却复用相同 ID。
- 对 degraded App 显式显示健康态和 lastGood 诊断信息；禁止以 lastGood 假装当前 ready。
- WorkspaceFormatter 可以生成旧结构化消息/Markup/IndexMap，但它是派生投影，不可反向修改 Tool/Ref 事实源。
- 不同 App 的 Tool 外部名字碰撞可用稳定公开命名空间映射，内部 Tool ID 必须始终无歧义；拒绝依赖数组顺序自动改内部身份。

## 10. Snapshot 生命周期与容量

~~~text
Committed current [Store 持有] --- 新 revision ---> retained history [限额]
         │                                      │
         ├── readLatest (不创建新 ID)             ├── getById
         └── lease(snapshotId)                  └── TTL/capacity/lease policy
~~~

- 当前最新 Snapshot 由 Store 持有，不受客户端单次 release 影响。
- 所有历史引用具有最大保留期限、数量和字节预算；超过容量时优先驱逐无 lease 的最旧历史项。
- 有效 lease 在明确的 TTL 上限内保持一致观察；达到强制上限后请求必须返回 SNAPSHOT_EXPIRED。若上限与在途执行冲突，要在**进入 Handler 之前**最终检查；进入 Handler 后不伪称取消了不可逆副作用。
- 若所有历史项均被 pin、预算已满，**拒绝需要额外保留空间的新 Commit 或 lease，返回 SNAPSHOT_CAPACITY 并使该 App 降级**；不能静默驱逐已承诺有效的 Snapshot。可仅丢弃没有 lease 且超过策略的历史项，不破坏当前指针。
- 每个 App 释放/重启时清理对应 runtime 资源、Listener、Ref/Tool Handler binding；历史快照仅可按配置供诊断，不可借旧 binding 操作新实例。
- 大 Ref payload 预算、View 内容截断策略需要配置；若发生截断，必须明确标记，不能截断 Ref Token 后继续当作合法引用发布。

## 11. Structured errors 与状态观察

| 错误码（拟议） | 触发条件 | 对外恢复建议 |
| --- | --- | --- |
| SNAPSHOT_UNREADY | App 无合法首次提交 | 等待 ready / 重新读取 |
| SNAPSHOT_PREPARE_BUSY | SDK/Producer 无法在预算内获得稳定捕获 | 重试捕获，检查循环更新 |
| SNAPSHOT_INVALID | Schema/Ref/View/Tool 校验失败 | 定位具体 path、修复 App |
| SNAPSHOT_SERIALIZATION_ERROR | payload 非可序列化数据或单项预算超限 | 显式 Codec/减小数据 |
| SNAPSHOT_CAPACITY | Store 保留预算已满且受有效 lease 保护，无法安全发布/保留 | 释放历史 lease 或调整受审预算 |
| SNAPSHOT_EXPIRED | 原快照已驱逐/过期 | 重新读取；不自动重绑 |
| SNAPSHOT_CONFLICT | 源 revision 与写入政策不符 | 新观察或显式 entity CAS |
| APP_INSTANCE_MISMATCH | 来源实例已被重建 | 重新读取 |
| VIEW_INSTANCE_REVOKED | 来源 View 已关闭/同 ID 新挂载 | 重新读取目标 View |
| REF_NOT_FOUND / REF_AMBIGUOUS | ref 不存在或作用域冲突 | 重新获取 Ref；不可猜测 |
| TOOL_UNAVAILABLE / TOOL_SCHEMA_CHANGED | Tool 停用、描述/Schema 不兼容 | 使用最新快照选择 Tool |
| TOOL_RESULT_UNKNOWN | 业务副作用可能发生，但未获确认结果 | 检查业务状态，禁止盲重试 |

错误必须携带 context，例如 appId、instanceId、snapshotId、viewId、refId/toolId、producerSeq、sourceEpoch、字段 path 与可执行的修复建议。公开错误与日志分开，默认不泄露敏感 payload 全量内容。

## 12. Compatibility / shadow / strict 演进协议

| 模式 | 行为 | 允许阶段 |
| --- | --- | --- |
| legacy | 现有 SNAPSHOT_FRAGMENT → SnapshotFormatter → SnapshotRegistry；保留当前执行路径 | M0～M5 限期兼容 |
| shadow | 旧路径仍对外执行；新 Producer/Committer 旁路验证并记录差异，无副作用 Tool 执行 | M2/M3，先验兼容 |
| strict | 只使用已提交 AppSnapshot 作为权威 View/Ref/Tool/版本；来源绑定执行 | M4/M5 满足准出后 |

- 同一个 ToolInvocation **不可在 strict 解析失败后自动 fallback 到 legacy 活态 Ref Registry**，否则会重新引入错误对象执行。
- 切换模式以 App 实例/会话边界为单位，旧 SnapshotID 不跨模式复用；进入 strict 前清空或显式隔离不兼容绑定。
- shadow 中核查三份差异：View 集合/content、Ref 索引与 payload、Tool 定义与可用性；区分预期兼容差异与 P0 阻塞差异。
- 限期兼容读取 API 可在内部使用新 Store 的 readLatest/getById 生成旧 CachedSnapshot 形状；旧 API 的创建 ID 行为不再定义新核心语义。
- 开关回退只切换发布/执行路径，不回写/篡改 App 业务状态；不可双执行有副作用 Tool。
- 初始 strict 应先灰度内存 App，再 IDE，再扩展其他 App；阈值根据 M0 性能与故障基线确定，不捏造统一性能数字。

## 13. 当前代码到新职责的具体对应

| 当前实现 | 新职责或归宿 |
| --- | --- |
| worker-runtime/index.ts: pushSnapshotFragment | DomSnapshotProducer.captureDraft + prepare barrier + SNAPSHOT_PREPARED |
| worker-runtime/app-kernel/AppKernel.ts | 活态 View/Ref/ViewTypeTool Registry；SDK 协调端口；当前 Tool Handler |
| sdk/hooks/useRef、useArrayRef、useViewTypeTool | 维持 DX，内部注册到 Coordinator 和语义索引，统一 dirty epoch |
| engine/app/worker-host.ts | IPC 接收与来源验证；调用 Core Committer，按成功提交发布信号 |
| engine/system/registry.ts | 迁至 SnapshotStore，current 与 retained history 分离 |
| engine/view/snapshot/formatter.ts | 从结构化 committed snapshot 派生旧 markup/indexMap |
| kernel/index.ts: acquireSnapshot | 兼容 facade 读取 Store；新 Core API 不按每次 read 创建版本 |
| engine/system/dispatcher.ts | 来源快照 Ref/Tool typed binding 解析，传给活态执行 Port |
| experiments/semantic-kernel 的 copyJson/目标 revision 测试思想 | 仅复制通用算法理念和测试用例，不迁入现成 Session/Action/Observation API |

## 14. 核心内部接口（最小，不提前拆包）

~~~ts
interface SnapshotProducer {
  flushPendingUpdates(): Promise<void>;
  readonly mutationEpoch: number;
  isReady(epoch: number): boolean;
  captureDraft(): Promise<Omit<PreparedAppSnapshotDraft, 'sourceEpoch' | 'producerSeq'>>;
  nextSeq(): number;
}
// sealPreparedDraft 为 Producer Adapter 提供的严格拷贝/序列化函数，
// 不能分配 committed revision 或发布对外 Snapshot。

interface SnapshotCommitter {
  accept(draft: PreparedAppSnapshotDraft): CommitResult;
}

interface SnapshotReader {
  readLatest(appId: string): SnapshotRead;
  getById(id: string): AppSnapshot | undefined;
  acquire(id: string): SnapshotLease;
}

interface ToolBindingResolver {
  bind(invocation: ToolInvocation): Promise<BoundToolInvocation>;
}
~~~

以上接口是**方向性最小契约**，并非立即冻结的公共 API；M1 先以内部分层和依赖倒置验证。若跨 Worker 的 clone 约束导致接口需要调整，应通过 RFC Decision Log 显式变更，不能默默让 Producer 或 SDK 偷走 Commit 权限。

## 15. 必须先落地的 PoC 决策点

1. **SP-01 / Q-02**：Preact Effects 与 Registry 是否能构成 flush-ready 屏障？不能则先改 SDK 内部注册协调。
2. **SP-03 / Q-01**：Ref 的非 JSON 数据是否普遍存在？明确 Serializer/Codec 最小 API，拒绝无提示丢字段。
3. **SP-04**：App 重启后旧 Worker 推送是否会发生；确定 instanceId 由 Runtime 赋值且端到端校验。
4. **SP-05**：View 重开同 ID、相同 RefId、实体删除重建，确保 generation+entity version 充分防止错误寻址。
5. **SP-07**：全量深拷贝/跨 IPC 内存成本是否可接受；先测预算和上界，再考虑增量 Producer。

这些决策直接进入 [04 开发计划](./04-plan.md) 的里程碑准出条件，并由 [05 测试计划](./05-tests.md) 覆盖。

## 16. 本轮明确不会扩展的能力

本 RFC 不改模型推理/编排层，不要求将 IDE 业务状态迁入 Runtime Store，不要求从 Preact 转为直接 IR，不建设跨 App 分布式事务，不承诺 Worker 即不可信代码安全沙箱。

**设计总结**：Producer 只生产可验证的事实草案，Runtime Core 才发布带身份和版本的工作世界；所有 Ref 与 ViewTypeTool 的观察和使用都必须尊重这一来源版本边界。

## 17. M0 实测驱动的协议收敛（不改变方案 C 的所有权）

完整证据见 [m0/RESULTS.md](./m0/RESULTS.md)。下述约束是已有 D-01/D-03/D-05/D-09 的加强解释，不引入第二套 Core 语义。

**17.1 Ref-only invalidation 必须是生产协议事件，而不是 DOM 的偶然副作用。** 当前真实 AppKernel 在 Ref A→B 且 View 文本恒定的情况下未产生 DOM Mutation，也未 markDirty。未来 `ProjectionCoordinator` 必须直接监听/承接 RefRegistry 和 ViewTypeToolRegistry 的变更，使 sourceEpoch 递增并触发 Prepare，即使 View Markup 字节相同。

**17.2 SnapshotProducer 的 flush-ready 不能只靠 MutationObserver 节流。** 测试证明 View DOM 与 Ref/Tool passive Effect 之间存在空窗；使用 commit-phase layout-effect + microtask 的独立 PoC 同步路径可以汇合状态，但尚未证明跨异步更新的全面一致性。因此 strict 必须等 M3 真实 SDK/Worker 校验后才能开启。

**17.3 Worker IPC 的 sender 身份独立于 payload 声称的 appId。** 发送方通道必须绑定预注册 App 实例；收到 `SNAPSHOT_PREPARED` 时，Receiver 先校验通道所属 appId/instanceId，随后验证 producerSeq、Schema。只相信 payload 内的 appId 不构成来源验证；不可再只用毫秒 timestamp 去重。

**17.4 Ref marker 必须有权威含义。** 当前 `useArrayRef` 可以输出 `(Task[]:tasks)` 的 list-level 链接，但仅注册 `tasks[0]` 等 item-level Ref。M3 需要明确二选一：
- 若 listRef 是真正的集合 Ref，必须在相同 Snapshot 中注册对应具有容量预算的、可序列化的列表引用；
- 若 listRef 仅作列表标签，应生成不被当成 Ref 的可读内容，并在 SDK/API 层清楚告知。
**禁止**在 strict 下保留没有对应 RefDescriptor 的“看似可寻址标记”。更倾向默认显示语义、显式启用集合 Ref，待现有消费者兼容调查后冻结决策。

**17.5 错误修复不能通过额外包装成功实现。** 正式 AppKernel 已复现业务 `success:false` 返回外层 `success:true`，未来 ToolResult 需要在 SDK Handler、AppKernel、IPC 和 Runtime Core 之间保持原始成功/失败事实；发送/接收成功属于传输结果，不能覆盖业务结果。

**17.6 M1 不依赖生产 SDK 修改。** M0 输出 Conditional-Go for M1 Pure Core：先用独立内存 Producer 把 Snapshot Types/Validator/Committer/Store 的语义定稳，再实施 M2 Producer/IPC 和 M3 SDK CommitBarrier；这不是允许把新的 SnapshotStore 暴露为已达到 INV-01 的正式 App 状态。

**17.7 性能要求基线化而非虚构。** M0 已对现有 DOM Transformer、View Extractor、Formatter、Registry 进行了合成微基准，但不包含真实 SDK Render、IPC 与 IDE 文件/LSP。真正阈值在 M0 剩余工作或 M5 的真实工作集测试后确定。

**架构结果**：方案 C 仍然不需要 Runtime 直接拥有业务状态，不要求立即替换 DOM/Preact/Worker，也不自动赋予 Core 对不可信 Worker 的操作系统级隔离能力；它要做的是保护 Snapshot 发布与 Ref/Tool 来源绑定的正确性边界。

## 18. M1 实装结果与后续接口约束（2026-10-22）

实际实现细节、命令及未完成风险见 [M1 实施报告](./m1/RESULTS.md)。本节将已测试的核心设计决策反馈到方案 C，不把纯 Core 的成功偷换成现有 DOM/SDK 的原子捕获已完成。

### 18.1 M1 已落地的实现选择

- Internal Core 模块：runtime/src/core/snapshot/；当前只导出内部 index.ts，没有追加到 Runtime 顶层 package exports。
- createSnapshotCore 将能力分割为 **store（读/Lease）**、**committer（唯一成功发布）**、**lifecycle（受信任 Runtime 启动/停止 App 实例）**。
- Draft 的 View、Ref、ViewTypeTool 公开描述由 Validator 纯数据深拷贝/校验；Ref 复合键使用结构化编码的 [viewId,viewGeneration,refId]；同名 Ref 不做字符串后缀匹配。
- AppSnapshot 的语义相等使用完整 Canonical JSON 精确比较；fnv1a64 contentDigest 是**非加密诊断摘要**，不参与合法性和身份判定。后续若需 IPC 网络传输一致性校验，应独立设计强摘要机制。
- Prepared Draft 可包含 schemaVersion、appId、instanceId、producerSeq、sourceEpoch、capturedAt；只有 Committer 能生成正式 committedRevision。成功的同语义重复提交保留同 ID，非法提交保持 lastGood 且标记 degraded。
- 对生产端在创建 Draft 前的失败，committer.reportPrepareFailure 作为**可信 Runtime 内部能力**存在；M2 需要在 IPC 接收器对发送通道与真实 appId/instanceId 进行绑定校验，不得盲信 payload 字段。
- Store 当前采用按读取/提交惰性 TTL 清理，包含有界历史条目、字节与活动 Lease 上限；current 不因客户端 release 删除。
- Workspace 组合利用已提交 App 的同步指针读取、成员/元数据版本，提供 ready/degraded/unready/stopped 判别状态；未准备成员没有伪造的快照 ID。

### 18.2 M1 明确未兑现的契约

- **Producer 就绪屏障**：结构校验只能保证 Draft 自身合法，不能判断 Preact Effect 是否尚未注册 Ref/Tool。M3 实现真正的 ProjectionBarrier 是 INV-01 完整准出前提。
- **Tool 执行权限**：Store 的 ToolDescriptor 是历史观察元数据，不是执行授权；M4 必须绑定活态 Handler、Schema、业务权限、实体版本并保留 ToolResult 真实状态。
- **跨 Worker 身份认证**：当前 M1 Core 只按受信任生命周期中分配的 instanceId 验证提交数据；M2 必须以 IPC 实际通道身份核对消息来源。
- **完整 Tool JSON Schema 规范性校验与 Codec**：当前以可序列化纯值、schema 根 type=object 为最小边界，后续由 M3 与 SDK defineParams 对齐。
- **跨 App 原子状态**：WorkspaceSnapshot 永远不能从不同 App 的独立提交推导为一份跨 App 事务；成员与 metadataRevision 必须由调用方维护。
- **真实端到端性能**：M1 的纯 Core 微基准只适用于内存数据流，不含 Worker/Preact/DOM/IDE。

**当前架构决议**：M1 isolated Gate 已通过，允许 M2 进入 shadow 适配；必须继续保持 strict No-Go，直到 M3/M4 正确性 Gate 通过。

## 19. M2 真实 Worker Shadow 接入实证（2026-10-22）

实测、代码位置与待解决限制见 [M2 实施报告](./m2/RESULTS.md)。**M2 Shadow vertical slice 已验证；不代表 Strict Producer 和 Tool 执行可用。**

- 真实 Runtime Worker 通过 DOM Adapter 生成 M1 AppSnapshot Draft；旧 SNAPSHOT_FRAGMENT 的正式执行链独立保留。
- 新增 SNAPSHOT_PREPARED / SNAPSHOT_PREPARE_FAILED。AppWorkerHost 每个逻辑实例分配 UUID，Worker RESET 后必须清除捕获状态；Core 仅接受绑定 App+Instance 且 producerSeq 单调前进的 Draft。
- 以 shadowCaptureSeq + shadowInstanceId 为旧 Fragment 增加可选诊断关联字段；ShadowReceiver 可对应原始捕获进行 View/Ref/ViewTypeTool **数量**比较，若同毫秒旧消息被过滤则报告 unpaired Prepared。
- 开发环境可通过 AOTUI_SNAPSHOT_SHADOW=1 启用；默认关闭，新的指标不影响旧 UpdateSignal、不执行 Tool。
- Shadow Report 固定 mode=shadow、producerConsistency=unverified、strictEligible=false；**即使 Core 验证通过并返回 ready，也不构成 INV-01 全面证明**。

### 19.1 下一层语义屏障不可省略

目前生产端 sourceEpoch 是捕获次数，而不是 SDK 的受控语义变更世代。真实 SDK 可以在同一 DOM 文本下更新 Ref/Tool，且被动 Effect 可能迟于 DOM 首次渲染。M3 必须改变 SDK 注册/撤销的协调与刷新通知，才能使 Prepared Draft 具有真正同源语义；不得通过增加定时器等待或简单 Hash 比较代替提交屏障。

当前 DOM Node generation 只保证相邻捕获中 DOM 实例改变可被观察；M3 需要稳定 View owner token，Typed Ref、ListRef marker 和 Tool Schema 也应在 SDK 内明确声明而非 Worker 反推。

**Core 依然保持纯 TypeScript、无 Host/DOM/模型 Provider 依赖。正式 Runtime 中的 Worker/DOM 仅属于本阶段第一个 Producer Adapter，下一阶段不可将该技术细节反向移入 Core。**

## 20. M3 真实 SDK / Worker 语义提交切片与后续严格边界（2026-10-22）

实施记录见 [m3/RESULTS.md](./m3/RESULTS.md)。本轮已在真实 SDK、AppKernel 与 Worker 链路验证 View/Ref/ViewTypeTool 的常规同步布局注册、Ref-only 语义事件、View Generation、来源 Tool owner 与历史 Ref A/B 不重绑。**没有宣布原子 Snapshot 的全面 Strict 语义已经交付。**

### 20.1 新实现的职责归属

- 纯 TypeScript Core 的 SemanticProjectionCoordinator 管理 epoch、显式 begin/end、通知合并及 ready token，不依赖 DOM/Worker。
- SDK 的 createTUIApp、View、useDataRef、useArrayRef、useViewTypeTool 负责把语义对象注册、撤销及 View owner generation 纳入受控 Layout 提交阶段。
- AppKernel 的 View/Ref/Tool 注册变化推进语义 Epoch；Worker 订阅这些事件。Ref-only 变化无 DOM Mutation 也能刷新默认 legacy IndexMap 和 Shadow Draft。
- Worker 的 DomSnapshotProducer 取得 SDK View generation 与 ViewTypeTool 的 declaredByViewId / declaredByViewGeneration，并将 Root 声明位置与 FileDetail 目标类型分开。
- ShadowProducer 以语义 token 前后比较判定已追踪 mutation 是否发生，但 token.ready 只能确认当前受控 scope 没有开放的显式提交；M3 全面异常/异步时序测试仍是 Strict 的必经 Gate。

### 20.2 SDK Reference Marker 的合同补充

当前 useArrayRef 的 listRef / itemRef 会生成类型化 Marker，例如 Task[]:pending 和 Task:pending[0]。此前这些 Marker 无对应 Registry 键，构成 Ghost Ref。

本轮确保：
- 类型化列表和条目 Marker 均注册同名 Ref；
- 保留原 pending、pending[0] 等 bare Ref 作为兼容别名；
- 列表重排、类别变化、空列表及 View 卸载后，过时别名及时撤销；
- 实际 Worker 快照中 Typed Ref 绑定的旧版本 A 与新版本 B 保持独立。

**资源约束**：列表级 Ref 包含数组值，typed/bare 双别名可能显著增加复制/序列化和 Ref 数。超出 Core 预算应拒绝 Draft 并告知 App，而不是静默丢弃一个可见 Marker。后续通过显式集合 Locator / Codec 和真实工作负载度量决定优化方案。

### 20.3 Tool origin 的独立身份

Tool 的 target viewType 与 declaredByViewId / declaredByViewGeneration 是不同身份字段。Root 可以声明 FileDetail Tool；声明 Root 重挂载后如果 Worker Registry 仍保留旧 declaration generation，Core 必须拒绝该 Draft。是否可执行仍由 M4 当前 Handler/权限/业务版本复核决定，不可因 Snapshot 描述有效而直接授权。

### 20.4 不应由此推导的保证

已测试的同步 Layout + Microtask 合并，不能替代所有异步业务更新、异常渲染和第三方 Hook 的完整提交屏障。普通对象未经框架 API 通知的原地修改不产生可靠 invalidation。正式 Reporter 仍标记 producerConsistency=unverified 与 strictEligible=false。

因此本 RFC 的设计目标不变：**Producer 提供可靠准备与同源保证，Core 提供提交正确性，M4 负责已提交来源 Ref/Tool 的执行正确性。**
## 21. M4 前置设计决议：View 自治 Tool + Runtime 统一聚合（2026-10-22）

**方案 B 已确认，纯 Core 最小合同通过；旧正式执行链尚未切换，Strict NO-GO。** 实际代码与证据：[架构方案](./07-view-owned-tool-identity-proposal.md) · [M4 前置结果](./m4-preflight/RESULTS.md)。

三个 View 概念固定为：viewId（人类可读，开发者可写）、viewType（类型级 Tool 聚合）、viewInstanceId（由可信 Runtime 根据 AppInstanceId 和单调 mount 序列分配；卸载重建不复用）。viewGeneration 后续版本化收敛，不能和 viewInstanceId 并存为两个独立真实身份。

Tool 的 Handler 归当前 ViewInstance 所有；Runtime 在内部按实例/名称保存绑定，向 Agent 按 App/ViewType/ToolName 聚合一致的公开 Schema。已通过 80 个 FileDetail 自治 Tool → 一条聚合定义的测试。Tool 绑定内部需要 registration/bindingVersion 防止同一 View 重注册或 enabled 切换后旧观察调用新 Handler；该值不是 Agent 需要填写的 View 身份。

**执行链约束**：未来 Adapter 只能从验证过的、已固定版本的 AppSnapshot 获取 viewId→viewInstanceId 与 Tool 绑定版本，再调用对应活态 Handler。内部纯 Core 的 invoke 原型不具备单独的生产授权能力；业务权限/状态版本、参数校验、并发和 ToolResult 真实性仍是 M4 正式 Gate。现有 M1 Snapshot Schema V1 未改动，须通过版本化适配后再作为正式来源。


## 22. M4 Stage 1 / Stage 2 已实现的 View-owned Tool 与 Snapshot V2（2026-10-22）

实际源代码、约束、日志和反例见 [Stage 1 报告](./m4-preflight/STAGE1_RESULTS.md)、[Stage 2 报告](./m4-preflight/STAGE2_RESULTS.md)。

**Stage 1** 让 Runtime-owned ViewInstanceId 在 SDK View 实际挂载时签发；原 viewId 和 viewType 仍属公开语义。新的 View-local useViewTypeTool 只注册到实例级 Registry，并按类型聚合只读定义；旧五参数 TypeTool API 完全保留。新 Tool 尚未授权执行，因此不进入原 Agent IndexMap，也不渲染可调用的旧 tool-ref Marker。

**Stage 2** 明确 Snapshot V1 与 V2 是不同的数据 Schema，而不是向 V1 偷添字段。V2 ViewSnapshot 采用 viewInstanceId，V2 Ref 按这个实例引用，V2 ToolDescriptor 有 targets[]，每个目标包含 viewId、viewInstanceId 与 Tool bindingVersion。只要 View 或 Tool 绑定变化，即使可见 DOM 不变，正确投影也必须更新 Snapshot 的语义内容与 Revision。整个 V2 Draft 由 Runtime-only Committer 在同一个 Store 中同步发布；v1 格式继续兼容。

V2 Shadow Producer 比对 Runtime 注册 View 与 DOM 的身份，且仅在没有 legacy TypeTool 的 View-owned App 中选择 V2；混合旧 Tool 使用 V1 Shadow 而不是丢失旧工具。Producer 错误不准静默降级，仍然不触发任何正式 Tool Handler。

读取历史 V2 的 Tool 来源只能通过 Runtime-owned Store 的有效 Lease、确切 Tool/Target、AppInstance 与当前 Committed ViewInstance/Tool 绑定版本，以及等价 Tool Schema 判断；只返回只读选择，没有 Handler。**来源选择不是执行权限**，必须另加活态 Handler、权限、业务 CAS 和并发检查。

V2 Validator 目前复用了 V1 校验的内部代理，因此存在额外拷贝成本，100 View 合成 p50 V1=5.298ms、V2=10.974ms，尚未通过真实 IDE 的性能门槛。M3 的异常/异步提交屏障与 Stage 3 正式 Tool 调度授权仍未完成。Strict NO-GO。


## 23. Stage 4：默认 Snapshot IPC 与原子创建的正确性收敛（2026-10-23）

真实源代码、测试与性能证据：[M4 Stage 4](./m4/stage4/RESULTS.md)。

Snapshot Fragment 的 timestamp 只是诊断数据，不是消息身份。同一绑定物理 Worker 通道按接收顺序处理消息：Host 对 appId 严格匹配，存在 AppInstanceId 时也必须匹配当前 Runtime 发行的 App 身份；若消息包含 shadowCaptureSeq，则拒绝非递增序号。两个合法的同毫秒 Fragment 不得因时间戳碰撞而被过滤。老 Worker 没有 AppInstanceId 时仍走绑定物理 Worker 的兼容通道，但不能虚构它具有独立的来源身份认证。

V2 的输入仍然先执行可信 Core copyJson。之后映射的 V1 校验代理已经来源于隔离数据，可由内部 validateCopiedV1Proxy 复用原始限额/Ref/Tool 规则，不必重新复制。V1 正式入口 validatePreparedDraft 永远自己复制输入。V2 代理不发布，不得直接让任意调用者访问内部 fast-path 作为授权或校验替代。

IDE create_file 不再推测 FileDetail viewId；实际编号只由已经挂载的 View 和下一份 Snapshot 确认。fileSystemService.createFile 使用 fs.writeFile(..., flag wx) 的原生排他创建保证不会在检查不存在后误覆盖另一并发创建者。此保证**只针对创建**，不能推广为 write_file/edit_file 的资源版本 CAS。后续 UI/持久化事件失败不能让成功的磁盘创建伪装成 CREATE_ERROR，应该返回业务成功并附带警告。

任何未解决的 Mutating Tool 来源/权限/CAS 不得绕过；正式 Strict Gate 仍 No-Go。


## 24. M4 Stage 5：V2 版本化实体 Ref + 合作式文件前置条件（2026-10-23）

完整代码事实、实际测试和不保证范围：[Stage 5 报告](./m4/stage5/RESULTS.md)。

**身份继续最小化**：开发者公开 viewId，Runtime 发放 viewInstanceId，Tool 绑定版本仍与 View 生命周期独立。已经提交的 Snapshot V2 RefTarget 支持 entityType/entityId/entityVersion；新增 SDK useEntityRef 在原 Layout Commit 阶段注册明确的版本化 JSON 标记，V2 Producer 只对严格结构的实体标记输出 entity Ref。不要把普通 JSON Ref 猜成受控资源，更不能因为声明带版本便认为具备业务权限。

新增纯 TS acquireVersionedEntitySource 复用既有 Store Lease/Tool Source 选择，只有相同 AppInstance、ViewInstance、Tool binding 和文件实体版本才返回只读资源来源。Snapshot 选择仍不执行 Tool，不允许 Agent 自填版本变成权限令牌。资源实际修改由独立 IDE File Adapter 比对真实磁盘 SHA-256 再行决定。

**文件系统可行性边界**：Node 原生 wx 锁文件 + SHA-256 前置检查 + 同目录临时文件与 fsync + rename，保证合作式写入者之间不丢失更新，且会拒绝在检查前已发生的外部修改。此机制不能对不参与锁协议的外部程序提供 OS 原生原子 CAS；写入调用之间没有跨 AppSnapshot/磁盘事务。默认 Agent 的 write_file/edit_file/delete_file 仍按旧路由执行，不接本实验接口。

纯 Core/V2 依旧不引入 DOM、Worker、SDK、文件系统依赖；FileSystem 特定原子写逻辑属于 IDE Adapter。真实 Worker V2/SDK 与真实临时文件系统的联合验证已执行，Strict 与 Mutating Agent Router 保持 No-Go。
