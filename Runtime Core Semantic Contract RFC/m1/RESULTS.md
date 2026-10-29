# M1 实施报告：纯 Runtime Core Snapshot 契约

- **状态**：M1 isolated implementation = PASS；**未接入正式 Worker/SDK/IDE**
- **日期**：2026-10-22
- **实施基线**：本地 HEAD 789ef07 加已有未提交修改；Node v23.11.0，pnpm 10.15.1
- **上游**：[M0 预研](../m0/RESULTS.md) · [目标与约束](../00-charter.md) · [技术设计](../03-design.md) · [开发计划](../04-plan.md) · [测试计划](../05-tests.md)

## 1. 结论

依据 M0 的 Conditional-Go，只实施了 **M1-A～E 的独立纯 TypeScript Runtime Core**：类型契约、数据防御性校验、不可变快照、版本化 Committer、有界 SnapshotStore、WorkspaceSnapshot 版本向量和内存 App。

**本次 M1 准出只对纯 Core 契约及其代码测试成立**。当前 SDK Hook 还不能保证原子捕获，尚未对现有 Worker/IDE 的 Snapshot 和 Tool 执行路径开启 strict。

## 2. 已交付文件与职责

| 交付 | 新增代码位置（相对于仓库） | 职责 |
| --- | --- | --- |
| M1-A / Types | runtime/src/core/snapshot/types.ts | AppSnapshot、ViewSnapshot、RefDescriptor、ToolDescriptor、PreparedAppSnapshotDraft、健康态、来源身份/版本及 WorkspaceSnapshot |
| M1-B / Validation | json.ts、validator.ts | 严格纯值拷贝、拒绝 getter/class/循环/不可序列化数据、深度与容量限制、View/Ref/Tool 身份与作用域校验 |
| M1-C / Committer | store.ts | Core 独占发布权；校验 instanceId、producerSeq、sourceEpoch，正式 Revision 只在成功语义变化时推进，内容不变复用 ID |
| M1-D / Store | store.ts | current/latest、历史保留、TTL、Lease、容量/失效、无歧义 Ref 解析和只读 ToolDescriptor 查询、App 实例生命周期 |
| M1-E / Memory App | memory-app.test.ts | 无 DOM/Worker/Preact 的 Task App，展示 Ref → ToolDescriptor → 业务方 CAS → 新 Snapshot |
| Workspace 组合 | workspace.ts | 各个已提交 AppSnapshot 的版本向量、ready/degraded/unready/stopped；不承诺跨 App 事务 |
| 内部导出 | index.ts | 仅供内部引用，未修改 runtime package.json exports 或 SDK 公共 API |

另外新增 snapshot.test.ts、workspace.test.ts 两份契约测试。**没有改动旧 Runtime/SDK/IDE 的生产文件**。

## 3. 已验证的语义不变量

- **INV-01（Core 能检验的部分）**：Ref 必须有现存 View owner + generation；Tool 标识、声明者与目标 ViewType 均经过验证。**尚不能从一份结构自洽的 Draft 推断它是否来自真实应用中的一致捕获时刻**；M3 必须继续提供 ProjectionBarrier。
- **INV-02**：快照数据经独立复制与 deep freeze；修改原 App 对象及嵌套值不会修改过去的快照；拒绝 getter、symbol、Date/Map/class、BigInt、NaN、环、不合法数组。
- **INV-03/04**：instanceId + 成功提交 Revision 为权威身份；sourceEpoch/producerSeq 用于来源顺序；重复相同内容不会因为重新读取或新的 capturedAt 分配新 ID。
- **INV-05**：Ref 复合键使用 JSON 编码的 [viewId, viewGeneration, refId]；两个 View 中的同名 Ref 分别解析，历史列表下标不会重绑到新对象。
- **INV-06**：Tool 公开描述和 Schema 从 Handler 中分离，Snapshot 仅包含描述，不包含闭包；**Tool 执行授权留待 M4**。
- **INV-07**：SnapshotCommitter 是唯一内部发布能力；Store 是读/Lease，生命周期由受信任 Runtime 单独驱动；失败不部分替换快照、不提高成功 Revision。
- **INV-08**：WorkspaceSnapshot 为各 App 已提交指针的版本向量，带 membershipRevision/metadataRevision；未就绪成员无虚构的 Snapshot ID。
- **INV-09**：老快照有界存储、TTL、Lease、条目/字节/活动 Lease 限制；失效/驱逐不能 fallback 当前 Ref；容量满且无法在保持 Lease 的前提下腾出空间时明确拒绝。
- **INV-10**：Core 生产代码只互相导入，不引用 Preact/DOM/Worker、Node 专用库、模型 SDK；纯 Node/Vitest 无 DOM 环境可运行。
- **INV-11/12**：目前没有接入旧 AppKernel ToolResult/权限处理；M4 才能证明跨层成功/失败与活态授权真实保持。

## 4. 额外失败恢复接口

为覆盖 Producer 在构造 Draft 之前失败的情况，新增内部 SnapshotCommitter.reportPrepareFailure。它只在受信任 Runtime 控制下，用有效 appId、instanceId、producerSeq、sourceEpoch 报告问题；Core 将 App 标记 degraded 并保留 lastGood，不虚构 ready 状态。

对于嵌套 Ref 循环或不可序列化而未能完成 Clone 的 Draft，Validator 尝试只从顶层**自有数据描述符**读取来源字段，在不执行顶层 getter 的前提下恢复可核验的来源信息。正式 M2 仍必须依据真实 WorkerHost 通道校验发送者，不能将 payload 声称的身份当作认证。

## 5. 真实测试结果

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| Runtime TypeScript noEmit | exit 0 | [final-regression.log](./final-regression.log) |
| Runtime 全套 Vitest | 47 文件，432 passed、3 skipped、7 todo，exit 0 | [final-regression.log](./final-regression.log) |
| SDK 全套 Vitest | 7 文件，64 passed，exit 0 | [final-regression.log](./final-regression.log) |
| IDE Jest | 3 suites，5 passed，exit 0 | [final-regression.log](./final-regression.log) |
| 新 Core 专项 | 3 文件，52 passed，exit 0 | [coverage-final.log](./coverage-final.log) |

新增 52 项 Core 测试均通过，原有 Runtime 380 passed 维持：432 = 380 + 52。覆盖率仅统计本次 Core 目录（Vitest V8）：

- **Statements/Lines：95.95%**
- **Branches：87.06%**
- **Functions：100%**

这些数据不等于整个项目覆盖率，也不能代替尚未创建的 M2/M3 真实 Producer 和 IDE E2E 测试。

### 5.1 纯 Core 微基准（不是整体性能承诺）

每 View 约 1 KiB 文本和一条 Ref，5 次 warmup + 20 次采样；只测进程内 Committer.accept，包含复制/校验/内容比较/发布：

| View 数 | p50 | p95 |
| ---: | ---: | ---: |
| 1 | 0.183ms | 0.372ms |
| 10 | 0.622ms | 0.764ms |
| 50 | 2.547ms | 2.894ms |
| 100 | 5.367ms | 5.760ms |

原始结果见 [performance-baseline.log](./performance-baseline.log)，复现入口见 [benchmark.ts](./benchmark.ts)。没有包含 Preact、DOM、Worker IPC、IDE 文件 I/O 或 LSP，**不能与 M0 的不同合成工作负载直接对比后宣称性能变好或变差**。

## 6. 对原设计草案的明确取舍

| 设计点 | M1 实现决策 | 长期含义 |
| --- | --- | --- |
| Core 端口 | createSnapshotCore 返回只读 Store、唯一 Committer、受信任 Lifecycle | 明确控制权，避免任何读取端成为隐式写入者 |
| 语义相等性 | 完整 Canonical JSON 精确比较 | 不依赖短 Hash 碰撞概率作为对象正确性的依据 |
| contentDigest | fnv1a64 非加密摘要，仅供诊断 | 不参与快照身份、来源认证或一致性判断；跨进程校验需另行定义强摘要 |
| Ref 作用域 | [viewId,generation,refId] 复合键，不猜测字符串后缀 | 避免同名 Ref 和 View 重挂载导致 ABA |
| Tool Schema | 已验证可序列化、根对象 schema type=object | 尚未运行完整 JSON Schema 元验证；M3 要与 SDK defineParams 对齐 |
| JSON Codec | M1 仅接受纯 JSON，不自动转 Date/Map/BigInt/class | M3 可以提供显式 Codec，不应静默删字段 |
| 历史存储 | current 强引用；有界历史与活动 Lease；按读/提交惰性清理超期项 | M2/M5 若需后台回收应由执行 Adapter 实施，Core 不引入 Timer |
| Workspace | Composer 缓存版向量；membership/metadataRevision 由调用者提供 | M4 正式 Desktop 提供来源数据，当前未接入 Host |
| 来源实例 | 生命周期端口必须由可信 Runtime 提供唯一 instanceId | M2 必须绑定真正 Worker 通道身份，不能单凭 payload appId |
| 对外发布 | 不向 @aotui/runtime 根包 re-export | 保持 M1 内部实现状态，避免 SDK 尚未兑现的 API 承诺 |

## 7. 代码审查中修复的问题

- TS 类型检查提示健康态判别联合可能返回缺少 Snapshot 的 ready，已经按状态收敛。
- 测试中将默认任务 ID 误写为其他对象，修复 Fixture 预期，没有放松 Ref 作用域断言。
- Lease 预算策略明确为先淘汰**未被 Lease 保护**的历史，只有无法腾出空间才拒绝提交；修复了原本过度保守的测试假设。
- 恢复成相同 lastGood 内容属于 unchanged，不产生新的 Revision；通过测试固定该规则。
- 对源循环/序列化失败缺少 degraded 状态的问题，补充可安全读取的 envelope 与显式失败上报。
- 增加数据拷贝前期近似字节预算，降低巨型 Payload 在最终精确预算检查前的内存风险。
- 增加活动 Lease 数量限制及相关资源测试，避免无限 Lease 分配。

## 8. 尚未解决的工程风险与明确后续归属

**M2 / Worker Producer & shadow**：真正绑定通道来源 appId/instanceId、使用 producerSeq/sourceEpoch，旧 Worker 消息隔离，Producer 失败上报，新旧快照影子对比。

**M3 / SDK ProjectionBarrier**：useDataRef、useArrayRef、ViewTypeTool 的 Effect/注册时序，Ref-only 变更通知，ListRef marker 与真实 Ref 的语义一致，必要的 Codec/API 向后兼容。

**M4 / Strict Tool 与正式 Workspace 集成**：旧 Snapshot Tool 调用的活态权限/版本校验，跨层 ToolResult 真实性，Ref/Tool 对应实际执行环境，legacy/strict 安全切换。

**非本轮能力**：不会因为目前 Core 只读 getTool 返回一个历史描述，就宣称它具备副作用执行授权；不会因为 Draft 自洽就宣称当前 Preact Producer 已经提供真正原子捕获；不会因为 Node Worker 存在就宣称不可信代码安全隔离。

需要后续审查的资源与性能事项包括历史 lazy TTL、长期 instanceId tombstone 集合、复杂 JSON Schema 的元验证以及真实 IDE 的大工作集压力。

## 9. M1 Gate 结果与推荐

| M1 交付 | 结果 |
| --- | --- |
| M1-A 纯类型/身份约束 | 已交付、已测试 |
| M1-B 严格复制/Validator | 已交付、已测试 |
| M1-C Core 权威 Committer | 已交付、已测试 |
| M1-D Store/Lease/容量/失败恢复 | 已交付、已测试 |
| M1-E 无 DOM 的内存 App 与 Workspace 组合 | 已交付、已测试 |
| Runtime/SDK/IDE 原有基线回归 | 全部已执行且通过 |
| 真实 Worker/SDK Producer 原子性 | **未证明，属于 M2/M3** |
| 正式 IDE Strict Tool 执行 | **不允许，属于 M4** |

**架构决策：M1 isolated gate = PASS。可以推进 M2 的 Versioned IPC / SnapshotProducer shadow；Strict 仍为 No-Go。**

所有新增实现放在 runtime/src/core/snapshot/，相关报告/日志放在本 RFC 的 m1/。本轮没有主动覆盖、暂存、提交或重置其他已有工作树修改。