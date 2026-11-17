# 从正式包入口使用纯 Core

`@aotui/runtime/core` 提供 V5 Snapshot、App/ViewType Tool、App 实例交互与 Observation、参数合同与 StateSession；`@aotui/runtime/adapters/memory-state-storage` 提供内存存储。Core 不加载 DOM、Worker、Node 或模型 SDK。业务规则和外部副作用仍由 App/Host 负责。

本例面向自建 Host／Producer 的低层装配者，只使用 Runtime 的纯 Core 与内存存储入口。普通 App 作者可从 `@aotui/sdk` 包内 `docs/app-authoring.md` 开始。Agent Driver 用户通过独立 `@aotui/agent-driver-adapter` 接入。安装时使用同次交付记录的版本与 tar。[本地交付说明](sdk-runtime-distribution.md#current-delivery)

B02 起，直接使用 `InstanceInteraction` 的 Core 集成者用 `inspect()` 替代 `sweepExpired()`。`inspect()` 仍会处理到期记录，自动回收仍由实例维护。

V5 Snapshot 的 `ToolDescriptorV5` 要求布尔字段 `nameSharedAcrossViewTypes`。`createViewOwnedTools().defineTools()` 从完整注册声明计算该值。直接构造草稿的 Producer 也按 App 的完整声明计算，同类型多个实例共用一份定义。

每次 App 运行都通过 `createSnapshotCore({ appId, instanceId })` 创建一个 Core，构造时绑定身份并进入 `unready`。运行结束时调用 `lifecycle.stop()` 停止新发布与观察，等在途调用和授权回调结算后再调用 `lifecycle.dispose()`。同名 App 再次启动时，由 Host 分配新的 `instanceId` 并创建新的 Core。 [生命周期与保留额度](core-lifetime-and-bounds.md)

<a id="snapshot-limits"></a>
## Snapshot 限额

`createSnapshotCore({ appId, instanceId, limits })` 在构造时固定有效配置。`limits` 可省略或设为 `undefined`。提供时须是 `options` 自有可枚举的数据属性，值为普通对象或 null-prototype 对象。对象只接受下表的自有可枚举数据字段。省略或设为 `undefined` 的字段采用默认值。每个覆盖值是从 0 到默认值的安全整数，形状错误抛 `TypeError`，值超出范围或类型错误抛 `RangeError`。限额确定后，调用方可继续修改自己的对象。

| 字段 | 默认值及硬上限 | 计量对象 |
| --- | ---: | --- |
| `maxDepth` | 48 | JSON 值深度，根为 0 |
| `maxNodes` | 100,000 | 容器和每个子值，属性键不计节点 |
| `maxSnapshotBytes` | 4 MiB | 完整 prepared draft，含 producer envelope，Store 之后生成 id 和 revision |
| `maxViews` | 1,000 | View 条目数 |
| `maxRefs` | 10,000 | Ref 条目数 |
| `maxTools` | 1,000 | Tool 条目数 |
| `maxViewContentBytes` | 512 KiB | `content.value`，包含 Markdown 的 JSON 引号与转义 |
| `maxRefPayloadBytes` | 512 KiB | 单个 Ref payload |
| `maxToolSchemaBytes` | 64 KiB | 完整 normalized Tool profile，含内部参数合同标记 |

表中的字节限额使用 canonical JSON UTF-8，KiB 和 MiB 分别为 1,024 和 1,048,576 字节。复制时的近似成本另有限制。若旧 Host 依靠修改配置改变已有 Core 的限额，需要在创建 Core 前选定限额。原先高于默认值的覆盖须改为允许的范围。

`compileOrdinarySchema` 和 `compileValueSchema` 的失败码包括 `PARAMETER_DECLARATION_INVALID`、`PARAMETER_DECLARATION_UNSUPPORTED` 和 `PARAMETER_DECLARATION_CAPACITY`。对 `OrdinaryCompileResult` 做穷尽判断时须处理容量分支。完整 Tool profile 超限时，`ordinaryParameterProfile` 抛 `SnapshotDataError`，其 code 为 `TOOL_SCHEMA_CAPACITY`，`compileOrdinaryProfile` 返回 `null`。Ref 自有的值 Schema 单独校验。

## 完整 Core 示例

两个 Tool 都声明一次到 `Note` ViewType，统一使用正式 `view-type-parameters-v1` profile。`add` 接收普通数值；`read` 接收一个必填 Note 对象 Ref。Note 是本例的内存业务数据，不是文件定位。下面的 JSON 注解与 SDK TypeBox `refParam` 对应，低层装配者不另造 Ref parser。Core 从原观察解析参数，授权与执行使用同一 effectiveInput。

纯 Core 装配通过 `SemanticProjectionCoordinator.commit` 的同步回调交出完整 View、Ref 和 Tool。先由 `prepareFrame` 生成候选实例和绑定，再交给协调器在整帧验证通过后调用 `accept`。框架管理发布版本，观察读取已接受的结果。正文通过 View 呈现，Tool 返回完成收据。示例分别验证旧观测和新观测读到的冻结 Ref 值。包消费者提取 b1 标记里的示例，以 ES2022-only 和 `types: []` 严格编译并执行。

<!-- b1-example:start -->
```ts
import {
  createSnapshotCore, createViewOwnedTools, createAppInteraction, SemanticProjectionCoordinator,
  compileOrdinarySchema, createStateSession, SNAPSHOT_SCHEMA_VERSION,
  type ExecutionBinding, type ExecutionFact, type JsonValue, type ToolResult,
  type StateSessionLimits, type ObservationGrant,
} from '@aotui/runtime/core';
import { createMemoryStateStorage } from '@aotui/runtime/adapters/memory-state-storage';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const appId = 'notes', instanceId = 'tutorial-run-1';
const snapshots = createSnapshotCore({ appId, instanceId, now: () => 0 });
const previewLimits = { maxViews: 0 };
const previewInstanceId = 'tutorial-preview-1';
const preview = createSnapshotCore({ appId, instanceId: previewInstanceId, limits: previewLimits });
previewLimits.maxViews = 1;
const registry = createViewOwnedTools(appId, instanceId);
const owner = {};
const view = { viewId: 'detail', viewType: 'Note' };

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
check(compileOrdinarySchema(addSchema).ok, 'Add Schema');
check(compileOrdinarySchema(readSchema).ok, 'Ref Schema');

let count = 1, noteText = 'old', handlerEntries = 0, addEnabled = true;
const projection = new SemanticProjectionCoordinator({ identity: () => ({ appId, instanceId }) });
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
registry.defineTools([
  { viewType: 'Note', name: 'add', description: 'Add to the counter', inputSchema: addSchema },
  { viewType: 'Note', name: 'read', description: 'Inspect a displayed Note', inputSchema: readSchema },
]);
const binding: ExecutionBinding = {
  identity: {},
  validateInput: (_source, value) => ({ ok: true, value }),
  isLive: source => ({ ok: registry.validateTypeToolBinding(source.tool, source.receiver).success }),
  execute: async context => {
    const terminal = await registry.invokeTypeTool(context.source.tool, context.source.receiver, context.effectiveInput);
    if (terminal.result.success) check(terminal.result.data?.completed === true, 'Expected a concise completion receipt');
    return { kind: 'tool-result', ...terminal } satisfies ExecutionFact;
  },
};
function publish(text: string) {
  const prepared = projection.commit(() => {
    noteText = text;
    const candidate = registry.prepareFrame([{ id: view.viewId, type: view.viewType, owner, bindings: [
      { name: 'add', enabled: addEnabled, execute: add },
      { name: 'read', enabled: true, execute: read },
    ] }]);
    const published = candidate.instances[0]; check(published, 'Expected the Note View');
    const { viewInstanceId, toolBindings } = published;
    return {
      views: [{ id: view.viewId, viewInstanceId, type: view.viewType, name: 'Note', kind: 'state',
        content: { format: 'markdown-v1', value: `Counter: ${count}\nNote: ${noteText}` }, toolBindings }],
      refs: [{ viewId: view.viewId, viewInstanceId, id: 'selected', refType: 'Note', value: { text } }],
      tools: candidate.tools, accept: candidate.accept,
    };
  });
  check(prepared.status === 'prepared', 'Expected a complete View, Ref and Tool frame');
  const result = projection.publishTo(snapshots.committer);
  check(result.status === 'published', 'Expected a new source version');
}
publish('old');
const sample = snapshots.store.readLatest(appId);
check(sample.status === 'ready', 'Expected a published Note');
try {
  const { views, refs, tools } = sample.snapshot;
  const result = preview.committer.accept({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, appId, instanceId: previewInstanceId,
    producerSeq: 1, sourceEpoch: 1, capturedAt: 0, views, refs, tools });
  check(result.status === 'rejected' && result.issue.path === '$.views', 'The Core retained maxViews: 0');
} finally { preview.lifecycle.dispose(); }

let authorizations = 0;
const authority = createAppInteraction(snapshots.store, { namespace: 'tutorial:tutorial-run-1', now: () => 0, appId, instanceId, policy: {
  project: ({ source }): ObservationGrant => ({
    refs: Object.values(source.refs).map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
    toolIds: Object.keys(source.tools),
  }),
  authorize: () => { authorizations++; return true; }, canReadReceipt: () => true,
}, execution: { resolve: () => binding } });
const client = authority;
async function observe() {
  const result = await client.observe({ all: true });
  check(result.status === 'observed', 'Expected an observation');
  check(client.adoptObservation(result.observation.observationId).status === 'adopted', 'Expected adoption');
  return result.observation;
}
function request(observation: Awaited<ReturnType<typeof observe>>, name: string, invocationId: string,
  input: Readonly<Record<string, JsonValue>>) {
  const tool = observation.tools.find(item => item.name === name);
  check(tool, 'Expected an observed Tool');
  return { invocationId, observationId: observation.observationId, toolId: tool.id, input: { view_id: view.viewId, ...input } };
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
  const prior = await client.readReceipt({ observationId: old.observationId, invocationId: 'add-1' });
  check(prior.kind === 'receipt' && prior.receipt.outcome.status === 'succeeded' && count === 3,
    'Reading the original receipt after adoption preserves the counter');

  addEnabled = false; publish(noteText);
  addEnabled = true; publish(noteText);
  const stale = await client.invoke(request(fresh, 'add', 'old-binding', { n: 2 }));
  check(stale.kind === 'receipt' && stale.receipt.outcome.status === 'rejected' && handlerEntries === 3, 'Old activation cannot enter or redirect');

  beforeClosed = authorizations;
  snapshots.lifecycle.stop();
  authority.close(); await authority.whenClosed();
  check((await client.invoke(request(fresh, 'read', 'closed', { note: 'detail.selected', suffix: '!' }))).kind === 'refused', 'Closed Client rejects');
  check(authorizations === beforeClosed && handlerEntries === 3, 'Closed authority does not authorize or enter handlers');
  check(authority.inspect().observations.observationSlots === 0 &&
    authority.inspect().combinedBytes === 0 && snapshots.store.inspect().activeLeases === 0,
    'Observation slots, logical bytes and leases released');
} finally {
  snapshots.lifecycle.stop();
  authority.close(); await authority.whenClosed();
  projection.close(); registry.dispose(); snapshots.lifecycle.dispose();
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

`defineTools` 注册共享业务参数合同。`prepareFrame` 准备每页当前绑定，投影校验通过后调用 `accept`。Core 与 Worker 共用 `view-type-parameters-v1` 参数 profile。`ExecutionBinding` 可以拒绝输入，接受时返回等值参数。

调用先定位原观察中的工具和 `view_id`，再检查该页面挂载和 activation。Ref 参数独立选择原观察中的数据来源。页面关闭、替换或禁用工具会撤销相应资格。App 检查业务对象是否仍然有效。新的观察在明确采用后替换当前观察；诊断预览独立运行。

StateSession owner 释放和持久值保留分别验证：第一 owner flush 并释放后，第二 owner 仍恢复 41，再确认最终 owner 归零。关闭必须等真实调用/读取责任结算后再 dispose Registry/Core；不以删除 Map、abort 或返回超时替代真实结束。正式存储与外部资源由具体适配器负责。
