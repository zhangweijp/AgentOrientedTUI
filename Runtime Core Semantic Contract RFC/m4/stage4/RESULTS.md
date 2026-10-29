# M4 Stage 4：默认路径语义正确性与 V2 校验开销收敛

**状态：本轮针对性缺陷修复和限定性能优化 PASS；完整 M4/Mutating Tool Strict 仍 NO-GO。**

- 时间：2026-10-23；本地 HEAD 789ef07 + 已存在的大量未提交修改；Node v23.11.0，pnpm 10.15.1。
- 最小实现原则：复用 Snapshot V1 校验、copyJson、现有 Worker IPC、Node fs O_EXCL（flag wx），不新增独立 CAS 服务、包或权限框架。
- 依据：[Stage 3 的 P0 修复](../stage3/RESULTS.md) · [Stage 2 V2 契约](../../m4-preflight/STAGE2_RESULTS.md) · [本轮最终回归](./final-regression.log)。

## 1. 发现并修复的真实正确性问题

### 1.1 默认 Legacy Snapshot 同毫秒丢帧

原 AppWorkerHost 以 timestamp 大于上次 timestamp 才接受 SNAPSHOT_FRAGMENT；真实 Worker 一毫秒内的两个合法更新会使第二条被丢弃。timestamp 是诊断时间，不是快照 ID。

现只接受物理 Worker 绑定的 App ID，并在有 AppInstanceId / Shadow Instance Token 时校验具体实例；对提供 shadowCaptureSeq 的消息做严格单调检查，普通 Legacy 消息按单条 Worker 通道的接收顺序处理。**不再用时间戳否决同一毫秒内的独立更新。**

真实 worker_threads M2 回归由原来的“第二帧被丢”负面证据，更新为同毫秒两帧都被接受、都能和 Shadow 对应、都触发正确通知。新增 2 项默认关闭 Shadow 或开启 Shadow 的身份/同毫秒/旧序号拒绝测试。

兼容边界：原本未提供 appInstanceId 的旧第三方 Worker 消息仍能通过绑定的物理 Worker 通道进入 Host，但会校验 appId；并不能把可选来源身份字段称为所有旧 Worker 的独立密码学认证。当前真实 Worker INIT 在 Shadow OFF 下也会回传 Runtime 发放的 appInstanceId。

### 1.2 ToolResult 非法 success 字段不能包装成成功

Stage 3 已修正 SDK Handler 返回 success:false 时保留业务失败；本轮补足另一反例：Handler 错误返回 success:"false"（非布尔）。旧兼容 raw-object 逻辑可能当作普通 data 包装成 success:true。

现只要返回对象带 success 字段但不是布尔，就明确返回 success:false + TOOL_RESULT_INVALID，且不触发成功后的额外渲染。对普通无 success 字段的 Legacy Raw Handler 保留原兼容；新增 1 项回归。

### 1.3 IDE 创建文件后不能猜测 View ID

修正 stable FileDetail viewId 后，create-file-workflow 仍根据 activeFiles.length 推算新文件的 fd_N，并把可能错误的目标写入 create_file 成功结果。

现在文件创建完成后，只说明“FileDetail 打开请求已提交”，指导 Agent 从**下一份已提交 Workspace Snapshot**读取实际 viewId，不再附上猜测的 view_id。原来的 create_file 文件业务成功保持不变。

### 1.4 Node 文件创建竞态：TOCTOU 与误覆盖

原 fileSystemService.createFile() 先 fs.access 检查不存在、再调用默认写入模式的 writeFile；另一进程在两次系统调用之间创建同名文件会被新写覆盖。

现改用 fs.writeFile(filePath, content, {encoding:'utf-8', flag:'wx'})（Node O_EXCL）并创建父目录，文件已存在时返回确定错误。**仅修复文件创建的“不覆盖”原子性；不代表已有 write_file/edit_file/rename_file 获得文件版本 CAS。**

实际 Jest 在系统临时目录内创建文件、保留已有文件、针对同一路径发起 8 个并发创建：恰好 1 项成功、其他 7 项报告文件已存在，最终内容属于完整成功调用，不出现被覆盖/混合的内容。

### 1.5 文件已经创建后，后续 UI 失败不能谎报文件创建失败

文件 fs.createFile 成功，但打开 View、持久化打开记录或发送事件失败时，原业务 Tool 可能向 Agent 返回 CREATE_ERROR。Agent 误以为文件未创建，重复尝试不利于状态一致性。

现 create-file-workflow 在真正文件创建后，后续 UI/Persistence/Event 问题只附带 warnings 并返回成功消息；实际 fs.createFile 失败才抛出创建错误。所有用户可见的 View 身份仍须读取下个 Snapshot。

新增 2 项 Jest 回归，覆盖“磁盘成功但 4 个后续步骤失败”与“磁盘创建失败、不运行后续步骤”。

## 2. V2 验证效率：只移除可信路径上的重复复制

Stage 2 的 V2 Validator 先对不可信 Draft 做安全 JSON copyJson，然后将 V2 映射到 V1 检查代理，再调用 V1 validatePreparedDraft 进行第二次防御性复制。100 View 合成 Commit 的 p50 曾约为 10.974ms。

本轮把 V1 的**现有校验规则**抽成 validateCopiedV1Proxy，供 V2 对已由 copyJson 深度检查并隔离的代理数据直接复用，而不再次复制。V1 的公共 validatePreparedDraft 仍然先执行自己的原始防御性复制，再调用该内部 helper；V1 的规则、边界、输出保持不变。V2 的代理不进入 Store，也不作为执行快照。

改动文件：runtime/src/core/snapshot/validator.ts、v2-validator.ts。需要特别遵守：该 helper 是内部可信调用点，绝不能把调用方的未复制 JS 对象直接传入；只允许 V2 在严格初次复制后构造的 V1 代理使用。

## 3. 最终验证与性能

| 项目 | 真实结果 | 证据 |
| --- | --- | --- |
| Runtime TS Build | exit 0 | [完整回归](./final-regression.log) |
| SDK TypeScript | exit 0 | 同上 |
| IDE TypeScript | exit 0 | 同上 |
| Runtime Vitest | **61 files，509 passed，3 skipped，7 todo** | 同上 |
| SDK Vitest | **9 files，84 passed** | 同上 |
| IDE Jest | **5 suites，14 passed** | 同上 |
| V1/V2/Tool来源专项 | **71 passed**，含真实 Worker Shadow | [最初类型/回归](./initial-tests.log) |
| WorkerHost 来源与同毫秒回归 | **4 test files / 8 passed** | [Legacy IPC 合同](./legacy-ipc-tests.log) |
| 两个 V2 校验与来源选择文件覆盖率 | 94.71% lines、85.58% branches、100% functions | [Core coverage](./core-coverage.log) |
| IDE 新 Workflow/View ID 两文件 | 100% statements/lines/functions、88.88% branches | [Scoped Jest coverage](./ide-focused-coverage.log) |

合成 V1/V2 Commit，1KiB Markdown + 每 View 1 Ref + 单个 Tool；V2 每 View 增加一个 Tool target；5 次预热 + 20 次采样，与 Stage 2 相同脚本。**注意是两次独立时刻的运行，不是同批对照实验。**

| 100 Views | Stage 2 原 V2 | Stage 4 优化后的 V2 |
| --- | --- | --- |
| p50 | 10.974ms | 首次 9.314ms；连续复跑 **8.987–9.551ms** |
| p95 | 12.153ms | 首次 11.096ms；连续复跑 **9.492–9.987ms** |

参考：同轮优化后 V1 100 View p50 通常约 5.2–5.4ms。V2 的 ToolTarget 元数据和校验仍有额外开销；尚未在实际 IDE 里证明性能预算。来源：[Stage 2 原始合成数据](../../m4-preflight/stage2-v2-performance.log) · [优化后](./benchmark-after.log) · [三轮复测](./benchmark-reruns.log)。

### 3.1 覆盖率统计边界

首次探索性 Jest 命令误把数百行未在本轮测试覆盖的整个 file-system-service.ts 纳入 global 80% coverage Gate，因而汇总比率仅 11.13%，尽管全部 14 项测试都通过；原始日志保留在 ide-coverage.log。随后按本轮新增的两个 Workflow/ViewID 代码文件设置 scoped coverage，Gate exit 0；对于庞大的 file-system-service 只宣称已对 createFile 的排他创建路径做真实文件系统负例测试，**没有宣称整个文件系统服务达到 80% 覆盖率**。

## 4. 接下来不能绕过的 Gate

- **Snapshot 真正 CaptureBarrier**：M3 对任意异常 Preact/第三方 Hook/非 JSON 对象的原子来源证明还不完整；Shadow 继续固定 producerConsistency=unverified、strictEligible=false。
- **Mutating Tool 安全执行**：新 V2 受限只读路径仍拒绝全部 isMutating:true；旧 Legacy write_file/edit_file/delete_file 等没有来源 V2、文件内容版本 CAS、业务权限、资源锁/并发取消门槛，不能因为 create_file(wx) 成功就宣布写操作都安全。
- **真实 IDE 全链路**：当前 Jest 真文件并发测试仅在临时路径，真实 IDE/Worker/LSP、多项目及 UI 的端到端 CPU/内存/延迟仍缺 Gate。
- **其他 Host/模型与独立 Agent Framework**：纯 Core 无 DOM/Worker/模型 Provider 依赖，但尚未证明所有生产 Adapter 完全去耦；这仍是 P1 目标，不属于当前 P0 已完成结论。
- **Legacy Ref 的来源版本**：Stage 3 已移除跨 View 后缀误绑定，但唯一同名 Ref 在业务变化后仍可能重新指向新对象；在所有正式调用迁移到 V2 之前，不可宣称所有旧 Snapshot 误操作已杜绝。

**Stage 4 已识别的默认路径正确性风险修复和 V2 内部性能优化 = PASS；完整 M4/Strict/全部原始 P0 = NO-GO。**

本轮仅作本地源码/测试/RFC 修改，没有 stage、commit、reset，也没有删除用户原有未提交内容。
