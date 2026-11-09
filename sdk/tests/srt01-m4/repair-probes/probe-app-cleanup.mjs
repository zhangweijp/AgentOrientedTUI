// Run with Node 23 --experimental-import-meta-resolve and a tar-installed consumer.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [consumer, scenario] = process.argv.slice(2);
assert.ok(['init', 'close', 'reenter-close'].includes(scenario));
const oldDisabled = process.argv.includes('--old-disabled');
const parent = pathToFileURL(resolve(consumer, 'package.json')).href;
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
const { createViewOwnedTools } = await load('@aotui/runtime/core');
const { createAppId, createDesktopId } = await load('@aotui/runtime/spi');
const tools = defineToolSet({
    use: defineViewTypeTool({ name: 'use_card', viewType: 'Card', description: 'Use card', inputSchema: Type.Object({}) }),
});
let serial = 0;
function host() {
    const registry = createViewOwnedTools('cards', 'instance_' + ++serial);
    let epoch = 0, depth = 0, begins = 0, ends = 0;
    const projection = {
        beginCommit() { begins++; depth++; },
        endCommit() { ends++; assert.ok(depth > 0); depth--; },
        recordMutation() { return ++epoch; },
        token() { return { epoch, ready: depth === 0 }; },
        subscribe() { return () => {}; },
    };
    return { registry, initialBytes: registry.inspect().retainedBytes,
        commits: () => ({ begins, ends, depth, epoch }), context: {
        appId: createAppId('cards'), desktopId: createDesktopId('desk'), projection, markDirty() {},
        refExporter: { registerRef() { throw Error('fixture has no Refs'); } },
        appLifecycle: { protocol: 'app-lifecycle-v2', register() { throw Error('fixture has no SDK lifecycle registration'); } },
        appTypeTools: registry, // The frozen shipped Core registry is used verbatim.
        viewTools: {
            mount(id, type) { const view = registry.mount(id, type); projection.recordMutation('view'); return view.viewInstanceId; },
            unmount(id) { registry.unmount(id); projection.recordMutation('view'); },
        },
    } };
}
const faultMount = Error('application mount callback failed');
const faultCleanup = Error('application cleanup callback failed once');
const bad = host(), good = host(), events = [];
let once = true;
let old;
function make(label, badApp = false) {
    function Root() {
        useLayoutEffect(() => () => {
            if (badApp && once) {
                once = false;
                if (scenario === 'reenter-close') {
                    events.push('app cleanup requests the same public renderer to unmount');
                    former.unmount();
                    events.push('nested unmount returned');
                }
                events.push('app cleanup throws once');
                throw faultCleanup;
            }
        }, []);
        useLayoutEffect(() => {
            if (badApp) old = bad.registry.listTools()[0];
            if (badApp && scenario === 'init') {
                events.push('app mount throws');
                throw faultMount;
            }
        }, []);
        const id = oldDisabled && label === 'successor' ? 'new_card' : 'card';
        return h(AppTools, { definition: tools, bindings: { use: { enabled: !(oldDisabled && badApp), execute: () => {
            events.push('entered ' + label);
            return { success: true, data: { label } };
        } } } }, h(View, {kind: 'state', id, type: 'Card' }, label));
    }
    return createTUIApp({ app_name: 'cards', component: Root });
}
const container = () => document.createElement('div');
const first = container(), second = container();
const call = async (host, tool) => {
    if (!tool) return null;
    const fact = await host.registry.invokeTypeTool(tool, tool.execution, {});
    return { phase: fact.phase, label: fact.result.data?.label, code: fact.result.error?.code };
};
const callCurrent = instance => call(instance, instance.registry.listTools()[0]);
const healthy = await make('healthy').initializeComponent(container(), good.context);
let former, reported;
try {
    former = await make('old', true).initializeComponent(first, bad.context);
    old = bad.registry.listTools()[0];
    if (scenario !== 'init') former.unmount();
} catch (error) { reported = error; }
assert.equal(reported, scenario === 'init' ? faultMount : faultCleanup);
old ??= bad.registry.listTools()[0];
const failed = { gotRenderer: Boolean(former), reported: reported.message, tree: first.textContent,
    registry: bad.registry.inspect(), commits: bad.commits(), call: await call(bad, old) };
const independent = await callCurrent(good);
let successor, successorError;
try { successor = await make('successor').initializeComponent(second, bad.context); }
catch (error) { successorError = { message: error.message, code: error.code }; }
const recovered = { successorError, registry: bad.registry.inspect(), tree: second.textContent,
    gotSuccessor: Boolean(successor), stale: await call(bad, old), current: await callCurrent(bad) };
if (former) former.unmount();
const afterOldRetry = { registry: bad.registry.inspect(), current: await callCurrent(bad) };
if (successor) successor.unmount();
const remaining = bad.registry.inspect();
healthy.unmount();
bad.registry.dispose();
good.registry.dispose();
console.log(JSON.stringify({ scenario, oldDisabled, sdk: import.meta.resolve('@aotui/sdk', parent), runtime: import.meta.resolve('@aotui/runtime/core', parent),
    failed, independent, recovered, afterOldRetry, remaining, final: bad.registry.inspect(), events }, null, 2));
dom.window.close();
assert.equal(independent.label, 'healthy');
assert.equal(recovered.gotSuccessor, true, 'a one-shot application exception must not strand the SDK Tool/View owner');
assert.equal(recovered.current.label, 'successor');
assert.equal(recovered.stale?.phase ?? 'not-entered', 'not-entered');
assert.equal(afterOldRetry.current.label, 'successor');
assert.equal(remaining.bindings, 0);
assert.equal(remaining.views, 0);
assert.equal(remaining.retainedBytes, bad.initialBytes);
assert.equal(failed.call?.phase ?? 'not-entered', 'not-entered',
    'framework Tool still enters application code after the failed initialization or close');
assert.ok(!events.includes('entered old'));
