# M3 语义提交协调：实施结果与阶段审查

- **状态**：M3 核心纵向链路和专项测试通过；**完整 Strict Gate 仍为 No-Go**
- **时间**：2026-10-22
- **代码基准**：本地 HEAD 789ef07 加原有未提交变更；Node v23.11.0 / pnpm 10.15.1
- **资料依据**：本地真实 TS/TSX 实现、实际测试、执行日志；没有读取仓库既有旧 Markdown 作为实现事实
- **相关报告**：[M0](../m0/RESULTS.md) · [M1](../m1/RESULTS.md) · [M2](../m2/RESULTS.md) · [设计](../03-design.md) · [测试计划](../05-tests.md)

## 1. 这次实际解决的正确性问题

1. **首帧 Ghost Ref/Tool**：SDK useDataRef 和 useViewTypeTool 现在与 View/useArrayRef 一样在 Preact Layout Commit 阶段注册。真实 createTUIApp → View → AppKernel 首次返回时，View、单 Ref、列表 Ref、ViewTypeTool 均已注册。
2. **Ref-only/Tool-only 不触发刷新**：AppKernel 对 View、Ref、ViewTypeTool 的注册、修改、撤销均推进 SemanticProjectionCoordinator Epoch。Worker 订阅语义变化，哪怕 DOM 没变化也会刷新；**默认 legacy 路径和可选 Shadow 都已验证**。
3. **View 实例身份**：SDK 为一次 View Mount 赋予 sdk_mount_N generation；同 viewId 关闭重开得到新 generation。DOM Producer 优先采用 SDK 的声明式 generation，而非依赖 DOM Node 是否更换。
4. **类型化 ArrayRef 标记有真实目标**：原 useArrayRef 输出 Task[]:pending、Task:pending[0] 等链接，但注册表只有 pending[0]。现在 Typed list/item 和 bare pending/pending[0] 都注册，类型改变、重排、删项、卸载均清理不再有效的键。
5. **ViewTypeTool 声明者 vs 执行目标**：SDK Tool 注册携带 declaredByViewId + declaredByViewGeneration；AppKernel 持有并由 DOM Producer 投影到 ToolDescriptor。Root View 可以声明 FileDetail Tool，Root 同名重挂载时残留旧 owner 的 Draft 被 Core 拒绝。
6. **Worker AppID 修复**：实际 Worker INIT 现在调用 AppKernel.setId(appId)，避免真实 SDK Context 中 AppID 为空以及 Tool ID 前缀不正确；在真正 Worker E2E 中有独立断言。

这些改动没有要求重写 IDE 的 Tool Handler，也没有改动 M1 纯 Snapshot Core 已确定的契约。

## 2. 主要代码范围与架构边界

| 子系统 | 位置（相对于仓库根目录） | 职责 |
| --- | --- | --- |
| Pure Core | runtime/src/core/projection/coordinator.ts | 无 DOM/Preact/Worker 的 Epoch、nested begin/end、合并事件、Token |
| SPI | runtime/src/spi/runtime/projection.interface.ts、相关 index、component-factory.interface.ts | IProjectionPort 与 SDK 可选注入边界 |
| AppKernel | runtime/src/worker-runtime/app-kernel/AppKernel.ts | Ref/View/Tool 语义变更世代、Tool 声明 owner |
| SDK | sdk/src/app-factory/createTUIApp.ts、components/View.tsx、hooks/useRef.ts、hooks/useArrayRef.ts、hooks/useViewTypeTool.ts | 注册阶段统一、View generation、声明 owner、真实 Ref Marker |
| Runtime Adapter | runtime/src/worker-runtime/index.ts、dom-snapshot-producer.ts | Epoch 捕获/一致性检查、无 DOM 语义变更的 Snapshot 刷新 |
| Tool / View 类型 | runtime/src/spi/app/public-types.ts | View generation 和 ViewTypeTool declaration owner 可选类型字段 |

**职责仍然分离**：Core 管语义事件和已提交 Snapshot，不管理 Preact、DOM 或 Worker；Worker/SDK Adapter 负责感知业务状态投影的就绪情况。本轮没有新建独立 npm 包。

## 3. 真实执行和测试证据

实际最终回归日志：[final-regression.log](./final-regression.log)。

| 验证项 | 结果 |
| --- | --- |
| Runtime 编译（tsc） | exit 0 |
| SDK 类型检查（tsc --noEmit） | exit 0 |
| Runtime 全套 Vitest | 53 files，**452 passed、3 skipped、7 todo** |
| SDK 全套 Vitest | 8 files，**72 passed** |
| IDE Jest | 3 suites，**5 passed** |
| 40 步 View/Ref/Tool 随机化生命周期与重排 | 通过 |
| 20 次连续状态更新、只暴露最终 Ref/Tool 结果 | 通过 |
| 真 Worker + 真 SDK + 历史 Ref A/B 绑定 | 通过 |
| Typed list/item 标记、类型改变与清理 | 通过 |
| Root 声明 FileDetail Tool、owner 旧 generation | 有效 Draft 通过，过期 owner Draft 拒绝 |

新增测试范围：runtime/src/core/projection/coordinator.test.ts、runtime/src/worker-runtime/dom-snapshot-producer.test.ts、runtime/src/engine/app/worker-host.m3-sdk-e2e.test.ts 及 sdk/src/projection-coordinator.test.ts。

与 M2 的 Runtime 445 / SDK 64 相比，本次累计增加 Runtime 7 项和 SDK 8 项通过用例。覆盖率、性能预算仍需后续专门测量，不能依据通过计数声称达到产品指标。

### 3.1 有价值的反例测试

- 真实 Worker 更新 Ref A→B，但 View markup 字节没有变化：默认旧 IndexMap 可刷新 B，Shadow 生成新 revision；
- 来自旧 Snapshot 的 Task:pending[0] 始终指向 A，新 Snapshot 同名 Ref 指向 B；历史对象绑定不漂移；
- 同一个 Preact 状态更新同时变更两个 Ref 和 Tool enabled：语义观察者没有接收到 Ref A/B 混合或过期 Tool；
- 重挂载 Root 后 Tool 仍携带上一代 declaredByViewGeneration：Core 拒绝发布；
- 类型化 ArrayRef 经过列表重排、Type 变化和置空后，旧别名不再出现在 Registry。

**注意**：本轮测试检查 Snapshot 描述、Ref 身份与可用状态，不执行真实文件写入 Tool。

## 4. 审查时发现并修正的问题

1. 在真正 Worker SDK E2E 中观察到 AppKernel 初始 AppID 为空，已修正并回归。
2. 首轮 SDK 类型检查发现 ViewRuntimeContext 的 generation 仍可能被类型推断为 null；已经在挂载赋值之后收敛并重新运行全部 tsc。最终结果 0 错误。
3. M0 的 ArrayRef ghost marker：SDK 原有 listRef/itemRef 类型化字符串与注册键不一致，已补齐 typed + bare aliases。**资源代价**：数组越大 Ref alias 和快照 payload 越多，后续须测量预算与集合级 Codec，不可忽略。
4. Tool 的声明组件与目标 ViewType 不是同一对象，旧 Snapshot 不能通过名字碰巧命中新声明者；已加 origin generation 与负例校验。
5. Microtask Coordinator 可以合并同步提交回调；40 步状态/20 次批量测试证明常规生命周期可靠，但不能将此结果推广为“所有异步渲染错误均具备数据库事务”。

## 5. M3 严格准出的剩余阻塞

**M3 核心切片已通过，完整 M3 仍未通过 Strict Gate。**

尚需验证或实现：

- **异常与复杂异步提交**：Preact 内部 setState、异常恢复、重入与第三方 Hook 的全面 CommitBarrier；当前 token.ready 只能说明无显式未结束 commit，尚不足以宣布任何 Draft 完全原子；
- **Ref 源数据 Codec/内存预算**：Date/Map/class、大集合、Mutable-in-place 业务数据如何显式处理。当前框架不能凭空检测开发者未通知的原地修改；
- **Marker Validator**：目前 SDK 的已知 Marker 具有实际 Ref 键，但 Snapshot Core 还不能证明任意手写 Markdown 的 Reference Marker 都匹配 RefDescriptor；
- **Tool Schema 对等验证**：ViewTypeTool 的 SDK 参数 Schema 到 Core ToolDescriptor Schema 的精确等价性、旧 Handler 执行目标和角色权限仍未在本阶段验收；
- **真实 IDE 大工作负载**：多 View、LSP、搜索与文件修改频繁变化时的 Shadow Diff、内存和 p95 延迟；
- **原始 P0 的后续 M4**：正式执行链仍使用旧 AppKernel/Dispatcher 的活态 Ref fallback，ToolResult 业务失败包装成成功的问题未被本次 M3 修复。

即使 ShadowReceiver 返回 ready，仍明确标注 producerConsistency=unverified 与 strictEligible=false。**严禁将该字段作为启用真实 Tool 写入的权限**。

## 6. 阶段决策

**M3-A / 核心 ProjectionCoordinator：PASS。M3-B / 常规 Ref/Tool-only invalidation：PASS。M3-C / View generation 与 declaration owner：PASS。M3-D / 已知 Typed Ref Marker：PASS（需性能与 Codec 后续验证）。完整 Strict：NO-GO。**

建议下一步先围绕异常边界、Ref Codec/Marker 与真实 IDE 工作负载做剩余 M3 验证，补全正式 Producer 的安全发布证明；再推进 M4 统一 Ref Resolution、ViewType/实例身份、ToolResult 失败传播与执行授权。

本轮未执行 git stage、commit、reset，也没有清理用户原有未提交工作；E2E 的临时 App 和 Worker 文件保存在系统临时目录并由测试清理。