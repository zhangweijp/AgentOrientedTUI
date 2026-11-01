# 从正式包入口使用纯 Core

`@aotui/runtime/core` 公开明确的快照、View-owned 工具、参数合同、Scoped interaction 和 StateSession API；`@aotui/runtime/adapters/memory-state-storage` 单独提供内存存储。它们复用 Runtime 中的同一实现。根包、SPI 大入口和其他 adapter 保持原环境要求，不因这两个子路径可纯消费而全部成为无 DOM 模块。

这是可信 Producer/Host 的低层装配 API：装配者管理 AppInstance、View 注册、稳定 execution binding、policy、存储 owner 和关闭顺序。它不是应用代码自行伪造来源或跳过授权的通道。Core `registerTool` 的签名为 `(viewInstanceId, spec, handler, options?, safeInvoker?)`；旧的 `enabled` 参数和 `setEnabled` 方法已移除。条件能力通过调用注册返回的 release 函数后重新注册表达；新 binding 使用新版本，旧观察不能转而调用它。实际 Runtime/App 的公共 Scope 桥接、父级关闭等待和资源报告已接入，见 [Runtime/App 公共交互](runtime-app-interaction.md)。

下面的主示例会在交付检查中逐字提取，使用实际 tar 内容从包名编译、执行，并在同 realm VM 中再次运行。没有源码路径别名、workspace symlink、DOM/Node 类型 shim 或模型 SDK。示例只用 ES 语言能力；运行 Core 的环境还需标准 `TextEncoder` 与 `AbortController`。示例里的固定 ID 仅用于一次隔离运行；生产装配必须为新生命周期提供全新 AppInstance 和 authority namespace。

<!-- b1-example:start -->
```ts
import {
  createSnapshotCore, createViewOwnedTools, createScopedInteraction, refKey,
  compileOrdinaryParams, ordinaryParameterProfile, compileSnapshotValueParams,
  createStateSession,
  type AggregatedViewTool, type ExecutionBinding, type ExecutionFact,
  type Observation, type JsonValue, type OperationResult,
  type SafeOrdinaryInvoker, type SafeRefInvoker, type StateSessionLimits,
} from '@aotui/runtime/core';
import { createMemoryStateStorage } from '@aotui/runtime/adapters/memory-state-storage';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const appId = 'notes', instanceId = 'tutorial-run-1';
const snapshots = createSnapshotCore({ now: () => 0 });
snapshots.lifecycle.startApp(appId, instanceId);
const registry = createViewOwnedTools(appId, instanceId);
const view = registry.mount('detail', 'Note');
const ordinary = compileOrdinaryParams({ n: { type: 'number', required: true } }, { additionalProperties: false });
const reference = compileSnapshotValueParams({
  file: { type: 'reference', required: true, refSource: 'snapshot-value-v1', refType: 'File' },
  suffix: { type: 'string', required: true },
}, { additionalProperties: false });
check(ordinary.ok && reference.ok, 'Parameter declarations must compile');
const ordinaryContract = ordinary.contract, refContract = reference.contract;
let addCalls = 0, readCalls = 0;
async function add(args: Readonly<Record<string, unknown>>): Promise<OperationResult> {
  check(typeof args.n === 'number', 'Expected validated number');
  addCalls++;
  return { success: true, data: { value: args.n + 1 } };
}
async function read(args: Readonly<Record<string, unknown>>): Promise<OperationResult> {
  const file = args.file;
  check(file !== null && typeof file === 'object' && 'text' in file && typeof file.text === 'string', 'Expected snapshot payload');
  check(typeof args.suffix === 'string', 'Expected validated suffix');
  readCalls++;
  return { success: true, data: { value: file.text + args.suffix } };
}
const safeAdd: SafeOrdinaryInvoker = async args => {
  const valid = ordinaryContract.validate(args);
  if (!valid.ok) return { phase: 'not-entered', result: { success: false, error: { code: valid.code, message: 'Invalid parameters' } } };
  return { phase: 'entered-returned', result: await add(valid.value) };
};
const safeRead: SafeRefInvoker = async args => {
  const valid = refContract.validateEffective(args);
  if (!valid.ok) return { phase: 'not-entered', result: { success: false, error: { code: valid.code, message: 'Invalid effective parameters' } } };
  return { phase: 'entered-returned', result: await read(valid.value) };
};
function registerAdd() {
  return registry.registerTool(view.viewInstanceId, { name: 'add', description: 'Add one', inputSchema: ordinaryParameterProfile(ordinaryContract), isMutating: false },
    add, { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }, safeAdd);
}
const releaseAdd = registerAdd();
registry.registerTool(view.viewInstanceId, { name: 'read', description: 'Read the source Note', inputSchema: refContract.schema, isMutating: false },
  read, { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, safeRead);

const bindings = new Map<string, ExecutionBinding>();
const bindingKey = (toolId: string, target: { viewInstanceId: string; bindingVersion: number }) =>
  JSON.stringify([toolId, target.viewInstanceId, target.bindingVersion]);
function installBinding(tool: AggregatedViewTool) {
  const target = tool.targets[0], isRef = tool.name === 'read';
  const binding: ExecutionBinding = {
    identity: {}, mode: isRef ? 'snapshot-value-v2' : 'ordinary-v2',
    validateInput: (_source, input) => {
      const result = isRef ? refContract.validateEffective(input) : ordinaryContract.validate(input);
      return result.ok ? { ok: true, value: result.value } : { ok: false };
    },
    isLive: source => ({ ok: (isRef ? registry.validateSnapshotValueParametersBinding(tool, source.target)
      : registry.validateOrdinaryParametersBinding(tool, source.target)).success }),
    execute: async context => {
      const terminal = await (isRef ? registry.invokeSnapshotValueParameters(tool, context.source.target, context.effectiveInput)
        : registry.invokeOrdinaryParameters(tool, context.source.target, context.effectiveInput));
      const result = terminal.result, value = result.data?.value;
      if (!result.success) return { kind: 'operation-result', phase: terminal.phase,
        result: { success: false, error: { code: result.error?.code ?? 'BUSINESS', message: result.error?.message ?? 'Business failure' } }, failureEffects: 'none' };
      check(typeof value === 'number' || typeof value === 'string', 'Expected the demo business value');
      return { kind: 'action', phase: terminal.phase, outcome: { status: 'succeeded', value } } satisfies ExecutionFact;
    },
  };
  bindings.set(bindingKey(tool.id, target), binding);
  return binding;
}
registry.listTools().forEach(installBinding);
let seq = 0;
function publish(text: string) {
  const tools = Object.fromEntries(registry.listTools().map(t => [t.id, {
    id: t.id, name: t.name, viewType: t.viewType, description: t.description,
    inputSchema: t.inputSchema, isMutating: t.isMutating, targets: t.targets,
  }]));
  const result = snapshots.committer.accept({ schemaVersion: 2, appId, instanceId, producerSeq: ++seq, sourceEpoch: seq, capturedAt: 0,
    views: [{ id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: 'Note', kind: 'state', content: { format: 'markdown-v1', value: text } }],
    refs: { [refKey(view.viewId, view.viewInstanceId, 'selected')]: { id: 'selected', ownerViewId: view.viewId, ownerViewInstanceId: view.viewInstanceId,
      refType: 'File', target: { kind: 'snapshot-value', payload: { text } } } }, tools });
  check(result.status === 'published', 'Expected a new source version');
  return result.snapshot;
}
publish('old');
let authorizations = 0;
const authority = createScopedInteraction(snapshots.store, { namespace: 'tutorial:tutorial-run-1', now: () => 0 });
const opened = authority.createScope({ appId, instanceId, policy: {
  project: ({ source }) => ({ views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
    refs: Object.values(source.refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
    targets: Object.values(source.tools).flatMap(t => t.targets.map(target => ({ toolId: t.id, target }))), content: [] }),
  authorize: () => { authorizations++; return true; }, canReadReceipt: () => true,
}, execution: { resolve: source => bindings.get(bindingKey(source.tool.id, source.target)) ?? null } });
check(opened.status === 'opened', 'Expected a Scope');
const client = opened.client;
async function observe(): Promise<Observation> {
  const result = await client.observe({ viewIds: [view.viewId] });
  check(result.status === 'observed', 'Expected an observation'); return result.observation;
}
function request(source: Observation, name: string, invocationId: string, input: Readonly<Record<string, JsonValue>>) {
  const tool = source.tools.find(t => t.name === name), binding = source.bindings.find(b => b.toolId === tool?.id);
  check(binding, 'Expected a visible tool binding');
  return { invocationId, observationId: source.observationId, bindingId: binding.bindingId, input };
}
async function value(source: Observation, name: string, invocationId: string, input: Readonly<Record<string, JsonValue>>) {
  const result = await client.invoke(request(source, name, invocationId, input));
  check(result.kind === 'receipt' && result.receipt.outcome.status === 'succeeded', 'Expected business success');
  return result.receipt.outcome.value;
}
const old = await observe();
check(await value(old, 'add', 'add-1', { n: 2 }) === 3, 'ordinary-v2 dispatch');
const beforeInvalid = addCalls;
const invalid = await client.invoke(request(old, 'add', 'invalid', { n: 'wrong' }));
check(invalid.kind === 'receipt' && invalid.receipt.outcome.status === 'rejected' && addCalls === beforeInvalid, 'Invalid input cannot enter handler');
publish('new');
check(await value(old, 'read', 'old-ref', { file: 'selected', suffix: '!' }) === 'old!', 'Pinned old Ref must keep old value');
const fresh = await observe();
check(await value(fresh, 'read', 'new-ref', { file: 'selected', suffix: '!' }) === 'new!', 'New source must read new value');
const oldAdd = registry.listTools().find(t => t.name === 'add'); check(oldAdd, 'Expected add');
const oldKey = bindingKey(oldAdd.id, oldAdd.targets[0]), oldBinding = bindings.get(oldKey);
releaseAdd(); registerAdd(); bindings.delete(oldKey);
const newAdd = registry.listTools().find(t => t.name === 'add'); check(newAdd, 'Expected replacement');
const newBinding = installBinding(newAdd);
check(newBinding !== oldBinding && bindingKey(newAdd.id, newAdd.targets[0]) !== oldKey, 'New registration needs a fresh binding identity');
const beforeStale = addCalls, stale = await client.invoke(request(old, 'add', 'old-binding', { n: 2 }));
check(stale.kind === 'receipt' && stale.receipt.outcome.status === 'rejected' && addCalls === beforeStale, 'Old binding cannot redirect');
const beforeClosed = authorizations;
authority.close(); await authority.whenClosed();
check((await client.invoke(request(fresh, 'read', 'closed', { file: 'selected', suffix: '!' }))).kind === 'refused', 'Closed Client must reject');
check(authorizations === beforeClosed && authority.inspect().combinedBytes === 0, 'Closed authority cannot reauthorize');
registry.dispose(); snapshots.lifecycle.dispose();

const memory = createMemoryStateStorage({ maxStoredKeys: 16, maxStoredBytes: 65536, maxRecordBytes: 16384, maxAddressBytes: 512,
  maxActiveOwners: 2, maxClaimedNamespaces: 4 });
const limits: StateSessionLimits = { maxDepth: 16, maxNodes: 1000, maxValueBytes: 8192, maxRecordBytes: 16384, maxAddressBytes: 512,
  maxKeys: 8, maxRetainedBytes: 65536, maxPendingOperations: 8, maxConcurrentOperations: 2, maxRevision: 1000 };
const address = { namespace: 'notes-data', key: 'count' }, first = memory.open('data-owner-1'); check(first.status === 'opened', 'Storage owner');
const session = createStateSession({ instanceId: 'data-owner-1', storage: first.storage, limits, now: () => 0 });
const bound = session.bind(address, 0, { hydrate: true }); check(bound.status === 'bound', 'State binding');
const recovered = await bound.binding.recovery; check(recovered.status === 'missing', 'Initial storage is empty');
check(bound.binding.confirmInitialization(recovered, { status: 'ready' }).status === 'accepted', 'Initialization acknowledgment');
check(bound.binding.update(41).status === 'accepted' && (await session.flush()).ok, 'Update and real flush');
check((await session.dispose()).release.status === 'released', 'First owner actually released');
check(memory.getStats().activeOwners === 0 && memory.getStats().storedKeys === 1, 'Released ownership does not delete data');
const second = memory.open('data-owner-2'); check(second.status === 'opened', 'Fresh owner');
const restored = createStateSession({ instanceId: 'data-owner-2', storage: second.storage, limits, now: () => 0 });
const next = restored.bind(address, 0, { hydrate: true }); check(next.status === 'bound', 'Fresh binding');
const recovery = await next.binding.recovery; check(recovery.status === 'found' && recovery.value === 41, 'New owner reads persisted value');
check(next.binding.confirmInitialization(recovery, { status: 'ready', value: recovery.value }).status === 'accepted', 'Restored acknowledgment');
check((await restored.dispose()).release.status === 'released' && memory.getStats().activeOwners === 0, 'Final owner release');
export const demoFacts = Object.freeze({ ordinaryValue: 3, oldRefValue: 'old!', newRefValue: 'new!', persistedValue: 41,
  addCalls, readCalls, authorizations, closed: true, storedKeys: memory.getStats().storedKeys, activeOwners: memory.getStats().activeOwners });
```
<!-- b1-example:end -->

存储为空时，初值已经由 `bind` 提供，初始化确认只传 `{status: 'ready'}`；恢复到持久值时，确认才携带实际恢复后的 `value`。示例同时实际运行这两条路径。

`ExecutionBinding` 的 identity 和函数引用必须对同一注册保持稳定，重注册使用新身份。参数声明中的 `refSource: 'snapshot-value-v1'` 标识 Ref 的来源语义；执行 Binding 与参数合同使用 `snapshot-value-v2`。普通参数的执行 Binding 使用 `ordinary-v2`。声明、实际 callable 资格与来源校验仍分别生效。

`authority.close()` 同步永久撤销并返回原统计；`whenClosed()` 始终返回同一个 Promise，只在显式 close 后、Core 接纳的 project、验证、授权、执行、回执读取和实际 provider.query 都完成 finally 清理后结算。它不依赖成功时钟，不提供期限、取消或强制终止。无限挂起的用户 Promise 仍可能令关闭一直 pending，受原 Scope/调用/费用额度约束。调用者自己挂在 Promise 上的回调属于调用者持有，不由框架代为删除。

业务返回 accepted operation ID 不等于把后台任务 Promise 交给了 Core。`whenClosed()` 会等实际在途的 provider.query，却不能证明外部 accepted 任务已停止。通过公共 Runtime/App 桥接使用时，此信号参与父级关闭等待与资源报告；具体行为见 [Runtime/App 公共交互](runtime-app-interaction.md)。

新 Core/Registry/authority 必须使用新的可信身份域，不能 reset 旧域或用旧客户端重新授权。Memory adapter 的所有权释放与业务数据保留是两件事；示例的 storedKeys=1、activeOwners=0 是预期结果。持久化到真实文件和 SDK 的已有回归另行运行。

本页示例保留 B1 阶段的独立验收边界：精确 tar 内容的两个纯入口、ES2022-only 声明和受限 VM 闭环。整包消费、双 Producer、版本兼容、资源曲线及完整 IDE 显式迁移的当前状态见 [实施及验收总计划](../../rfcs/sdk-runtime-delivery/README.zh-CN.md) 和 [分发与边界](sdk-runtime-distribution.md)。这些验收仍不保证任意 Browser/Edge/Worker Host。
