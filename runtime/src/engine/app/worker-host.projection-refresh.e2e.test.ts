import { projectCompleteViews } from '@aotui/core/internal';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import type { AppInteractionPolicy, AppInteraction } from '@aotui/core';

let directory: string, workerPath: string, appPath: string;
const hosts: AppWorkerHost[] = [];
const policy: AppInteractionPolicy = {
    project: projectCompleteViews,
    authorize: () => true, canReadReceipt: () => true,
};

beforeAll(async () => {
    const runtime = process.cwd();
    directory = await mkdtemp(join(tmpdir(), 'aotui-refresh-worker-'));
    const modules = join(directory, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
    for (const [name, target] of [['preact', join(runtime, 'node_modules/preact')],
        ['acorn', join(runtime, '../core/node_modules/acorn')], ['linkedom', join(runtime, '../sdk/node_modules/linkedom')], ['typebox', resolve(runtime, '../sdk/node_modules/typebox')],
        ['@aotui/core', resolve(runtime, '../core')], ['@aotui/runtime', runtime]]) await symlink(target, join(modules, name), 'dir');
    workerPath = join(directory, 'worker.mjs'); appPath = join(directory, 'app.mjs');
    await build({ entryPoints: [join(runtime, 'src/worker-runtime/index.ts')], outfile: workerPath,
        platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent' });
    await build({ stdin: { resolveDir: runtime, sourcefile: 'refresh-app.tsx', loader: 'tsx', contents: `
        import { parentPort } from 'node:worker_threads';
        import { h, options } from 'preact';
        import { useState, useLayoutEffect, useMemo } from 'preact/hooks';
        import Type from 'typebox';
        import { createTUIApp, useDataRef, refParam, defineViewType, DynamicView } from '@aotui/sdk';
        const WorkspaceType = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Workspace', tools: {
            change: {
                description: 'Change the fixture',
                inputSchema: Type.Object({ value: Type.Number(), invalid: Type.Optional(Type.Boolean()) },
                    { additionalProperties: false }),
                execute({ input, context }) {
                    calls++;
                    context.set({ value: input.value, invalid: input.invalid ?? false });
                    return { success: true, data: { calls } };
                },
            },
            stats: {
                description: 'Read operation count', inputSchema: Type.Object({}),
                execute: () => ({ success: true, data: { calls } }),
            },
        } });
        const FileType = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'File', tools: {
            edit: {
                description: 'Edit the current file', inputSchema: Type.Object({}),
                enabled: ({ value }) => value > 0,
                execute: () => ({ success: true }),
            },
            read: {
                description: 'Read observed data',
                inputSchema: Type.Object({ record: refParam('Record', Type.Object({ value: Type.Number() })) }),
                execute: ({ input }) => ({ success: true, data: { value: input.record.value } }),
            },
        } });
        const OtherType = defineViewType({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Other' });

        const queued = []; options.debounceRendering = cb => queued.push(cb);
        let calls = 0;
        let currentRecord, redrawFile, redrawOther;

        function File({state}) {
            const data=useMemo(()=>state.invalid ? {value:()=>state.value} : {value:state.value},[state.value,state.invalid]);
            const [, tick] = useState(0); redrawFile = () => tick(n => n + 1); currentRecord = data;
            const ref=useDataRef('selected',data,{scope: 'protected', refType:'Record'});
            return h('p',{},'file:'+(state.invalid ? state.value : data.value)+ref('Selection'));
        }
        function Other() {
            const [value, tick] = useState(0); redrawOther = () => tick(n => n + 1);
            return h(DynamicView, {idPrefix: 'other',type:OtherType}, h('p', {}, 'other:'+value));
        }
        function App() {
            const [state,set]=useState({value:0,invalid:false});
            useLayoutEffect(()=>{
                const onCommand = message => {
                    if (message.type !== 'TEST_COMMAND') return;
                    if (message.command === 'release') {while(queued.length)queued.shift()();}
                    if(message.command==='repair')set(s=>({...s,invalid:false}));
                    if(message.command==='mutate-live')currentRecord.value = 9;
                    if(message.command==='redraw-file')redrawFile();
                    if(message.command==='redraw-other')redrawOther();
                };
                parentPort.on('message', onCommand);
                return ()=>parentPort.off('message', onCommand);
            },[]);
            return h('div', null, [
                h(DynamicView, { idPrefix: 'workspace', type: WorkspaceType, context: { set }, key: 'root' },
                    h('p', {}, 'workspace:' + state.value)),
                state.value > 0 ? h(DynamicView, { idPrefix: 'file', type: FileType, context: state, key: 'file' }, h(File, { state })) : null,
                h(Other, { key: 'other' }),
            ]);
        }
        export default createTUIApp({viewTypes:[WorkspaceType,FileType,OtherType], app_name:'refresh_fixture',component:App,signalPolicy:'never'});
    ` }, outfile: appPath, platform: 'node', format: 'esm', bundle: true, packages: 'external',
        alias: { '@aotui/sdk': resolve(runtime, '../sdk/src/index.ts') }, logLevel: 'silent' });
});
afterEach(async () => {
    for (const host of hosts.splice(0)) { try { await host.close(); } finally { host.terminate(); await host.waitForResourceRelease(); } }
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function start() {
    const host = new AppWorkerHost({ appId: 'refresh_app' as any, desktopId: 'desktop' as any,
        appModulePath: appPath, workerScriptPath: workerPath, existingWorker: new Worker(workerPath),
        config: { AOTUI_DATA_DIR: directory } });
    hosts.push(host); host.onUpdateRequest = vi.fn(); await host.start(); await host.open();
    const opened = host.getAppInteraction(policy); if (opened.status !== 'ready') throw new Error(opened.issue.code);
    return { host, client: opened.interaction };
}
async function observe(client: AppInteraction) {
    const observed = await client.observe({ all: true });
    if (observed.status !== 'observed') throw new Error(observed.issue.code);
    expect(client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
    return observed.observation;
}
let invocation = 0;
function invoke(client: AppInteraction, observed: Awaited<ReturnType<typeof observe>>, name: string, input: Record<string, unknown>) {
    const tool = observed.tools.find(t => t.name === name)!;
    const view = observed.views.find(view => view.type === tool.viewType)!;
    return client.invoke({ invocationId: 'refresh-' + ++invocation, observationId: observed.observationId, toolId: tool.id, input: { view_id: view.id, ...input } });
}

describe('real SDK Worker observation refresh', () => {
    it('adopts a new observation without retargeting old Refs or retaining retired source data', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        await invoke(client, initial, 'change', { value: 1 });
        const waiting = observe(client); host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' }); const first = await waiting;
        await invoke(client, first, 'change', { value: 2 });
        const preparing = client.observe({ all: true }); host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' });
        const next = await preparing; if (next.status !== 'observed') throw Error(next.issue.code);
        expect((await client.preview()).status).toBe('previewed');
        expect(await invoke(client, next.observation, 'read', { record: '$refresh_app.file.selected' }))
            .toMatchObject({ kind: 'refused', code: 'OBSERVATION_NOT_ADOPTED' });
        expect(await invoke(client, first, 'read', { record: '$refresh_app.file.selected' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 1 } } } } });
        expect(client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
        expect(await invoke(client, first, 'read', { record: '$refresh_app.file.selected' }))
            .toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        expect(await invoke(client, next.observation, 'read', { record: '$refresh_app.file.selected' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 2 } } } } });
        const store = (host as any).snapshotReceiver.core.store;
        expect(store.getById(first.source.snapshotId).status).toBe('rejected');
        expect(store.inspect()).toMatchObject({ heldSnapshots: 0, heldSnapshotBytes: 0 });
        expect(store.getById(next.observation.source.snapshotId).status).toBe('found');
    });
    it('observes queued commits and compatible View/Ref/Tool without a prior notification or fixed sleep', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        const messages: Array<{ type: string; requestId?: string }> = [];
        host['worker']!.on('message', message => messages.push(message));
        const business = await invoke(client, initial, 'change', { value: 1 });
        expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        const observing = observe(client);
        host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' });
        const next = await observing;
        expect(JSON.stringify(next)).toContain('file:1'); expect(next.tools.map(t => t.name)).toContain('edit');
        const snapshot = (host as any).snapshotReceiver.core.store.readLatest(host.appId).snapshot;
        expect(snapshot.views.map((v: any) => v.content.value).join(' ')).toContain('workspace:1');
        expect(Object.values(snapshot.refs)).toMatchObject([{ target: { payload: { value: 1 } } }]);
        expect(host.onUpdateRequest).not.toHaveBeenCalled();
        expect(messages.filter(message => message.type === 'SNAPSHOT_PREPARED')).toEqual([
            expect.objectContaining({ requestId: expect.any(String) }),
        ]);
        const received = host.getSemanticSnapshotReport()!.prepared;
        expect(await invoke(client, next, 'read', { record: '$refresh_app.file.selected' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 1 } } } } });
        expect(host.getSemanticSnapshotReport()!.prepared).toBe(received);
        const confirmed = await observe(client);
        expect(host.getSemanticSnapshotReport()!.prepared).toBe(received);
        expect(messages.filter(message => message.type === 'PROJECTION_CURRENT')).toEqual([
            expect.objectContaining({ requestId: expect.any(String) }),
        ]);
        expect(confirmed.source).toEqual(next.source);
        client.releaseObservation(confirmed.observationId);
        expect(host.getInteractionReport()!.core.observations.observations).toBe(0);
    });

    it('reuses confirmed content when nothing changes', async () => {
        const { host, client } = await start(); await observe(client); const id = host.getSemanticSnapshotReport()!.snapshotId;
        await observe(client); expect(host.getSemanticSnapshotReport()!.snapshotId).toBe(id);
        expect(host.onUpdateRequest).not.toHaveBeenCalled();
    });

    it('answers raw requests without a valid known identity with a complete frame', async () => {
        const { host, client } = await start();
        await observe(client);
        const worker = host['worker']!;
        const known = host['snapshotReceiver'].currentPublication()!;
        for (const [index, invalid] of [undefined, { ...known, producerSeq: '2' }, { ...known, extra: true }].entries()) {
            const requestId = 'legacy-' + index;
            const reply = new Promise<{ type: string }>(resolve => {
                const receive = (message: { type: string; requestId?: string }) => {
                    if (message.requestId !== requestId) return;
                    worker.off('message', receive);
                    resolve(message);
                };
                worker.on('message', receive);
            });
            worker.postMessage({ type: 'FLUSH_PROJECTION', requestId, ...(invalid ? { known: invalid } : {}) });
            expect(await reply).toMatchObject({ type: 'SNAPSHOT_PREPARED', requestId });
        }
        expect((await client.preview()).status).toBe('previewed');
    });

    it('observes cached values after a live mutation and only changes a Ref when its owner commits', async () => {
        const { host, client } = await start();
        const initial = await observe(client);
        await invoke(client, initial, 'change', { value: 1 });
        host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' });
        const first = await observe(client);
        const event = (name: string) => host['worker']!.postMessage({ type: 'TEST_COMMAND', command: name });
        const resultFor = (value: number) => ({ kind: 'receipt', receipt: {
            outcome: { status: 'succeeded', value: { data: { value } } },
        } });
        await event('mutate-live');
        const cached = await observe(client);
        expect(cached.source.snapshotId).toBe(first.source.snapshotId);
        expect(await invoke(client, cached, 'read', { record: '$refresh_app.file.selected' })).toMatchObject(resultFor(1));

        await event('redraw-other'); await event('release');
        const unrelated = await observe(client);
        expect(unrelated.source.snapshotId).not.toBe(first.source.snapshotId);
        expect(JSON.stringify(unrelated)).toContain('other:1');
        expect(JSON.stringify(unrelated)).toContain('file:1');
        expect(await invoke(client, unrelated, 'read', { record: '$refresh_app.file.selected' })).toMatchObject(resultFor(1));

        await event('redraw-file'); await event('release');
        const updated = await observe(client);
        expect(JSON.stringify(updated)).toContain('file:9');
        expect(await invoke(client, updated, 'read', { record: '$refresh_app.file.selected' })).toMatchObject(resultFor(9));

    });

    it('keeps the known business result on projection failure and recovers by observing, without repeating the operation', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        const receipt = await invoke(client, initial, 'change', { value: 1, invalid: true });
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        const failed = client.observe({ all: true }); host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' });
        expect(await failed).toMatchObject({ status: 'rejected', issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR', path: 'Ref file.selected $["value"]',
            message: expect.stringContaining('Expected finite JSON data'),
        } });
        expect(host.getSemanticSnapshotReport()!.health).toBe('degraded');
        host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'redraw-other' }); host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' });
        expect(await client.observe({ all: true })).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
        const source = (host as any).snapshotReceiver.core.store.readLatest(host.appId);
        expect(source).toMatchObject({ status: 'degraded', lastGood: { id: initial.source.snapshotId } });
        host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'repair' }); host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'release' });
        const recovered = await observe(client);
        expect(await invoke(client, recovered, 'stats', {})).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
    });

    it('closes the pending render/Worker/Scope wait and releases resources without running the scheduler', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        await invoke(client, initial, 'change', { value: 1 });
        const pending = client.observe({ all: true });
        await host.close(); expect((await pending).status).toBe('rejected');
        host.terminate(); const resources = await host.waitForResourceRelease(); expect(resources.resourcesReleased).toBe(true);
        expect((host as any).pendingRequests.size).toBe(0); expect((host as any).projectionRefresh).toBeUndefined();
    });
});
