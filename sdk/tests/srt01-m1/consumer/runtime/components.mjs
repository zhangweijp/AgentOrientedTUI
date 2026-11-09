import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createViewOwnedTools } from '@aotui/runtime/core';
import { createAppId, createDesktopId } from '@aotui/runtime/spi';
const dom = new JSDOM('<!doctype html><body></body>');
for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Event']) globalThis[key] = dom.window[key];
const { act } = await import('preact/test-utils');
const fixture = await import('../results/runtime-build/types/jsx-runtime.js');
const registry = createViewOwnedTools('jsx_fixture', 'jsx_run');
let depth = 0, begins = 0, ends = 0, epoch = 0, owner;
const projection = {
  beginCommit() { begins++; depth++; }, endCommit() { ends++; assert.ok(depth > 0); depth--; },
  recordMutation() { return ++epoch; }, token() { return { epoch, ready: depth === 0 }; }, subscribe() { return () => {}; },
};
const context = {
  appId: createAppId('jsx_fixture'), desktopId: createDesktopId('jsx_desktop'), projection, markDirty() {},
  refExporter: { registerRef() { throw new Error('No Ref is published by this ordinary fixture'); } },
  appLifecycle: { protocol: 'app-lifecycle-v2', register(callbacks) {
    assert.equal(owner, undefined, 'the App remains the sole business lifecycle owner'); owner = callbacks;
    return () => { owner.stop?.(); owner.close?.(); };
  } },
  appTypeTools: registry,
  viewTools: { mount(id, type) { return registry.mount(id, type).viewInstanceId; }, unmount(id) { registry.unmount(id); }, },
};
const container = document.createElement('div'); document.body.appendChild(container);
let renderer;
await act(async () => { renderer = await fixture.factory.initializeComponent(container, context); });
const catalog = container.querySelector('[data-role="tool-catalog"]').outerHTML;
assert.equal(fixture.facts().renders, 1, 'first ToolRef needs no effect-driven extra render');
assert.equal(container.querySelectorAll('tool-ref').length, 2); assert.equal(registry.listTools().length, 2);
const initial = registry.listTools().find(tool => tool.name === 'read_file');
const invoke = tool => registry.invokeTypeTool(tool, tool.execution, { filePath: 'a.txt' });
assert.equal((await invoke(initial)).result.data.label, 'initial');
await act(async () => fixture.change({ label: 'updated', enabled: true, count: 3 }));
const updated = registry.listTools().find(tool => tool.name === 'read_file');
assert.equal(updated.execution.activationId, initial.execution.activationId); assert.equal((await invoke(initial)).result.data.label, 'updated');
assert.equal(registry.listTools().length, 2); assert.equal(container.querySelectorAll('tool-ref').length, 3);
await act(async () => fixture.change({ label: 'disabled', enabled: false, count: 1 }));
assert.equal(container.querySelectorAll('tool-ref').length, 0); assert.equal((await invoke(initial)).phase, 'not-entered');
await act(async () => fixture.change({ label: 'reenabled', enabled: true, count: 1 }));
const latest = registry.listTools().find(tool => tool.name === 'read_file');
assert.notEqual(latest.execution.activationId, initial.execution.activationId); assert.equal((await invoke(initial)).phase, 'not-entered');
assert.equal((await invoke(latest)).result.data.label, 'reenabled');
assert.equal(container.querySelector('[data-role="tool-catalog"]').outerHTML, catalog);
await act(async () => renderer.unmount());
assert.equal(depth, 0); assert.equal(begins, ends); assert.equal(registry.inspect().bindings, 0); assert.equal(registry.inspect().views, 0);
assert.throws(() => renderer.render(), error => error.code === 'APP_RENDERER_CLOSED'); renderer.unmount();
registry.dispose(); assert.equal(registry.inspect().retainedBytes, 0);
assert.deepEqual({ stops: fixture.facts().stops, closes: fixture.facts().closes }, { stops: 1, closes: 1 });
const facts = { status: 'passed', firstRenderCount: 1, sharedTools: 2, handlerIdentityPreserved: true,
  staleRejected: true, catalogStable: true, businessLifecycle: fixture.facts(), projection: { depth, begins, ends }, resources: registry.inspect() };
await mkdir(new URL('../results/', import.meta.url), { recursive: true });
await writeFile(new URL('../results/components-facts.json', import.meta.url), JSON.stringify(facts, null, 2) + '\n');
console.log(JSON.stringify(facts)); dom.window.close();
