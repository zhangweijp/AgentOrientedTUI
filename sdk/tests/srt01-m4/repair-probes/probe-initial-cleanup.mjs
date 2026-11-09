import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const parent = pathToFileURL(resolve(process.argv[2], 'package.json')).href;
const fromPackage = specifier => import(import.meta.resolve(specifier, parent));
const { JSDOM } = await fromPackage('jsdom');
const dom = new JSDOM('<!doctype html><body></body>');
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MutationObserver']) globalThis[key] = dom.window[key];
const { h } = await fromPackage('preact');
const { default: Type } = await fromPackage('typebox');
const { AppTools, View, createTUIApp, defineViewTypeTool, defineToolSet } = await fromPackage('@aotui/sdk');
const { createViewOwnedTools } = await fromPackage('@aotui/runtime/core');
const { createAppId, createDesktopId } = await fromPackage('@aotui/runtime/spi');
const registry = createViewOwnedTools('recovery', 'first');
const definition = name => defineViewTypeTool({ name, viewType: 'Card', description: name, inputSchema: Type.Object({}) });
const tools = defineToolSet({ first: definition('read'), second: definition('other') });
const binding = { execute: () => ({ success: true }) };
let broken = true, releaseAttempts = 0, begins = 0, ends = 0;
const context = {
    appId: createAppId('recovery'), desktopId: createDesktopId('review'),
    projection: { beginCommit() { begins++; }, endCommit() { ends++; } }, markDirty() {},
    appLifecycle: { protocol: 'app-lifecycle-v2', register() { return () => {}; } },
    viewTools: { mount(id, type) { return registry.mount(id, type).viewInstanceId; }, unmount(id) { registry.unmount(id); } },
    refExporter: { registerRef() { throw Error('unexpected Ref'); } },
    appTypeTools: { protocol: 'view-type-tools-v1', registerTypeTool(meta, options) {
        if (broken && meta.name === 'other') throw Error('injected second registration failure');
        const release = registry.registerTypeTool(meta, options);
        return () => { releaseAttempts++; if (broken) throw Error('injected retained handle'); release(); };
    } },
};
const factory = createTUIApp({ app_name: 'recovery', component: () =>
    h(AppTools, { definition: tools, bindings: { first: binding, second: binding } }, h(View, {kind: 'state', id: 'card', type: 'Card' }, h('p', {}, 'active'))) });
const initialize = container => factory.initializeComponent(container, context);
const err = error => ({ code: error.code, message: error.message, original: error.diagnostics?.original?.message });
const container = document.createElement('main');
let initialError;
try { await initialize(container); } catch (error) { initialError = err(error); }
assert.equal(initialError?.code, 'TOOL_BINDING_CLEANUP_FAILED', JSON.stringify(initialError));
const failed = { info: initialError, releases: releaseAttempts, markup: container.textContent, ...registry.inspect() };
broken = false;
let renderer, retryError;
try { renderer = await initialize(document.createElement('main')); } catch (error) { retryError = err(error); }
const recovered = { releases: releaseAttempts, ...registry.inspect(), retryError };
if (renderer) renderer.unmount();
const atEnd = { releases: releaseAttempts, ...registry.inspect(), begins, ends };
registry.dispose();
dom.window.close();
console.log(JSON.stringify({ sdk: import.meta.resolve('@aotui/sdk', parent), failed, recovered, atEnd }, null, 2));
assert.ok(renderer, 'initialization returned no renderer and a new initialization could not retry the old cleanup');
assert.equal(atEnd.bindings, 0);
assert.equal(begins, ends);
