import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction.js';

let Host: typeof import('./worker-host.js').AppWorkerHost;
let temporary: string, appFile: string, workerFile: string;
const running: any[] = [], facts: any[] = [];
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
async function start(existing?: Worker) {
    const worker = existing ?? new Worker(workerFile, { stdout: true, stderr: true });
    const messages: any[] = [], sent: any[] = [], logs: string[] = [];
    const post = worker.postMessage.bind(worker); worker.postMessage = (m: any) => { sent.push(m); post(m); };
    worker.stdout!.on('data', b => logs.push(String(b))); worker.stderr!.on('data', b => logs.push(String(b)));
    const host = new Host({ appId: 'scoped_sdk' as any, desktopId: 'd' as any, appModulePath: appFile, existingWorker: worker,
        timeout: 1500, interactionModes: ['ordinary-v2', 'snapshot-value-v2'] });
    worker.on('message', m => messages.push(m));
    const x = { host, worker, messages, sent, logs,
        snapshot: () => (host as any).snapshotReceiver.core.store.readLatest('scoped_sdk').snapshot,
        refs: () => sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V2') };
    running.push(x); await host.start(); await host.open(); return x;
}
function scope(x: Awaited<ReturnType<typeof start>>) {
    const grant = (ctx: any) => ({ views: ctx.source.views.filter((v: any) => ctx.selection.viewIds.includes(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(ctx.source.refs).filter((r: any) => ctx.selection.viewIds.includes(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(ctx.source.tools).flatMap((t: any) => t.targets.filter((v: any) => ctx.selection.viewIds.includes(v.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] });
    const controls = { project: (ctx: any): any => grant(ctx), authorize: (_ctx: any): any => true, read: (_m: any, _s: any): any => true };
    const policy: ScopePolicy = { project: ctx => controls.project(ctx), authorize: ctx => controls.authorize(ctx), canReadReceipt: (m, s) => controls.read(m, s) };
    const opened = x.host.createInteractionScope(policy); expect(opened.status).toBe('opened'); if (opened.status !== 'opened') throw Error(opened.issue.code);
    return { client: opened.client, controls, policy, grant,
        async observe(view = 'aa') { const r = await opened.client.observe({ viewIds: [view] }); expect(r.status).toBe('observed'); if (r.status !== 'observed') throw Error(r.issue.code); return r.observation; },
        request(o: any, id = 'call', input: any = { file: 'file' }, name = 'read', view = 'aa') {
            const tool = o.tools.find((t: any) => t.name === name); expect(tool).toBeDefined();
            const binding = o.bindings.find((b: any) => b.toolId === tool.id && b.target.viewId === view); expect(binding).toBeDefined();
            return { invocationId: id, observationId: o.observationId, bindingId: binding.bindingId, input };
        } };
}
async function configure(x: Awaited<ReturnType<typeof start>>, data: any) {
    const seq = x.messages.filter(m => m.type === 'SNAPSHOT_PREPARED').at(-1)?.draft.producerSeq ?? 0;
    const changed = wait(x, m => m.type === 'SNAPSHOT_PREPARED' && m.draft.producerSeq > seq);
    await x.host.sendExternalEvent('aa' as any, 'configure', data); await changed;
}
async function counts(x: Awaited<ReturnType<typeof start>>) {
    const tag = Math.random().toString(36).slice(2), result = wait(x, m => m.type === 'TEST_COUNTS' && m.tag === tag);
    x.worker.postMessage({ type: 'TEST_INSPECT', tag });
    return result;
}

describe('C actual emitted Host / accepted SDK / safe Worker Scope chain', () => {
    beforeAll(async () => {
        const runtime = resolve(process.cwd()); temporary = await mkdtemp(join(tmpdir(), 'aotui-scoped-c-'));
        Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
        const modules = join(temporary, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const pkg of ['preact', 'linkedom']) await symlink(join(runtime, 'node_modules', pkg), join(modules, pkg), 'dir');
        await symlink(runtime, join(modules, '@aotui/runtime'), 'dir');
        appFile = join(temporary, 'app.mjs'); workerFile = join(runtime, 'dist/worker-runtime/index.js');
        await build({ stdin: { contents: await readFile(join(runtime, 'src/e2e-test/fixtures/snapshot-value-sdk.mjs'), 'utf8'), resolveDir: runtime,
            sourcefile: 'snapshot-value-sdk.mjs', loader: 'js' }, outfile: appFile,
            alias: { '@fixture/sdk': join(runtime, '../sdk/dist') },
            bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    });
    afterEach(async () => {
        const workers = new Set<Worker>();
        for (const x of running.splice(0)) { x.host.terminate(); workers.add(x.worker); expect(x.logs.join('')).not.toContain(SENTINEL); expect(x.logs.join('')).not.toContain('receivedArgs'); }
        await Promise.all([...workers].map(w => w.terminate())); vi.restoreAllMocks();
    });
    afterAll(async () => {
        if (process.env.AOTUI_C_FACTS_FILE) {
            const runtime = resolve(process.cwd()), paths = ['dist/engine/app/worker-host.js', 'dist/worker-runtime/index.js', 'src/e2e-test/fixtures/snapshot-value-sdk.mjs', '../sdk/dist/app-factory/createTUIApp.js', '../sdk/dist/hooks/useViewTypeTool.js'];
            const inputs = await Promise.all(paths.map(async path => ({ path: resolve(runtime, path), sha256: createHash('sha256').update(await readFile(resolve(runtime, path))).digest('hex') })));
            await writeFile(process.env.AOTUI_C_FACTS_FILE, JSON.stringify({ kind: 'Actual emitted Host and Node Worker; accepted SDK dist; existing immutable fixture', inputs, cases: facts }, null, 2), { flag: 'wx' });
        }
        if (temporary) await rm(temporary, { recursive: true, force: true });
    });

    it('executes concurrent/settled duplicates once, keeps actual aa/bb ownership and rejects ID conflict', async () => {
        const x = await start(), s = scope(x), aa = await s.observe(), bb = await s.observe('bb'), request = s.request(aa);
        let authorizations = 0, reads = 0; s.controls.authorize = () => { authorizations++; return true; }; s.controls.read = () => { reads++; return true; };
        const [a, b] = await Promise.all([s.client.invoke(request), s.client.invoke(request)]); const first = receipt(a);
        expect(receipt(b)).toEqual(first); expect(receipt(await s.client.invoke(request))).toEqual(first);
        expect(first.outcome).toMatchObject({ status: 'succeeded', value: { success: true, data: { owner: 'aa', calls: 1 } } });
        expect(await s.client.invoke({ ...request, input: { file: 'file', value: 'different' } })).toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' });
        expect(receipt(await s.client.invoke(s.request(bb, 'bb', { file: 'file' }, 'read', 'bb'))).outcome)
            .toMatchObject({ value: { data: { owner: 'bb', calls: 2 } } });
        expect(x.refs()).toHaveLength(2); expect(authorizations).toBe(2); expect(reads).toBe(4);
        expect(JSON.stringify(aa)).not.toContain(SENTINEL); facts.push({ id: 'C03/C05', wire: 2, handlers: 2, authorizations, reads }); s.client.close();
    });
    it('checks each current read permission and cancels a pending reading policy before diagnostics', async () => {
        const x = await start(), s = scope(x), o = await s.observe(); const first = receipt(await s.client.invoke(s.request(o)));
        s.controls.read = () => false;
        expect(await s.client.invoke(s.request(o))).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
        expect(await s.client.readReceipt('call')).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
        const gate = deferred(), entered = deferred(); let signal: any;
        s.controls.read = (_m, value) => { signal = value; entered.resolve(undefined); return gate.promise; };
        const reading = s.client.readReceipt('call'); await entered.promise; s.client.close(); expect(signal.aborted).toBe(true);
        expect(x.host.getInteractionReport()?.core.activeReads).toBe(1); gate.resolve(true); expect(await reading).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
        expect(x.refs()).toHaveLength(1); facts.push({ id: 'C04', originalStatus: first.outcome.status, pendingReadAbortedBeforeInspect: true, wire: 1 });
    });
    it('retains original S1/A after actual SDK S2/B and Ref deletion, while new observations use the new source', async () => {
        const x = await start(), s = scope(x), old = await s.observe(); await configure(x, { text: 'B' }); const newer = await s.observe();
        const b = receipt(await s.client.invoke(s.request(newer, 'new'))); expect(b.outcome).toMatchObject({ value: { data: { args: { file: { text: 'B' } } } } });
        await configure(x, { showRef: false });
        const a = receipt(await s.client.invoke(s.request(old, 'old'))); expect(a.outcome).toMatchObject({ value: { data: { args: { file: { text: 'A' } } } } });
        expect(x.refs().at(-1).snapshotId).toBe(old.source.snapshotId); expect(newer.source.snapshotId).not.toBe(old.source.snapshotId);
        facts.push({ id: 'C06', originalA: true, newB: true, afterDeletion: true, wire: x.refs().length }); s.client.close();
    });
    it.each(['published', 'unpublished'])('rejects an actually disabled SDK binding after authorize (%s)', async visibility => {
        const x = await start(), s = scope(x), o = await s.observe(), gate = deferred(), entered = deferred();
        s.controls.authorize = () => { entered.resolve(undefined); return gate.promise; };
        const running = s.client.invoke(s.request(o)); await entered.promise;
        const deliver = x.worker.listeners('message')[0] as (m: any) => void;
        const relay = (m: any) => { if (m.type !== 'SNAPSHOT_PREPARED') deliver(m); };
        if (visibility === 'unpublished') { x.worker.off('message', deliver); x.worker.on('message', relay); }
        try {
            await configure(x, { enabled: false }); gate.resolve(true); const r = receipt(await running);
            expect(r.outcome.status).toBe('rejected'); expect(r.executionPhase).toBe(visibility === 'published' ? 'not-dispatched' : 'not-entered');
            expect(x.refs()).toHaveLength(visibility === 'published' ? 0 : 1); expect((await counts(x)).calls).toBe(0);
            facts.push({ id: 'C07', visibility, phase: r.executionPhase, handlerCalls: 0, wire: x.refs().length });
        } finally { if (visibility === 'unpublished') { x.worker.off('message', relay); x.worker.on('message', deliver); } s.client.close(); }
    });
    it('rejects invalid parameters before dispatch and keeps a completed false result separate from transport loss', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        const before = receipt(await s.client.invoke(s.request(o, 'bad-param', { file: 'file', choice: 'disallowed' })));
        const entered = receipt(await s.client.invoke(s.request(o, 'business', { file: 'file', mode: 'false' })));
        expect(before).toMatchObject({ executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'ACTION_INPUT_INVALID' } });
        expect(entered).toMatchObject({ executionPhase: 'entered-returned', outcome: { status: 'unknown', details: { result: { error: { code: 'E_INVALID_ARGS' }, data: { calls: 1 } } } } });
        expect(x.host.getInteractionReport()?.transportUncertain).toBe(false);
        expect(receipt(await s.client.invoke(s.request(o, 'next'))).outcome.status).toBe('succeeded'); expect(x.refs()).toHaveLength(2);
        facts.push({ id: 'C08/C09', before: before.executionPhase, entered: entered.executionPhase, completedFalseNotTransportLoss: true, wire: 2 }); s.client.close();
    });
    it('keeps hidden and foreign Refs out of execution while ordinary and Ref modes use their own bindings', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), other = scope(x);
        expect(receipt(await other.client.invoke(s.request(o, 'moved'))).outcome.status).toBe('rejected');
        expect(x.host.getInteractionReport()?.negotiatedModes).toEqual(['ordinary-v2', 'snapshot-value-v2']);
        expect(o.tools.some(tool => tool.name === 'read')).toBe(true);
        expect(o.tools.some(tool => ['optional', 'multi'].includes(tool.name))).toBe(false);
        expect(receipt(await s.client.invoke({ invocationId: 'plain', observationId: o.observationId,
            bindingId: 'unobserved-ordinary-binding', input: { file: 'file' } }))).toMatchObject({
            executionPhase: 'not-dispatched', outcome: { status: 'rejected' },
        });
        for (const [id, name, file] of [['unknown-ref', 'read', 'entity'], ['foreign-ref', 'read', 'bb_only']]) {
            expect(receipt(await s.client.invoke(s.request(o, id, { file }, name))).outcome.status).toBe('rejected');
        }
        expect(x.refs()).toHaveLength(0);
        expect((await counts(x)).calls).toBe(0);
        facts.push({ id: 'C05/C16', unknownAndForeignRefsRejected: true, noHandlerEntered: true });
        s.client.close(); other.client.close();
    });
    it('cancels only the closed Scope while actual remote work remains in flight', async () => {
        const x = await start(), a = scope(x), b = scope(x), oa = await a.observe(), ob = await b.observe();
        const pending = a.client.invoke(a.request(oa, 'held', { file: 'file', mode: 'barrier' }));
        await wait(x, m => m.type === 'TEST_HANDLER_ENTERED'); a.client.close();
        expect((x.host as any).pendingRequests.size).toBe(1); expect(x.host.getInteractionReport()?.core.activeInvocations).toBe(1);
        expect(x.host.getInteractionReport()?.transportUncertain).toBe(false);
        expect(receipt(await b.client.invoke(b.request(ob))).outcome.status).toBe('succeeded');
        await x.host.sendExternalEvent('aa' as any, 'release-handler', {}); expect(await pending).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
        expect(x.host.getInteractionReport()?.core.activeInvocations).toBe(0); facts.push({ id: 'C11', remoteNotCancelledByScopeClose: true, otherScopeSucceeded: true, wire: x.refs().length }); b.client.close();
    });
    it('returns unknown while the actual Handler remains behind its barrier, preserves it against late terminal, and forbids pooling', async () => {
        const x = await start(), s = scope(x), o = await s.observe(); (x.host as any).timeout = 100;
        const request = s.request(o, 'blocked', { file: 'file', mode: 'barrier' }), pending = s.client.invoke(request);
        const handler = await wait(x, m => m.type === 'TEST_HANDLER_ENTERED'); const original = receipt(await pending), wire = x.refs()[0];
        expect(handler.calls).toBe(1); expect(original).toMatchObject({ executionPhase: 'unknown', outcome: { status: 'unknown' } });
        expect(x.messages.some(m => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' && m.requestId === wire.requestId)).toBe(false);
        expect((x.host as any).pendingRequests.size).toBe(0); expect(x.host.getInteractionReport()).toMatchObject({ transportUncertain: true, core: { activeInvocations: 0 } });
        expect(receipt(await s.client.invoke(request))).toEqual(original); expect(receipt(await s.client.invoke(s.request(o, 'new'))).outcome.status).toBe('rejected');
        expect(x.host.createInteractionScope(s.policy).status).toBe('rejected'); expect(x.refs()).toHaveLength(1);
        const late = wait(x, m => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' && m.requestId === wire.requestId);
        await x.host.sendExternalEvent('aa' as any, 'release-handler', {}); const terminal = await late;
        expect(terminal.terminal.phase).toBe('entered-returned'); expect(receipt(await s.client.readReceipt('blocked'))).toEqual(original);
        await x.host.pause(); await x.host.resume(); expect(x.host.getInteractionReport()?.transportUncertain).toBe(true);
        s.client.close(); expect(x.host.createInteractionScope(s.policy).status).toBe('rejected');
        const terminate = vi.spyOn(x.worker, 'terminate'); expect(await x.host.releaseWorker()).toBeNull(); expect(terminate).toHaveBeenCalledTimes(1);
        expect(x.sent.filter(m => m.type === 'RESET')).toHaveLength(0);
        facts.push({ id: 'C13/C14', handlerEntered: 1, hostUnknownBeforeHandlerRelease: true, localTransportSettledNotRemoteFinished: true,
            lateTerminalDidNotChangeReceipt: true, wire: 1, reset: 0, releaseReturnedNull: true });
    });
    it('a pending real Handler makes concurrent release return null and never hands off the uncertain Worker', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        const pending = s.client.invoke(s.request(o, 'pending-release', { file: 'file', mode: 'barrier' })); await wait(x, m => m.type === 'TEST_HANDLER_ENTERED');
        const terminate = vi.spyOn(x.worker, 'terminate'), a = x.host.releaseWorker(), b = x.host.releaseWorker();
        expect(await a).toBeNull(); expect(await b).toBeNull(); expect(await pending).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
        expect(terminate).toHaveBeenCalledTimes(1); expect(x.sent.filter(m => m.type === 'RESET')).toHaveLength(0);
        facts.push({ id: 'C14-pending', noWorkerOwnershipDelivered: true, terminateAttempts: 1, resets: 0 });
    });
    it('normally completed work still permits pooling into a new Host and AppInstance', async () => {
        const first = await start(), s = scope(first), o = await s.observe(); receipt(await s.client.invoke(s.request(o)));
        const a = first.host.releaseWorker(), b = first.host.releaseWorker(); const returned = await a;
        expect(await b).toBeNull(); expect(returned).toBe(first.worker); expect(first.host.getStatus()).toBe('closed');
        const next = await start(returned!); expect(next.host.appInstanceId).not.toBe(first.host.appInstanceId);
        expect(await s.client.invoke(s.request(o, 'old'))).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
        const fresh = scope(next), observed = await fresh.observe(); expect(receipt(await fresh.client.invoke(fresh.request(observed))).outcome.status).toBe('succeeded');
        facts.push({ id: 'C14-normal', workerReused: true, distinctAppInstance: true, oldObservationUnavailable: true }); fresh.client.close();
    });
    it('carries a genuine SDK 6000-node object Ref without the old M5 input ceiling', async () => {
        const x = await start(); await configure(x, { text: { items: Array.from({ length: 6000 }, () => null) } });
        const s = scope(x), o = await s.observe(), r = receipt(await s.client.invoke(s.request(o)));
        const diagnostic = { phase: r.executionPhase, outcome: r.outcome.status, code: 'code' in r.outcome ? r.outcome.code : null };
        facts.push({ id: 'C15-diagnostic', ...diagnostic });
        expect(r.outcome.status, JSON.stringify(diagnostic)).toBe('succeeded'); if (r.outcome.status !== 'succeeded') return;
        expect((r.outcome.value as any).data.args.file.text.items).toHaveLength(6000); expect(x.refs()).toHaveLength(1);
        expect(JSON.stringify(x.host.getInteractionReport())).not.toContain(SENTINEL);
        facts.push({ id: 'C15', genuineSdkRefArrayNodes: 6000, wire: 1, succeeded: true }); s.client.close();
    });
    it.each(['non-json', 'invalid-result', 'oversize'])('marks actual lost terminal for %s output uncertain without replay', async mode => {
        const x = await start(), s = scope(x), o = await s.observe(); (x.host as any).timeout = 100;
        const request = s.request(o, mode, { file: 'file', mode }), r = receipt(await s.client.invoke(request));
        expect(r).toMatchObject({ executionPhase: 'unknown', outcome: { status: 'unknown' } });
        expect(x.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE')).toHaveLength(0);
        await wait(x, m => m.type === 'TEST_READ_HANDLER_ENTERED');
        expect(x.messages.filter(m => m.type === 'TEST_READ_HANDLER_ENTERED')).toEqual([{ type: 'TEST_READ_HANDLER_ENTERED', owner: 'aa', calls: 1 }]);
        const authorize = vi.fn(() => true);s.controls.authorize = authorize;
        expect(await s.client.invoke(s.request(o, 'after-loss'))).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'TOOL_EXECUTION_UNAVAILABLE' },
        } });
        expect(authorize).not.toHaveBeenCalled();expect(x.refs()).toHaveLength(1);
        expect(receipt(await s.client.invoke(request))).toEqual(r);
        expect(x.host.getInteractionReport()?.transportUncertain).toBe(true); expect(x.host.createInteractionScope(s.policy).status).toBe('rejected');
        expect(x.refs()).toHaveLength(1); facts.push({ id: 'C09/C10', mode, noTrustedTerminal: true, handlerCalls: 1, wire: 1, transportUncertain: true }); s.client.close();
    });
});
