# M4 Stage 2 — Snapshot V2 与来源绑定 Tool 选择：实施结果

**状态：V2 纯 Core 合同 + 真实 Worker Shadow 纵向链路 PASS；M4 正式 Tool 执行 / Strict 仍 NO-GO。**

2026-10-22，HEAD 789ef07（有用户原有未提交变更），Node v23.11.0、pnpm 10.15.1。依据为本地真实 TS/TSX 源码、测试和日志，不将仓库旧 Markdown 当作事实依据。

关联：[方案 B](../07-view-owned-tool-identity-proposal.md) · [Stage 0](./RESULTS.md) · [Stage 1](./STAGE1_RESULTS.md) · [Stage 2 全量回归](./stage2-final-regression.log)

## 1. 核心架构结论

开发者仍写公开 viewId（例如 fd_0），但 Agent 当时看到的这个 View，可能已经关闭并用同名重新创建。**只有当前可信 Snapshot 记录的 viewInstanceId 和 Tool bindingVersion，才能判断是哪个实例以及 Tool 的哪次注册。**

V1 的数据 Schema 不暗加字段；本轮明确加入 schemaVersion=2，并沿用**同一个 Runtime Core Committer、Store、Revision、Lease、TTL 与历史版本规则**。

| 语义 | 保持原有 V1 | 新 V2 |
| --- | --- | --- |
| View 身份 | id + generation | id + viewInstanceId |
| Ref 来源 | ownerViewId + ownerViewGeneration | ownerViewId + ownerViewInstanceId |
| Tool 描述 | viewType、visible 和可选声明者 Generation | viewType + targets（每个目标携带 viewId、viewInstanceId、bindingVersion） |
| Tool 可用性 | visible 字段 | 必须有合法非空 targets，没目标就不发布该 Tool |
| Snapshot ID | aotui-app-snapshot:v1:... | aotui-app-snapshot:v2:... |
| Handler | 不进入 Snapshot | 依然不进入 Snapshot |

V2 的聚合 Tool ID 为 [appId,viewType,toolName] 的规范化 JSON 数组键，不靠截字符串推断身份。Tool target 需绑定到本次 Snapshot 中同类型、同实例的 View，禁止重复目标、无效 bindingVersion、未知字段及含 getter/非 JSON 业务数据。来源 Epoch 不变而内容改变时，Core 按原有 M1 规则拒绝并标记 degraded。Tool-only 注册版本改变也会推进 Snapshot Revision。

**V2 是真实 Runtime Core 原子提交的不可变快照，不是附加的异步 Sidecar；但这尚不能证明生产端对所有 UI/SDK 情况都做到了原子捕获。**

## 2. 实际 Worker 只读 V2 接线

- AppKernel 给 SDK 分配的 Runtime-owned viewInstanceId，在实际 Preact 挂载时写入内部 DOM 属性；Worker Producer 同时核对 DOM 和 AppKernel 只读实例登记，确认 View ID、类型和实例相同。
- 如果当前 App 由 Runtime-owned View 组成，且不再使用 Root 注册的 legacy TypeTool，Shadow 生成 V2 Draft 并通过 SNAPSHOT_PREPARED IPC 交给现有 SnapshotReceiver → Core Committer。
- 若 App 还包含 legacy TypeTool，继续使用 V1 Shadow。**不能为了生成 V2 就丢失 Root-level Tool**；V2 捕获内部身份错误时直接报失败，绝不静默降级为一个“成功”的 V1。
- 真实 Worker + 真实 SDK E2E 验证：Ref 从 A 更新到 B，但可见文本不变；Tool 仅修改 Schema/绑定版本，Snapshot Revision 仍增加；同名 fd_0 卸载重开得到新的 ViewInstanceId，旧 Snapshot Ref 仍指向 A。测试现在还从实际 WorkerHost 的只读 Shadow Store 调用 acquireToolSource：仅 Ref 更新则原 Tool 来源有效；Tool 注册版本改变返回 TOOL_SOURCE_STALE；同名 View 重挂载返回 VIEW_INSTANCE_REVOKED，且不会调用 Handler。
- 默认正式 Agent IndexMap/旧 Tool Dispatcher 没接 V2，新 View-local Tool 不会被误展示为可执行 Tool，也不触发额外 Handler。

## 3. 新增纯 Core 可信来源选择

新增内部 acquireToolSource(store, {snapshotId,appId,instanceId,toolId,viewId})：

1. App 的最新提交状态必须 ready，且属于相同 AppInstance。
2. 来源 Snapshot 必须真实存在于 Runtime Store 并可获取当前有效 Lease。调用方自己拼的 Tool JSON、失效历史 TTL、不存在的 Snapshot ID 不获得来源身份。
3. 来源必须为 V2，且来源 Tool/Target 必须包含可读 viewId 所属的 viewInstanceId。
4. 当前 committed V2 的对应 ViewInstanceId 与 Tool bindingVersion 必须相同；Tool 的公开 description、inputSchema、isMutating 即使 Producer 复用了同一 version 也须语义一致。
5. 非法、过期或 App degraded/stopped 的选择均返回明确错误，并自动释放 Lease；成功返回只读 ToolDescriptor、ToolTarget 和 release 函数，没有 Handler 和执行方法。

历史 Snapshot 不是必然过期：仅内容或 Ref 变更时，同一 View/Tool binding 的历史目标仍可以被解析；若 View 关闭/重新挂载、Tool 重新注册、App 重启或 Schema 改变，则拒绝。

**重要：这是可信来源选择，不是业务授权，也不执行 Tool。** 正式 M4 仍须检查活态 Handler/权限/业务资源 CAS 等条件；不得将该函数开放成 Agent 可以直接执行文件操作的接口。

## 4. 真实代码变更

- runtime/src/core/snapshot/types.ts：显式 AppSnapshotV1/V2 union，新增 V2 View/Ref/ToolTarget/ToolDescriptor 和相应 Ref selector；新增 TOOL_SOURCE_STALE 诊断码。
- runtime/src/core/snapshot/v2-validator.ts（新增）：严格 V2 复制、结构和跨 View/Tool 验证；内部构造一份 V1 校验代理，复用已成熟的 V1 限额与 Schema 校验。代理**不会作为 V2 发布**。
- runtime/src/core/snapshot/store.ts / index.ts：V1/V2 按显式版本接入单一 Committer/Store；版本专有 Snapshot ID，Ref/Tool 查询按版本选择字段。
- runtime/src/core/tool/source-binding.ts（新增）：经 Runtime Store Lease 的只读来源选择器，不返回 Handler。
- runtime/src/core/tool/view-owned-tools.ts：只读的 Runtime-owned View 实例清单，供 Worker Producer 捕获。
- runtime/src/worker-runtime/app-kernel/AppKernel.ts、runtime/src/worker-runtime/dom-snapshot-producer.ts、runtime/src/worker-runtime/index.ts、sdk/src/components/View.tsx：条件性 V2 Shadow 源身份核对与投影；旧 Tool 执行未修改。
- 新测试：runtime/src/core/snapshot/v2.test.ts、runtime/src/core/tool/source-binding.test.ts、runtime/src/engine/app/worker-host.m4-v2-shadow.test.ts。
- 没有新增依赖或单独复杂的 ToolDefinition/Binding 类库；没有改写 IDE Tool Handler。

**与 M1 指纹关系**：本轮确实修改了 M1 的 types/store/index 文件以明确升级到 V2，不能再宣称 M1 所有 9 个文件原封不动。V1 格式与已有测试行为持续受回归保护。

## 5. 完整实际测试

| 测试 | 最终结果 | 证据 |
| --- | --- | --- |
| Runtime、SDK、IDE TypeScript | 全部 exit 0 | [Stage 2 全量回归](./stage2-final-regression.log) |
| Runtime 全套 Vitest | **58 files，497 passed，3 skipped，7 todo** | 同上 |
| SDK 全套 Vitest | **9 files，84 passed** | 同上 |
| IDE Jest | **3 suites，5 passed** | 同上 |
| V2 Core Schema/Ref/Tool 合同 | **14 测试**（含众多负例） | [adversarial tests](./stage2-v2-adversarial-tests.log) |
| Runtime Store Lease 来源选择 | **10 测试** | [binding tests](./stage2-binding-final-tests.log) |
| 真 Worker / 真 SDK / IPC / Committer V2 E2E | **1 测试**，覆盖 Ref-only、Tool-only、同名 View 重新挂载 | [real Worker E2E](./stage2-v2-real-worker-final.log) |
| 真 Worker V2 稳定性 | 连续 4 次实际通过 | [复跑](./stage2-stability-reruns.log) |
| 两个新增 Core 文件覆盖率 | **94.71% statements/lines；85.58% branches；100% functions** | [coverage](./stage2-v2-final-coverage.log) |

Stage 1 Runtime 472 passed，本轮新增 25 项，现共 497 passed；SDK 和 IDE 84/5 均无回归。曾在来源选择测试中修正了一个测试期待：从 degraded 恢复且语义内容未变时，Core 正确返回 unchanged、复用旧 Revision。没有为通过测试而放松 Store 行为。

## 6. 性能评估：真实代价，暂不准出

[合成脚本](./stage2-v2-benchmark.ts) · [原始日志](./stage2-v2-performance.log)：Node 23，1KiB Markdown / View、每 View 一个 Ref、单个 Tool，V2 另有每 View 一个 ToolTarget；各组预热 5 次、收集 20 个 Commit 样本。

| Views | V1 Commit p50 / p95 (ms) | V2 Commit p50 / p95 (ms) |
| --- | --- | --- |
| 1 | 0.187 / 0.340 | 0.192 / 0.303 |
| 10 | 0.630 / 0.739 | 1.168 / 1.276 |
| 50 | 2.649 / 2.824 | 5.246 / 6.015 |
| 100 | 5.298 / 5.450 | **10.974 / 12.153** |

V2 的额外目标数据与复用 V1 Validator 时的额外克隆/规范化，使此 synthetic 100-View 场景耗时接近 V1 两倍。两者负载并非严格相同（V2 增加了 ToolTargets）；数字**不是**真实 IDE/Worker p95，更不能与 M0 DOM benchmark 直接比较。正式启用前须测 IDE 工作负载的 CPU、内存和 p95；如不达预算，优先减少复制，而不是增加缓存层和基类。

## 7. 尚未准出的 P0 / M4 与发布门槛

- 正式 Agent 调度没有切到 Runtime Snapshot V2；旧 AppKernel.callTypeTool 仍有 success:false 被外层标记成功的生产缺陷，不能宣称 P0 完成。
- V2 Producer 在 M3 常见场景已验证，但没有证明所有 Preact 异常、第三方 Hook、业务未通知原地突变均具备原子捕获。Shadow 仍固定 producerConsistency=unverified 和 strictEligible=false。
- ViewInstanceId 只是来源身份，不是权限令牌。正式执行前必须重新核查活态 View/Handler 绑定、角色权限、业务状态/资源版本 CAS、异步取消与并发。
- 混合 Root 旧 Tool 与 View-local Tool 仍为 V1 Shadow，需渐进迁移与完整 parity；Agent 工具名、旧 IDE 按位置生成 fd_index 的公开标识、非 JSON Ref Codec、TypeTool 参数 Schema 精确等价仍需单独准出。
- V2 Validator 目前为有额外成本的 V1 代理检查，极大 View 和真实 IDE 大工作集仍需资源预算与优化。

**结论：Stage 2 的 V2 Core Snapshot + 只读来源选择 + Worker Shadow 纵向链路 = PASS。正式 M4 Tool 执行 / Strict = NO-GO。**

本轮未执行 Git stage、commit 或 reset，不清理用户原有未提交工作。
