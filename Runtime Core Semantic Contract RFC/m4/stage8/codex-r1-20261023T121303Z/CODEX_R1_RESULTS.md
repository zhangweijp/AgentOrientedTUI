# Stage 8 R1 — 修复完成，等待 ChatGPT 再验收

本批只修 fulfilled transport 后的生命周期 continuation 失效问题。没有执行 Wave 2，没有启动其他代理，不宣布完整 Stage 8 PASS。Stage 8 的 REQUEST_CHANGES 是否解除由 ChatGPT 独立决定。

## 根因与最小差异

`handleMessage` 已 resolve Promise 并移除 pendingRequests 条目时，`sendLifecycleRequest` 的 await continuation 还可能没有运行。后续同一 message listener 调用 terminate，或注入 exit/error 后，清理 pendingRequests 不能撤销已经 fulfilled 的 Promise。原代码只看 closing/closePromise/releasePromise，因此继续设置 ready/running/paused；reinitialize 虽然不设置状态，也会错误返回成功。

相对本批起始工作树，生产文件 **`runtime/src/engine/app/worker-host.ts` 只新增 8 行、删除 0 行**：

1. dispatch 前捕获现有 Worker 所有权；await 后检查仍属于同一个 Worker。terminate/exit 将 Worker 置 null，后续 start 创建另一个 Worker 时也不能被旧响应污染。
2. 同 Worker 的新 INIT 会重建执行上下文；error 会失效当前执行但仍保留 Worker 对象。两者无法仅靠 Worker identity 区分，故增加一个私有 `lifecycleContextVersion`，只在 INIT/error 时推进，并在 await 后核对。
3. 不匹配就 reject `App lifecycle request was invalidated by a Worker or execution context change`，不更新状态。原有 closing/closePromise/releasePromise 防护仍保留。

没有新增 Store、状态机、基类、依赖、公开身份或 IPC 字段。该数字不是 View 身份、Snapshot Epoch 或授权凭证。没有全局禁止 closed/error 后的新操作：每个新请求捕获自己的上下文，合法的新操作仍可以完成。

唯一新增测试文件为 `runtime/src/engine/app/worker-host.r1-terminal-race.test.ts`。未修改任何既有测试、Core/SDK/IDE 生产行为、默认 Agent Router、实验默认值或 Strict 标志。独立复现脚本、独立审计目录、上批验收文件及日志均保留原内容。

## 本批实际红绿证据

先在 Node **v24.15.0** / pnpm **10.15.1** 下执行 Runtime tsc，再直接执行原独立脚本，未更改脚本事件顺序：

| 证据 | 修复前 | 修复后 |
| --- | --- | --- |
| 原真实 Worker 脚本 | exit 1，REAL_WORKER_VIOLATIONS=4/4 | exit 0，0/4 |
| 原受控 transport 脚本 | exit 1，VIOLATIONS=10/10 | exit 0，0/10 |
| 新 Runtime 回归文件 | 27 failed / 2 passed，exit 1 | 29 passed；与现有 lifecycle 合跑 50 passed，exit 0 |

原始日志：`test-red-independent-real-worker.log`、`test-red-independent-controlled.log`、`test-red-r1-regression.log`；对应修复后日志为 `test-green-independent-*.log` 和 `test-green-r1-regression.log`。失败日志没有删除、覆盖、skip 或 todo 化。

新增 29 个用例的覆盖：

| 场景 | 用例数 | 证据层次 |
| --- | --- | --- |
| start/open/pause/resume/reinitialize × terminate/exit/error，transport 已 fulfilled 后失效 | 15 | EventEmitter 仅控制 transport；真实 Host sendRequest/handleMessage，无 mocked sendRequest |
| 已为 error 的同 Worker 再次 error，reinitialize 仍须 reject | 1 | Worker 和状态均相同，证明需要最小失效序号 |
| 同 Worker 的新 INIT 使五种旧 continuation 失效，新 INIT 自身正常完成 | 5 | 真实 Host 公共方法和 request/response 路径 |
| error 后合法新 INIT、正常 close/open/pause/resume/reinitialize/close/INIT | 2 | 保留原有合法兼容行为，修复前就通过 |
| 后续外部 message listener 同步 terminate，五种生命周期均拒绝旧成功 | 5 | 真实 node:worker_threads 通道；先确认 Host pendingRequests 已为 0；外部 exit observer 仍能收到实际 exit |
| 旧 pause 已 fulfilled 后 terminate，公共 start 创建不同的真实 Worker | 1 | 旧请求 reject，不污染新 Worker；新 INIT 返回 ready |

所有窗口通过同步事件顺序或 Promise microtask 控制；没有 sleep、放宽 timeout 或改动既有成功/失败期望。新增原生 Worker 使用最小 ACK fixture，是 Host/worker_threads 生命周期证据，不冒充完整 SDK App；现有真实 SDK versioned-file/readonly/producer-race 在全量和三轮复跑中继续验证。

## 六项全量回归与三轮稳定性

以下六条命令本批按顺序真实执行，均 exit 0，原始输出为 `test-final-r1-*.log`：

| 命令 | 实际结果 |
| --- | --- |
| `pnpm --dir runtime exec tsc --pretty false` | 成功，生成当前 Runtime 编译产物 |
| `pnpm --dir sdk exec tsc --noEmit --pretty false` | 成功 |
| `pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false` | 成功 |
| `pnpm --dir runtime exec vitest run --reporter=dot` | 67 files，593 passed / 3 skipped / 7 todo |
| `pnpm --dir sdk exec vitest run --reporter=dot` | 9 files，86 passed |
| `pnpm --dir demo-apps/aotui-ide exec jest --runInBand` | 6 suites，27 passed |

随后重新运行未修改的独立脚本，再顺序执行三轮稳定性测试：每轮均 **6 files / 58 passed、0 failed、0 skipped/todo、exit 0**。文件为新 R1、原 lifecycle、真实 versioned-file、readonly、producer-race、snapshot-shadow。完整参数记录在 `commands.jsonl`、`R1_GATE_STATUS.json` 和 `test-stability-r1-{1,2,3}.log`。

以上均为本次运行结果，没有拿上批日志替代。原有 single-flight close/release、磁盘 I/O 等待、外部 exit listener、pending request 清理和实验能力 RESET 隔离的原测试保持通过。

## 工作树与证据保护

- 本批起始 HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`。
- 起始 staged diff SHA-256：`258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`。最终相同才完成本批保护条件；真实核对见 `test-integrity-r1.log` 和 `R1_GATE_STATUS.json`。
- 本批起始 unstaged diff SHA-256：`9820faaa60acfcfa943217f939b56e0ce3ccbd3896fc23b53f89ee90764751e2`。本批修改生产源码，unstaged 指纹会变化。
- 起始状态 153 条记录，tracked/非忽略路径基线 1096 项。`baseline.json`、`baseline-status.log`、`baseline-readonly/runtime/src/engine/app/worker-host.ts` 是本批另存的只读基线；忽略的编译产物不在该保护清单内。
- 只有已有 `worker-host.ts` 增量修改；另新增 R1 测试和本独立证据目录。`incremental-changes.patch` 相对本批起始工作树，不把上批修改算作本批。
- 未执行 git add/commit/reset/restore/clean/stash/checkout/push/rebase，未改 Git index。指纹清单区分已有用户改动与本批新文件。

## 兼容性与剩余限制

“请求失效”表示旧 continuation 不能再代表当前有效 Host 上下文，不意味着 Worker 的生命周期回调或外部副作用从未发生。本批不提供回滚、取消或自动重试；也不改变文件写入 API 的成功/冲突/未知结果语义。

新 INIT 只使此前尚未完成的 Host 生命周期 continuation 失效，不取消已经派发的 Worker 回调。APP_REINITIALIZE 沿用现有回调语义，不在本批重新定义其 App/Core 生命周期；若期间 terminate/error/exit/新 INIT，其返回同样必须失效。

原 Stage 8 的 Strict、跨进程文件 CAS、哈希 ABA、持久化幂等性及性能限制全部保留。本批没有执行新的性能/覆盖率测量、Strict 证明、第二 Adapter 或 Wave 2 实现；不声称已解决这些问题。

**交付建议仅为：Stage 8 R1 修复完成，等待 ChatGPT 再验收。**
