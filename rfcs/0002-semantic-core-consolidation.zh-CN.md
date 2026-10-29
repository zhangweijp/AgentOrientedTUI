# RFC-0002：Semantic Core Consolidation（语义核心收敛）

- 状态：**Draft / M5 内部纵向切片已验证，未批准默认 Runtime 迁移**
- 日期：2026-10-24
- 范围：Runtime Core、SDK 的语义边界、一个不依赖宿主的验证切片
- 明确排除：Mobile、Agent Driver 改造、桌面 UI 重写、依赖升级、全仓拆包、业务功能扩张
- 源码基线：当前工作树（HEAD `789ef07` + 大量既有未提交修改）；**不能只从 HEAD 复现此切片**
- 上位依据：`rfcs/0001-semantic-runtime-technology.zh-CN.md`
- 相关实现：`runtime/src/core/`、`experiments/semantic-kernel/`

## 1. 核心决策

AOTUI 的核心应定义 **Agent-Native Application 的交互事实**，而不定义一种桌面环境或一种 UI 渲染技术。

核心独立性是关于**职责与可替换性**，不是禁止外围实现使用 DOM、Preact、Node Worker 或 Electron：

- Core 不读取 DOM、不管理 Worker、不构造 Prompt、不依赖具体模型/Host。
- 应用通过 SDK 或其他 Producer 生产语义投影；Host 只负责环境装配、身份、权限、资源和生命周期驱动。
- Core 维护身份、不可变快照、来源绑定、动作调用记录与结果语义。
- 资源适配器执行真实的文件/数据库/网络变更，并在其自己的事务边界验证版本。
- Preact/DOM 作为默认的易用 Adapter 保留，而不是替代语义内核。
- 这是 **Semantic Microkernel**，不是“仅仅加载插件的通用容器”。

**禁止用拆 npm 包来替代契约设计**。先从可验证的内部模块逐步收敛，最后决定公共包出口。

## 2. 语义对象：不合并职责不同的概念

| 对象 | 最终权威含义 | 所有者 |
|---|---|---|
| AppSnapshot | 某个 App Execution 发布并通过 Core 校验的不变投影 | Core Snapshot Store |
| WorkspaceSnapshot | 若干 AppSnapshot 版本指针及健康状态的组合；非跨 App 原子事务 | Workspace Composer |
| Observation | 一个调用方被允许看到的工作切片及该切片中的动作绑定；关联源 AppSnapshot 版本 | 未来 Observation Issuer / Policy Adapter |
| ViewInstance | 某个 View 实际挂载期的身份；与开发者写的 viewId 区分 | Core 所确认的 App 生命周期 / SDK Producer |
| Reference | 对原 Observation 中快照值或业务实体的明确引用，不是列表索引的“最新解释” | Core 验证 + Producer 声明 |
| ActionDefinition | 动作公共描述和输入契约，定义可复用 | App / SDK |
| ActionBinding | 特定 Observation 中的 Action 对特定 ViewInstance / Entity / 版本的绑定 | Core 验证 |
| Invocation | 一次以 invocationId 标识的逻辑动作，引用原始绑定并提交输入 | Core 协调 |
| Outcome | succeeded / rejected / failed / accepted / unknown | Core 契约 + 业务适配器报告 |

注意：`runtime/src/core/snapshot` 使用 `AppSnapshotV2`、`ToolDescriptorV2`；`experiments/semantic-kernel` 使用 `Observation`、`Target`、`ActionResult`。**二者目前不是可互换类型，不应粗暴合并或拷贝代码**。

必须先建立交叉映射与统一行为测试，之后才决定某个公开类型的稳定形式。

## 3. 七条不可破坏的不变量

1. **原始来源绑定**：调用必须指向调用方实际取得的观测。执行时不能悄悄把旧 Ref、View ID 或工具改绑到最新对象。
2. **实例生命周期**：`viewId` 可重用，`viewInstanceId` 不重用；卸载某个实例后其旧绑定失效，即使它重新挂载为同名 View。
3. **局部条件失效**：View/Tool 所属实例或绑定修订变化时拒绝旧动作；仅显示内容变化不自动撤销无关动作。资源版本依赖可独立声明。
4. **业务 CAS**：Core 的来源验证不能代替数据库事务或文件条件更新。真正的写入必须使用观测的实体版本并在适配器的实际写入边界检查。
5. **结果真实性**：不能将 `{success:false}` 重新包装为成功。执行已开始后遭异常、超时或失联，不能假设没有副作用，需允许 `unknown`。
6. **有限幂等性**：同一逻辑 invocationId 与相同请求复用结果；相同 ID、不同请求拒绝；记录容量耗尽时拒绝新请求，而非淘汰旧写入的去重记录。
7. **保留和取消有边界**：快照租约、调用记录、观测和诊断受容量约束。AbortSignal 不保证底层效果撤销，内存记录不提供跨进程 exactly-once。

## 4. 最小内部切片 M5：Snapshot V2 → Bound Invocation → Business Adapter

本轮不发行正式 Observation Issuer，也不改变旧 Agent Tool Router。**复用已存在的 V2 受信 Snapshot 选择器**，以固定五元组（snapshotId、appId/instanceId、toolId、viewId）作为临时动作来源身份；写入另带原始 refId。

新模块：`runtime/src/core/invocation/bound-action-executor.ts`

调用路径：

```text
Trusted V2 Producer → SnapshotCore.committer.accept()
       ↓
AppSnapshotV2 (store-issued snapshotId)
       ↓
BoundInvocation(snapshotId, appId, instanceId, toolId, viewId, refId?, invocationId, input)
       ↓
BoundActionExecutor
  ├─ 防御性 JSON 拷贝与完整请求指纹
  ├─ 预留调用记录（避免并发重复进入）
  ├─ acquireToolSource / acquireVersionedEntitySource（来自原快照的租约）
  ├─ adapter.validateInput（必须针对当前绑定 Schema）
  ├─ 重新核对原来源 + adapter.isLive（异步让出后）
  ├─ adapter.authorize（Host 身份/角色/租户权限）
  ├─ 重新核对原来源 + adapter.isLive（异步让出后）
  ├─ adapter.execute（真实业务 CAS / 查询 / 操作；仅此处产生副作用）
  └─ 五态 Outcome + 释放租约 + 保留调用记录
```

### 当前实际接口

```ts
const runner = createBoundActionExecutor(snapshotCore.store, {
  validateInput: (source, input) => validateAgainst(source.tool.inputSchema, input),
  isLive: source => liveRegistry.check(source.tool, source.target),
  // check returns {ok:true} or {ok:false, code, message}
  authorize: (source, input) => policy.canExecute(source, input),
  execute: async ({ source, invocationId, signal }, input) => {
    // Atomically CAS source.resource.entityVersion in the business adapter.
    // invocationId is available for durable idempotency/audit at that layer.
    return resourceAdapter.apply(source, input, { invocationId, signal });
  }
}, { maxReceipts: 1024 });

const result = await runner.invoke({
  snapshotId, appId, instanceId, toolId, viewId,
  refId: 'task', invocationId: 'one-logical-attempt', input: {}
});
```

示例中的 `validateAgainst`、`liveRegistryStillOwns` 和 `resourceAdapter` 是**应用/宿主需要提供的适配函数**，不是本轮新增的框架 API。适配器可信，Core 不执行 JSON Schema 引擎，也不授予资源级权限。

此切片暂时对修改操作要求 **V2 versioned Entity Ref**；不覆盖无 Ref 写入、无版本写入、read-only Ref 参数解析、跨资源原子事务或长时间持久作业。禁止为迁就旧 IDE 写入 API 而放宽要求。

## 5. 明确现状与成熟度差异

| 路径 | 现状 | 结论 |
|---|---|---|
| 旧 DOM/Markup/IndexMap | 现有 Desktop/IDE 默认路径 | 继续兼容，本轮不更改 |
| `runtime/src/core/snapshot` | V1/V2 严格校验、历史、租约、绑定 | 已有 Core 基础，但不是默认路径 |
| `runtime/src/core/tool/view-owned-tools` | View 实例所有权与工具定义聚合 | 已有严格注册/撤销行为 |
| `runtime/src/core/invocation` | **本轮新增 M5 内部切片** | 测试验证执行边界，未作为公共入口 |
| `experiments/semantic-kernel` | 独立 Session / Observation / ActionResult 技术实验 | 已有独立验证，但未迁入默认 Host |

特别强调：`BoundActionExecutor` 不创建正式 `Observation`，也不提供自己独立的 Producer、Scope、持久调用日志或模型集成。它只证明现有 Snapshot 和来源绑定可与可信执行适配器形成一次可测试的闭环。

## 6. 已做验证与尚未取得的保证

本轮新增测试：

`runtime/src/core/invocation/bound-action-executor.test.ts`

覆盖：无 DOM/Worker/Host 的执行、无关显示内容变化、同类型多个 View 的目标隔离、View 卸载/同名重挂、未提交 Snapshot 前的工具禁用、异步输入校验和授权后的重新验证、外部版本变化的业务 CAS、并发及完成后去重、ID 冲突、容量饱和、伪造 Ref、权限拒绝、恶意 getter、调用输入与用户对象隔离、五态结果、异常的 unknown、关闭后的 AbortSignal 与真实结果保留。

已运行（2026-10-24）：

```sh
pnpm -C runtime exec vitest run src/core/invocation/bound-action-executor.test.ts --reporter=dot
# 15/15 passed

pnpm -C runtime exec vitest run src/core --reporter=dot
# 13 test files; 214/214 passed

pnpm -C runtime exec vitest run --reporter=dot
# 75 test files; 738 passed, 3 skipped, 7 todo

pnpm -C runtime exec tsc --noEmit -p tsconfig.json
# exit 0
```

**这些结果不能证明：** 默认 IDE 正在使用 M5、生产权限安全、真实文件系统并发写入严格 CAS、跨进程/重启去重、模型任务质量、完整 GUI 或 npm 发布可用性。

## 7. 下一阶段的明确准入门槛

### M6：统一语义定义，避免永久“双 Core”

- 建立 `AppSnapshotV2 → Observation` 的受信只读转换，并明确定义策略裁剪何时生效。
- 统一 `experiments/semantic-kernel` 的 `ActionResult` 与本轮 `ActionOutcome`，保留唯一权威定义。
- 把本轮固定来源选择和独立实验中的真正 `ActionBindingId` 对接，避免 ActionBinding 只存在于适配器约定中。
- 在纯 Core 测试中验证多 View 同类型实例、列表重排、取消与业务 CAS、历史租约、异步授权竞态。

### M7：连接 SDK 的一条真实 View-owned 工具

- 先从一个无副作用的 IDE 读取能力开始，使用当前 SDK View-owned tools 与 V2 Producer。
- Core 成为**此能力的唯一执行依据**；对照旧路径测试相同业务后置状态。
- 在开发/调试环境中显示来源 Snapshot、Tool Binding、资源版本和执行结果，禁止静默回退到旧路径。
- 有读取路径证据后，再选一项带业务原子更新的实际 IDE 写入操作进入新路径。

### M8：逐步迁移默认路径、收敛对外 SDK

- 必须证明 DOM Producer 的语义提交边界、Ref/Tool 生命周期以及 Worker 关闭竞态。
- 为旧应用定义明确版本和迁移指南，完成独立产物消费测试。
- 只在 IDE 真实链路和第二种非桌面宿主都满足一致性验证后，考虑稳定 Core npm 出口并移除旧路径。

## 8. 拒绝的短期做法

- 不把 `experiments/semantic-kernel/src/kernel.ts` 整个复制进 Runtime。
- 不因 Core 已可在 Node 运行而宣称已脱离 Node/DOM 的所有部署约束。
- 不将文件、LSP、Database 的业务算法塞入 Semantic Core。
- 不把异步 `authorize` 的通过等同于执行权限永久有效；执行前必须重新核对，写入时必须业务 CAS。
- 不直接升级依赖、重排 pnpm workspace 或一次性拆成多个包。
- 不改变用户现有的约 160 项未提交修改；新增文件与默认路径保持隔离。

**最终目标**：让 Runtime 真实维护 Observation 与 Invocation 的唯一语义，不让 DOM、Worker、Host 或模型厂商成为交互正确性的前提；由独立可替换的适配器兑现具体执行环境和业务数据的事实。
