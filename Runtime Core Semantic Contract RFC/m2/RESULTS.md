# M2：版本化 IPC 与 Snapshot Shadow 实施报告

- **状态**：Shadow 纵向链路已通过；**Strict 仍不允许**
- **代码依据**：本地 HEAD 789ef07 加原有未提交修改；不依赖仓库旧 Markdown 说明
- **关联**：[M0](../m0/RESULTS.md) · [M1](../m1/RESULTS.md) · [技术设计](../03-design.md) · [开发计划](../04-plan.md) · [测试计划](../05-tests.md)

## 1. 架构判断

M1 的纯 Runtime Core 已不依赖 Host / DOM / Preact / Worker / 模型 SDK，但旧 Runtime 的执行链仍依赖 Worker 与 DOM。

本轮将**真实 Worker Runtime** 接成 Core 的一个 SnapshotProducer Adapter，并采用双轨模式：

~~~text
App + SDK + AppKernel + DOM
            |
            +--> SNAPSHOT_FRAGMENT --> 原 WorkerHost/Runtime/Tool 执行路径（不变）
            |
            +--> DomSnapshotShadowProducer (M2)
                       |
                       +--> SNAPSHOT_PREPARED / SNAPSHOT_PREPARE_FAILED
                                   |
                                   +--> WorkerHost 可信实例校验
                                              |
                                              +--> SnapshotShadowReceiver
                                                           |
                                                           +--> M1 Committer / Store
                                                                       |
                                                                       +--> 只读诊断与数量对比
~~~

**Shadow 不等于 Strict**：即使 Core 返回 ready，现有 Preact Effect 与 Ref/ViewTypeTool 仍可能不一致。报告明确带 mode=shadow、producerConsistency=unverified、strictEligible=false。

## 2. 本次真实改动及边界

| 交付 | 路径 | 说明 |
| --- | --- | --- |
| M2-A App 代际 | runtime/src/engine/app/worker-host.ts；runtime/src/worker-runtime/index.ts | AppWorkerHost 为每个逻辑实例分配随机 UUID；Worker INIT 接收令牌；RESET 清空状态，复用时新令牌 |
| M2-B IPC | runtime/src/spi/worker-protocol/messages.ts；runtime/src/spi/runtime/worker-message.interface.ts | 增加 SNAPSHOT_PREPARED / SNAPSHOT_PREPARE_FAILED，旧 Fragment 可选捕获序号/实例关联字段 |
| M2-C DOM Producer | runtime/src/worker-runtime/dom-snapshot-producer.ts | 将现有 DOM View、AppKernel Ref、ViewTypeTool 转成 Draft；View generation 根据 DOM Node 变化；不携带 Handler |
| M2-D Shadow Receiver | runtime/src/adapters/snapshot/shadow-receiver.ts；runtime/src/engine/app/worker-host.ts | 绑定实际 WorkerHost 所属 App/Instance，交给纯 Core；拒绝来源错误/旧序号；不驱动 Tool |
| M2-E 初级对比 | shadow-receiver.ts | 对同一捕获序号的旧/新 View、Ref、Tool **数量**比较，并报告未配对的 Shadow 帧 |
| Opt-in | runtime/src/engine/app/worker-sandbox.ts | 配置 snapshotShadow 或设置 AOTUI_SNAPSHOT_SHADOW=1，默认关闭；只读 getSnapshotShadowReport() |

源 Adapter 属于 Worker / DOM 具体技术实现；M1 Core 未增加对 Element、Preact 或 Node Worker 的依赖。

## 3. 测试与实证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| Runtime 类型检查 | exit 0 | [regression-final.log](./regression-final.log) |
| Runtime 全套测试 | 51 files、445 passed、3 skipped、7 todo，exit 0 | [regression-final.log](./regression-final.log) |
| SDK 全套测试 | 64 passed，exit 0 | [regression-final.log](./regression-final.log) |
| IDE Jest | 5 passed，exit 0 | [regression-final.log](./regression-final.log) |
| M2 Adapter / Receiver / IPC | 12 tests passed | [初轮 M2 测试](../m0/m2-second-tests.log) |
| 实际 Worker Runtime + 临时 App | passed，含同一物理 Worker RESET 后复用、全新 instanceId/快照 ID | [真实 Worker E2E](./reuse-worker-e2e.log) |
| 同一次捕获序号诊断配对 | passed，可发现旧同毫秒丢帧对应 unpaired shadow frame | [配对测试](./correlated-tests.log) |

本轮新增 13 个 Runtime 测试，使 432 passed（原有 M1 总数）上升到 445 passed。SDK 与 IDE 测试维持原有通过数量。

**真实 Worker 的证据**：测试用 esbuild 在系统临时目录编译当前 worker-runtime/index.ts 并启动真正的 Node Worker，加载测试 App Factory，经 AppKernel、View、Ref、ViewTypeTool、双轨 IPC 到 Core。此测试没有调用模型、没有执行 IDE 写文件 Tool。

**真实物理 Worker 复用**：对同一 Worker 执行 RESET，再由新 AppWorkerHost 接管，新的 Shadow Snapshot ID 与 instanceId 均不同，Revision 重新从 1 开始。

## 4. 对开发者的默认行为保证

默认不开启：不创建 ShadowReceiver；Worker 只发既有 Fragment；正式 SnapshotFormatter/IndexMap、应用消息、Tool 执行路径未替换。

显式开启：旧 Snapshot Fragment 仍先发布并保持权威；Shadow 只增加观察、复制、验证和指标成本。新消息不触发旧 onUpdateRequest，不会第二次执行 Tool；不输出 Ref payload 或 Tool Handler。

启用方法：环境变量 AOTUI_SNAPSHOT_SHADOW=1，或传 WorkerSandboxConfig.snapshotShadow=true。此开关是执行适配器诊断能力，不进入纯 Runtime Core。

## 5. 尚未符合 Strict 的原因

| 未兑现的契约 | 当前证据/行为 | 后续阶段 |
| --- | --- | --- |
| **真实语义 Epoch** | M2 sourceEpoch 是捕获计数，不是 SDK 变化世代；Ref-only 变化不会必然引起 DOM 推送 | M3 首要阻塞 |
| **可靠 View Generation** | 当前依赖 DOM 节点身份；两个捕获之间关闭/重开复用同一 Node 的情况并未提供 SDK owner token 保证 | M3 |
| **Typed Ref** | 旧 Registry 仅有对象，Shadow 只能记录 refType=unknown；listRef marker 可能无实际绑定 | M3 |
| **Tool Schema 精确等价** | 仅将旧参数定义作保守 JSON Schema 转换，未涵盖完整 SDK 校验语义；isMutating 默认 true | M3 |
| **完整内容 Diff** | 目前有同序号配对与数量差异，但没有 Ref payload identity / Tool Schema 逐字段差异 | M2-E 后续 |
| **Legacy 来源保护** | Shadow 拒绝其他实例；旧 Fragment 仍遵循原有 timestamp/旧 appId 接收逻辑（已知缺陷未在本轮改变） | M2 安全收敛 Gate |
| **Workspace 真正接线** | M2 是每个 WorkerHost 独立的 ShadowReceiver，并未取代正式 Desktop WorkspaceSnapshot | M4 |
| **产品性能预算** | opt-in 新增复制/序列化成本；尚未测量真实 IDE 大工作集的额外内存/耗时 | M5 |

由于 M0 已实际证明 DOM 与 Ref/Tool 注册 Effect 不同步，仅靠 M2 成功生成结构合法的 Draft，**不能宣称用户的工作状态已经原子提交**。

## 6. 后续工程决策

下一步优先 **M3-A：SDK ProjectionCoordinator / 统一语义变更与提交屏障**。所需验证：
1. View、Ref、ViewTypeTool 通过同一受控提交周期声明与撤销；
2. 无 DOM 变化的 Ref-only/Tool-only 更新也推进可靠的 sourceEpoch；
3. SnapshotProducer 捕获中遇到状态变化必须废弃 Draft、重试或报错；
4. 真实 SDK 初始化时不会再产生可发布的 Ghost Ref；
5. Core 的源快照绑定和版本语义在已有 IDE/Planning App 下复现。

**阶段结论**：M2 Shadow vertical slice = PASS；M2 完整内容等价对比与 M3 Barrier 未完成；Strict Tool 执行 = No-Go。

仅修改了本次涉及的 Runtime 源码、新测试和 RFC 目录；不提交、不暂存、不重置用户已有未提交内容。