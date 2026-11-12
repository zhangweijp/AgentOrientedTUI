# Runtime 关闭与结果报告

普通应用只需要等待原来的关闭方法：

```ts
import { createRuntime } from '@aotui/runtime';

const runtime = createRuntime();
// 创建 Desktop、安装应用、执行操作……
await runtime.shutdown();
```

首次请求立即停止本 Runtime 的新建、安装、执行、新观察、预览、收据读取、重初始化、暂停、恢复和加锁。已经接受的操作仍由原对象监督；释放快照、释放锁、关闭和读取仍受管理的 Desktop 状态可以继续。`shutdown()` 始终加入同一次关闭，返回稳定的 `Promise<void>`。已知关闭失败会以 `RUNTIME_CLOSE_FAILED` 拒绝并附冻结的 `report`；完成之后再次调用仍返回原来的失败。

## 需要有限等待时

```ts
const close = runtime.beginShutdown();
const result = await close.wait({ timeoutMs: 1000 });

if (result.status === 'deadline') {
    console.log(result.report.resources); // 截止这一刻仍由原对象持有的资源
}

const final = await close.completion; // 不另建等待 timer，持续监督实际完成
console.log(final.hasFailures, final.resourcesReleased, final.verification);
```

三项事实分别判断：

| 事实 | 看什么 | 含义 |
| --- | --- | --- |
| 本次等待是否结束 | `wait().status` | `deadline` 只结束该观察者的等待 |
| 是否发生已知故障 | `report.hasFailures`、固定失败样本 | 保存、卸载或清理故障不会被后来的资源释放抹去 |
| 是否确认资源释放 | `resourcesReleased`、`verification` | 完成的尝试也可能留下未确认释放的所有者 |

`interactions.retainedOperations` 统计实际尚未结算的执行、收据读取和投影准备。停止调用方等待之后，实际操作仍会计入。

`completion` 解析最终报告，已知业务或清理失败通过报告表达。`inspect()` 每次返回新的深度冻结快照；以前拿到的快照保持原样。`ok` 仅在实际尝试完成、资源确认释放、证据为 `managed` 且没有已知故障时为 `true`。

`wait` 缺省为 30000ms，允许安全整数 1–300000。同一个操作最多有 16 个尚未结束的观察者；超额以 `CLOSE_OBSERVER_LIMIT` 拒绝，无效配置为 `CLOSE_OPTIONS_INVALID`。已完成操作无需 timer。观察者互不取消，也不取消实际 I/O、Worker 退出或已经进入的回调。

报告是有限摘要：失败最多 16 份样本，每份最多 8 个固定 code，显示 ID 最多 256 UTF-8 字节，完整 JSON 不超过 64KiB。`failureCount` 和 `samplesTruncated` 保留被截断样本的事实。显示 ID 不参与对象身份判断；报告不包含用户异常正文、配置、文件路径或业务数据。未确认释放的原对象仍由对应的 Manager/Host 或资源 adapter 持有，不能因为报告截断而丢弃。

## 关闭单个 Desktop 并保存应用清单

```ts
const beforeClose = async () => {
    const state = runtime.serialize(desktopId);
    await saveDesktopState(state);
};

const close = runtime.beginDesktopShutdown(desktopId, {
    timeoutMs: 30000,
    beforeClose,
});
const report = await close.completion;
```

先停止新业务并等待 App 关闭，再运行一次 `beforeClose`，最后清理 Desktop 的信号、LLM 通道、日志和已释放元数据。App 的逻辑 reopen 状态保留到回调结束；这不表示物理 Worker 仍在运行。

首次完整关闭决定回调及其资格期限；单独 `drain()` 尚未选择完整关闭回调。相同函数可重复加入，之后不带回调也可加入；不同函数以 `LIFECYCLE_CONFLICT` 拒绝。先 `dispose()` 或 `destroyDesktop()` 后，不能再追加回调。Runtime 关闭会加入已经开始的 Desktop 关闭，不替换其回调和期限。

回调只在 drain 没有已知故障、且首次请求的单调时钟期限尚未到达时启动。期限已到则记 `skipped-deadline`；drain 失败则记 `skipped-drain-failed`；这两种跳过原本要求的回调都属于已知故障。已经启动的回调持续被监督到实际返回，后来更短的 `wait` 不取消它。系统墙钟回拨不会延长期限。

旧 `gracefulShutdown(id, options)` 使用同一个关闭操作及一次有限等待：观察者截止为 `CLOSE_DEADLINE_EXCEEDED`，实际关闭故障为 `DESKTOP_CLOSE_FAILED`，都附当刻冻结报告。超时后不会发起第二次 destroy。缺失 ID 的关闭保持幂等，报告为 `found=false`、本次零个 Desktop/App；它不证明某个历史实例保存成功。

close/delete 由首次意图决定。delete 先开始会先尝试 App 的 `onDelete`；失败仍继续 close/unmount 和资源释放。close/drain 先开始后不能升级为 delete。`AppKernel` 同实例的异步 open、delete、close 各自共用一次操作；卸载失败仍独立撤销五类自身监听和 owned View/Ref/Tool 注册。

## 保存回执与资源释放

`persistence` 按实际 Sandbox/Host 聚合：`managedApps`、`unnegotiatedApps` 和 `notUsedApps` 分开计数；flush 成功、失败、unknown 和 unsaved 分开保留。关闭中 `unmount=pending`、顶层 `ok=false` 的 B2 进度报告本身不算故障。flush 已成功仍计 `confirmedFlushes`。完成时缺合格最终报告，或实际 flush、unmount、dispose、release 失败，则保留固定失败。

每个 App 使用专属 Worker。Runtime 的 `workers.report` 给出容量状态、上限及当前物理 Worker 数量。关闭完成后，Runtime 自有容量报告为 `closed` 和 `total=0`。由父级 Runtime 管容量的 Desktop 报告 `workers.ownership=not-owned`。Host 在真实退出后归还名额，已接纳的存储 I/O 继续由原 Host 跟踪。

`mixed` / `unverified` 描述报告中实际存在的未协商或无法确认的资源事实，不代表旧 SDK/Worker 的兼容运行模式。资源释放证据与持久化协商结果分别保留；未使用持久化的 Sandbox 计入 `notUsedApps`，没有 managed 协商的则计入 `unnegotiatedApps`。只有报告中存在相应未确认参与者时才保留 `mixed` / `unverified`，不会仅因已确认释放的资源凭空增加未知参与者。

旧注入 Manager/Desktop/AppManager/AppHostService/Registry 缺少新能力时，仍尝试既有关闭入口，并记录未验证参与者。Promise 返回不能证明物理资源已经释放。真正抛出的关闭故障仍保留。默认装配具有完整报告能力；不会为测试替身把默认路径降成未验证。

如果结算后 `resources.retainedStorageOwners` 大于零，仍活跃的 Desktop 可对同一实例再次调用 `desktop.closeApp(appId, expectedInstanceId)`。对已关闭的 Desktop 使用 `runtime.beginDesktopShutdown(desktopId).completion` 发起释放尝试，Runtime 整体关闭结算后仍可使用该入口。并发重试加入同一尝试。释放成功后原 owner 被移除，关闭回调、App cleanup 和写入均只保留原结果。此前的冻结报告及 `runtime.beginShutdown()` 原 handle 保持原样。后续报告可同时显示 `resourcesReleased: true` 和 `hasFailures: true`。

## 对现有调用方的影响

- closing 即拒绝新业务，不能通过之前保存的 Desktop 对象绕过。重复 App/Desktop ID 在活动、关闭中或资源未确认释放时不能覆盖。
- `getInstalledApps()` / `getAppStates()` 返回独立记录快照，修改快照不会改动 Manager 内部状态。业务配置的任意深层冻结不在此保证内。合法 pending/closed 重开使用原 metadata 的内部路径。
- `Desktop.output` 和 `getLLMOutputChannel()` 返回本实例缓存 facade。关闭后不能新增订阅；旧取消函数只取消旧订阅，无法作用于同 ID 后继。后者保持服务方法形状，但要求本 Desktop ID，不再等于注入的原始 service 对象；错误 ID 为 `DESKTOP_SCOPE_MISMATCH`。关闭后的旧 facade 历史查询为空，push/subscribe/外部 cleanup 拒绝。
- `logSystem`、`emitSignal` 的迟到诊断无副作用。Logger 按精确 Desktop ID 隔离，包括带冒号的 ID。App 生命周期事件使用同一系统日志；独立 App 操作日志缓存及 `logAppActivity` 已退出。
- AppManager 与 Kernel 分别最多接受 128 个规定类别的未完成异步业务操作，超额在依赖副作用之前以 `LIFECYCLE_CAPACITY_EXCEEDED` 拒绝。复用操作不重复占 AppManager 槽，清理、释放和查询不占 Kernel 槽，也没有隐藏等待队列。

手工共享原始 SignalBus、LLM 服务或 Logger 时，同时存活的 Desktop 必须使用不同 ID；只有前一实例完整关闭之后才能复用 ID。直接绕过 facade 操作原始第三方对象仍由注入方负责。本次没有增加跨 Runtime 的全局服务注册中心。

此文说明 W08-C2 的实现合同；阶段验收由原设计会话独立签署。长期 RSS、产品延迟、跨进程与跨平台、干净 tarball 分发、无 DOM Producer 和完整 IDE 迁移各有后续门槛，不由本关闭报告替代。
