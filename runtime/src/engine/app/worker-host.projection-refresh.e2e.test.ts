import { committedState, fixtureHost, fixtureWorker } from './__tests__/worker-fixture.js';
import { workerTurns } from '../../../tests/fixtures/semantic-worker-tools.js';
import { projectCompleteViews } from '@aotui/core/host';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import type { AppInteractionPolicy, AppInvocation, ObservationCandidate } from '@aotui/core';

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
    for (const [name, target] of [['acorn', join(runtime, '../core/node_modules/acorn')], ['typebox', resolve(runtime, '../sdk/node_modules/typebox')],
        ['@aotui/core', resolve(runtime, '../core')], ['@aotui/runtime', runtime]]) await symlink(target, join(modules, name), 'dir');
    workerPath = join(directory, 'worker.mjs'); appPath = join(directory, 'app.mjs');
    await build({ entryPoints: [join(runtime, 'src/worker-runtime/index.ts')], outfile: workerPath,
        platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent' });
    await build({ stdin: { resolveDir: runtime, sourcefile: 'refresh-app.ts', loader: 'ts', contents: `import { parentPort } from 'node:worker_threads';
        import Type from 'typebox';
        import { createApp, createView, ref, formatRef, refParam, defineViewType } from '@aotui/sdk';
        const WorkspaceType = defineViewType()({ multiplicity: 'multiple', name: 'Workspace', tools: {
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
        const FileType = defineViewType()({ multiplicity: 'multiple', name: 'File', tools: {
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
        const OtherType = defineViewType({ multiplicity: 'multiple', name: 'Other' });

        let calls = 0;
        export default createApp({ viewTypes: [WorkspaceType, FileType, OtherType], app_name: 'refresh_fixture',
            initialize({ publish: publishAuthorFrame, registerLifecycle }) {
                let state = { value: 0, invalid: false }, otherValue = 0, liveValue = 0;
                const workspace = (() => { const handle = createView(WorkspaceType, { idPrefix: 'workspace', region: 'dynamic' }); return { handle, frame: () => handle.frame({ body: 'workspace:' + state.value, context: { set } }) }; })();
                const file = (() => { const handle = createView(FileType, { idPrefix: 'file', region: 'dynamic' }); return { handle, frame: () => {
                    const data = state.invalid ? { value: () => state.value } : { value: state.value };
                    const selected = ref('selected', data, { schema: { type: 'object' }, scope: 'protected', refType: 'Record' });
                    return handle.frame({ body: 'file:' + state.value + ' ' + formatRef('Selection', selected), refs: [selected], context: state });
                } }; })();
                const other = (() => { const handle = createView(OtherType, { idPrefix: 'other', region: 'dynamic' }); return { handle, frame: () => handle.frame({ body: 'other:' + otherValue }) }; })();
                function publish() {
                    try { publishAuthorFrame(() => (state.value > 0 ? [workspace, file, other] : [workspace, other]).map(page => page.frame())); }
                    catch { /* Capture the Runtime diagnostic and preserve the result already returned by the fixture. */ }
                }
                function set(next) { state = next; liveValue = state.value; publish(); }
                const receive = message => {
                    if (message.type !== 'TEST_COMMAND') return;
                    if (message.command === 'repair') { state = { ...state, invalid: false }; publish(); }
                    if (message.command === 'mutate-live') liveValue = 9;
                    if (message.command === 'redraw-file') { state = { ...state, value: liveValue }; publish(); }
                    if (message.command === 'redraw-other') { otherValue++; publish(); }
                };
                parentPort.on('message', receive);
                registerLifecycle({ stop() { parentPort.off('message', receive); } });
                publish();
            },
        });
    ` }, outfile: appPath, platform: 'node', format: 'esm', bundle: true, packages: 'external',
        alias: { '@aotui/sdk': resolve(runtime, '../sdk/src/index.ts') }, logLevel: 'silent' });
});
afterEach(async () => {
    for (const host of hosts.splice(0)) { try { await host.close(); } finally { host.terminate(); await host.waitForResourceRelease(); } }
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function start() {
    const host = fixtureHost(AppWorkerHost, { policy: policy, appId: 'refresh_app' as any, desktopId: 'desktop' as any,
        appModulePath: appPath,
        config: { AOTUI_DATA_DIR: directory } }, { worker: new Worker(workerPath) });
    hosts.push(host); host.onUpdate = vi.fn(); await host.start(); await host.open();
    return { host, turns: workerTurns(host) };
}
type WorkerTurns = ReturnType<typeof workerTurns>;
function adopt(turns: WorkerTurns, candidate: ObservationCandidate) {
    return { observation: candidate.observation, turn: turns.adopt(candidate) };
}
async function observe(turns: WorkerTurns) {
    const prepared = await turns.prepare();
    if (prepared.status !== 'prepared') throw new Error(prepared.issue.code);
    return adopt(turns, prepared.candidate);
}
let invocation = 0;
function invoke({ observation, turn }: ReturnType<typeof adopt>, name: string, input: AppInvocation['input']) {
    const tool = observation.tools.find(t => t.name === name)!;
    const view = observation.views.find(view => view.type === tool.viewType)!;
    return turn.invoke(observation.source.appId, { invocationId: 'refresh-' + ++invocation, observationId: observation.observationId,
        toolId: tool.id, viewId: view.id, input });
}

describe('real SDK Worker observation refresh', () => {
    it('adopts a new observation without retargeting old Refs or retaining retired source data', async () => {
        const { host, turns } = await start(); const initial = await observe(turns);
        await invoke(initial, 'change', { value: 1 });
        const first = await observe(turns);
        await invoke(first, 'change', { value: 2 });
        const preparing = turns.prepare();
        const prepared = await preparing; if (prepared.status !== 'prepared') throw Error(prepared.issue.code);
        expect((await host.preview()).status).toBe('previewed');
        expect(await invoke({ observation: prepared.candidate.observation, turn: first.turn }, 'read', { record: '$ref.refresh_app.file_1.selected' }))
            .toMatchObject({ kind: 'refused', code: 'TURN_SELECTION_INVALID' });
        expect(await invoke(first, 'read', { record: '$ref.refresh_app.file_1.selected' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 1 } } } } });
        const next = adopt(turns, prepared.candidate);
        expect(await invoke(first, 'read', { record: '$ref.refresh_app.file_1.selected' }))
            .toMatchObject({ kind: 'refused', code: 'TURN_NOT_ACTIVE' });
        expect(await invoke(next, 'read', { record: '$ref.refresh_app.file_1.selected' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 2 } } } } });
        const store = (host as any).snapshotReceiver.core.store;
        expect(store.getById(first.observation.source.snapshotId).status).toBe('rejected');
        expect(store.inspect()).toMatchObject({ heldSnapshots: 0, heldSnapshotBytes: 0 });
        expect(store.getById(next.observation.source.snapshotId).status).toBe('found');
    });
    it('observes a completed commit and compatible View, Ref and Tool without a prior notification or fixed sleep', async () => {
        const { host, turns } = await start(); const initial = await observe(turns);
        const messages: Array<{ type: string; requestId?: string }> = [];
        fixtureWorker(host)!.on('message', message => messages.push(message));
        const business = await invoke(initial, 'change', { value: 1 });
        expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        const observing = observe(turns);
        const next = await observing;
        expect(JSON.stringify(next)).toContain('file:1'); expect(next.observation.tools.map(t => t.name)).toContain('edit');
        const snapshot = (host as any).snapshotReceiver.core.store.readLatest(host.appId).snapshot;
        expect(snapshot.views.map((v: any) => v.content.value).join(' ')).toContain('workspace:1');
        expect(Object.values(snapshot.refs)).toMatchObject([{ target: { payload: { value: 1 } } }]);
        expect(host.onUpdate).not.toHaveBeenCalledWith('attention_requested');
        expect(messages.filter(message => message.type === 'SNAPSHOT_PREPARED')).toEqual([
            expect.objectContaining({ requestId: expect.any(String) }),
        ]);
        const preparedFrames = () => messages.filter(message => message.type === 'SNAPSHOT_PREPARED').length;
        const received = preparedFrames();
        expect(await invoke(next, 'read', { record: '$ref.refresh_app.file_1.selected' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 1 } } } } });
        expect(preparedFrames()).toBe(received);
        const messagesBeforeConfirmation = messages.length;
        const confirmed = await observe(turns);
        expect(preparedFrames()).toBe(received);
        expect(messages.slice(messagesBeforeConfirmation).filter(message => message.type === 'PROJECTION_CURRENT')).toEqual([
            expect.objectContaining({ requestId: expect.any(String) }),
        ]);
        expect(confirmed.observation.source).toEqual(next.observation.source);
        confirmed.turn.release();
        expect(host.getResourceReport().interactions.retainedOperations).toBe(0);
    });

    it('reuses confirmed content when nothing changes', async () => {
        const { host, turns } = await start();
        const startupNotices = vi.mocked(host.onUpdate!).mock.calls.slice();
        expect(startupNotices.length).toBeGreaterThan(0);
        expect(startupNotices.every(([reason])=>reason==='app_runtime_changed')).toBe(true);
        const first = await observe(turns), next = await observe(turns);
        expect(next.observation.source.snapshotId).toBe(first.observation.source.snapshotId);
        expect(vi.mocked(host.onUpdate!).mock.calls).toEqual(startupNotices);
    });

    it('answers raw requests without a valid known identity with a complete frame', async () => {
        const { host, turns } = await start();
        await observe(turns);
        const worker = fixtureWorker(host)!;
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
        expect((await host.preview()).status).toBe('previewed');
    });

    it('observes cached values after a live mutation and only changes a Ref when its owner commits', async () => {
        const { host, turns } = await start();
        const initial = await observe(turns);
        await invoke(initial, 'change', { value: 1 });
        const first = await observe(turns);
        const event = (name: string) => fixtureWorker(host)!.postMessage({ type: 'TEST_COMMAND', command: name });
        const resultFor = (value: number) => ({ kind: 'receipt', receipt: {
            outcome: { status: 'succeeded', value: { data: { value } } },
        } });
        await event('mutate-live');
        const cached = await observe(turns);
        expect(cached.observation.source.snapshotId).toBe(first.observation.source.snapshotId);
        expect(await invoke(cached, 'read', { record: '$ref.refresh_app.file_1.selected' })).toMatchObject(resultFor(1));

        await event('redraw-other');
        const unrelated = await observe(turns);
        expect(unrelated.observation.source.snapshotId).not.toBe(first.observation.source.snapshotId);
        expect(JSON.stringify(unrelated)).toContain('other:1');
        expect(JSON.stringify(unrelated)).toContain('file:1');
        expect(await invoke(unrelated, 'read', { record: '$ref.refresh_app.file_1.selected' })).toMatchObject(resultFor(1));

        await event('redraw-file');
        const updated = await observe(turns);
        expect(JSON.stringify(updated)).toContain('file:9');
        expect(await invoke(updated, 'read', { record: '$ref.refresh_app.file_1.selected' })).toMatchObject(resultFor(9));

    });

    it('keeps the known business result on projection failure and recovers by observing, without repeating the operation', async () => {
        const { host, turns } = await start(); const initial = await observe(turns);
        const receipt = await invoke(initial, 'change', { value: 1, invalid: true });
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        const failed = turns.prepare();
        expect(await failed).toMatchObject({ status: 'rejected', issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR', path: 'Ref file.selected $["value"]',
            message: expect.stringContaining('Expected finite JSON data'),
        } });
        expect(committedState(host).status).toBe('degraded');
        fixtureWorker(host)!.postMessage({ type: 'TEST_COMMAND', command: 'redraw-other' });
        expect(await turns.prepare()).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
        const source = (host as any).snapshotReceiver.core.store.readLatest(host.appId);
        expect(source).toMatchObject({ status: 'degraded', lastGood: { id: initial.observation.source.snapshotId } });
        fixtureWorker(host)!.postMessage({ type: 'TEST_COMMAND', command: 'repair' });
        const recovered = await observe(turns);
        expect(await invoke(recovered, 'stats', {})).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
    });

    it('closes a pending observation and releases Worker and candidate resources', async () => {
        const { host, turns } = await start(); const initial = await observe(turns);
        await invoke(initial, 'change', { value: 1 });
        const pending = turns.prepare();
        await host.close(); expect((await pending).status).toBe('rejected');
        host.terminate(); const resources = await host.waitForResourceRelease(); expect(resources.resourcesReleased).toBe(true);
        expect((host as any).pendingRequests.size).toBe(0); expect((host as any).projectionRefresh).toBeUndefined();
    });
});
