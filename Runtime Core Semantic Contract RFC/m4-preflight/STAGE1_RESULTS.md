# M4 Stage 1 最终验收：Runtime-owned ViewInstanceId + SDK View-local Tool

**状态：Stage 1 PASS；Snapshot 来源绑定 Stage 2 / M4 正式 Tool 执行 / Strict 仍 NO-GO。**

时间：2026-10-22。本地 HEAD 789ef07（所有工作保持在用户原有未提交工作树；没有 stage、commit、reset）。

关联文件：[阶段 0 的纯 Core 合同](./RESULTS.md) · [方案 B](../07-view-owned-tool-identity-proposal.md) · [完整回归日志](./stage1-final-regression.log) · [稳定性复跑](./stage1-stability-reruns.log)。

## 1. 这次接入后，实际可以做什么

- 开发者仍通过 <View id="fd_0" type="FileDetail"> 填写公开 viewId/viewType。Runtime 的 AppKernel 为已挂载的 View 分配带可信 AppInstanceId 的 viewInstanceId；SDK 在 Preact ref 提交时领取，而不是在 render() 中消耗未挂载的身份。
- 新 SDK 重载：useViewTypeTool('inspect', {description, params}, handler, {enabled?})；从所在 View Context 自动取得 ViewType 与 Runtime 分配的实例 ID。原 useViewTypeTool(viewType, name, ..., handler, config?) 完全保留并走旧 Registry。
- 当前一个 FileDetail 内 Tool handler 的注册、删除、disabled 只影响自己的实例；Runtime 通过单个 Map 按 Type+Name 聚合只读定义供诊断。关闭 fd_0 不删除 fd_1 的工具；重挂载同名 fd_0 必定拿新的 ViewInstanceId。
- Runtime 的 AppInstanceId 在启用或关闭 Shadow 时均随 INIT 下发给实际 Worker，AppKernel 绑定它；同一物理 Worker RESET 后由新 Host 重用，生成的新 ID 不和之前运行复用。
- SDK 的新 Tool 参数通过纯 Core copyJson + canonicalJson 取得稳定键，内联参数对象仅换属性顺序/引用不造成无意义重注册；真正 Schema 变化导致旧绑定版本失效。访问器/非 JSON 元数据失败前不会执行 getter。
- 首次 Preact 提交如果发生两个 FileDetail Schema 冲突，SDK 清理已局部注册的 View/Tool 并抛错。同一 AppKernel 修正冲突后可以再次打开。
- AppKernel.onClose() 真正卸载 Preact 组件；这同时确保新旧 Hook cleanup、Ref 和 Tool 身份释放，不让 APP_CLOSE 后的 Handler 意外残留。
- Stage 1 的本地 Tool **不会进入旧 Agent IndexMap**，也不渲染旧可调用 <tool-ref> 标记；新 Tool 的内部只读诊断不是正式可执行能力，防止 Agent 看到“可用”但实际上无法来源绑定调用。
- Runtime Core 只读注册与 Agent 真正执行不同。内部测试可以调用纯 Core invoke()，但它**不是**正式的 Tool 调度接口；正式 AppKernel.callTypeTool 的历史 success:false 外层包装成功问题尚待 Stage 2/M4 修复。

## 2. 精确变更边界

既有源码的最小改动：

| 层 | 修改路径 | 职责 |
| --- | --- | --- |
| SPI | runtime/src/spi/runtime/view-owned-tools.interface.ts（新增）、runtime/src/spi/runtime/index.ts、runtime/src/spi/component-factory.interface.ts、runtime/src/spi/app/public-types.ts | 增加可选、无 DOM/Preact 类型的 IViewOwnedToolPort；公开的 IViewMeta 增加可选 viewInstanceId |
| Runtime | runtime/src/engine/app/worker-host.ts、runtime/src/worker-runtime/index.ts、runtime/src/worker-runtime/app-kernel/AppKernel.ts | 每个 Host 的可信 AppInstanceId 到 Worker；AppKernel 内部 View-owned Tool registry 与诊断；正式旧路由不变 |
| SDK | sdk/src/app-factory/createTUIApp.ts、sdk/src/components/View.tsx、sdk/src/context/AppRuntimeContext.tsx、sdk/src/contexts/view-runtime-context.ts、sdk/src/hooks/useViewTypeTool.ts | 仅在真实提交时分配/注销 View 身份，兼容原调用形式，新的 View-local 签名与已知 Tool 的只读诊断 |
| 新测试 | sdk/src/view-owned-tools.test.ts；runtime/src/engine/app/worker-host.m4-view-owned-e2e.test.ts | 真 Preact/AppKernel 与实际 Node Worker + SDK E2E |
| 原纯 Core | runtime/src/core/tool/view-owned-tools.ts / .test.ts | 重用 Stage 0 的唯一 ID、聚合、绑定 version；仅为输出的目标列表改为稳定按 viewId 排序，并相应调整测试，不增加类或依赖 |

未迁移 IDE ToolHandler，未改变 M1 Snapshot V1 的正式 schema、Store/Committer、Worker Snapshot v1 源协议，也没有将新 Tool 加入正式 Agent tool list。

## 3. 测试证据与边界

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Runtime tsc / SDK tsc / IDE tsc | exit 0 / exit 0 / exit 0 | [Stage 1 最终全量回归](./stage1-final-regression.log) |
| Runtime 全部 Vitest | **55 files / 472 passed、3 skipped、7 todo**，exit 0 | 同上 |
| SDK 全部 Vitest | **9 files / 84 passed**，exit 0 | 同上 |
| IDE Jest | **3 suites / 5 passed**，exit 0 | 同上 |
| 新 SDK + AppKernel 行为 | 12 tests：双 View 自治聚合、独立 enabled、真实卸载/重开、Schema 稳定与变化、参数 accessor 拒绝、原 API 并行、冲突回滚、60 步多 View 压力 | [Stage 1 全量回归](./stage1-final-regression.log) |
| 新真实 Worker + SDK | 1 test：Shadow OFF；可信 AppInstanceId 贯通；两个 FileDetail ID 互异；APP_CLOSE/OPEN 更换 View ID；同一物理 Worker RESET 后新 Host ID；Agent IndexMap 不出现新本地 Tool | [Worker 复用](./stage1-worker-reuse.log) |
| SDK + 实际 Worker 专项稳定性 | **3 次 SDK + 3 次 Worker**，每次均通过 | [重复执行日志](./stage1-stability-reruns.log) |
| 新 Core 工具 | 19 tests 通过；97.02% statements、89.24% branches、100% functions | [Core 覆盖率](./stage1-core-coverage.log) |
| SDK View + Tool Hook | 同时执行 M3 与 M4 的 20 个相关集成测试，覆盖 76.61% statements / 69.01% branches / 50% functions（仅限两个指定 SDK 文件） | [SDK 覆盖率](./stage1-sdk-coverage.log) |

**不是产品性能**：纯 Core 的 synthetic benchmark 测试 1/10/100/500/1000 个 FileDetail 注册一项同名 Tool，输出参见 [stage1-performance.log](./stage1-performance.log)。1000 个实例的总注册耗时 p50=39.609ms / p95=46.153ms，聚合一次 p50=0.375ms / p95=0.851ms。只包含纯 Core Map 和 schema canonical；不含 Preact、DOM、IPC、LSP、IDE IO。注册期为了检测冲突扫描同组 Tool，整体注册开销在大规模实例下非线性；先记录预算风险，禁止拿这些数据承诺真实 IDE p95。

## 4. 发现并解决的真实问题

1. **渲染中的内联参数对象造成多余 Tool 更新**：测试中关闭 A 导致 B 重渲染，虽然 B 的 ViewInstanceId 未变，旧 Hook 却会按对象引用重新注册；现在新 SDK 签名按纯 Core 的 canonical JSON 比较，避免无意义地失效 B 的来源绑定。旧签名依赖关系原样保留。
2. **目标列表顺序不确定**：大量 View 卸载重挂载后聚合目标跟着挂载顺序变化；改为按 viewId 排序，并让测试永远按显式 viewId 查目标，绝不把 target 数组下标当身份。
3. **APP_CLOSE 后仍留活态 Handler**：旧 AppKernel.onClose 仅清空 ViewRegistry，未真正调用 Preact unmount；本轮修复，并通过 APP_CLOSE/OPEN 的重挂载回归。
4. **初次提交中途失败后残留旧声明**：Schema 冲突测试明确证明会遗留局部注册；SDK Factory 在初次 render 失败后尝试 render(null) 清理，并验证修正后可再次打开。
5. **新本地 Tool 的幽灵 affordance**：Stage 1 尚无来源绑定执行，所以新签名不渲染 tool-ref 标记。旧签名仍渲染并保持 IDE 行为，避免混淆 Agent。
6. **对不可信参数做 JSON.stringify 可能触发 getter**：采用已有 Core copyJson+canonicalJson 做只读、严格规范化，Accessor 不能在新 SDK Tool metadata 边界执行。

所有这些中间失败均记录在 stage1-* 的目标日志；最终 Gate 通过后才准出，不掩盖中间发现的问题。

## 5. 长期身份语义与待办

**确定的长期身份**：viewId / viewType / Runtime viewInstanceId。M3 的 viewGeneration 目前仍作为 Snapshot V1 兼容字段存在，尚未静默迁移。

**接下来 Stage 2** 不能只给 V1 Draft 增加任意字段。M1 Validator 当前对 V1 采用 exact schema；需要清晰引入 **Snapshot V2 的显式版本化扩展**，并在同一个 Runtime Commit 事务中将 Tool 的来源 ViewInstanceId、bindingVersion 纳入只读数据，确保 Tool 注册变化也推进 Snapshot revision。应用于正式 Tool 执行前，必须测试来源快照/实例/权限/业务 CAS，且在 AppKit/Worker IPC 中保证来源通道身份；不能把 Agent 送来的自由 Tool JSON 当作执行令牌。

**同名 fd_N 仍是目前 IDE 的位置型公开 View ID**，有定位漂移风险；正式切换来源绑定前必须修正，或按来源 Snapshot 绑定内部实例并拒绝旧目标。现有 Tool Handler 的错误包装、参数权限和真正 IDE/LSP p95 尚属于后续 M4/M5。

**Stage 1 PASS；Strict / 原始 P0 完整准出 = NO-GO。**
