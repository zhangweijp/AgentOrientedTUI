# 实例持久化

`usePersistentState` 将 JSON 状态绑定到当前托管 App 实例。Core 会话管理初始化、修订和保存；Host 负责文件系统和资源所有权。需要同时采用支持 `state-session-v1` 的 SDK 工厂与 Runtime。

```tsx
import { createTUIApp, usePersistentState, useAppRuntimeContext } from '@aotui/sdk';

function Settings() {
  const [count, setCount, meta] = usePersistentState('count', 0);
  const { persistence } = useAppRuntimeContext();
  const save = async () => {
    if (!persistence) throw new Error('Compatible persistence Runtime required');
    setCount(previous => previous + 1);
    const report = await persistence.flush();
    if (!report.ok) throw new Error('Save failed; inspect report.entries');
    return report;
  };
  // Connect save/clear to the application's existing View tool or event handler.
  void save; void meta;
  return null;
}
export default createTUIApp({ app_name: 'settings', component: Settings });
```

三元组仍为 `[state, setter, meta]`。`ready` 表示本次初始化已经得出结论，包括读取失败；它不代表已保存。`meta.getStatus()` 同步查询 `pending`、当前 `open/sealed` 的 initialized/revision/dirty/issue，或 `released`。查询不会触发 I/O，也不订阅保存状态；保存后不会专为状态变化自动重渲染。判断一次显式保存是否成功，应检查该次 `flush()` 的 `ok` 和 `entries`。通常使用 `usePersistentState` 即可；需要应用自行管理会话绑定或恢复流程时，`useAppRuntimeContext().persistence` 提供完整的 `AppStatePersistence` 客户端口。它不暴露 Ref、View Tools、投影协调、生命周期端口或 Host 的文件系统/storage adapter。

## 高级应用：自行拥有绑定生命周期

直接使用端口适合 IDE 等需要协调多份应用会话状态的服务。应用需要自行验证恢复值、确认初始化、处理更新/清理结果，并在所属服务结束时释放 binding；一般组件状态优先使用上面的 Hook。

```ts
import type { AppStatePersistence, StateValue } from '@aotui/sdk';

function checkedTabs(value: StateValue): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error('INVALID_TABS');
  }
  return value;
}

export async function rememberCurrentTab(persistence: AppStatePersistence): Promise<void> {
  const started = persistence.bind('recent-tabs', [], { hydrate: true });
  if (started.status !== 'bound') throw new Error(started.issue.code);
  const binding = started.binding;
  try {
    const recovery = await binding.recovery;
    if (recovery.status === 'blocked') {
      binding.confirmInitialization(recovery, { status: 'failed' });
      throw new Error(recovery.issue.code);
    }
    const tabs = recovery.status === 'found' ? checkedTabs(recovery.value) : [];
    const initialized = binding.confirmInitialization(
      recovery,
      recovery.status === 'found' ? { status: 'ready', value: tabs } : { status: 'ready' },
    );
    if (initialized.status !== 'accepted') throw new Error(initialized.issue.code);

    const updated = binding.update([...tabs, 'current']);
    if (updated.status !== 'accepted') throw new Error(updated.issue.code);
    const report = await persistence.flush();
    if (!report.ok) throw new Error('SAVE_FAILED');
  } finally {
    binding.release();
  }
}
```

`StateValue` 是受管状态的 JSON 值合同，不是底层存储对象。Host 仍拥有文件系统和资源配置；应用只拿到当前 App 实例的受管会话客户端口。

绑定与读取只在 layout commit 开始，废弃 render 不登记状态。setter 只计算一次函数更新，按当前已提交的 serializer 同步交给 Core，再安排界面更新。连续 setter 后直接 flush 或关闭，不必等被动 Effect。App 端口同步安装共享保存 Promise，下一微任务开始 Core 的有限快照；同一同步 commit 栈内的有效 layout 绑定和早期 setter 会纳入。Core 快照之后的新更新属于后续修订，旧保存不会将它标为已保存。并发 flush 共享同一 Promise；成功只针对该批条目，不承诺保存期间的所有后续更新。

同一个有效 namespace/key 同时只能有一个活跃绑定。key、storageKey、hydrate 选择或实例身份变更会重绑；旧 setter、clear 和迟到恢复不能作用于继任绑定。普通重渲染或 serializer 函数身份变化不会自动提交更新。卸载、seal、dispose 后的 setter 会在调用业务 updater/serializer 之前给出固定错误。

默认支持严格 JSON：null、布尔、有限数字、字符串、稠密数组和普通对象。Core 捕获独立快照，不冻结业务对象；setter 后原地修改业务对象不会改变已捕获值。Date、Map、Set、函数等 T 必须提供同步转换：

```tsx
import { usePersistentState } from '@aotui/sdk';

export function Dates() {
  const [date] = usePersistentState('lastVisit', new Date(0), {
    serialize: value => value.toISOString(),
    deserialize: value => new Date(String(value)),
  });
  void date;
  return null;
}
```

恢复只由 Core 解码一次，只接受精确的 v1 外壳 `{ version: 1, updatedAt, value }`；裸 JSON、未知版本或形状不匹配的记录会以 `UNSUPPORTED_FORMAT` 阻止恢复，原文件不自动覆盖或删除。确认不再需要旧内容后，应用可显式 clear。解包仅一层，业务对象自身的 `value` 字段保持原样。Hook 对恢复值执行 deserialize→serialize 正规化，包括同一会话中卸载重绑的待保存值。初始化期间已有 setter 时，迟到恢复不能覆盖新 UI 或 Core 修订。正常启动默认 hydrate；startupKind=reinitialize 默认保留新的初始状态，`rehydrateOnReinitialize: true` 才恢复。

serializer 或 deserialize 失败不会保留原异常正文/cause。有效 UI 更新可留在界面，但 Core 会记录本次捕获失败，flush 不会将旧值当作最新保存成功。无法捕获的任意 T 不会保留进 Core；重绑恢复上一份可捕获 JSON 和已有失败事实。修复 serializer 并显式 setter，再主动 flush 检查结果；关闭不会暗中重试已失败的手工保存整批。初始快照无法登记、重复活跃 key 或非法端口则明确失败。

`await meta.clear()` 只在删除为 applied 时成功；failed/unknown 以固定 code/message 拒绝。它不重置当前 UI，普通重渲染、flush 和关闭不会复活该状态；下一次显式 setter 才创建待保存值。损坏或未来格式、权限错误、超限不会静默覆盖。确认可以丢弃旧内容后显式 clear；如果删除也失败，先解决存储问题。unknown 表示实际效果无法确认，不能直接宣称保存失败无副作用；当前实例无法再安全写入时应关闭并检查真实存储结果。

| 固定诊断 | 操作指引 |
| --- | --- |
| PERSISTENCE_UNAVAILABLE | 使用同时支持实例端口的 SDK/Runtime；无持久化的组件仍可运行。 |
| OWNER_BUSY / STALE_BINDING / SEALED / DISPOSED | 避免同 key 双重挂载；使用当前代次，只在开放生命周期内更新。 |
| SERIALIZATION_FAILED / INITIALIZATION_FAILED | 修复同步转换并显式更新；必要时显式 clear 后重建。 |
| CORRUPT / UNSUPPORTED_FORMAT | 检查并保留原文件，选择修复或显式 clear，不能依赖默认值覆盖。 |
| CAPACITY_EXCEEDED / REVISION_EXHAUSTED | 缩小数据和并发规模，结束旧实例；工程上限见 Runtime 文档。 |
| ADDRESS_UNSUPPORTED / RESOURCE_UNSUPPORTED | 使用受支持的历史合法名称和普通存储资源，不清洗成其他人的地址。 |
| PERMISSION_DENIED / IO_FAILED / NAMESPACE_BUSY | 修复权限/环境或等待真实旧 owner 释放，检查本次报告。 |
| UNKNOWN_OUTCOME / INVALID_RECEIPT | 不自动重试可能已执行的修改；保留报告、检查结果并结束风险实例。 |

Hook 不安装自动保存定时器。`PersistOptions` 支持 `storageKey`、`serialize`、`deserialize` 和 `rehydrateOnReinitialize`；文件根、路径校验、Node backend、seal/dispose 都不暴露给 Hook。namespace 为 Runtime 捕获的 Desktop 与有效 AOTUI_APP_NAME（缺省 appId）；`storageKey` 显式覆盖 App 部分。同一 backend 的不同 namespace 独立，同 namespace 的活动 owner 互斥；不同进程或 backend 不保证互斥。

C01 已删除全局 `persistenceManager` 入口及其类型。通常使用 `usePersistentState` 声明实例状态；需要应用拥有更细的绑定/恢复流程时，可使用 `useAppRuntimeContext().persistence` 的 `AppStatePersistence` 接口，并在显式保存后检查 `flush()` 报告的 `ok` 和 `entries`。该客户端口不暴露 Host 文件系统/storage adapter。内部 writeJson 与 DOM shutdown 模块已删除。

| 实际组合 | 边界 |
| --- | --- |
| 当前 SDK＋支持 `state-session-v1` 的 Runtime | 工厂声明经实例确认后使用 managed 会话；Hook 的状态更新、恢复、flush 和 clear 按本文合同执行。 |
| 旧 SDK＋新 Runtime | legacy-unverified，旧直接写文件不受 managed 互斥保护；不支持新旧实现同时写同 namespace。 |
| 新 SDK＋旧 Runtime | 普通组件可运行，Hook 明确 unavailable，无文件系统 fallback。 |
| 旧 SDK＋旧 Runtime | 归档兼容起点，未获得新保证。 |

managed 关闭同步 seal，等待既有手工保存并取得最终快照；失败仍独立卸载和 dispose，等待真实存储释放。flush/卸载/释放任何失败或 unknown 均不能成功回池。完整 Manager/Desktop/Kernel 关闭聚合、独立 tarball、无 DOM Producer、跨平台/跨进程以及性能/RSS SLA 不在本批保证内。详见 [API 状态](api-status.md)与 [Runtime 持久化职责](../../runtime/docs/persistence.md)。

F01 补充：AppStatePersistence.captureValue(unknown) 是同步纯捕获，直接复用 A 的 captureStateValue 与本实例同一份已捕获预算；不 bind、不分配会话 entry/队列、不进行 I/O，也不保存输入/输出。pending setter 在当刻调用它，只暂存一个独立不可变 JSON 快照或失败标志；后续对象修改不能改变快照或掩盖失败。用户 T 不被冻结。bind 后快照交 update，预绑定捕获/预算拒绝交既有 reportUpdateFailure，诊断为 SERIALIZATION_FAILED；已绑定 update 直接捕获一次，其 CAPACITY_EXCEEDED 等准确预算诊断保持。纯捕获在 dispose 后仍是纯操作，不能恢复绑定权限。
