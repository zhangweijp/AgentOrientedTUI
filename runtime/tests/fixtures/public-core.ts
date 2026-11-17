import {
  createSnapshotCore, createViewOwnedTools, createAppInteraction, SemanticProjectionCoordinator,
  compileToolParameters, createStateSession, SNAPSHOT_SCHEMA_VERSION,
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
check(compileToolParameters(addSchema).ok, 'Add Schema');
check(compileToolParameters(readSchema).ok, 'Ref Schema');

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
    authority.inspect().combinedBytes === 0 && snapshots.store.inspect().activeHolds === 0,
    'Observation slots, logical bytes and leases released');
} finally {
  snapshots.lifecycle.stop();
  authority.close(); await authority.whenClosed();
  projection.close(); registry.dispose(); snapshots.lifecycle.dispose();
}
check(registry.inspect().bindings === 0 && snapshots.store.inspect().activeHolds === 0, 'Registry and Snapshot cleanup');

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

export const coreFixtureFacts = { handlerEntries, authorizations: beforeClosed, witness,
  observationSlots: authority.inspect().observations.observationSlots, logicalBytes: authority.inspect().combinedBytes,
  leases: snapshots.store.inspect().activeHolds, bindings: registry.inspect().bindings,
  restoredValue: recovery.value, stateOwners: memory.getStats().activeOwners, storedKeys: memory.getStats().storedKeys };
