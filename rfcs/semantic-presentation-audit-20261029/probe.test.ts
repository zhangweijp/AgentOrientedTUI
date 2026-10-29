/** Investigation probes: passing means the reported current behavior was reproduced, not accepted. */
import { afterEach, expect, it } from 'vitest';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { createTUIApp } from '../../sdk/src/app-factory/createTUIApp.js';
import { View } from '../../sdk/src/components/View.js';
import { useViewTypeTool } from '../../sdk/src/hooks/useViewTypeTool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createViewFragmentExtractor } from '../../runtime/src/worker-runtime/view-fragment-extractor.js';
import { DomSnapshotShadowProducer } from '../../runtime/src/worker-runtime/dom-snapshot-producer.js';
import { SemanticAOTUIDrivenSource } from '../../runtime/src/adapters/semantic-aotui-driven-source.js';
import { AOTUIDrivenSource } from '../../runtime/src/adapters/aotui-driven-source.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function mount(enabled = true, readOnly = false) {
  function Content() {
    const [Tool] = useViewTypeTool(readOnly ? 'read_status' : 'search_files_by_pattern', {
      description: 'Audit operation', isMutating: !readOnly,
      params: readOnly ? {} : { pattern: { type: 'string', required: true } },
    }, async () => ({ success: true }), { enabled });
    return h('section', {}, h('h2', {}, 'Workspace'), h(Tool, {}));
  }
  const factory = createTUIApp({ app_name: 'system_ide', component: () => h('div', {},
    h(View, { id: 'root', type: 'Root', name: 'IDE' },
      h('section', { 'data-role': 'application-instruction' }, h('p', {}, 'Application help.'))),
    h(View, { id: 'workspace', type: 'Workspace', name: 'Workspace' }, h(Content, {})),
  ) });
  const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
  kernel.setId('app_0' as any); kernel.setAppExecutionInstanceId('audit-instance');
  const container = document.createElement('div'); document.body.appendChild(container);
  cleanup.push(async () => { await act(async () => { await kernel.onClose(); }); container.remove(); });
  await act(async () => { await kernel.onOpen({ appId: 'app_0' as any, desktopId: 'audit' as any,
    markDirty() {}, onRender() {} }, container); });
  const fragments = createViewFragmentExtractor()(container, 'app_0' as any, 100);
  const draft = new DomSnapshotShadowProducer().captureV2({ appId: 'app_0', instanceId: 'audit-instance',
    sourceEpoch: 1, producerSeq: 1, capturedAt: 100, container, fragments, kernel });
  return { container, kernel, fragments, draft };
}

function adapter(draft: Awaited<ReturnType<typeof mount>>['draft']) {
  let revision = 1;
  const calls: any[] = [];
  const app = { appId: 'app_0', name: 'system_ide', status: 'running' };
  const desktop: any = { id: 'audit', getInstalledApps: () => [app],
    openApp: async () => {}, closeApp: async () => {}, collapseApp: async () => {}, showApp: async () => {},
    output: { subscribe() {}, unsubscribe() {} } };
  const client = {
    observe: async () => ({ status: 'observed', observation: {
      observationId: 'observation-' + revision, expiresAt: null,
      source: { appId: draft.appId, instanceId: draft.instanceId, snapshotId: 'snapshot-' + revision, revision },
      views: draft.views, refs: [], tools: Object.values(draft.tools),
      bindings: Object.values(draft.tools).flatMap(tool => tool.targets.map(target => ({
        bindingId: 'binding-' + revision, toolId: tool.id, target,
      }))),
    } }),
    invoke: async (request: any) => {
      calls.push(request);
      return { kind: 'receipt', receipt: { ...request, source: null, completedAt: 1, expiresAt: 2,
        executionPhase: 'entered-returned', outcome: { status: 'succeeded', value: null } } };
    },
    releaseObservation() {}, close() {},
  };
  const source = new SemanticAOTUIDrivenSource(desktop, {
    experimentalCreateAppScope: () => ({ status: 'opened', client }),
  } as any);
  cleanup.push(() => source.dispose());
  return { source, desktop, calls, next: () => { revision++; } };
}

it('reproduces a disabled Tool label remaining in DOM while the actual registry is empty', async () => {
  const { container, kernel } = await mount(false);
  expect(kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
  expect(container.querySelector('tool-ref')?.textContent).toBe('search_files_by_pattern');
});

it('reproduces an enabled zero-parameter read-only Tool being registered without its requested UI label', async () => {
  const { container, kernel } = await mount(true, true);
  expect(kernel.getViewOwnedToolDefinitions()).toHaveLength(1);
  expect(container.querySelector('tool-ref')).toBeNull();
  expect(container.textContent).not.toContain('read_status');
});

it('reproduces double View wrapping using actual SDK DOM, extractor and Producer; the old formatter wraps once', async () => {
  const { draft, fragments } = await mount();
  const fixture = adapter(draft), current = await fixture.source.getContext();
  const currentView = current.messages.find(message => String(message.content).startsWith('<view ') && String(message.content).includes('id="workspace"'))!;
  const fragment = fragments.find(view => view.viewId === 'workspace')!;
  expect((fragment.markup.match(/<view\b/g) || []).length).toBe(1);
  expect((String(currentView.content).match(/<view\b/g) || []).length).toBe(2);
  const legacy = new AOTUIDrivenSource(fixture.desktop, {
    acquireSnapshot: async () => ({ id: 'legacy', createdAt: 100, structured: { appStates: [],
      viewStates: [{ appId: 'app_0', appName: 'system_ide', ...fragment }] } }),
    releaseSnapshot() {},
  } as any, { includeInstruction: false });
  const oldView = (await legacy.getMessages())[0];
  expect((String(oldView.content).match(/<view\b/g) || []).length).toBe(1);
});

it('reproduces the logged hashed name; two contexts retain different private bindings despite the same public name', async () => {
  const { draft } = await mount(), fixture = adapter(draft);
  const first = await fixture.source.getContext(); fixture.next();
  const second = await fixture.source.getContext();
  const name = 'aotui_system__workspa_search_files_by_pattern_c34610fed1';
  expect(first.tools[name]).toBeDefined(); expect(second.tools[name]).toBeDefined();
  await first.executeTool!(name, { pattern: '*.txt' }, 'first');
  await second.executeTool!(name, { pattern: '*.txt' }, 'second');
  expect(fixture.calls.map(call => [call.observationId, call.bindingId])).toEqual([
    ['observation-1', 'binding-1'], ['observation-2', 'binding-2'],
  ]);
});

it('reproduces instruction Views becoming dynamic and unchanged View text changing with the App revision', async () => {
  const { draft } = await mount(), fixture = adapter(draft);
  expect(draft.views.find(view => view.id === 'root')!.kind).toBe('instruction');
  const first = await fixture.source.getContext(); fixture.next();
  const second = await fixture.source.getContext();
  const root = (context: typeof first) => context.messages.find(message => String(message.content).startsWith('<view ') && String(message.content).includes('id="root"'))!;
  expect(root(first).region).toBe('dynamic');
  expect(root(first).content).not.toBe(root(second).content);
  expect(root(first).content).toContain('Application help.');
  expect(root(second).content).toContain('Application help.');
  expect(root(first).content).toContain('instance="');
});
