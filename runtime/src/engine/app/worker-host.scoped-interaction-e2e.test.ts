import { workerTurns } from '../../../tests/fixtures/semantic-worker-tools.js';
import { policyProbe } from '../../../tests/fixtures/policy-probe.js';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActiveTurn, AppInteractionPolicy, AppInvocation } from '@aotui/core';

let Host: typeof import('./worker-host.js').AppWorkerHost;
let temporary: string, appFile: string, workerFile: string;
const running: any[] = [], facts: any[] = [];
const REF_A = '$ref.scoped_sdk.aa_1.alpha', REF_B = '$ref.scoped_sdk.bb_1.beta';
const SENTINEL = 'W03_B_SDK_PRIVATE_b6143_秘密';
function deferred<T = any>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function receipt(value: any) { expect(value.kind).toBe('receipt'); if (value.kind !== 'receipt') throw Error(value.code); return value.receipt; }
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
    const ready = x.messages.slice(from).find(predicate); if (ready) return Promise.resolve(ready);
    return new Promise((yes, no) => {
        const timeout = setTimeout(() => { x.worker.off('message', receive); no(Error('Fixture event timed out')); }, 4000);
        const receive = (m: any) => { if (predicate(m)) { clearTimeout(timeout); x.worker.off('message', receive); yes(m); } };
        x.worker.on('message', receive);
    });
}
async function start() {
    const worker = new Worker(workerFile, { stdout: true, stderr: true, env: { ...process.env, AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR ?? join(temporary, 'host-state') } });
    const messages: any[] = [], sent: any[] = [], logs: string[] = [];
    const post = worker.postMessage.bind(worker); worker.postMessage = (m: any) => { sent.push(m); post(m); };
    worker.stdout!.on('data', b => logs.push(String(b))); worker.stderr!.on('data', b => logs.push(String(b)));
    const authorization = policyProbe();
    const host = new Host({ policy: authorization.policy, appId: 'scoped_sdk' as any, desktopId: 'd' as any, appModulePath: appFile, existingWorker: worker,
        config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR ?? join(temporary, 'host-state') },
        timeout: 1500 });
    worker.on('message', m => messages.push(m));
    const x = { authorization, host, worker, messages, sent, logs,
        snapshot: () => (host as any).snapshotReceiver.core.store.readLatest('scoped_sdk').snapshot,
        refs: () => sent.filter(m => m.type === 'VIEW_TOOL_INVOKE') };
    running.push(x); await host.start(); await host.open(); return x;
}
function scope(x: Awaited<ReturnType<typeof start>>) {
    let refView = 'aa_1';
    const grant = ({source}: any) => ({
        refs: Object.values(source.refs).filter((ref:any)=>ref.ownerViewId===refView)
            .map((ref:any)=>({viewId:ref.ownerViewId,viewInstanceId:ref.ownerViewInstanceId,refId:ref.id})),
        toolIds: Object.keys(source.tools),
    });
    const controls = { project: (ctx: any): any => grant(ctx), authorize: (_ctx: any): any => true, read: (_m: any, _s: any): any => true };
    const policy: AppInteractionPolicy = { project: ctx => controls.project(ctx), authorize: ctx => controls.authorize(ctx), canReadReceipt: (m, s) => controls.read(m, s) };
    x.authorization.use(policy); const opened = x.host.getAppInteraction(); expect(opened.status).toBe('ready'); if (opened.status !== 'ready') throw Error(opened.issue.code);
    const turns = workerTurns(x.host);
    let turn: ActiveTurn;
    return { client: opened.interaction, controls, policy, grant,
        async observe(view = 'aa_1') {
            refView = view;
            const prepared = await turns.prepare();
            if (prepared.status !== 'prepared') throw Error(prepared.issue.code);
            turn = turns.adopt(prepared.candidate);
            return prepared.candidate.observation;
        },
        invoke: (request: AppInvocation, timeout?: number) => turn.invoke(x.host.appId, request, timeout ?? x.host.timeout),
        release: () => turn.release(),
        request(o: any, id = 'call', input: any = { file: REF_A }, name = 'read', view = 'aa_1') {
            const tool = o.tools.find((t: any) => t.name === name); expect(tool).toBeDefined();
            return { invocationId: id, observationId: o.observationId, toolId: tool.id, viewId: view, input: {...input} };
        } };
}
async function configure(x: Awaited<ReturnType<typeof start>>, data: any) {
    const changed = wait(x, m => m.type === 'APP_EVENT' && m.reason === 'view_updated', x.messages.length);
    x.worker.postMessage({ type: 'TEST_COMMAND', command: 'configure', viewId: 'aa', data: data }); await changed;
}
async function counts(x: Awaited<ReturnType<typeof start>>) {
    const tag = Math.random().toString(36).slice(2), result = wait(x, m => m.type === 'TEST_COUNTS' && m.tag === tag);
    x.worker.postMessage({ type: 'TEST_INSPECT', tag });
    return result;
}

describe('C actual emitted Host / accepted SDK / safe Worker App interaction chain', () => {
    beforeAll(async () => {
        const runtime = resolve(process.cwd());
        temporary = await mkdtemp(join(process.env.AOTUI_MIGRATION_TEMP_DIR ?? tmpdir(), 'aotui-scoped-c-'));
        Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
        const modules = join(temporary, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const [owner, pkg] of [['../core', 'acorn']]) await symlink(join(runtime, owner, 'node_modules', pkg), join(modules, pkg), 'dir');
        await symlink(runtime, join(modules, '@aotui/runtime'), 'dir');
        await symlink(resolve(runtime, '../core'), join(modules, '@aotui/core'), 'dir');
        await symlink(join(runtime, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
        appFile = join(temporary, 'app.mjs'); workerFile = join(runtime, 'dist/worker-runtime/index.js');
        await build({ stdin: { contents: await readFile(join(runtime, 'src/e2e-test/fixtures/snapshot-value-sdk.mjs'), 'utf8'), resolveDir: runtime,
            sourcefile: 'snapshot-value-sdk.mjs', loader: 'js' }, outfile: appFile,
            alias: { '@aotui/sdk': join(runtime, '../sdk/dist/index.js') },
            bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
        await writeFile(join(process.env.AOTUI_MIGRATION_INPUTS_DIR ?? temporary, 'scoped-interaction.bundle.mjs'), await readFile(appFile), { flag: 'wx' });
    });
    afterEach(async () => {
        const cases = running.splice(0), workers = new Set<Worker>();
        try {
        for (const x of cases) { x.host.terminate(); workers.add(x.worker); }
        await Promise.all([...workers].map(w => w.terminate()));
        await Promise.all(cases.map(x => x.host.waitForResourceRelease()));
        for (const x of cases) {
            facts.push({ cleanupKind: 'forced low-level Host/Worker termination', gracefulRuntimeShutdownClaimed: false,
                settled: true, resourceReport: x.host.getResourceReport(),
                dispatches: x.refs().length, handlerEntries: x.messages.filter((m: any) => m.type === 'TEST_HANDLER_ENTRY').length,
                appGuards: x.messages.filter((m: any) => m.type === 'TEST_APP_GUARD').length,
                businessEntries: x.messages.filter((m: any) => m.type === 'TEST_READ_HANDLER_ENTERED').length }); }
        for (const x of cases) { expect(x.logs.join('')).not.toContain(SENTINEL); expect(x.logs.join('')).not.toContain('receivedArgs'); }
        } finally { vi.restoreAllMocks(); }
    });
    afterAll(async () => {
        if (process.env.AOTUI_C_FACTS_FILE) {
            const runtime = resolve(process.cwd()), paths = ['dist/engine/app/worker-host.js', 'dist/worker-runtime/index.js', 'src/e2e-test/fixtures/snapshot-value-sdk.mjs', '../sdk/dist/app-factory/createApp.js'];
            const inputs = await Promise.all(paths.map(async path => ({ path: resolve(runtime, path), sha256: createHash('sha256').update(await readFile(resolve(runtime, path))).digest('hex') })));
            await writeFile(process.env.AOTUI_C_FACTS_FILE, JSON.stringify({ kind: 'Actual emitted Host and Node Worker; accepted SDK dist; plain TypeScript fixture', inputs, cases: facts }, null, 2), { flag: 'wx' });
        }
        if (temporary) await rm(temporary, { recursive: true, force: true });
    });

    it('executes concurrent/settled duplicates once, keeps actual aa/bb ownership and rejects ID conflict', async () => {
        const x = await start(), s = scope(x);
        const aa = await s.observe(), request = s.request(aa);
        let authorizations = 0, reads = 0; s.controls.authorize = () => { authorizations++; return true; }; s.controls.read = () => { reads++; return true; };
        const [a, b] = await Promise.all([s.invoke(request), s.invoke(request)]); const first = receipt(a);
        expect(receipt(b)).toEqual(first); expect(receipt(await s.invoke(request))).toEqual(first);
        expect(first.outcome).toMatchObject({ status: 'succeeded', value: { success: true, data: { owner: 'aa', calls: 1 } } });
        expect(await s.invoke({ ...request, input: { file: REF_A, value: 'different' } })).toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' });
        const bb = await s.observe('bb_1');
        expect(receipt(await s.invoke(s.request(bb, 'bb', { file: REF_B }, 'read', 'bb_1'))).outcome)
            .toMatchObject({ value: { data: { owner: 'bb', calls: 2 } } });
        expect(x.refs()).toHaveLength(2); expect(authorizations).toBe(2); expect(reads).toBe(4);
        expect(JSON.stringify(aa)).not.toContain(SENTINEL); facts.push({ id: 'C03/C05', wire: 2, handlers: 2, authorizations, reads });
    });
    it('checks each current read permission and cancels a pending reading policy before diagnostics', async () => {
        const x = await start(), s = scope(x), o = await s.observe(); const first = receipt(await s.invoke(s.request(o)));
        s.controls.read = () => false;
        expect(await s.invoke(s.request(o))).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
        expect(await s.invoke(s.request(o))).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
        const gate = deferred(), entered = deferred(); let signal: any;
        s.controls.read = (_m, value) => { signal = value; entered.resolve(undefined); return gate.promise; };
        const reading = s.client.readReceipt({ observationId: first.observationId, invocationId: first.invocationId });
        try {
            await entered.promise; x.host.beginInteractionClose(); expect(signal.aborted).toBe(true);
            expect(x.host.getResourceReport().interactions.retainedOperations).toBe(1);
            gate.resolve(true); expect(await reading).toMatchObject({ code: 'APP_INTERACTION_UNAVAILABLE' });
            expect(x.refs()).toHaveLength(1); facts.push({ id: 'C04', originalStatus: first.outcome.status, pendingReadAbortedBeforeInspect: true, wire: 1 });
        } finally { gate.resolve(true); await reading.catch(() => undefined); }
    });
    it('preserves the original Ref through a read-only preview and replaces it on adoption', async () => {
        const x = await start(), s = scope(x), old = await s.observe(); await configure(x, { text: 'B' });
        expect(await x.host.preview()).toMatchObject({ status: 'previewed' });
        const oldRequest = s.request(old, 'old'), first = receipt(await s.invoke(oldRequest));
        expect(first.outcome).toMatchObject({ value: { data: { args: { file: { text: 'A' } } } } });
        expect(first.source?.snapshotId).toBe(old.source.snapshotId);
        expect(x.refs().at(-1)).not.toHaveProperty('snapshotId');
        const newer = await s.observe();
        expect(newer.source.snapshotId).not.toBe(old.source.snapshotId);
        expect(receipt(await s.invoke(s.request(newer, 'new'))).outcome).toMatchObject({
            value: { data: { args: { file: { text: 'B' } } } },
        });
        await configure(x, { showRef: false });
        expect(receipt(await s.invoke(s.request(newer, 'removed-ref')))).toMatchObject({
            executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'REF_NOT_VISIBLE' },
        });
        expect(await s.invoke(s.request(old, 'stale'))).toMatchObject({ kind: 'refused', code: 'TURN_SELECTION_INVALID' });
        expect(receipt(await s.client.readReceipt({ observationId: oldRequest.observationId, invocationId: oldRequest.invocationId }))).toEqual(first);
        expect(x.refs()).toHaveLength(2);
        facts.push({ id: 'C06', originalA: true, newB: true, withdrawalRejects: true, wire: x.refs().length });
    });
    it.each(['with preview', 'without preview'])('rejects an actually disabled SDK binding after authorize (%s)', async visibility => {
        const x = await start(), s = scope(x), o = await s.observe(), gate = deferred(), entered = deferred();
        s.controls.authorize = () => { entered.resolve(undefined); return gate.promise; };
        const running = s.invoke(s.request(o));
        try {
            await entered.promise;
            await configure(x, { toolEnabled: false });
            if (visibility === 'with preview') expect((await x.host.preview()).status).toBe('previewed');
            else expect(x.snapshot().id).toBe(o.source.snapshotId);
            gate.resolve(true); const r = receipt(await running);
            expect(r.outcome.status).toBe('rejected'); expect(r.executionPhase).toBe('not-dispatched');
            expect(x.refs()).toHaveLength(0); expect((await counts(x))).toMatchObject({ calls: 0, handlerEntries: 0, guards: 0 });
            facts.push({ id: 'C07', visibility, phase: r.executionPhase, handlerCalls: 0, wire: x.refs().length });
        } finally {
            gate.resolve(true); await running.catch(() => undefined);

        }
    });
    it('rejects invalid parameters before dispatch and keeps a completed false result separate from transport loss', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        const before = receipt(await s.invoke(s.request(o, 'bad-param', { file: REF_A, choice: 'disallowed' })));
        const entered = receipt(await s.invoke(s.request(o, 'business', { file: REF_A, mode: 'false' })));
        expect(before).toMatchObject({ executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'TOOL_INVALID_ARGS' } });
        expect(entered).toMatchObject({ executionPhase: 'entered-returned', outcome: { status: 'failed', details: { result: { error: { code: 'E_INVALID_ARGS' }, data: { calls: 1 } } } } });
        expect(receipt(await s.invoke(s.request(o, 'next'))).outcome.status).toBe('succeeded'); expect(x.refs()).toHaveLength(2);
        facts.push({ id: 'C08/C09', before: before.executionPhase, entered: entered.executionPhase, completedFalseNotTransportLoss: true, wire: 2 });
    });
    it('keeps hidden and ungranted Refs out of execution through the shared ordinary binding', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        const other = await start();
        const foreign = scope(other);
        await foreign.observe();
        expect(await foreign.invoke(s.request(o, 'moved'))).toMatchObject({ kind: 'refused', code: 'TURN_SELECTION_INVALID' });
        expect(o.tools.some(tool => tool.name === 'read')).toBe(true);
        expect(o.tools.some(tool => ['optional', 'multi'].includes(tool.name))).toBe(false);
        expect(receipt(await s.invoke({ invocationId: 'plain', observationId: o.observationId,
            toolId: 'unobserved-tool', viewId: 'aa_1', input: { file: REF_A } }))).toMatchObject({
            executionPhase: 'not-dispatched', outcome: { status: 'rejected' },
        });
        for (const [id, name, file] of [['unknown-ref', 'read', 'entity'], ['foreign-ref', 'read', '$ref.scoped_sdk.bb_1.private_beta']]) {
            expect(receipt(await s.invoke(s.request(o, id, { file }, name))).outcome.status).toBe('rejected');
        }
        expect(x.refs()).toHaveLength(0);
        expect((await counts(x))).toMatchObject({ calls: 0, handlerEntries: 0, guards: 0 });
        facts.push({ id: 'C05/C16', unknownAndForeignRefsRejected: true, noHandlerEntered: true });
    });
    it('rejects wrong registered refType even when payload.type says File, and rejects an array for object schema', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        const metadata: any = Object.values(x.snapshot().refs).find((ref: any) => ref.id === 'metadata_alpha');
        expect(metadata.refType).toBe('Data'); expect(metadata.target.payload.type).toBe('File');
        const typed = receipt(await s.invoke(s.request(o, 'wrong-real-type', { file: '$ref.scoped_sdk.aa_1.metadata_alpha' }, 'typed')));
        expect(typed.outcome).toMatchObject({ status: 'rejected', code: 'REF_TYPE_MISMATCH' });
        const array: any = Object.values(x.snapshot().refs).find((ref: any) => ref.id === 'array_alpha');
        expect(array.refType).toBe('Data'); expect(Array.isArray(array.target.payload)).toBe(true);
        const shape = receipt(await s.invoke(s.request(o, 'wrong-payload-shape', { file: '$ref.scoped_sdk.aa_1.array_alpha' })));
        expect(shape.outcome).toMatchObject({ status: 'rejected', code: 'REF_VALUE_UNSUPPORTED' });
        expect(x.refs()).toHaveLength(0); expect(await counts(x)).toMatchObject({ calls: 0, handlerEntries: 0, guards: 0 });
        facts.push({ id: 'metadata-and-shape-controls', typed, shape, dispatches: 0, handlerEntries: 0 });
    });
    it('revokes the released observation and keeps the App busy until its actual execution ends', async () => {
        const x = await start(), s = scope(x), original = await s.observe();
        const request = s.request(original, 'held', { file: REF_A, mode: 'barrier' });
        const pending = s.invoke(request);
        await wait(x, m => m.type === 'TEST_HANDLER_ENTERED'); s.release();
        const current = await s.observe();
        expect((x.host as any).pendingRequests.size).toBe(1);
        expect(await s.invoke(s.request(current, 'busy'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        x.worker.postMessage({ type: 'TEST_COMMAND', command: 'release-handler', viewId: 'aa' });
        const result = receipt(await pending);
        expect(result.outcome.status).toBe('succeeded');
        expect(receipt(await s.client.readReceipt({ observationId: request.observationId, invocationId: request.invocationId }))).toEqual(result);
        expect(receipt(await s.invoke(s.request(current))).outcome.status).toBe('succeeded');
        facts.push({ id: 'C11', releasedObservation: true, nextCallAfterTerminal: true, wire: x.refs().length });
    });
    it('keeps the original execution and source across deadline, new adoption and late terminal', async () => {
        const x = await start(), s = scope(x), originalView = await s.observe();
        const request = s.request(originalView, 'blocked', { file: REF_A, mode: 'barrier' });
        const pending = s.invoke(request, 150);
        const handler = await wait(x, m => m.type === 'TEST_HANDLER_ENTERED');
        const wire = x.refs()[0];
        expect(handler.calls).toBe(1);
        expect(await pending).toEqual({
            kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT',
            message: expect.stringMatching(/readReceipt.*observationId.*invocationId/),
        });
        expect((x.host as any).pendingRequests.has(wire.requestId)).toBe(true);
        const store = (x.host as any).snapshotReceiver.core.store;
        expect(store.inspect().activeHolds).toBe(2);
        expect(await s.invoke({ ...request, input: { file: REF_A } })).toMatchObject({ code: 'INVOCATION_ID_CONFLICT' });

        await configure(x, { text: 'new version' });
        const currentView = await s.observe();
        expect(store.inspect().heldSnapshots).toBe(1);
        expect(store.inspect().activeHolds).toBe(2);
        expect(await s.invoke(s.request(currentView, 'busy'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        const correlated = { type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId: wire.requestId, appId: wire.appId,
            instanceId: wire.instanceId, success: true,
            terminal: { phase: 'finished-unknown' } };
        x.worker.emit('message', { ...correlated, instanceId: 'another-instance' });
        x.worker.emit('message', { ...correlated, requestId: 'another-request' });
        x.worker.emit('message', { ...correlated, type: 'VIEW_TOOL_INVOKE_V4_RESPONSE' });
        x.worker.emit('message', { ...correlated, terminal: { phase: 'entered-returned',
            result: { success: false, error: { code: 'INVALID_REPLY', message: 'Premature' } }, failureEffects: 'none' } });
        expect((x.host as any).pendingRequests.has(wire.requestId)).toBe(true);

        const query = { observationId: request.observationId, invocationId: request.invocationId };
        const replay = s.client.readReceipt(query);
        expect(await s.invoke(request, 25)).toMatchObject({ kind: 'refused', code: 'TURN_SELECTION_INVALID' });
        {
            const result = await s.client.readReceipt(query, 25);
            expect(result).toEqual({
                kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT',
                message: expect.stringMatching(/readReceipt.*observationId.*invocationId/),
            });
        }
        expect((x.host as any).pendingRequests.has(wire.requestId)).toBe(true);
        const late = wait(x, m => m.type === 'VIEW_TOOL_INVOKE_RESPONSE' && m.requestId === wire.requestId && m.instanceId === wire.instanceId);
        const releasedAt = Math.floor(performance.timeOrigin + performance.now());
        x.worker.postMessage({ type: 'TEST_COMMAND', command: 'release-handler', viewId: 'aa' });
        const terminal = await late;
        expect(terminal.terminal.phase).toBe('entered-returned');
        const settled = receipt(await replay);
        expect(settled).toMatchObject({ outcome: { status: 'succeeded' }, source: { snapshotId: originalView.source.snapshotId } });
        expect(settled.completedAt).toBeGreaterThanOrEqual(releasedAt);
        expect(settled.expiresAt).toBeGreaterThan(settled.completedAt);
        x.worker.emit('message', terminal);
        expect(receipt(await s.client.readReceipt(query))).toEqual(settled);
        expect((x.host as any).pendingRequests.has(wire.requestId)).toBe(false);
        expect(store.inspect()).toMatchObject({ activeHolds: 1, heldSnapshots: 0 });
        expect(await s.invoke(s.request(originalView, 'old'))).toMatchObject({
            kind: 'refused', code: 'TURN_SELECTION_INVALID',
        });
        expect(x.refs()).toHaveLength(1);
        expect(receipt(await s.invoke(s.request(currentView, 'after-terminal'))).outcome.status).toBe('succeeded');
        expect(x.refs()).toHaveLength(2);

    });

    it('reports a deadline during authorization as not dispatched and prevents late admission', async () => {
        const x = await start(), s = scope(x), view = await s.observe();
        const entered = deferred(), gate = deferred<boolean>();
        let signal: AbortSignal | undefined;
        s.controls.authorize = context => { signal = context.signal; entered.resolve(undefined); return gate.promise; };
        const readPermission = vi.fn(() => false);
        s.controls.read = readPermission;
        const request = s.request(view, 'before-dispatch');
        const pending = s.invoke(request, 100);
        await entered.promise;
        const query = { observationId: request.observationId, invocationId: request.invocationId };
        let releasedAt: number;
        try {
            expect(await pending).toEqual({
                kind: 'unavailable', code: 'INVOCATION_DEADLINE_EXCEEDED',
                message: expect.stringContaining('before dispatch'),
            });
            expect(signal?.aborted).toBe(true);
            expect(x.refs()).toHaveLength(0);
            expect(await s.client.readReceipt(query, 25)).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT' });
            expect(readPermission).not.toHaveBeenCalled();
        } finally {
            releasedAt = Math.floor(performance.timeOrigin + performance.now());
            gate.resolve(true);
        }
        expect(await s.client.readReceipt(query)).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_PERMISSION_DENIED' });
        readPermission.mockReturnValue(true);
        const terminal = receipt(await s.client.readReceipt(query));
        expect(terminal).toMatchObject({ executionPhase: 'not-dispatched',
            outcome: { status: 'rejected', code: 'INVOCATION_DEADLINE_EXCEEDED' } });
        expect(terminal.completedAt).toBeGreaterThanOrEqual(releasedAt);
        expect(terminal.expiresAt).toBeGreaterThan(terminal.completedAt);
        expect(receipt(await s.invoke(request))).toEqual(terminal);
        expect(x.refs()).toHaveLength(0);
        expect((await counts(x)).handlerEntries).toBe(0);

    });
    it('retains timed-out execution until a forced close confirms Worker exit', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        const pending = s.invoke(s.request(o, 'pending-release', { file: REF_A, mode: 'barrier' }), 100);
        await wait(x, m => m.type === 'TEST_HANDLER_ENTERED');
        expect(await pending).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT' });

        const terminating = deferred<void>(), allowExit = deferred<void>();
        const nativeTerminate = x.worker.terminate.bind(x.worker);
        const terminate = vi.spyOn(x.worker, 'terminate').mockImplementation(() => {
            terminating.resolve();
            return allowExit.promise.then(nativeTerminate);
        });
        try {
            (x.host as any).timeout = 200;
            const closing = x.host.close();
            const failure = expect(closing).rejects.toMatchObject({ code: 'APP_CLOSE_DEADLINE_EXCEEDED' });
            expect(x.host.close()).toBe(closing);
            await terminating.promise;
            expect(terminate).toHaveBeenCalledTimes(1);
            expect(x.sent.some(m => m.type === 'APP_CLOSE')).toBe(false);
            expect(x.host.getResourceReport()).toMatchObject({ worker: 'retiring', resourcesReleased: false });
            expect(x.host.getResourceReport().interactions.retainedOperations).toBeGreaterThan(0);
            expect(x.worker.threadId).toBeGreaterThan(0);
            allowExit.resolve();
            await failure;
            expect(await x.host.waitForResourceRelease()).toMatchObject({ worker: 'exited', resourcesReleased: true, interactions: { retainedOperations: 0 },
                appCleanup: { report: { state: 'stopped' } } });
            expect(x.refs()).toHaveLength(1);
        } finally { allowExit.resolve();terminate.mockRestore(); }
    });
    it('admits work in a fresh Worker without restoring the old Observation', async () => {
        const first = await start(), s = scope(first), o = await s.observe();
        receipt(await s.invoke(s.request(o)));
        await first.host.close();
        expect(first.worker.threadId).toBe(-1);
        expect(first.host.getStatus()).toBe('closed');
        const next = await start();
        expect(next.worker).not.toBe(first.worker);
        expect(next.host.appInstanceId).not.toBe(first.host.appInstanceId);
        expect(await s.invoke(s.request(o, 'old'))).toMatchObject({ code: 'OBSERVATION_UNAVAILABLE' });
        const fresh = scope(next), observed = await fresh.observe();
        expect(receipt(await fresh.invoke(fresh.request(observed))).outcome.status).toBe('succeeded');

    });
    it('carries a genuine SDK 6000-node object Ref without the old M5 input ceiling', async () => {
        const x = await start(); await configure(x, { text: { items: Array.from({ length: 6000 }, () => null) } });
        const s = scope(x), o = await s.observe(), r = receipt(await s.invoke(s.request(o)));
        const diagnostic = { phase: r.executionPhase, outcome: r.outcome.status, code: 'code' in r.outcome ? r.outcome.code : null };
        facts.push({ id: 'C15-diagnostic', ...diagnostic });
        expect(r.outcome.status, JSON.stringify(diagnostic)).toBe('succeeded'); if (r.outcome.status !== 'succeeded') return;
        expect((r.outcome.value as any).data.args.file.text.items).toHaveLength(6000); expect(x.refs()).toHaveLength(1);
        expect(JSON.stringify(x.host.getResourceReport())).not.toContain(SENTINEL);
        facts.push({ id: 'C15', genuineSdkRefArrayNodes: 6000, wire: 1, succeeded: true });
    });
    it.each(['non-json', 'invalid-result', 'oversize'])('reports completed %s output with unknown business result', async mode => {
        const x = await start(), s = scope(x), o = await s.observe();
        const request = s.request(o, mode, { file: REF_A, mode }), r = receipt(await s.invoke(request));
        expect(r).toMatchObject({ executionPhase: 'unknown', outcome: { status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN' } });
        expect(r.expiresAt).toBeGreaterThan(r.completedAt);
        const terminal = x.messages.find(m => m.type === 'VIEW_TOOL_INVOKE_RESPONSE' && m.requestId === x.refs()[0].requestId);
        expect(terminal?.terminal).toEqual({ phase: 'finished-unknown' });
        expect(receipt(await s.client.readReceipt({ observationId: request.observationId, invocationId: request.invocationId }))).toEqual(r);
        expect(receipt(await s.invoke(request))).toEqual(r);
        expect((await counts(x)).calls).toBe(1);
        expect(receipt(await s.invoke(s.request(o, 'after-terminal'))).outcome.status).toBe('succeeded');
        expect(x.refs()).toHaveLength(2);

    });
});
