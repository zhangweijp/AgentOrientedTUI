import { VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/runtime/spi';
// Trusted Producer test wiring. The App controller itself imports only public SDK/SPI APIs.
import {
  createSnapshotCore, createViewOwnedTools, createScopedInteraction,
  type ExecutionBinding, type JsonValue, type OrdinaryParameterContract,
  type Observation, type ObservationGrant,
} from '@aotui/runtime/core';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
import { createFileController, type OpenedFiles } from './file-controller.js';

function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const appId = 'plain_files', instanceId = 'plain_run';
const snapshots = createSnapshotCore({ now: () => 0 });
snapshots.lifecycle.startApp(appId, instanceId);
const registry = createViewOwnedTools(appId, instanceId);
const contracts = new Map<string, OrdinaryParameterContract>();
const bindings = new Map<string, ExecutionBinding>();
const views = new Map<string, ReturnType<typeof registry.mount>>();
const key = (id: string, execution: unknown) => JSON.stringify([id, execution]);
const port: IAppTypeToolPort = {
  protocol: VIEW_TYPE_TOOL_PROTOCOL,
  registerTypeTool: (definition, options) => registry.registerTypeTool(definition, {
    ...options,
    createSafeOrdinaryParametersInvoker: contract => {
      contracts.set(definition.viewType + ':' + definition.name, contract);
      return options.createSafeOrdinaryParametersInvoker(contract);
    },
  }),
};
let seq = 0;
function publish(opened: OpenedFiles) {
  const pages = [
    { id: 'root', type: 'Root', kind: 'instruction' as const, content: 'Open a.txt or b.txt from Workspace; read FileDetail after editing.' },
    { id: 'workspace', type: 'Workspace', kind: 'state' as const, content: 'Available paths: a.txt, b.txt.' },
    ...Object.entries(opened).map(([path, file]) => ({ id: file.viewId, type: 'FileDetail', kind: 'state' as const,
      content: `filePath: ${path}\n${file.content}` })),
  ];
  for (const [id, view] of views) if (!pages.some(page => page.id === id)) {
    registry.unmount(view.viewInstanceId); views.delete(id);
  }
  for (const page of pages) if (!views.has(page.id)) views.set(page.id, registry.mount(page.id, page.type));
  const tools = registry.listTools();
  for (const tool of tools) if (!bindings.has(key(tool.id, tool.execution))) {
    const contract = contracts.get(tool.viewType + ':' + tool.name); check(contract, 'Compiled registration contract');
    bindings.set(key(tool.id, tool.execution), {
      identity: {}, mode: 'view-type-parameters-v1',
      validateInput: (_source, input) => {
        const checked = contract.validate(input);
        return checked.ok ? { ok: true, value: checked.value as Readonly<Record<string, JsonValue>> } : { ok: false };
      },
      isLive: source => ({ ok: registry.validateTypeToolBinding(source.tool, source.execution).success }),
      execute: async context => {
        const terminal = await registry.invokeTypeTool(context.source.tool, context.source.execution, context.effectiveInput);
        if (terminal.result.success) {
          check(typeof terminal.result.data?.message === 'string', 'Concise message receipt');
          return { kind: 'tool-result', phase: terminal.phase, result: { success: true, data: { message: terminal.result.data.message } } };
        }
        check(terminal.result.error, 'Explicit failure reason');
        return { kind: 'tool-result', phase: terminal.phase, result: { success: false,
          error: { code: terminal.result.error.code, message: terminal.result.error.message } },
          ...(terminal.phase === 'entered-returned' && terminal.failureEffects !== undefined ? { failureEffects: terminal.failureEffects } : {}) };
      },
    });
  }
  const accepted = snapshots.committer.accept({ schemaVersion: 3, appId, instanceId,
    producerSeq: ++seq, sourceEpoch: seq, capturedAt: 0,
    views: pages.map(page => ({ id: page.id, viewInstanceId: views.get(page.id)!.viewInstanceId,
      type: page.type, kind: page.kind, name: page.id, content: { format: 'markdown-v1', value: page.content } })),
    refs: {}, tools: Object.fromEntries(tools.map(tool => [tool.id, tool])),
  });
  check(accepted.status === 'published', 'Published business state and current Tool bindings');
}
const app = createFileController(port, publish);
const authority = createScopedInteraction(snapshots.store, { namespace: 'plain:plain_run', now: () => 0 });
const scope = authority.createScope({ appId, instanceId, policy: {
  project: ({ source }): ObservationGrant => ({
    views: source.views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })), refs: [],
    toolBindings: Object.values(source.tools).map(tool => ({ toolId: tool.id, execution: tool.execution })),
    content: source.views.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
  }), authorize: () => true, canReadReceipt: () => true,
}, execution: { resolve: source => bindings.get(key(source.tool.id, source.execution)) ?? null } });
check(scope.status === 'opened', 'Open Scope');
const client = scope.client;
let calls = 0;
async function observe() {
  const result = await client.observe({ viewIds: [...views.keys()] }); check(result.status === 'observed', 'Observe current pages');
  check(client.adoptObservation(result.observation.observationId).status === 'adopted', 'Adopt current state');
  return result.observation;
}
async function call(observation: Observation, name: string, input: Readonly<Record<string, JsonValue>>) {
  const tool = observation.tools.find(tool => tool.name === name);
  const binding = observation.bindings.find(binding => binding.toolId === tool?.id); check(binding, 'Visible Tool binding');
  const result = await client.invoke({ invocationId: 'plain-' + ++calls, observationId: observation.observationId, bindingId: binding.bindingId, input });
  check(result.kind === 'receipt', 'A receipt'); return result.receipt.outcome;
}
try {
  let observation = await observe(); check(!observation.tools.some(tool => tool.name === 'edit_file'), 'No edit before opening');
  check((await call(observation, 'open_file', { filePath: 'a.txt' })).status === 'succeeded', 'Open file');
  observation = await observe(); check(observation.tools.filter(tool => tool.name === 'edit_file').length === 1, 'One shared edit declaration');
  const edited = await call(observation, 'edit_file', { filePath: 'a.txt', content: 'PLAIN_UPDATED' });
  check(edited.status === 'succeeded' && !JSON.stringify(edited).includes('PLAIN_UPDATED'), 'Receipt does not duplicate content');
  observation = await observe(); check(observation.views.some(view => view.content?.format === 'markdown-v1' && typeof view.content.value === 'string' && view.content.value.includes('PLAIN_UPDATED')), 'Observe updated business data');
  const old = observation;
  check((await call(observation, 'close_file', { filePath: 'a.txt' })).status === 'succeeded', 'Close file');
  check((await call(old, 'edit_file', { filePath: 'a.txt', content: 'STALE' })).status === 'rejected', 'Old binding cannot enter');
  observation = await observe(); check(!observation.tools.some(tool => tool.name === 'edit_file') && observation.views.length === 2, 'Only Root and Workspace remain');
} finally {
  client.close();
  check(authority.inspect().scopes === 0 && snapshots.store.inspect().activeLeases === 0, 'Local Scope cleanup before global shutdown');
  authority.close(); await authority.whenClosed(); app.dispose(); registry.dispose(); snapshots.lifecycle.dispose();
  bindings.clear(); contracts.clear(); views.clear();
}
check(authority.inspect().combinedBytes === 0 && registry.inspect().bindings === 0, 'Final framework resources released');
export const ordinaryFacts = { calls, scopes: authority.inspect().scopes, leases: snapshots.store.inspect().activeLeases,
  logicalBytes: authority.inspect().combinedBytes, bindings: registry.inspect().bindings };
