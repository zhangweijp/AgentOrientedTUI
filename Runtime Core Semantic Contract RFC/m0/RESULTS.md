# M0 第一轮代码预研：实测证据、风险判断与阶段决策

- **状态**：Executed first pass / Conditional-Go for M1 only
- **日期**：2026-10-21（本地终端执行）
- **依据**：本地工作树 HEAD `789ef07` **加现有未提交修改**；Node `v23.11.0`、pnpm `10.15.1`、macOS。所有行为结论基于运行中的代码与测试，不使用原仓库旧 Markdown 文档作为事实源。
- **目标**：回答 RFC-00/01 的 M0 是否存在可实现的 Snapshot 同源提交屏障，是否可以安全启动 M1 核心契约开发，以及是否允许接入 strict。
- **边界**：所有实验放在本 RFC 的 `m0/`；测试执行时为 SDK/Runtime 解析依赖而临时生成源目录的独立测试文件，运行后均已确认删除。没有修改既有 Runtime/SDK/IDE 源码、没有重置/提交既有 Git 修改。

## 1. 实际测试执行摘要

| 环境 / 测试 | 结果 | 证据 |
| --- | --- | --- |
| SDK 原有完整测试 | 7 文件、64 tests passed，exit 0 | [full-suite-baseline.log](./full-suite-baseline.log) |
| Runtime 原有完整测试 | 44 文件、380 passed、3 skipped、7 todo，exit 0 | [full-suite-baseline.log](./full-suite-baseline.log) |
| IDE Jest 测试 | 3 suites、5 passed，exit 0；未运行可选 LSP 集成测试 | [ide-tests-baseline.log](./ide-tests-baseline.log) |
| semantic-kernel 独立实验 | 2 文件、26 passed，exit 0；有 **Node >=24.22.0** 的引擎不匹配 warning | [baseline-tests.log](./baseline-tests.log) |
| SDK 本轮实测时序探针 | 3 文件、4 tests passed，exit 0 | [sdk-probes-rerun.log](./sdk-probes-rerun.log) |
| Runtime 本轮边界/微基准探针 | 2 文件、8 tests passed，exit 0 | [runtime-probes-rerun.log](./runtime-probes-rerun.log) |
| Ref 调用点 TS AST 扫描 | 53 个代码文件，成功 | [source-inventory.json](./source-inventory.json) |
| Ref 数据序列化样本 | 9 组受控输入，成功记录与解释 | [ref-wire-compat.json](./ref-wire-compat.json) |

**重要**：本轮 12 个新探针「通过」是指成功验证或复现指定的**当前行为**，其中包括不满足目标 RFC 的行为；不是未来 Snapshot Contract Tests 已经通过。测试数量不与原有 full suite 合并计数。

## 2. SP-01：SDK 注册与 DOM 就绪时序 —— 已确认核心不一致（P0）

使用真实 `createTUIApp → View → AppKernel`（in-process jsdom + SDK）：

- AppKernel.onOpen 返回时，`viewRegistry` 已存在 `workspace`，DOM 已展示 `(current)` Ref marker，但 `exportRefsToIndexMap()` 仍为空，`getAllTypeTools()` 仍为空；`dirtyCount=0`。
- 约 140ms 后，被动 Effect 执行，Ref 和 Workspace Tool 才注册，`dirtyCount=1`（来自 Tool 注册）。
- 在同一 App 的 Ref-only 更新中，`workspace:current` 从对象 A 变为 B；DOM 文本完全一样、MutationObserver 记录 **0** 次变更，`markDirty` 调用计数差值仍为 **0**。
- 独立 SDK Hook 探针重现了一轮中 `tasks[0]` 已更新成 B，但 `focused` 暂时仍绑定 A 的混合 Ref 状态；Tool 禁用也延迟至 Effect 完成才反映到 Registry。
- `useArrayRef` 的 listRef 输出 `(Task[]:tasks)` 形式的链接标记，注册表却只有 `tasks[0]`，**并无 list-level `tasks` Ref**。未来的严格 Markup/Ref 校验必须决定它究竟是可执行 Ref 还是展示标记，不能假定已有完整绑定。

**结论**：DOM 变化不能作为唯一 invalidation；延长 16ms/300ms 防抖不是可靠的就绪屏障。当前快照构建器会在 SDK 注册表阶段出现可观测的源状态不齐。此项作为 M3 的 P0 阻塞。

**证据**：[sp01-sdk-appkernel.log](./sp01-sdk-appkernel.log)、[sp01-sdk-timing.log](./sp01-sdk-timing.log)，源码 `sdk/src/hooks/useRef.ts`、`useArrayRef.ts`、`useViewTypeTool.ts`，`runtime/src/worker-runtime/app-kernel/AppKernel.ts`。

## 3. SP-02：候选 ProjectionCoordinator —— 同步路径 PoC 通过，严格保证尚不成立

构建不修改 SDK 源码的布局阶段 Hook + 语义 Registry + `queueMicrotask` 合并捕获原型。

生成 4 次已提交观察：
- 初次挂载：epoch=3；View=workspace，Ref=A，Tool=Workspace.complete。
- 只改变底层 Ref：epoch=5，Ref=B，Tool 不变，DOM Mutation=0；仍成功形成新观察。
- Tool 禁用：epoch=7，Ref=B，Tool 列表为空，DOM 内容不变。
- 卸载：epoch=9，View/Ref/Tool 均为空。

**能证明**：将所有 SDK 语义注册纳入一致的 commit phase，并对注册变化单独发送 invalidation，是一种可行的局部实现方向。

**不能证明**：当前 SDK 的 passive useEffect 已具有屏障；跨异步任务/LSP、异步 cancel、React/Preact 重入、真实 Worker 与多 View 大规模挂卸载已正确同步。不要直接把示范性 `queueMicrotask` 方案当作生产版 Coordinator。

**结论**：M1 纯 Core 可先行；M3 必须使用真实 SDK Hook 和 Producer 的压力/故障测试证明 INV-01，才能允许 M4 strict。

**证据**：[sp02-coordinator-poc.log](./sp02-coordinator-poc.log)、[sdk-probes-rerun.log](./sdk-probes-rerun.log)。

## 4. SP-03：Ref payload 兼容性 —— 接口宽泛，Demo 类型声明倾向 JSON，但未获得运行时保证

TS AST 扫描 53 个 Demo App TS/TSX 文件（排除 generated dist/test），发现 62 处核心 API 调用：

- `useDataRef` 4 处、`useArrayRef` 8 处，共 **12 个 Ref Hook 调用点**；
- `useViewTypeTool` 共 45 处；`createTUIApp` 5 处。
- Ref 实际应用集中在 Planning、Terminal、Lite Browser；**IDE 主要使用字符串文件路径 Tool**，不是验证复杂 Ref 行为的最好样本。
- `planning-app/src/types.ts` 的 Plan/Phase/TaskItem、`terminal-app/src/types.ts` 的 TerminalSession、`lite-browser-app/src/types.ts` 的 SearchResultItem 在声明层看主要由原始 JSON 型值构成。该事实**不能证明**运行时无 Date/class/引用环或第三方 App 的对象均可序列化。

在真实 Node `structuredClone` 与 JSON.stringify 的 9 类样本中：
- Date/Map 可被 structuredClone 保留为对象，但 JSON 表达不同（Date 变字符串，Map 变空对象）；
- 类实例 clone 丢失原型；有 getter 的对象会调用 getter（本实验分别由 JSON 和 structuredClone 触发，计数 2）；
- 循环引用可被 structuredClone 保留，但 JSON stringify 失败；
- function 字段被 JSON.stringify 静默丢弃，structuredClone 抛 DataCloneError；
- BigInt JSON stringify 失败；NaN JSON stringify 成 null。

**结论**：不能简单使用 JSON.stringify 或原样 structuredClone 作为通用“纯值冻结”契约。Core 应执行受限 JSON-value clone/validator，非 JSON 数据由显式 Codec 映射；M1 先定义拒绝语义，M3 做真实应用兼容清单。

**证据**：[source-inventory.json](./source-inventory.json)、[ref-wire-compat.json](./ref-wire-compat.json)。

## 5. SP-04：Worker IPC / 实例边界 —— 当前协议不满足目标（P0）

真实 `worker_threads.Worker` 向 AppWorkerHost（绑定 `app_0`）发送三份**人工构造的协议消息**：

- `app_0` at timestamp T，Fragment `accepted`：被接收；
- `app_0` at timestamp T，Fragment `same-ms-dropped`：被拒收；
- `app_other` at timestamp T+1，Fragment `wrong-app-accepted`：**被 app_0 的 WorkerHost 接收**。

此实验表明当前 AppWorkerHost 的接收逻辑主要依据毫秒时间戳，而没有比对消息内 appId 与已绑定的 appId。真实生产 Worker 当前通常从自身上下文生成 appId；本实验不证明第三方一定能利用这个路径，但证明接收端缺少所需的来源身份保护。

**限制**：尚未以正式 WorkerPool 复用/重启全链执行 SP-04 的完整版本；已通过真实 Worker IPC 测试确认接收端行为和同毫秒丢失。必须在 M2 继续完成重启/晚到、seq 回绕和 unknown sender 故障测试。

**结论**：M2 必须使用由 Runtime 分配和验证的 instanceId + producerSeq；不能继续使用 Date.now 作权威顺序。真实 WorkerHost 的 appId 绑定也必须在接收边界校验。

**证据**：[sp03-04-05-runtime.log](./sp03-04-05-runtime.log)、[runtime-probes-rerun.log](./runtime-probes-rerun.log)。

## 6. SP-05：旧 Snapshot 与活态 Ref 分裂 —— 实测可错绑（P0）

- SnapshotRegistry 中来源 Ref `app_0:workspace:tasks[0]` = Entity A；
- AppKernel 当前 Registry 重排后 `workspace:tasks[0]` = Entity B；
- 当前 ViewTypeTool 的 `reference` 参数调用最终解析到 B（尽管历史 Snapshot Ref 指向 A）。

另构造两个 View 都注册 `selected`：当指定 ViewType 范围为空时，AppKernel 的 `resolveRefId` 回退按全局后缀匹配，获得第一条同名 Ref。

这是 Ref 身份错误，不是仅用更长 Markdown 描述能解决的问题。现有独立 semantic-kernel 实验有目标实体版本 CAS 与相同 ID 删除重建的属性测试，26 项测试通过，但它未接入当前正式 Runtime。

**结论**：M4 执行必须依据来源 Snapshot 中的 RefDescriptor 身份进行解析，再由活态业务条件做最终校验；不得使用后缀模糊查询或将旧 Ref 字符串重新解析到当前列表。

**证据**：[runtime-probes-rerun.log](./runtime-probes-rerun.log)、[baseline-tests.log](./baseline-tests.log)。

## 7. SP-06：Workspace 组合语义 —— 当前可聚合但无 revisionVector

使用正式 SnapshotFormatter 将两个 App Fragment 聚合：
- 生成两份 App viewState 和分别加 appId 前缀的 Ref IndexMap 键；
- StructuredSnapshot 具有 `systemInstruction / desktopState / desktopTimestamp / applicationInstructions / appStates / viewStates`，**无 App instance/revision vector**。
- 现有 Formatter 对 Tool 名称碰撞具有自动重命名行为；未来只能用稳定的公开 Tool 别名映射，内部 Tool 身份不得按收集顺序变化。

**结论**：单 App 强提交、Workspace vector 聚合的设计具有明确现实接口落点；但尚无跨 App 完整版本化观察能力。M4 加组合快照时必须保留成员健康态和 metadataRevision。

**证据**：[runtime-probes-rerun.log](./runtime-probes-rerun.log)，源码 `runtime/src/engine/view/snapshot/formatter.ts`。

## 8. SP-07：当前投影流水线微基线（仅局部）

采用正式 `transformElement`、`createViewFragmentExtractor`、`SnapshotFormatter`、`SnapshotRegistry.create/release` 测 1/10/50/100 Views。每组 5 次 warmup + 30 次测量，简化的每 View ~1 KiB 内容。

| Views | 输出序列化估算 | total p50 | total p95 |
| --- | ---: | ---: | ---: |
| 1 | 13,917 B | 0.042 ms | 0.096 ms |
| 10 | 43,617 B | 0.189 ms | 0.374 ms |
| 50 | 175,817 B | 0.864 ms | 1.191 ms |
| 100 | 341,067 B | 1.537 ms | 1.968 ms |

这些结果来自单次执行、轻量合成 DOM、进程内微基准。**未包括**：Preact 完整 Render、真实 Worker IPC、Ref payload 大对象深复制、IDE 文件 I/O、LSP、Runtime Store 留存内存，不能据此承诺生产 p95，也不能把这些数字当成性能目标。

**结论**：给 M1/M2 提供最低限度的局部回归比较入口；M0 性能预算仍待真实 IDE 工作负载测量后批准。

**证据**：[runtime-probes-rerun.log](./runtime-probes-rerun.log)、[sp07-projection-performance.log](./sp07-projection-performance.log)。

## 9. 额外代码事实：业务 ToolResult 传播错误（P0，需 M4 或更早独立修复）

正式 AppKernel 的 `callTypeTool` 业务 Handler 返回 `{ success: false, error: BUSINESS_DENIED }` 时，对外得到外层 `success: true`，内层 data.success=false。该行为已通过真实 AppKernel 类复现。

**工程后果**：需以测试 T-08 绑定结果语义，且不要仅以 Worker IPC success 代表业务 Tool success。本项可在不影响 Snapshot 协议的独立小 PR 中修复，但必须检查旧调用方对嵌套结构的依赖。

## 10. M0 决策：Conditional-Go（仅限 M1），Strict No-Go

| 条件 | 当前判断 |
| --- | --- |
| 存在能实现的 commit-phase 协调方向 | **Yes（局部 PoC）** |
| 现有 SDK 可直接强一致提交 | **No（实测反证）** |
| Ref payload 全量兼容已有纯值协议 | **Not Proven** |
| App 实例/IPC 的严格版本与身份约束 | **No（实测反证）** |
| Workspace 版本向量 | **Not Implemented** |
| 原有测试基线可用 | **Yes（代码测试已运行）** |
| 现有 IDE Strict Snapshot 可安全打开 | **No-Go** |

**执行结论：允许启动 M1 的纯 Core Types / Validator / Committer / Store 内部实现和契约测试；暂不允许启用 strict、改变 IDE Tool 执行路径或宣称 M0 已全部完成。**

### M1 前必须决定的最小约束

1. Core Snapshot 同步 Commit 的唯一权威由 Runtime Core 承担，Worker 不自行分配 revision；
2. Core 使用独立的 instanceId、producerSeq、sourceEpoch、committedRevision，不混用 `timestamp`；
3. Ref/Tool 与 Source Snapshot 同版本绑定，纯值防御性复制与类型化错误是必须；
4. 未通过 M3 的真实 SDK 准备屏障时，Core 只能在独立内存 Producer 和 shadow 中验证，不接管正式 IDE；
5. 非 JSON Ref 的 Codec 策略、useArrayRef list marker 语义、跨 Hook 的注册就绪需要专门变更与测试；
6. Worker IPC 来自同一 App 实例的来源身份校验是 M2 P0；
7. 所有真实业务副作用执行都必须在最后阶段做活态条件校验；Shadow 模式不能执行第二份 Tool。

### 仍需补齐才能关闭完整 M0 Gate 的事项

- SP-04：正式 WorkerPool 重启和旧包晚到的更完整故障注入；
- SP-03：真实 App 运行时 Ref payload 采样及 Codec 使用分布，而不只检查 TS 声明；
- SP-07：包含真实 Worker IPC 与 IDE 大文件、多 View、LSP 状态的性能/内存基线；
- 本地 semantic-kernel 在声明的 Node >=24.22.0 环境下复核（当前 Node 23 通过，但有 engine warning）；
- 将已经观察到的 Ref list-level marker 规范冲突纳入 SDK 兼容决策，不能在 strict 里任意猜测。

## 11. 可复现探针与安全说明

从仓库根目录执行：

~~~sh
zsh "Runtime Core Semantic Contract RFC/m0/run-probes.sh"
~~~

脚本只暂时新增 **5 个有唯一前缀的独立测试文件** 到 sdk/src、runtime/src 以保证模块解析；执行后通过受约束的 trap 删除，只对本脚本创建且具 M0 头标记的文件操作，不覆盖原有文件。

探针源代码全部留在 [probes](./probes/) 目录内；原始日志保存在当前 m0/ 下。运行结束需再次确认 `git status --short`，不可清理用户已有未提交修改。

**质量保证说明**：本报告的事实仅证明特定本地版本、具体测试输入的行为。M0 不可替代 M1～M5 的真实契约验收。

## 12. 本地脏工作树的可追溯源代码指纹

考虑到 HEAD 789ef07 **不能唯一描述已有未提交的 Runtime/SDK 改动**，本次额外保存 [source-fingerprints.json](./source-fingerprints.json)：

- 22 个实际核验的 TS/TSX 代码文件 SHA-256、字节长度；
- 8 个可重跑探针/脚本的 SHA-256；
- 完整 Git HEAD、Node 和 pnpm 版本及状态项计数。

如后续 M1 测试行为与本报告不一致，应先比对这些源码指纹，而不是假设旧文档或 Git HEAD 能说明差异。本指纹记录不包括既有仓库其他文件内容和敏感运行时数据。