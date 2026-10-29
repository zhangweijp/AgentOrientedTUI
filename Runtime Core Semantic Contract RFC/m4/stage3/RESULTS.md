# M4 Stage 3 — P0 执行修复与来源绑定只读 Tool：实施与审查

**阶段状态：生产 P0 两项明确缺陷已修复；实验性只读 V2 Tool 调用通过；完整 M4、Mutating Tool、Strict 仍 NO-GO。**

- 日期 2026-10-22；本地 HEAD 789ef07；Node v23.11.0，pnpm 10.15.1。工作树中已有大量用户未提交修改。
- 关联：[Stage 1](../../m4-preflight/STAGE1_RESULTS.md) · [Stage 2](../../m4-preflight/STAGE2_RESULTS.md) · [方案 B](../../07-view-owned-tool-identity-proposal.md) · [本轮最终回归](./final-regression.log)
- 继续遵守 Minimalist：复用现有 Worker IPC、Snapshot Store、ViewOwnedTools、copyJson，不新建 Tool 框架类库、模型 Adapter 或 npm 依赖。不包含 Mobile 和 Agent Driver 实施。

## 1. 生产正确性修复：真实代码，不只是 Core 预测

### P0-A：ToolResult 成功/失败不再失真

原 AppKernel.callTypeTool() 将 SDK Handler 返回的业务 success:false 统一包装为 success:true，并把失败放入 data。现有生产代码改为：若 Handler 返回规范 OperationResult，保留其业务 success、error、data；失败结果不会错误触发额外重渲染；直接返回普通对象的旧 Handler 保留原兼容包装。

Worker OPERATION_RESPONSE 的 success:true 只表示**传输成功**，result.success 才是业务状态。Host 和 Agent Adapter 分别回传实际失败；Agent ToolResult 使用 error 而不是假的 result。

实测：6 个 AppKernel TypeTool 合同（包含业务失败/结构化成功/raw legacy handler）、真实 SDK/WorkerHost 成功/失败/无效 Ref，以及 AOTUIDrivenSource 的最终错误映射测试。

### P0-B：Legacy Ref Resolution 拒绝跨 View 与歧义

移除 AppKernel.resolveRefId() 的全局字符串后缀搜索。当前只在 Tool 指定的 ViewType 下寻找 Ref；多个该类型 View 同时注册相同 Ref 名时明确拒绝（OPERATION_INVALID_ARGS），跨 ViewType 同名 Ref 不会被任意选中，reference[] 同样受此限制。

**没有宣称 Legacy 已获得历史 Snapshot 绑定。** 如果旧 Ref 名本来唯一但业务状态后来改变，旧路线仍可能重新解析到最新对象。完全解决需来源 V2 正式调度。

### P0-C：IDE 的 FileDetail 公开 ID 不再由数组位置决定

原 SystemIDEApp.tsx 的 FileDetail ID 随 activeFiles 的数组下标变化，关闭前一个文件会使其他文件的地址漂移。现用单调、不重复复用的公开 ID 映射：
- 同一文件持续挂载时关闭前一文件或重排，不改变自己的公开 ID；
- 关闭文件后旧 ID 不会在这一 App 运行中分配给其他文件；重新打开同路径得到新 ID；
- SystemIDEApp 渲染 View、RootView 展示可用文件、Tool 查询 viewIdForFile、close_file_detail 通过同一精确映射，不再按下标解析；
- 恢复旧 activeFiles 持久化数据时先去重，避免异常数据导致双 View 同名挂载。

4 项 IDE Jest 测试通过，纯 file-view-ids.ts 模块语句/分支/函数/行覆盖率均 100%；IDE 原有测试未退化。

## 2. M4 受限执行链：Snapshot V2 来源到 View 实例 Handler

**这条 API 默认为关闭，不进入 Agent 的原有自动 Tool 列表，只做显式 opt-in 的 read-only 执行。**

按真实执行的顺序：

1. AppWorkerHost 的两个显式开关都必须为 true：snapshotShadow 和 experimentalReadOnlyViewTools；Worker INIT 单独传入执行能力，RESET 后不会保留。
2. Host 从自己持有的 Runtime-owned V2 Snapshot Store 取得真实存在、可租用的来源 Snapshot 和 Tool/Target。绑定 AppInstanceId、ViewInstanceId、Tool bindingVersion 与 Schema；不使用 Agent 自报的 Tool JSON。
3. 仅当来源 Tool 显式标记 isMutating:false 时继续。新 SDK View-local Tool 默认为 isMutating:true，先拒绝写入。
4. 调用参数在 Host 侧经已有 copyJson 限额保护的严格深拷贝和深度冻结，然后交由可信授权回调。回调能检查 App、View、Tool、来源版本和参数（例如限定可读取的文件范围）。
5. 如果授权异步等待，Host 在完成后**再次**确认 Snapshot、Lease、Tool Schema 和当前 App 状态仍有效，然后才发送 VIEW_TOOL_INVOKE。
6. Worker 复核当前 AppInstanceId、来自 INIT 的只读执行开关、View 活态实例、Tool 的绑定版本、定义和当前是否仍然 read-only。最后通过已有实例级 Tool Registry 调用真实 Handler。
7. 业务 success:false 原样返回；非法参数、无授权、可写 Tool、旧 View、旧 Tool、未知 Snapshot 和权限回调异常都明确失败。

这个方案可以验证完整的来源 ID 调度，同时明确拒绝未经业务许可的写入。**isMutating:false 是可信开发者的能力声明，并非 OS 文件权限/沙箱证明。** 正式发布前仍需产品统一授权和实际业务资源版本 CAS。

## 3. 主要源码与测试范围

| 范围 | 修改/新增 |
| --- | --- |
| 原生产 TypeTool 路径 | runtime/src/worker-runtime/app-kernel/AppKernel.ts：业务失败保真、限定 Ref Resolve 范围 |
| 新 V2 受限 Host | runtime/src/engine/app/worker-host.ts：来源、租约、read-only、授权参数、异步二次检查、IPC |
| Worker 与来源 Store | runtime/src/worker-runtime/index.ts、runtime/src/adapters/snapshot/shadow-receiver.ts：可信实例与 V2 IPC |
| 协议及 SDK | runtime/src/spi/worker-protocol/messages.ts、runtime/src/spi/runtime/worker-message.interface.ts、runtime/src/spi/app/public-types.ts、sdk/src/hooks/useViewTypeTool.ts：默认 mutating、显式 read-only |
| IDE View 身份 | demo-apps/aotui-ide/src/tui/SystemIDEApp.tsx、RootView.tsx、file-view-ids.ts（新增） |
| 合同测试 | runtime/src/worker-runtime/app-kernel/AppKernel.type-tool-contract.test.ts、runtime/src/engine/app/worker-host.p0-tool-result.test.ts、runtime/src/engine/app/worker-host.m4-readonly.test.ts、runtime/src/adapters/aotui-driven-source.test.ts，以及 IDE file-view-ids.test.ts |

M1 Snapshot V1/V2 Schema、Stage 2 的来源 Store Selector 没有被本轮改成新的隐式语义；没有改写 IDE 现有 Tool Handler。Root 旧签名继续按 Legacy 执行。

## 4. 实际验收

| 验证项目 | 结果 | 证据 |
| --- | --- | --- |
| Runtime TypeScript emit | exit 0 | [最终全量回归](./final-regression.log) |
| SDK TypeScript noEmit | exit 0 | 同上 |
| IDE TypeScript noEmit | exit 0 | 同上 |
| Runtime 全部 Vitest | **61 files / 506 passed / 3 skipped / 7 todo** | 同上 |
| SDK 全部 Vitest | **9 files / 84 passed** | 同上 |
| IDE Jest | **4 suites / 9 passed** | 同上 |
| P0 AppKernel scoped Ref / ToolResult | 6 新合同测试 | [Worker 与 P0 测试](../../m4-preflight/stage3-p0-real-worker.log) |
| 真 Worker/SDK 的旧业务失败保真 | 1 真实 WorkerHost 测试 | 同上 |
| Agent Adapter 业务失败进入 ToolResult.error | 1 单元集成测试 | Runtime 全量回归 |
| V2 read-only 真 Worker | 1 综合 E2E（默认关闭、授权、非法参数、业务失败、可写 Tool 拒绝、异步更新、WorkerPool RESET） | [策略和权限负例](./readonly-policy-args.log) |
| 真 Worker 实例级执行稳定性 | **4 次独立真实 Worker，均通过** | [重复测试与延迟](./worker-stability-final.log) |
| IDE 稳定 ID 的纯函数覆盖率 | 4 测试，语句/分支/函数/行均 100% | [IDE Coverage](./ide-view-id-coverage.log) |

相对上一阶段 Runtime 497、SDK 84、IDE 5，本轮新增 Runtime 9 项和 IDE 4 项通过用例，最终累计 506 / 84 / 9。

### 4.1 真实 Worker 的诊断级性能

每次运行采样 25 次 Host 策略回调 + Snapshot V2 Lease/来源检查 + Worker IPC + SDK Handler，四次独立 p50/p95（毫秒）：
- Run 1：0.200 / 0.636，最大 2.525
- Run 2：0.242 / 0.717，最大 2.199
- Run 3：0.203 / 0.477，最大 0.558
- Run 4：0.124 / 0.287，最大 0.311

不含真实 IDE、文件系统、LSP 或模型 API；不是产品 SLA。Stage 2 的 V2 Commit 双复制开销和真实 IDE CPU/内存/p95 预算仍未解决。

## 5. 仍未准出的 P0 / M4 / Strict

- **写入 Tool 的正式来源/权限**：Legacy 写文件/删除文件仍可经旧 Agent Router 执行；新 V2 只读链明确拒绝所有 isMutating:true。正式 Mutating Tool 必须检查活态 Handler、目标实例、角色权限和业务资源/文件版本 CAS，并处理执行中的竞争或取消。
- **Legacy 的来源 Ref**：虽然消除了跨 View 的误选和歧义，但 Legacy Dispatcher/TypeTool 没有全面迁入 Runtime Store 的历史 Snapshot V2，不能证明全部旧快照误操作已杜绝。
- **SDK CaptureBarrier**：M3 的已知常规/压力测试有效，但没有覆盖全部异常渲染、第三方 Hook、非 JSON 对象和未通知原地变化的严格原子语义；Shadow 仍固定 producerConsistency=unverified、strictEligible=false。
- **真实 IDE 工作负载**：本阶段没有启动完整 IDE 多文件/LSP/真实文件写入的 E2E；现有 Jest 是确定性 View 地址与其他业务单测，不能冒称全栈验收。
- **性能与跨 Host**：V2 Snapshot 复制成本、真实 IDE 多 View 资源预算、替换 Worker/DOM 的另一种正式执行 Adapter 都尚未通过。

**结论：已修复明确的两个 P0 生产 Bug 与 IDE 位置型身份漂移；V2 Source-bound Read-only Stage 3 切片 PASS；完整 Mutating Tool、P0 全覆盖与 Strict = NO-GO。**

未执行 Git stage、commit、reset，没有删除用户原有未提交代码；没有异步后台工作。
