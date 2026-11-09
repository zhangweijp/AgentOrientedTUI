// Trusted integration harness. AppKernel is loaded from the exact installed Runtime tar.
// No Runtime object or port is patched. All faults originate in application callbacks.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const parent = pathToFileURL(resolve(process.argv[2], 'package.json')).href;
const load = name => import(import.meta.resolve(name, parent));
const { JSDOM } = await load('jsdom');
const dom = new JSDOM('<body></body>');
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) {
    globalThis[key] = dom.window[key];
}
const { h } = await load('preact');
const { useLayoutEffect } = await load('preact/hooks');
const { default: Type } = await load('typebox');
const { AppTools, View, createTUIApp, defineToolSet, defineViewTypeTool } = await load('@aotui/sdk');
const kernelURL = new URL('./worker-runtime/app-kernel/AppKernel.js', import.meta.resolve('@aotui/runtime', parent));
const { AppKernel } = await import(kernelURL);
const appError = Error('application initial layout failed');
const tools = defineToolSet({ use: defineViewTypeTool({
    name: 'use_card', viewType: 'Card', description: 'Use card', inputSchema: Type.Object({}),
}) });
const entered = [];
function build(id, bad) {
    let cleanupFault = bad;
    function App() {
        useLayoutEffect(() => () => {
            if (cleanupFault) { cleanupFault = false; throw Error('one application cleanup interrupted Preact traversal'); }
        }, []);
        useLayoutEffect(() => { if (bad) throw appError; }, []);
        return h(AppTools, { definition: tools, bindings: { use: {
            execute: () => { entered.push(id); return { success: true, data: { id } }; },
        } } }, h(View, {kind: 'state', id: 'card', type: 'Card' }, 'body-' + id));
    }
    const kernel = new AppKernel(createTUIApp({ app_name: 'cards', component: App }).kernelConfig);
    kernel.setId(id);
    kernel.setAppExecutionInstanceId('instance_' + id);
    const container = document.createElement('div');
    const clock = kernel.getProjectionCoordinator();
    const snapshot = () => ({ ...clock.token(), body: container.textContent,
        views: kernel.getViewOwnedViewInstances().map(view => view.viewInstanceId),
        tools: kernel.getToolDefinitions().map(tool => ({ name: tool.name, activation: tool.execution.activationId })) });
    const notices = [];
    const stop = clock.subscribe(() => notices.push(snapshot()));
    const open = () => kernel.onOpen({ appId: id, desktopId: 'desk' }, container);
    return { kernel, open, snapshot, notices, stop };
}
const bad = build('failed', true), good = build('healthy', false);
async function execute(instance, source = instance.kernel.getToolDefinitions()[0]) {
    if (!source) return null;
    const preflight = instance.kernel.validateBoundTypeTool(source, source.execution);
    const result = await instance.kernel.invokeBoundTypeTool(source, source.execution, {});
    return { preflight: preflight.success, phase: result.phase, id: result.result.data?.id, code: result.result.error?.code };
}
await good.open();
await assert.rejects(bad.open(), err => err === appError);
await Promise.resolve();
const visible = bad.snapshot();
const old = bad.kernel.getToolDefinitions()[0];
const afterRejectedOpen = await execute(bad, old);
const healthyDuringFailure = await execute(good);
// Exercise the separate stock Runtime close barrier explicitly. Standard Worker orchestration
// calls beginShutdown after a rejected open, before returning its APP_OPEN response.
bad.kernel.beginShutdown();
const afterHostBarrier = await execute(bad, old);
await bad.kernel.onClose();
const afterHostClose = bad.snapshot();
const healthyAfterClose = await execute(good);
await good.kernel.onClose();
bad.stop();
good.stop();
const facts = { kernel: kernelURL.href, visible, notices: bad.notices, afterRejectedOpen, afterHostBarrier,
    afterHostClose, healthyDuringFailure, healthyAfterClose, entered };
console.log(JSON.stringify(facts, null, 2));
dom.window.close();
assert.equal(healthyDuringFailure.id, 'healthy');
assert.equal(healthyAfterClose.id, 'healthy');
assert.equal(afterHostBarrier?.phase ?? 'not-entered', 'not-entered');
assert.equal(afterHostClose.tools.length, 0);
assert.equal(afterHostClose.views.length, 0);
assert.ok(!bad.notices.some(notice => notice.ready && notice.tools.length),
    'an actual ready projection notification still contained the failed initialization Tool');
assert.equal(afterRejectedOpen?.phase ?? 'not-entered', 'not-entered');
