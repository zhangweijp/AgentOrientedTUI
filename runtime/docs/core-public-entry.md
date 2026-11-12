# 从正式包入口使用纯 Core

`@aotui/runtime/core` 提供 V3 Snapshot、App/ViewType Tool、App 实例交互与 Observation、参数合同与 StateSession；`@aotui/runtime/adapters/memory-state-storage` 提供内存存储。Core 不加载 DOM、Worker、Node 或模型 SDK。业务规则和外部副作用仍由 App/Host 负责。

本例面向自建 Host／Producer 的低层装配者。普通 App 作者先读 [SDK 指南](../../sdk/README.md)，不需复制这里的绑定、授权或资源接线。本例只依赖 Runtime 的纯 Core 与内存存储入口；Agent Driver 用户通过独立 `@aotui/agent-driver-adapter` 接入。安装版本和 tar 身份以同次交付为准，版本号不能替代联合验证。

两个 Tool 都注册一次到 `Note` ViewType，统一使用正式 `view-type-parameters-v1` profile。`add` 接收普通数值；`read` 接收一个必填 Note 对象 Ref。Note 是本例的内存业务数据，不是文件定位。下面的 JSON 注解与 SDK TypeBox `refParam` 对应，低层装配者不另造 Ref parser。Core 从原观察解析参数，授权与执行使用同一 effectiveInput。

普通 TypeScript 使用 `SemanticProjectionCoordinator.commit` 提交完整页面和当前工具，用现有 binding 提交参与本次的 Ref。框架管理发布版本，观察读取已准备的结果。正文只在 View 中呈现；Tool 返回完成收据，测试见证独立记录旧/新 Ref 的冻结值。b1 标记中的正文由真实新包消费者逐字提取、以 ES2022-only/types:[] 严格编译后执行，不能用另写的等价示例代替。

<!-- b1-example:start -->
```ts
import {
  createSnapshotCore, createViewOwnedTools, createAppInteraction, SemanticProjectionCoordinator,
  compileOrdinarySchema, createStateSession,
  type ExecutionBinding, type ExecutionFact, type JsonValue, type ToolResult,
  type OrdinaryParameterContract, type StateSessionLimits, type ObservationGrant,
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
const contracts = new Map<string, OrdinaryParameterContract>();
const bindings = new Map<string, ExecutionBinding>();
const bindingKey = (toolId: string, execution: unknown) => JSON.stringify([toolId, execution]);

const addSchema = {
  type: 'object', properties: { n: { type: 'number' } },
  required: ['n'], additionalProperties: false,
};
// This is the JSON annotation produced by SDK refParam('Note', NoteSchema).
const readSchema = {
  type: 'object', properties: {
    note: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'Note',
      'x-aotui-ref-value': { type: 'object', properties: { text: { type: 'string' } },
        required: ['text'], additionalProperties: false } },
    suffix: { type: 'string' },
  }, required: ['note', 'suffix'], additionalProperties: false,
};
check(compileOrdinarySchema(addSchema, 'view-type-parameters-v1').ok, 'Add Schema');
check(compileOrdinarySchema(readSchema, 'view-type-parameters-v1').ok, 'Ref Schema');

let count = 1, noteText = 'old', handlerEntries = 0;
const projection = new SemanticProjectionCoordinator({
  identity: () => ({ appId, instanceId }),
  readFrame: () => ({
    views: [{ id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: 'Note', kind: 'state',
      content: { format: 'markdown-v1', value: `Counter: ${count}\nNote: ${noteText}` } }],
    tools: registry.listTools(),
  }),
});
let selected: ReturnType<typeof projection.registerRef> | undefined;
const witness: Array<{ text: string; frozen: boolean }> = [];
async function add(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
  check(typeof args.n === 'number', 'Expected validated number');
  handlerEntries++; count += args.n; publish(noteText);
  return { success: true, data: { completed: true } };
}
async function read(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
  const note = args.note;
  check(note !== null && typeof note === 'object' && 'text' in note && typeof note.text === 'string', 'Resolved Note');
  check(typeof args.suffix === 'string' && Object.isFrozen(note), 'Validated frozen Ref');
  handlerEntries++; witness.push({ text: note.text + args.suffix, frozen: Object.isFrozen(note) });
  // Business text is already in the View; the receipt does not duplicate it.
  return { success: true, data: { completed: true } };
}
function register(name: string, schema: Readonly<Record<string, unknown>>,
  execute: (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>) {
  return registry.registerTypeTool({ viewType: 'Note', name, description: name === 'add' ? 'Add to the counter' : 'Inspect a displayed Note',
    inputSchema: schema }, {
    safeOrdinaryParametersInvocationMode: 'ordinary-v2',
    createSafeOrdinaryParametersInvoker: contract => {
      contracts.set(name, contract);
      return async args => {
        const result = await execute(args);
        if (result.success) return { phase: 'entered-returned', result };
        const { effects, ...data } = result;
        return { phase: 'entered-returned', result: data,
          ...(effects === undefined ? {} : { failureEffects: effects }) };
      };
    },
  });
}
let releaseAdd = register('add', addSchema, add);
const releaseRead = register('read', readSchema, read);
function installBinding(tool: ReturnType<typeof registry.listTools>[number]) {
  check(tool.execution.kind === 'view-type', 'One type-level execution identity');
  const contract = contracts.get(tool.name); check(contract, 'Captured registration contract');
  const binding: ExecutionBinding = {
    identity: {}, mode: 'view-type-parameters-v1',
    validateInput: (_source, input) => {
      const checked = (contract.validateResolvedInput ?? contract.validate)(input);
      return checked.ok ? { ok: true, value: checked.value as Readonly<Record<string, JsonValue>> } : { ok: false };
    },
    isLive: source => ({ ok: registry.validateTypeToolBinding(source.tool, source.execution).success }),
    execute: async context => {
      const terminal = await registry.invokeTypeTool(context.source.tool, context.source.execution, context.effectiveInput);
      if (terminal.result.success) {
        check(terminal.result.data?.completed === true, 'Expected a concise completion receipt');
        return { kind: 'tool-result', phase: terminal.phase,
          result: { success: true, data: { completed: true } } } satisfies ExecutionFact;
      }
      return { kind: 'tool-result', phase: terminal.phase,
        result: { success: false, error: { code: terminal.result.error?.code ?? 'BUSINESS',
          message: terminal.result.error?.message ?? 'Business failure' } },
        ...(terminal.phase === 'entered-returned' && terminal.failureEffects !== undefined
          ? { failureEffects: terminal.failureEffects } : {}) } satisfies ExecutionFact;
    },
  };
  bindings.set(bindingKey(tool.id, tool.execution), binding);
}
registry.listTools().forEach(installBinding);
function publish(text: string) {
  const prepared = projection.commit(() => {
    noteText = text;
    if (selected) selected.update({ text });
    else selected = projection.registerRef(view, 'selected', { text }, 'Note');
  });
  check(prepared === 'prepared', 'Expected a complete View, Ref and Tool frame');
  const result = projection.publishTo(snapshots.committer);
  check(result.status === 'published', 'Expected a new source version');
}
publish('old');

let authorizations = 0;
const authority = createAppInteraction(snapshots.store, { namespace: 'tutorial:tutorial-run-1', now: () => 0, appId, instanceId, policy: {
  project: ({ source }): ObservationGrant => ({
    views: source.views.map(item => ({ viewId: item.id, viewInstanceId: item.viewInstanceId })),
    refs: Object.values(source.refs).map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
    toolBindings: Object.values(source.tools).map(tool => ({ toolId: tool.id, execution: tool.execution })),
    content: source.views.map(item => ({ view: { viewId: item.id, viewInstanceId: item.viewInstanceId }, decision: 'retain' as const })),
  }),
  authorize: () => { authorizations++; return true; }, canReadReceipt: () => true,
}, execution: { resolve: source => bindings.get(bindingKey(source.tool.id, source.execution)) ?? null } });
const client = authority;
async function observe() {
  const result = await client.observe({ viewIds: [view.viewId] });
  check(result.status === 'observed', 'Expected an observation');
  check(client.adoptObservation(result.observation.observationId).status === 'adopted', 'Expected adoption');
  return result.observation;
}
function request(observation: Awaited<ReturnType<typeof observe>>, name: string, invocationId: string,
  input: Readonly<Record<string, JsonValue>>) {
  const tool = observation.tools.find(item => item.name === name);
  const binding = observation.bindings.find(item => item.toolId === tool?.id);
  check(binding, 'Expected a visible type binding');
  return { invocationId, observationId: observation.observationId, bindingId: binding.bindingId, input };
}
async function completed(observation: Awaited<ReturnType<typeof observe>>, name: string, id: string,
  input: Readonly<Record<string, JsonValue>>) {
  const result = await client.invoke(request(observation, name, id, input));
  check(result.kind === 'receipt' && result.receipt.outcome.status === 'succeeded', 'Expected business success');
  const value = result.receipt.outcome.value;
  check(value !== null && typeof value === 'object' && 'success' in value && value.success === true && 'data' in value,
    'Expected a ToolResult receipt');
  const data = value.data;
  check(data !== null && typeof data === 'object' && 'completed' in data && data.completed === true && Object.keys(data).length === 1,
    'Receipt contains completion, not the Note text or counter');
}
let beforeClosed = 0;
try {
  const old = await observe();
  await completed(old, 'add', 'add-1', { n: 2 });
  check(count === 3, 'Ordinary dispatch changed business state once');
  publish('new');
  await completed(old, 'read', 'old-ref', { note: 'detail.selected', suffix: '!' });
  const fresh = await observe();
  await completed(fresh, 'read', 'new-ref', { note: 'detail.selected', suffix: '!' });
  check(witness.length === 2 && witness[0]?.text === 'old!' && witness[1]?.text === 'new!' && witness.every(item => item.frozen),
    'Independent witness confirms original frozen values');
  const current = fresh.views[0]?.content;
  check(current?.format === 'markdown-v1' && current.value === 'Counter: 3\nNote: new', 'Current data is presented in the View');

  const oldAdd = fresh.tools.find(tool => tool.name === 'add'); check(oldAdd, 'Observed add');
  const oldKey = bindingKey(oldAdd.id, oldAdd.execution), oldBinding = bindings.get(oldKey);
  releaseAdd(); releaseAdd = register('add', addSchema, add);
  const newAdd = registry.listTools().find(tool => tool.name === 'add'); check(newAdd, 'Replacement add'); installBinding(newAdd);
  const newKey = bindingKey(newAdd.id, newAdd.execution);
  check(newKey !== oldKey && bindings.get(newKey) !== oldBinding, 'New registration has a new activation');
  const stale = await client.invoke(request(fresh, 'add', 'old-binding', { n: 2 }));
  check(stale.kind === 'receipt' && stale.receipt.outcome.status === 'rejected' && handlerEntries === 3, 'Old activation cannot enter or redirect');

  beforeClosed = authorizations;
  authority.close(); await authority.whenClosed();
  check((await client.invoke(request(fresh, 'read', 'closed', { note: 'detail.selected', suffix: '!' }))).kind === 'refused', 'Closed Client rejects');
  check(authorizations === beforeClosed && handlerEntries === 3, 'Closed authority does not authorize or enter handlers');
  check(authority.inspect().observations.observationSlots === 0 &&
    authority.inspect().combinedBytes === 0 && snapshots.store.inspect().activeLeases === 0,
    'Observation slots, logical bytes and leases released');
} finally {
  authority.close(); await authority.whenClosed();
  releaseAdd(); releaseRead(); projection.close(); registry.dispose(); snapshots.lifecycle.dispose();
  bindings.clear(); contracts.clear();
}
check(registry.inspect().bindings === 0 && snapshots.store.inspect().activeLeases === 0, 'Registry and Snapshot cleanup');

const memory = createMemoryStateStorage({ maxStoredKeys: 16, maxStoredBytes: 65536, maxRecordBytes: 16384, maxAddressBytes: 512,
  maxActiveOwners: 2, maxClaimedNamespaces: 4 });
const limits: StateSessionLimits = { maxDepth: 16, maxNodes: 1000, maxValueBytes: 8192, maxRecordBytes: 16384, maxAddressBytes: 512,
  maxKeys: 8, maxRetainedBytes: 65536, maxPendingRequests: 8, maxConcurrentRequests: 2, maxRevision: 1000 };
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
const recovery = await next.binding.recovery; check(recovery.status === 'found' && recovery.value === 41, 'New owner restores persisted value');
check(next.binding.confirmInitialization(recovery, { status: 'ready', value: recovery.value }).status === 'accepted', 'Restored acknowledgment');
check((await restored.dispose()).release.status === 'released' && memory.getStats().activeOwners === 0, 'Final owner release');

export const coreTutorialFacts = { handlerEntries, authorizations: beforeClosed, witness,
  observationSlots: authority.inspect().observations.observationSlots, logicalBytes: authority.inspect().combinedBytes,
  leases: snapshots.store.inspect().activeLeases, bindings: registry.inspect().bindings,
  restoredValue: recovery.value, stateOwners: memory.getStats().activeOwners, storedKeys: memory.getStats().storedKeys };
```
<!-- b1-example:end -->

低层注册 SPI 的 `safeOrdinaryParametersInvocationMode: 'ordinary-v2'` 是既有可信 invoker 工厂字段；执行绑定、参数 profile 和 Host/Worker mode 使用 `view-type-parameters-v1`，不能把前者当作仍支持旧 Worker mode 的依据。

View 与 Ref 仍有实例/原快照来源身份，Tool 只有 App/ViewType activation；关闭最后一个匹配 View或替换注册会拒绝旧 activation。Ref 参数不把 Tool 隐式绑定某个文件。App 检查对象是否仍存在、当前业务权限和父子归属；有业务意义的路径/标题/内容不必包装成 Ref。当前合同同时支持多个顶层对象／对象列表 Ref 和可选 Ref；缺席字段保持缺席，出现的字段必须有效，整个参数与来源 envelope 共享既有预算。Type.Array(refParam(...)) 表达 Ref 名数组，多选按输入顺序解析；重复选择保留，空选择不触发解析。新观察先准备，再由显式 adopt 撤销旧资格；单纯 observe 不会换掉当前观察。

StateSession owner 释放和持久值保留分别验证：第一 owner flush 并释放后，第二 owner 仍恢复 41，再确认最终 owner 归零。关闭必须等真实调用/读取责任结算后再 dispose Registry/Core；不以删除 Map、abort 或返回超时替代真实结束。正式存储与外部资源由具体适配器负责。
