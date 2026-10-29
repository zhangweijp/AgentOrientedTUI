# M4 Stage 6 — 实验性 V2 资源写入纵向链路：实施与准出

**结论：Stage 6 限定 PASS；默认 Agent Mutating Tool、完整 M4 和 Strict NO-GO。**

- 日期 2026-10-23；本地代码基准 HEAD 789ef07 加用户原有未提交工作树；Node v23.11.0、pnpm 10.15.1。
- [Stage 5：受控文件前置条件](../stage5/RESULTS.md) · [Stage 6 全量执行日志](./final-regression.log) · [4 次稳定性复测](./stability-reruns.log)
- 贯彻 Minimalist：没有新增 npm 依赖、CAS Framework 或复杂注册层。使用现有 V2 Store、Tool Registry、Worker IPC 和 IDE 文件版本写入适配器。没有实现 Mobile/Agent Driver。

## 1. 实际解决的执行链断点

Stage 5 证明“可信 V2 来源 → 受控磁盘版本修改”可以工作，但没有经过 Worker 中当前 Tool/Handler 身份检查，更没有明确 Controller 的执行策略。

本轮新增单独实验开关 experimentalVersionedMutations，并提供 AppWorkerHost.executeVersionedFileReplace 的受控入口。它只有在 Shadow V2 已启用、App 正运行并且 Controller 提供显式授权回调和可信 File Adapter 时才可调用，**默认关闭，也不暴露到旧 Agent Tool 列表**。

执行顺序：

1. 从 Runtime-owned、Lease 支持的 V2 AppSnapshot 获取 ViewInstanceId、Tool bindingVersion 与 Ref 中的 File 实体路径和 SHA-256 内容版本；不信任自由 Tool JSON 或 Agent 自填期望哈希。
2. 明确检查当前 Tool 声明为 isMutating=true、资源类型为 File、版本格式合法；文件新内容不超过 4 MiB。授权回调收到冻结的 App、Tool、View、具体 File 和新内容参数。
3. 授权可能等待外部状态。等待返回后再次验证 Store Source/Lease、实例和 Resource 版本。
4. 发出**独立的 VIEW_TOOL_VALIDATE IPC**，Worker 重新校验当前 AppInstance 和 View-owned Tool binding、Schema 与 Handler 所属实例；**只做身份预检查，不调用实际 mutating Tool Handler**。
5. Worker 返回后再次验证 Store Source，只有仍然有效才调用 Controller 提供的、真正执行资源版本 CAS 的 File Adapter。磁盘文件发生变化时由 Adapter 再比较版本。
6. 任何资源冲突、权限拒绝、Worker RESET、参数错误、Schema/Tool binding 改变或失败都返回确定性错误；业务成功报告新版本，带 cleanupWarning 时如实透传。
7. 写入后 Host 维护尚未被 SDK 新 Snapshot 确认的版本屏障，同一来源不能反复写入。SDK 确实读取了新磁盘版本并提交 V2 后才允许下次操作。
8. Adapter 可能在真正 rename 后才抛异常；此时返回 RESOURCE_OUTCOME_UNKNOWN，**不能谎称磁盘写入失败**，也不能未经重新核验就继续写入。

以上仅为**实验性 Controller/Worker/Adapter 专用 API**。它不代表新的 Tool Handler 已经被正式 Agent Router 调度，更不是操作系统的跨进程原子 CAS。特别注意 SDK/Producer 报告仍是 producerConsistency=unverified、strictEligible=false。

## 2. 实际覆盖的代码边界

| 组件 | 代码 |
| --- | --- |
| Core | runtime/src/core/tool/view-owned-tools.ts：提取不执行 Handler 的 live binding validate，复用原 invoke 身份规则 |
| AppKernel | runtime/src/worker-runtime/app-kernel/AppKernel.ts：validateBoundViewTool，仅做活态注册状态复核 |
| Worker SPI/Runtime | runtime/src/spi/worker-protocol/messages.ts、runtime/src/spi/runtime/worker-message.interface.ts、runtime/src/worker-runtime/index.ts：新增隔离的 VIEW_TOOL_VALIDATE IPC 与独立 INIT/RESET 开关 |
| Host | runtime/src/engine/app/worker-host.ts：受限来源解析、授权与异步后二次校验、Worker 预检查、真实文件适配、写后来源屏障、结果未知时失败关闭 |
| Shadow Receiver | runtime/src/adapters/snapshot/shadow-receiver.ts：内部 selectVersionedEntitySource，不把活态 Handler 暴露给外部 |
| IDE File Adapter | demo-apps/aotui-ide/src/core/versioned-file-write.ts：读时完整性比较、替换前重查工作区/锁 inode、保留原子 rename 后的真实成功结果及清理警告 |
| 验收 | runtime/src/engine/app/worker-host.m4-versioned-file.test.ts、runtime/src/core/tool/view-owned-tools.test.ts、demo-apps/aotui-ide/src/__tests__/versioned-file-write.test.ts |

## 3. 测试结果

| Gate | 真实最终结果 |
| --- | --- |
| Runtime/SDK/IDE TypeScript | 全部 exit 0 |
| Runtime 全量 Vitest | **63 files / 528 passed / 3 skipped / 7 todo** |
| SDK 全量 Vitest | **9 files / 86 passed** |
| IDE Jest | **6 suites / 27 passed** |
| 多项真实 Worker/IPC/SDK 联合测试 | 包括拒绝其他 Mutating Tool、授权参数、过期 Snapshot、写入后旧源拒绝与 SDK 新版本观察恢复 |
| 多次 SDK/Worker/文件系统稳定性 | [完整稳定性日志](./stability-reruns.log)，四轮定向测试通过 |
| 文件系统故障恢复 | 成功 rename 后锁清理失败仍返回 success + cleanupWarning；rename 实际失败不声称成功 |
| 资源竞争 | 多个并发相同 V2 来源的受控写入，真实 Adapter 仅有一胜，输出完整文件 |
| 未知写入结果 | Adapter 已提交后响应丢失，Host 报 RESOURCE_OUTCOME_UNKNOWN，并阻止未经核验的旧源重试 |

数据来自 [最终回归](./final-regression.log)。本阶段没有任何 Git stage、commit、reset。

## 4. 严格未准出的边界

- 完整 Agent 默认 Tool 路由并未接入 V2 Mutating Tool；旧 write_file/edit_file/delete_file 仍是 Legacy，无完整来源 + CAS 保证。
- 文件系统操作使用合作式锁，不能阻止完全不合作的外部进程在最终校验和 rename 之间竞争；传统内容哈希不能识别 A→B→A 的历史。
- SDK CaptureBarrier 对所有异常提交、外部对象原地修改、第三方 Hook 和跨 Host 的完整可证性仍缺；Stage 6 不是 Strict。
- 文件写入在 Worker 侧只是 Tool binding 预检查，真正磁盘写入由 Host 注入的受信任适配器执行；**不能宣称 View-local Mutating Tool Handler 已完整迁移**。
- Stage 6 尚未完善 App 关闭/WorkerPool 回收与磁盘适配器仍在执行时的生命周期竞争；后续必须先封闭此边界，才能进行更广泛推广。

**准出：M4 Stage 6 的实验性纵向链路 PASS；生产/Strict NO-GO。**
