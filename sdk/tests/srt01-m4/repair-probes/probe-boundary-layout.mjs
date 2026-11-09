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
const { Component } = await load('preact');
const { useState, useLayoutEffect } = await load('preact/hooks');
const { act } = await load('preact/test-utils');
refuseOnce = false;
let update, observed, callInLayout, caught = false;
const entered = [], order = [];
class Boundary extends Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { caught = true; order.push('caught'); }
    render() { return this.state.failed ? h('p', {}, 'fallback') : this.props.children; }
}
function Child({ bad }) {
    if (bad) { order.push('render throws'); throw Error('injected child failure'); }
    return h(View, {kind: 'state', id: 'card', type: 'Card' }, h('p', {}, 'committed card'));
}
function App() {
    const [bad, set] = useState(false); update = () => set(true);
    useLayoutEffect(() => {
        if (bad) {
            order.push('parent layout, caught=' + caught + ', registry=' + registry.listTools().length);
            callInLayout = registry.invokeTypeTool(observed, observed.execution, {});
        }
    }, [bad]);
    return h(Boundary, {}, h(AppTools, { definition: setDef, bindings: { read: { execute: () => {
        const label = bad ? 'candidate' : 'committed'; entered.push(label); order.push('entered ' + label); return { success: true, data: { label } };
    } } } }, h(Child, { bad })));
}
const setDef = set;
const factory = createTUIApp({ app_name: 'owner_probe', component: App });
const container = document.createElement('main');
const renderer = await factory.initializeComponent(container, context);
observed = registry.listTools()[0];
await act(async () => update());
const result = await callInLayout;
console.log(JSON.stringify({ order, entered, result, after: registry.inspect(), text: container.textContent, begins, ends }, null, 2));
renderer.unmount(); registry.dispose(); dom.window.close();
assert.ok(!entered.includes('candidate'), 'the candidate handler from a failed child render ran');
