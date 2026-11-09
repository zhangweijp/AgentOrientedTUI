import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const parent = pathToFileURL(resolve(process.argv[2], 'package.json')).href;
const load = specifier => import(import.meta.resolve(specifier, parent));
const { JSDOM } = await load('jsdom');
const dom = new JSDOM('<!doctype html><body></body>');
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) {
    globalThis[key] = dom.window[key];
}
const { h } = await load('preact');
const { default: Type } = await load('typebox');
const { AppTools, createTUIApp, View, defineViewTypeTool, defineToolSet } = await load('@aotui/sdk');
const { createViewOwnedTools } = await load('@aotui/runtime/core');
const { createAppId, createDesktopId } = await load('@aotui/runtime/spi');
const registry = createViewOwnedTools('owner_probe', 'owner_probe_run');
const set = defineToolSet({ read: defineViewTypeTool({ name: 'read', viewType: 'Card', description: 'Read card', inputSchema: Type.Object({}) }) });
const projectionFault = process.argv.includes('--projection');
let refuseOnce = !projectionFault, breakEnd = false, begins = 0, ends = 0;
const context = {
    appId: createAppId('owner_probe'), desktopId: createDesktopId('owner_test'),
    projection: { beginCommit() { begins++; }, endCommit() {
        ends++;
        if (breakEnd && begins === ends) { breakEnd = false; throw Error('injected endCommit failure after DOM detachment'); }
    }, recordMutation() {}, token() { return { epoch: 1, ready: begins === ends }; }, subscribe() { return () => {}; } },
    markDirty() {}, refExporter: { registerRef() { throw Error('Unexpected Ref'); } },
    appLifecycle: { protocol: 'app-lifecycle-v2', register() { return () => {}; } },
    appTypeTools: { protocol: 'view-type-tools-v1', registerTypeTool(definition, options) {
        const release = registry.registerTypeTool(definition, options);
        return () => { if (refuseOnce) { refuseOnce = false; throw Error('injected first release failure'); } release(); };
    } },
    viewTools: { mount(id, type) { return registry.mount(id, type).viewInstanceId; }, unmount(id) { registry.unmount(id); } },
};
const factory = label => createTUIApp({ app_name: 'owner_probe', component: () =>
    h(AppTools, { definition: set, bindings: { read: { execute: () => ({ success: true, data: { label } }) } } },
        h(View, {kind: 'state', id: label, type: 'Card' }, h('p', {}, label)))
});
const container = document.createElement('main');
document.body.appendChild(container);
const state = () => ({ text: container.textContent, bindings: registry.inspect().bindings, views: registry.inspect().views });
async function invoke(tool) {
    const result = await registry.invokeTypeTool(tool, tool.execution, {});
    return { phase: result.phase, success: result.result.success, label: result.result.data?.label };
}
const first = await factory('first').initializeComponent(container, context);
const initial = state();
breakEnd = projectionFault;
let firstError;
try { first.unmount(); } catch (error) { firstError = error.code ?? error.message; }
assert.equal(firstError, projectionFault ? 'injected endCommit failure after DOM detachment' : 'TOOL_BINDING_CLEANUP_FAILED');
const afterFailure = state();
console.log(JSON.stringify({ firstError, initial, afterFailure, begins, ends }));
if (process.argv.includes('--retry-before-next')) {
    first.unmount();
    console.log(JSON.stringify({ afterRetry: state(), begins, ends }));
}
const second = await factory('second').initializeComponent(container, context);
const secondTool = registry.listTools()[0];
assert.ok(secondTool);
const next = { ...state(), invocation: await invoke(secondTool) };
assert.equal(next.invocation.label, 'second');
first.unmount();
const afterStaleRetry = { ...state(), invocation: await invoke(secondTool) };
second.unmount();
registry.dispose();
dom.window.close();
console.log(JSON.stringify({ sdk: import.meta.resolve('@aotui/sdk', parent), firstError, initial, afterFailure, next, afterStaleRetry, begins, ends, final: registry.inspect() }, null, 2));
assert.equal(afterStaleRetry.text, next.text, 'a retry by the former renderer removed the successor DOM');
assert.equal(afterStaleRetry.bindings, next.bindings, 'a retry by the former renderer revoked the successor binding');
assert.equal(afterStaleRetry.invocation.label, 'second', 'successor invocation was revoked');
assert.equal(begins, ends);
