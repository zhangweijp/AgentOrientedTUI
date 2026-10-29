// Independent Wave 2B audit: current SDK/Worker metadata and historical Store facts.
// This script DOES NOT implement the proposed Ref resolver or modify production sources.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = process.cwd();
const runtime = join(root, 'runtime');
const require = createRequire(join(runtime, 'package.json'));
const { build } = require('esbuild');
const { AppWorkerHost } = await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href);
const { createSnapshotCore, refKey } = await import(pathToFileURL(join(runtime, 'dist/core/snapshot/index.js')).href);
const temp = await mkdtemp(join(tmpdir(), 'aotui-independent-ref-design-'));
let host;
try {
    const modules = join(temp, 'node_modules');
    await mkdir(join(modules, '@aotui'), { recursive: true });
    await symlink(join(runtime, 'node_modules/preact'), join(modules, 'preact'), 'dir');
    await symlink(join(runtime, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
    await symlink(runtime, join(modules, '@aotui/runtime'), 'dir');
    const workerFile = join(temp, 'worker.mjs');
    const appFile = join(temp, 'app.mjs');
    await build({ entryPoints: [join(runtime, 'src/worker-runtime/index.ts')], outfile: workerFile,
        bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    const fixture = `
        import { h } from 'preact';
        import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
        import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
        import { View } from './sdk/src/components/View.tsx';
        import { useDataRef } from './sdk/src/hooks/useRef.ts';
        import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';
        const calls = { A: 0, B: 0 };
        function Detail({ who, version }) {
            const data = useMemo(() => ({ who, version }), [who, version]);
            const file = useDataRef('file', data);
            const params = useMemo(() => ({ file: {
                type: 'reference', refType: who === 'A' ? 'File' : 'Todo', required: true,
            } }), [who]);
            useViewTypeTool('inspect', { description: 'Inspect a Ref-shaped argument', params, isMutating: false },
                async args => { calls[who]++; return { success: true, data: { who, received: args.file } }; });
            return h('p', {}, file('File ' + who));
        }
        function Content() {
            const [version, update] = useState(0);
            useLayoutEffect(() => {
                const onEvent = event => {
                    if (event.detail?.viewId === 'workspace' && event.detail?.type === 'advance') update(1);
                };
                document.body.addEventListener('aotui:external-event', onEvent);
                return () => document.body.removeEventListener('aotui:external-event', onEvent);
            }, []);
            useViewTypeTool('stats', { description: 'Audit calls', params: {}, isMutating: false },
                async () => ({ success: true, data: { ...calls } }));
            return h('main', {}, [
                h(View, { id: 'fd_A', type: 'FileDetail', key: 'A' }, h(Detail, { who: 'A', version })),
                h(View, { id: 'fd_B', type: 'FileDetail', key: 'B' }, h(Detail, { who: 'B', version })),
            ]);
        }
        export default createTUIApp({ app_name: 'independent_ref_audit',
            component: () => h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {})),
        });
    `;
    await build({ stdin: { contents: fixture, resolveDir: root, sourcefile: 'independent-ref-audit.tsx', loader: 'tsx' },
        outfile: appFile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    const appId = 'ref_design_audit';
    let clock = 0;
    host = new AppWorkerHost({ appId, desktopId: 'independent_audit', appModulePath: appFile,
        workerScriptPath: workerFile, snapshotShadow: true, experimentalReadOnlyViewTools: true });
    const core = createSnapshotCore({ now: () => clock, historyTtlMs: 20, leaseTtlMs: 100 });
    core.lifecycle.startApp(appId, host.appInstanceId);
    host.shadowReceiver.core = core; // Existing Core with a controlled clock; test-only before INIT.
    function awaitSnapshot(predicate) {
        return new Promise((resolveResult, reject) => {
            const worker = host.worker;
            const cleanup = () => { clearTimeout(deadline); worker.off('message', onMessage); };
            const check = () => {
                const current = core.store.readLatest(appId);
                if (current.status === 'ready' && predicate(current.snapshot)) {
                    cleanup(); resolveResult(current.snapshot);
                }
            };
            const onMessage = () => queueMicrotask(check);
            const deadline = setTimeout(() => { cleanup(); reject(new Error('Timed out awaiting committed audit V2')); }, 4000);
            worker.on('message', onMessage);
            check();
        });
    }
    await host.start(); await host.open();
    const inspectId = JSON.stringify([appId, 'FileDetail', 'inspect']);
    const first = await awaitSnapshot(s => s.schemaVersion === 2 && s.views.length === 3 && s.tools[inspectId]?.targets.length === 2);
    const instance = viewId => first.views.find(view => view.id === viewId).viewInstanceId;
    const aKey = refKey('fd_A', instance('fd_A'), 'file');
    const bKey = refKey('fd_B', instance('fd_B'), 'file');
    assert.deepEqual(first.tools[inspectId].inputSchema.properties.file, Object.assign(Object.create(null), { type: 'string' }));
    assert.equal(first.refs[aKey].refType, 'unknown');
    assert.equal(first.refs[bKey].refType, 'unknown');
    assert.equal(first.refs[aKey].target.payload.who, 'A');
    assert.equal(first.refs[bKey].target.payload.who, 'B');
    const reference = (snapshotId, viewId) => ({ snapshotId, appId, instanceId: host.appInstanceId,
        viewId, viewInstanceId: instance(viewId), refId: 'file' });
    const call = (snapshotId, viewId, value) => host.executeReadOnlyViewTool({
        snapshotId, toolId: inspectId, viewId, args: { file: value },
    }, () => true);
    const literal = await call(first.id, 'fd_A', 'file');
    assert.equal(literal.success, true); assert.equal(literal.data.received, 'file');
    const callerObject = await call(first.id, 'fd_B', { id: 'caller-value', type: 'NotTodo' });
    assert.equal(callerObject.success, true); assert.equal(callerObject.data.received.id, 'caller-value');
    const held = core.store.acquire(first.id);
    assert.equal(held.status, 'acquired');
    clock = 1;
    await host.sendExternalEvent('workspace', 'advance', {});
    const second = await awaitSnapshot(s => s.id !== first.id && s.refs[aKey]?.target.payload?.version === 1);
    assert.equal(core.store.resolveRef(reference(first.id, 'fd_A')).target.payload.version, 0);
    assert.equal(core.store.resolveRef(reference(second.id, 'fd_A')).target.payload.version, 1);
    assert.deepEqual(second.tools[inspectId], first.tools[inspectId]);
    clock = 21;
    assert.equal(core.store.resolveRef(reference(first.id, 'fd_A')).status, 'resolved');
    assert.equal(core.store.acquire(first.id).issue.code, 'SNAPSHOT_EXPIRED');
    const expiredCall = await call(first.id, 'fd_A', 'file');
    assert.equal(expiredCall.error.code, 'SNAPSHOT_EXPIRED');
    const stats = await host.executeReadOnlyViewTool({ snapshotId: second.id,
        toolId: JSON.stringify([appId, 'Workspace', 'stats']), viewId: 'workspace', args: {} }, () => true);
    assert.deepEqual(stats.data, { A: 1, B: 1 });
    held.lease.release();
    assert.equal(core.store.inspect().activeLeases, 0);
    assert.equal(host.getSnapshotShadowReport().strictEligible, false);
    console.log('INDEPENDENT_REAL_SDK_REF_FACTS=' + JSON.stringify({
        distinctDeveloperRefTypes: ['File', 'Todo'], aggregatedInspectDefinitions: 1,
        publicPropertySchema: first.tools[inspectId].inputSchema.properties.file,
        projectedRefTypes: [first.refs[aKey].refType, first.refs[bKey].refType],
        callerStringNotDecoded: literal.data.received,
        callerObjectNotProvenance: callerObject.data.received,
        historicalA: core.store.getById(first.id).status,
        historicalReadBeforeRelease: true, historicalVersion: 0, newVersion: 1,
        freshAcquireAfterHistoryTTL: expiredCall.error.code, handlerCounts: stats.data,
        activeLeases: core.store.inspect().activeLeases,
        proposedRefResolverImplemented: false, productionSourcesEdited: false,
    }));
} finally {
    if (host) { const worker = host.worker; host.terminate(); if (worker) await worker.terminate(); }
    await rm(temp, { recursive: true, force: true });
}
