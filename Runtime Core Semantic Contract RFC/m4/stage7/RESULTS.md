# M4 Stage 7 — 资源写入生命周期、失败关闭与捕获时序竞态

**结论：本阶段新增的正确性和稳定性 Gate PASS；正式 Agent Mutating Tool、完整 M4 和 Strict NO-GO。**

日期：2026-10-23；本地 HEAD 789ef07、Node v23.11.0、pnpm 10.15.1。未 stage、commit、reset 用户现存未提交内容。

关联：[Stage 6 实证](../stage6/RESULTS.md) · [最终全量回归](./final-regression.log) · [四轮稳定性复跑](./stability-reruns.log)

## 1. 本轮的实际发现与修复

### 1.1 App 关闭/Worker 回收与磁盘替换的生命周期协调

此前 WorkerHost.close()/releaseWorker()/terminate() 可能在 Host 调用的文件替换 Promise 尚未完成时拆除 Worker。

新增最小 in-flight 计数、closing 状态和等待者：APP_CLOSE 和 RESET 在确实已进入文件 Adapter 的替换操作结束后执行；同步 terminate 在磁盘替换未结束时推迟实际 Worker 终止。已进入 closing 后拒绝新写入及 reopen/resume，关闭 IPC 失败则终止异常 Worker。异步授权但尚未真正进入磁盘写入的操作不阻塞关闭；授权恢复时必须重新检查运行状态并拒绝。

**没有提供取消磁盘事务或回滚副作用的虚假保证。**

### 1.2 Tool 的操作类型与资源语义不可混淆

实验性专用文件替换 API 现在仅接受明确声明为 replace_file 的 V2 Tool，其他如 delete_file 不能借其来源调用 File Replace Adapter。仍需 Controller 提供真实授权策略及可信资源版本 Adapter；这是专用 API 的操作语义保护，不是通用 Tool Framework 的正式能力表。

### 1.3 同内容写入不可无限重放

替换写回与观察时 SHA-256 相同的内容仍可能更换文件 inode/元数据。现 Host 对这种文件写入在本 AppInstance 生命周期中保留 fail-closed 屏障，即使 UI 的无关变化产生新的 V2 Snapshot ID，也不能凭相同内容版本重新执行写入；更强的资源世代协议或新 AppInstance 才可处理后续操作。异常后的未知写入结果继续拒绝自动重放。

本轮 Pure Runtime Host + 真实 V2 Store 测试证实：相同哈希的写入只执行一次 Adapter，来源不能借另一个 Snapshot ID 复活。此策略有意牺牲同内容写入的便利性，直到更强的资源版本语义可以被证明。

### 1.4 捕获 V2 Draft 期间 Epoch 更新必须拒绝发布

代码审查确认 Worker 早已有 Draft 构造后的第二次 ProjectionToken 校验，因此没有重复添加校验代码。

本轮新增真正 SDK/Worker 的故障注入：V2 Tool inventory 被读取期间同步推进 SemanticProjectionCoordinator Epoch；该 Draft 触发 SNAPSHOT_PREPARE_FAILED，不会作为已提交 Revision 1 发布；后续稳定 Capture 恢复并发布 V2 Revision 1。Legacy Snapshot 仍保持可读，producerConsistency=unverified、strictEligible=false 的报告不改变。

这只是**已验证的捕获故障路径**，不等于 Preact 全部异常/并发/第三方 Hook/无通知原地变化已经有完整 Strict CaptureBarrier。

### 1.5 两个 FileDetail 的同名 Ref、同名 Tool 不能选错文件

新增 Pure Core V2 + 真实临时文件的双 View 测试：fd_0 与 fd_1 拥有不同 Runtime viewInstanceId、各自使用名为 file 的 Ref，聚合相同 FileDetail.replace_file Tool 定义。来源解析严格区分 File entityId/Version；只修改选中的 package.json 时，App.tsx 内容未改变。跨 View 的业务权限仍须由可信 Controller 检查，不能由字符串 View ID 自动赋权。

## 2. 变更边界与验证

| 代码位置 | 实际职责 |
| --- | --- |
| runtime/src/engine/app/worker-host.ts | closing + 在途 Adapter 计数和等待；关闭/池重用/强制终止协调；精确 replace_file Tool 约束；同版本写入重复调用阻止 |
| runtime/src/engine/app/worker-host.m4-lifecycle.test.ts（新增） | 6 项：关闭/重用/终止等待、reopen/resume 禁用、关闭失败清理、同哈希重放 |
| runtime/src/engine/app/worker-host.m4-versioned-file.test.ts | 实际 Worker 的错误 Tool 类型、异步授权来源变化、文件版本重观察与多写入竞争、结果未知和真实关闭时序 |
| runtime/src/engine/app/worker-host.m4-producer-race.test.ts（新增） | 1 项：真实 Worker/Sdk 在 V2 Draft 捕获过程中改变 Epoch，拒绝该次 Draft 且能恢复 |
| runtime/src/core/tool/versioned-file-integration.test.ts | 增加两个 FileDetail 同名 Ref/Tool 但不同磁盘文件的来源隔离与真实文件修改 |

**没有修改 M1 Snapshot V1/V2 Schema，也没有切换旧 Agent Tool Router；没有增加第三方包或框架基类。**

最终验收：[完整回归日志](./final-regression.log)。

| Gate | 真实结果 |
| --- | --- |
| Runtime TypeScript Emit | exit 0 |
| SDK TypeScript noEmit | exit 0 |
| IDE TypeScript noEmit | exit 0 |
| Runtime Vitest | **65 files，536 passed、3 skipped、7 todo** |
| SDK Vitest | **9 files，86 passed** |
| IDE Jest | **6 suites，27 passed** |
| 稳定性复测 | **四轮：每轮 Runtime 4 files / 14 passed，IDE 13 passed；全部 exit 0** |
| Stage 6 → Stage 7 新验证 | Runtime 从 528 → 536，通过数增加 8 项（6 lifecycle、1 Worker Epoch 故障、1 双文件资源源身份） |

证据：[真实关闭竞争](./close-while-writing-real-worker.log) · [无内容变化的写入屏障](./noop-fence-first.log) · [生产捕获故障注入](./producer-epoch-race-first.log) · [四轮稳定性](./stability-reruns.log)。

## 3. 强制保留的 No-Go

- 默认 Agent write_file/edit_file/delete_file 仍是旧执行路由，没有强制 V2 Source/权限/File CAS；本轮新增实验 API 默认关闭。
- Node fs wx + rename 是合作式锁，不能保证外部不合作进程的真正无条件原子 CAS；内容 SHA 无法表示 A→B→A 历史，更不能全面表达 ACL/xattr/inode 等状态。
- 实验性 mutating 文件适配由可信 Host Controller 执行，Worker 只重新核验 View-local Tool 的身份，而**没有真正迁移为 SDK Mutating Handler 的统一执行语义**。
- Strict SDK CaptureBarrier 不覆盖所有 Preact 异常、第三方 Hook、无通知可变对象更新和其他 Host；Shadow 仍标记 producerConsistency=unverified、strictEligible=false。
- 真实 IDE 大工作集、LSP 文件修改并发、资源权限 CAS、性能和 Node >=24 生产环境仍缺正式 Gate。

**阶段性 Stage 7 PASS；完整 P0/M4/M5 与生产 Strict 仍 NO-GO。**
