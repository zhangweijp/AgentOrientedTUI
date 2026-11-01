# Worker 租约与 App 资源归属

本文对应 W08-C1 的 Node 执行适配。这里的 Pool、Host、Sandbox 报告都是内部工程接缝，不是稳定的 Runtime 根 API，也不表示 Kernel 整体关闭已经完成。Core 不依赖 Worker、Node 或这些报告。

## 谁负责什么

| 对象 | 持有的资源 | 何时算完成 |
| --- | --- | --- |
| DesktopManager | 本 Runtime 的一个 WorkerPool | 池停止接收借用，全部物理 Worker 实际退出，预留槽归零 |
| AppManager | 借来的池；独立构造时可自有一个冷池 | 借来的池交由父级关闭；自有池通过内部 closeWorkerPool 等待 |
| WorkerSandbox | 一次安装、一个逻辑 Host、一张本次 lease | 安装终态、独立清理步骤、Host 资源、lease 归还均有结论；自有池还须关闭 |
| AppWorkerHost | 本逻辑实例的监听器、请求、文件替换与存储访问 | 自己的 Worker 已退出或安全转移，文件替换为零，真实后端 release 已确认 |
| WorkerPool | 有限的实际 Worker 与创建预留槽 | 只根据真实 exit 释放物理额度 |

默认链路是 DesktopManager → Desktop → AppManager → WorkerSandbox，传递同一个池。两个 createRuntime 不共享池；同一 Runtime 的多个 Desktop 共享容量。B2 默认存储后端仍按原合同共享，保证 namespace 排他；本单不清空或关闭其他实例的存储。

独立 AppManager 和独立 Sandbox 在没有注入池时各自拥有冷池。构造不启动 Worker。池上限在构造时固定，后续 App 的启动配置不能改变共享池容量；原有 Worker timeout 和 launchConfig 仍传入 Host/Worker。

## 借用凭证只属于本次借用

```ts
// 内部 deep import；不是新的稳定根导出。
const pool = new WorkerPool({ initialSize: 0, maxSize: 1 });
const first = await pool.acquireLease(workerScript);
await first.release();
const second = await pool.acquireLease(workerScript);
// 可能是同一物理 Worker，但必定是另一张 lease。
await first.release(false); // 返回第一次归还的同一个 Promise；不影响 second。
const closing = pool.destroy(); // 同步停止准入，不强杀 second。
await second.release();         // closing 池中等待真实退出。
await closing;
```

每张 lease 冻结，首次 release 同步登记唯一决定与 Promise，重复调用即使传入相反参数也共享原结果。池不积累已完成借用 ID。正常健康归还是 `pooled`；不健康或池关闭时，等实际 exit 后为 `exited`。旧凭证不能把新借用归还或杀掉。

`maxSize` 包括 leased、idle、retiring 和 reserved。没有空位且全部借出/退出中时，立即拒绝 `WORKER_POOL_CAPACITY_EXCEEDED`；没有无界等待队列。关闭后拒绝 `WORKER_POOL_CLOSED`，构造失败为 `WORKER_CREATE_FAILED`，不返回原始异常正文。

脚本按调用时工作目录解析为绝对路径，完整路径精确匹配。满额但有不同脚本的 idle Worker 时，只选择一个槽，先等旧 Worker 实际退出，再用同一槽创建新脚本 Worker。关闭会取消尚未创建的替换。它不提供文件系统访问隔离。

首次 warmup/首次 acquire 最多预热一次，目标包含本次借用。自动预热使用首次请求脚本，显式 warmup 使用默认脚本。initialSize 是首次目标，空闲可以回收到零，不周期补齐。部分构造失败仍保留已创建 Worker 的监督与销毁能力。

| 配置 | 默认 | 范围 |
| --- | --- | --- |
| initialSize | 2 | safe integer，0–100，且不大于 maxSize |
| maxSize | 10 | safe integer，1–100 |
| idleTimeoutMs | 60000 | safe integer，5000–600000 |

直接构造和 defineRuntimeConfig 都验证上述范围。每个 idle Worker 只有一个 unref 定时器，借出、退出、替换、销毁时取消；旧回调不能作用于新 lease。

通过 `defineRuntimeConfig` 提供部分配置时，根对象及 `worker`、`worker.pool`、`logger` 等配置段须为普通对象或 null-prototype 对象；字段须是自有、可枚举的数据属性。Getter/setter 与非枚举字段会以 `CONFIG_INVALID` 拒绝，校验和合并不会读取 getter。未知字段、对象段形状错误及数值范围错误也以 `CONFIG_INVALID` 报告；message 会包含字段路径，例如 `[worker.pool.maxSize]`。省略的字段及显式设为 `undefined` 的字段都沿用默认值。合并不会改写调用方传入的对象。

公开的 `validateRuntimeConfig` 接受完整配置；它用同一描述符读取方式检查配置字段，访问器会在对应路径以 `CONFIG_INVALID` 拒绝。

## 三种完成不要混为一谈

Host.close 的业务结果、Worker 的物理退出、后端 I/O 的真实结束分别记录。terminate 只请求终止；它返回、native terminate Promise resolve/reject 或业务 timeout，都不能代替 exit。终止拒绝且尚未 exit 时，Pool 继续计 retiring，Host 继续报告未释放。

Host 只解绑自己的 message/error/exit 回调，保留 Pool 和外部监听。成功 RESET 后，Host 报告 `transferred`，表示所有权交回池；物理 Worker 可能继续运行。请求终止时，即使 Host.worker 已置空，独立 exit 观察仍存在。

内部 waitForResourceRelease 只在 releaseWorker 开始、terminate 请求或实际 exit 后可用；之前以 `RESOURCE_RELEASE_NOT_STARTED` 拒绝，不隐式关闭 App。重复等待共用一次实际完成 Promise。它先等已有 close/release 尝试，再等实际文件替换和 B2 后端 release，避免在最后保存前关闭存储准入。它不增加 flush 或重试策略。

被接受的文件替换仍受原 M4 屏障保护，不能提前强杀；保存操作可以在 Worker 已退出后继续执行，Host 仍保留后端所有者并等待。后端 release 为 failed/unknown 时，报告可 `settled`，但 `resourcesReleased=false`；文件保存的失败/unknown 不会因 Worker 随后退出而改成成功。

## Sandbox 一次清理

安装在途重复调用共享 Promise，完成后重复安装拒绝。关闭开始同步停止新安装、异步业务/事件/View 调用和 void 推送；快照不再返回活动内容。每个安装 await 后复核关闭身份，迟到 acquire/INIT/OPEN 不会把状态重新变成 running。已获得的 lease 在 Host 构造、start、open 任一步失败时仍必须清理。

close、dispose、disposeAsync、delete 共用清理。第一种 close/delete 意图生效：delete 先开始只调用一次删除，失败也继续 close；close 先开始后 delete 拒绝 `LIFECYCLE_CONFLICT`。AppKernel 内部完整 onDelete 异常传播仍留给 C2，这里只承诺 Sandbox 对收到的失败独立清理。

顺序为：等待已接受安装 → 尝试 delete（适用时）→ 尝试 Host.close → releaseWorker/必要 terminate → Host 实际资源等待 → 唯一 lease 归还 → 等自有池关闭。每步独立保留固定失败；不能因一个错误跳过后续。自有池先同步关闭准入，归还 lease 后再 await destroy，避免相互等待。

```ts
await sandbox.close(); // 保留 Promise<void>；失败以 SANDBOX_CLOSE_FAILED 和 report 拒绝。
// 或获取有限报告，业务/清理失败以报告返回：
const report = await sandbox.disposeAsync();
```

dispose 仍为 void，只发出同一清理请求并观察失败。报告保留实例资源引用到实际结束。共享池健康归还允许 Sandbox.resourcesReleased=true、Host.worker=transferred，而父级池仍有 idle Worker；自有池还要求 closed。只有资源完成、无固定失败且 managed 持久化成功才 ok=true。Host、lease 或自有 Pool 的固定问题统一保留为 RESOURCE_RELEASE_FAILED，即使实际资源后来释放也不会把顶层 ok 改成 true。旧二进制保持 `legacy-unverified`，兼容关闭返回不等于 managed 保存确认。

## 有限报告和当前边界

Pool 报告只有状态、上限、total/reserved/idle/leased/retiring 与最多两个固定 issue。Host 报告只有状态、Worker 所有权、活动文件替换数、B2 存储快照与最多四个 issue。Sandbox 报告只有意图、状态、ok/resourcesReleased、Host/lease/自有池结论与最多五个 issue。快照及 issue 数组冻结，不保留业务正文、用户 cause 或无限历史；已完成 Sandbox 报告保留原结论。

本批受控测试验证交错、拒绝和计数；真实 Node/SDK 测试验证脚本身份、物理退出、实际文件和后端屏障、保存失败/回执丢失、Shadow 开关下复用，以及旧 SDK 标签。自然退出测试由新 Node 子进程完成 Pool/独立 Sandbox 清理后自行结束，没有 process.exit 或 afterAll 强杀作为成功证明。

上层 Manager/Desktop/Kernel 的安装登记、清理聚合、关闭期限、onDelete/unmount 全面异常处理、公共报告仍属 C2。这里的显式内部 pool 关闭测试不能证明 Kernel.shutdown 已经实现完整自然退出。跨进程、跨平台、长期 RSS、产品延迟、干净 tarball 分发和完整 IDE 迁移也不在本单签署范围。

## C2 上层关闭接入（追加）

C2 沿用以上 C1 资源归属和实际完成报告，接入 AppManager → Desktop → DesktopManager → Kernel。普通调用仍为 `await runtime.shutdown()`；进阶调用通过 `beginShutdown()` / `beginDesktopShutdown()` 的同一关闭操作区分观察者截止、已知故障和资源释放。截止不会取消实际 I/O，也不会启动第二次 destroy。

上层同步停止新业务、登记已接受的安装与创建，独立启动所有子项清理，按原对象身份移除已释放记录并保留未确认所有者。AppKernel 的异步 open、delete、close 共用各自实际操作；delete 固定失败经原 LIFECYCLE_RESPONSE 返回，unmount 失败后仍独立清理自身监听及注册。B2 原有 flush → unmount → dispose 顺序保持。

实际 C1 legacy 资源释放证据与 managed 保存确认分开；`unmount=pending` 的 B2 进度顶层 `ok=false` 不单独视为故障。完整公共 API、兼容行为和新旧调用方式见 [Runtime 关闭与结果报告](runtime-shutdown.md)。本段不改写上文 C1 的底层保证；C2/W08 的历史验收以已经封存的决定为准。

## W10 App 资源生命周期

当前 Host/Sandbox 关闭开始立即调用 `beginApplicationStop`，在安装尚未完成时保留停止意图；INIT 协商完成后补送 APP_STOP。业务 owner 的同步 stop 先于 managed session seal/flush，之后 join 初始化、卸载组件、等待实际 owner close 和 session dispose。新 owner 若在 stop 后才注册，会立即停止；卸载不抹去已登记的 cleanup 责任。

App cleanup 使用 v2，只报告 state/issues；stop/close 各自可选，无回调正常完成。失败或未完成回调仍禁止健康回池并保留错误，但不覆写 Host 自身已确认的 Worker/storage/Scope 释放事实。Legacy 保持 legacy-unverified。完整合同见 [普通 Tool 与应用清理](tool-lifecycle.md)。App 创建的外部子进程仍由 App 清理，callback 完成不构成框架对任意外部资源的证明。
