# M4 Stage 8 / Wave 1 — Codex 实际交付

本批完成源码修改、负面测试、真实 SDK/Worker/文件系统验证和全量回归。建议 **Stage 8 limited PASS，等待 ChatGPT 独立验收**。这不是完整 M4 PASS、Strict PASS 或默认 Agent 写入路径的开放批准。Wave 2 未执行。

## 1. 起始事实与保护用户数据

- HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`。
- Node `v24.15.0`，pnpm `10.15.1`。
- 起始 `git status --porcelain=v1` 有 152 条记录；这是状态记录数，不是展开后的文件总数。完整记录在本批证据目录的 `baseline-status.log`。
- 起始 staged diff SHA-256：`258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`。最终值见 `GATE_STATUS.json` 和 `test-integrity-delivery.log`；相同才满足本批准出条件。
- 起始 unstaged diff SHA-256：`800a991934dba25b11ce50d75f13fe678b59df7b4a55a519d10ff4ce859325bd`。本批必须修改源码，因此最终 unstaged 指纹会变化，不能用它要求工作树保持不变。
- 未执行 `git add/commit/reset/checkout/restore/clean/stash/push/rebase`，未修改 Git index。
- 本批起点已经包含请求 `copyJson`/冻结逻辑、`closePromise` 和 2 个 Stage 8 生命周期测试；这些是已有用户改动。本批验证并补强它们，不将它们算作本批首次实现。
- Stage 7 报告的 Runtime 536 passed 是历史数字；本批修改前实际为 **65 files / 538 passed / 3 skipped / 7 todo**。SDK 86 passed、IDE 27 passed，基准三处 TypeScript 均 exit 0。

已先完整阅读 minimalist skill、RFC 00–07、指定 M3/M4 preflight 与 Stage 3–7 结果，再沿当前 TypeScript 实现核查。`codex-20261023T103428Z/AUDIT_PLAN.md` 记录触碰范围；`incremental-changes.patch` 对比本批起始工作树，而不是将用户已有改动混入本批差异。

## 2. 实际触碰的源码与原因

| 文件 | 起始状态 | 本批变化 |
| --- | --- | --- |
| `runtime/src/engine/app/worker-host.ts` | 已有 staged + unstaged 修改（MM） | 协调 close/release/在途生命周期；同路径写入预留；适配器结果严格归一化；明确授权和异常失败边界；退出时清理 pending requests |
| `runtime/src/engine/app/worker-host.m4-lifecycle.test.ts` | 已有 untracked 文件，8 tests | 保留原断言，增加 13 tests，使用可控 Promise gate 验证关闭、RESET、退出和监听器行为 |
| `runtime/src/engine/app/worker-host.m4-versioned-file.test.ts` | 已有 untracked 文件，1 个完整 E2E | 增加请求/尺寸/异步修改/授权中关闭/真实成功写盘中关闭与 RESET 的断言；用外部事件代替原有 1800ms Tool 变更定时器 |
| `runtime/src/engine/app/worker-host.m4-stage8-outcome.test.ts` | 本批新建 | 13 tests：真实 Core Store + mkdtemp 文件、适配器结果异常、同哈希在途重放、明确授权、异常访问器 |
| `runtime/src/core/tool/versioned-file-integration.test.ts` | 已有 untracked 文件 | 保留现有 6 tests，在同名双 View 用例中增加 A 实际写入后 B 内容不变的反向断言，不改 Core 实现 |

另新建本阶段验收文件和独立原始日志目录。没有修改 Core/SDK/Worker IPC/DOM Producer/IDE 的生产源码，没有新增 npm 依赖或第二个 Snapshot Store。已有 Stage 8 会话日志、预检日志、任务书等文件保持原内容。

## 3. 问题、最小修复与取舍

### 3.1 冻结请求和拒绝异常数据

沿用既有严格 `copyJson`，在任何授权或 Worker await 前复制一次完整请求，拒绝访问器、非 JSON、额外字段、空选择器、错误类型和超过预算的输入。精确验证 4 MiB UTF-8 内容边界；emoji 用例验证字节而非 JS 字符长度。

真实 SDK + Worker V2 测试在授权 Promise 未完成时修改原始请求的 snapshotId/toolId/viewId/refId/newContent，证明授权和文件适配器仍使用原有冻结值。Worker 继续只接收并复核 V2 Tool/target 元数据，不消费文件内容、不执行 mutating SDK Handler；本批没有为它新增内容授权语义。

本批将策略授权收紧为只有字面值 `true` 才放行，`1`、`'false'`、对象、null、undefined 均拒绝。初始来源选择异常转换成确定性失败。授权抛出的异常值也不再读取其 `message`，避免异常处理再次执行 getter/Proxy 逻辑。

**边界**：普通对象的 getter 不执行；Proxy 的反射 trap 可能在 JSON 检查期间执行。测试证明一个抛异常的 `getPrototypeOf` trap 会运行一次后被拒绝，授权和适配器均不运行。这里是 JSON 数据契约，不能隔离恶意 JS、阻止任意 trap 副作用或终止同步死循环。

### 3.2 close、releaseWorker、terminate 与旧生命周期响应

原有 close 单飞没有覆盖已开始的 RESET 和 open/pause/resume/reinitialize/INIT 响应；正常 APP_CLOSE 后 `releaseWorker` 又因为 `closed` 状态拒绝返回仍存活的 Worker。

本批用一个 release Promise 和一个在途生命周期 Promise 集合补齐协调：

1. 开始关闭或归还时立即置 closing，阻止新 request、生命周期操作和 fire-and-forget LLM output。
2. 等待已开始的生命周期请求与 Host 文件 I/O；旧响应不能把状态改回 running/paused/ready。
3. 重复 close 共用原 Promise；close 遇到既有 RESET 等待其完成；release 等待既有 close。
4. 归还物理 Worker 只允许一个调用者取得所有权，RESET 不重复发送；正常 APP_CLOSE 之后仍可 RESET 并归还。
5. 文件 I/O 尚在执行时强制 terminate 延后；IPC TERMINATE 发送失败仍执行原生 terminate；Worker error/exit 立即拒绝 pending requests。
6. 原生终止时只移除 Host 自己的监听器，保留外部 exit observer。WorkerPool RESET 后解绑全部监听器沿用既有归还契约。

实际成功写盘的 E2E 在受控 gate 上同时调用 close/close/release，验证成功结果仍返回，且实际 IPC 顺序严格为一次 APP_SHUTDOWN、APP_CLOSE、RESET。授权尚未完成时关闭，迟到的 grant 返回 APP_STOPPED，适配器未执行。

**取舍**：不新增生命周期框架或取消抽象。文件适配器若永不 settle，关闭也会等待；本批没有声称能取消已经开始的磁盘提交或保证关闭的时间上界。`terminate()` 仍是 void，不将调用完成解释成已 await 原生线程 exit。

### 3.3 写入结果与重放门槛

原有在途计数在适配器返回后过早结束，且读取返回对象的字段可能执行 getter。写盘已成功后若返回丢失或字段读取异常，不能报成普通失败诱导重复执行。同一内容的并发替换也可能在旧 fence 更新前再次进入适配器。

本批在调用适配器前，同步使用**已有** `unobservedFileVersions` Map 预留该文件，在途计数覆盖适配器执行、结果严格 JSON 复制、三态归一化和 fence 更新，最后才通知关闭等待者。

| 实际适配器反馈 | 对外结果 | 后续门槛 |
| --- | --- | --- |
| 合法 `written` + SHA-256 version | success；可携带 cleanupWarning | 新版本写入必须先被 V2 观察到；同哈希写入保留不可用单哈希解除的 fence |
| 合法 `conflict` + currentVersion | RESOURCE_VERSION_STALE | 确认为未写入，移除本次 pending 预留，仍需重新通过来源/业务版本检查 |
| 抛异常、结果丢失、getter、非法结构/字段/版本 | RESOURCE_OUTCOME_UNKNOWN | 保留未知结果 fence；同一 Host 的旧观察不能再次进入适配器 |

真实文件测试证明：写盘成功但响应携带 getter 时不运行 getter，不谎称普通失败，文件保留已提交内容；同哈希在途请求只能进入适配器一次；合法 conflict 不永久消耗本来仍有效的来源。

**边界**：这是 Host 内存中的来源 fence，不是持久化幂等日志。RESET 后新建 Runtime AppInstance，旧 snapshotId 被拒绝；新实例重新观察并获授权的操作不具备跨重启 exactly-once 保证。不能把新的相同哈希观察解释成证明旧写入从未执行。

### 3.4 复用既有正确实现，补证据

- `worker-host.m4-producer-race.test.ts` 已有真实 SDK/Worker V2 epoch 前后检查故障注入：构造 Draft 期间推进 Projection Epoch，Prepare Failed、不发布 torn Draft、稳定后恢复。代码正确，复跑留原始日志，没有重复实现。
- `core/tool/versioned-file-integration.test.ts` 已有双 FileDetail + 同名 `file` Ref / `replace_file` Tool 的真实 Core + mkdtemp 文件隔离测试，原来只实际写 B 并验证 A 不变。本批在保留全部原断言后，增加 A 的实际写入并验证 B 内容不变，补齐任务书指定方向。这项是 Core + 文件系统证据，不冒充双 View 的完整 Host E2E。
- Shadow 保持 `producerConsistency: 'unverified'` 和 `strictEligible: false`；默认 Agent mutating/Legacy Router 未切换。

## 4. 实际测试与失败轨迹

所有执行命令、stdout/stderr、真实退出码在 `codex-20261023T103428Z/test-*.log`；`commands.jsonl` 保留全部运行，失败日志未删除或覆盖。最终状态以 **final-delivery** 和 **stability-delivery** 为准；较早的 final-recheck/stability-final 是补双向隔离断言前的通过记录。

| 最后一次全量命令 | 结果 |
| --- | --- |
| `pnpm --dir runtime exec tsc --pretty false` | exit 0，先构建 Runtime 产物 |
| `pnpm --dir sdk exec tsc --noEmit --pretty false` | exit 0 |
| `pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false` | exit 0 |
| `pnpm --dir runtime exec vitest run --reporter=dot` | exit 0，66 files，564 passed / 3 skipped / 7 todo |
| `pnpm --dir sdk exec vitest run --reporter=dot` | exit 0，9 files，86 passed |
| `pnpm --dir demo-apps/aotui-ide exec jest --runInBand` | exit 0，6 suites，27 passed |
| 最终 3 轮针对性复跑 | 每轮 exit 0，9 files / 46 passed，无 skip/todo |

相对实际基线新增 26 个 Runtime test cases；原有 3 skipped / 7 todo 数量不变，本批没有添加或改成 skip/todo。完整安全场景与日志映射见 `GATE_STATUS.json`。

需要保留并解释的失败：

- `test-red-lifecycle.log`：6 failed / 8 passed；关闭与 RESET/生命周期竞争，正常 close 后不能归还 Worker。
- `test-red-termination.log`：2 failed / 14 passed；延后 terminate 时 close 提前完成、IPC 抛异常阻止 teardown。
- `test-red-outcome.log`：5 failed / 1 passed；非法适配器结果、结果访问器、同哈希并发重放。
- `test-red-authorization-boundary.log`：4 failed / 8 passed；truthy 授权和来源选择异常。
- `test-red-worker-exit.log`：2 failed / 17 passed；Worker exit 后 closing 与 pending requests 清理。
- `test-red-shutdown-output.log`：1 failed / 20 passed；关闭后仍发送 LLM output。
- `test-red-exception-accessor.log`：1 failed / 12 passed；读取策略异常 message 的访问器导致 API 再次抛异常。
- `test-regression-audit.log`：全量 1 failed / 560 passed，本批最初的 terminate 清理误删外部 exit listener，导致真实 Worker 通道测试超时。`test-red-exit-observer.log` 单独重现；只移除 Host 监听器后通过，不提高 timeout 掩盖问题。
- `test-green-lifecycle-first.log` 中一次失败来自测试假设 RESET 必须在一个微任务内到达，改为明确 resetEntered gate，不改安全断言。`test-lifecycle-typecheck.log` 的 TS2367 通过使用实际状态读取消除。
- `test-real-worker-first.log` 中恢复失败来自尝试复用已 stopped 的同一个 Shadow Store；修正 fixture 为 RESET + 新 Host/AppInstance，不复活旧 Store 或放宽来源要求。
- `test-stability-1.log` 是较早的 7 文件/43 cases 审查运行，其中一个过滤参数不是实际文件名。它不计入三轮门槛；最终三轮使用 9 个实际文件，均 46 passed。

未为了通过测试更改原有安全期望、放宽全局门槛、跳过失败用例或关闭 TypeScript。

## 5. 性能、未验证项和平台限制

- **NOT_TESTED**：真实 IDE 多文件/LSP GUI 工作负载、第二个独立非 DOM/Worker Adapter、CPU/heap、Commit 与调用 p50/p95、拒绝率/吞吐预算、100/1000/10000 规模预算。本批没有执行这些命令或实验；它们属于后续独立 Gate。
- **NOT_TESTED**：行/分支覆盖率百分比，没有运行 coverage 命令；26 个新增 test cases 不能换算为覆盖率。
- **NO-GO**：完整 Strict CommitBarrier、完整 M4 mutating gate、默认 Agent 写入开放。本批不把 V2 结构合法、viewInstanceId、只读标志或 SHA-256 当作业务授权。
- 已知文件 CAS 仍是 SHA-256 + 合作式同路径 wx 锁 + 同目录临时文件/fsync/rename；不合作的外部进程仍可在最后比较与 rename 间竞争，A→B→A 无法由单哈希区分，元数据/ACL/xattr/inode 不保证保留。本批未进行 OS 崩溃/断电、跨平台文件系统或恶意不合作进程的安全证明。
- View/Tool 生命周期也可能在 Worker 校验结束后、实际磁盘提交前变化。本批保留 Store 复核、运行状态复核与资源 CAS，不宣称完成跨 Worker/Host/文件系统的原子提交。
- 长时间不完成的可信授权 Promise 会保留其来源 lease；关闭可以先拒绝新操作，但本批没有新增授权取消或外部策略超时机制。
- SDK 的 APP_SHUTDOWN flush timeout fallback 在真实 Worker 日志中仍可见；没有删日志或将它等同于所有外部副作用已持久化。文件适配器本批路径的结果由专门 gate 验证。
- 命令运行耗时仅作为测试证据，不能作为产品时延或 SLA。

## 6. 交付与停止位置

`GATE_STATUS.json`、`source-fingerprints.json`、`NEXT_WAVE_RECOMMENDATION.md` 与独立日志目录构成本批验收包。全部原始失败和修复后日志均保留；指纹清单区分本批新建文件、已有用户修改和本批增量。

本批在 **Wave 1 / Stage 8 Gate** 停止。下一步由 ChatGPT 独立审阅增量 patch、失败轨迹、最终回归和 Git index 指纹，再决定是否接受 limited PASS；未经该验收，不实施 Wave 2 的来源/Tool 对外契约变更。
