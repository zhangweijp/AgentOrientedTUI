import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

const SENTINEL = 'W03_B_SDK_PRIVATE_b6143_秘密';
const running: any[] = [];
let temporary: string, appFile: string, workerFile: string;
async function start(config: any = {}) {
    const worker = new Worker(workerFile, { stdout: true, stderr: true });
    const messages: any[] = [], sent: any[] = [], logs: string[] = [];
    const original = worker.postMessage.bind(worker); worker.postMessage = (message: any) => { sent.push(message); original(message); };
    worker.stdout!.on('data', b => logs.push(String(b))); worker.stderr!.on('data', b => logs.push(String(b)));
    const host = new AppWorkerHost({ appId: 'real_sdk' as any, desktopId: 'd' as any, appModulePath: appFile,
        existingWorker: worker, timeout: 1000, snapshotShadow: true, experimentalReadOnlyViewTools: true,
        experimentalSnapshotValueRefExecution: true, ...config });
    worker.on('message', m => messages.push(m));
    const x = { host, worker, messages, sent, logs }; running.push(x);
    await host.start(); await host.open();
    return {
        ...x,
        snapshot: () => (host as any).shadowReceiver.core.store.readLatest('real_sdk').snapshot,
        request(name = 'read', viewId = 'aa', args: any = { file: 'file' }) {
            const snapshot = (host as any).shadowReceiver.core.store.readLatest('real_sdk').snapshot;
            const tool: any = Object.values(snapshot.tools).find((t: any) => t.name === name && t.targets.some((target: any) => target.viewId === viewId));
            return { snapshotId: snapshot.id, toolId: tool.id, viewId, args };
        },
    };
}
function waitWire(worker: Worker, messages: any[], predicate: (m: any) => boolean): Promise<any> {
    const found = messages.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.off('message', receive); reject(new Error('Fixture barrier timed out')); }, 3000);
        const receive = (m: any) => { if (predicate(m)) { clearTimeout(timer); worker.off('message', receive); resolve(m); } };
        worker.on('message', receive);
    });
}
async function configure(x: Awaited<ReturnType<typeof start>>, data: any) {
    const before = x.messages.filter(m => m.type === 'SNAPSHOT_PREPARED').at(-1)?.draft.producerSeq ?? 0;
    const published = waitWire(x.worker, x.messages, m => m.type === 'SNAPSHOT_PREPARED' && m.draft.producerSeq > before);
    await x.host.sendExternalEvent('aa' as any, 'configure', data); await published;
}
function clean(x: any) {
    expect((x.host as any).pendingRequests.size).toBe(0);
    expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
}
describe('compiled genuine SDK / V2 producer / Store / authorized Host / Node Worker', () => {
    beforeAll(async () => {
        const runtime = resolve(process.cwd()); temporary = await mkdtemp(join(tmpdir(), 'aotui-ref-sdk-b-'));
        const modules = join(temporary, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const pkg of ['preact', 'linkedom']) await symlink(join(runtime, 'node_modules', pkg), join(modules, pkg), 'dir');
        await mkdir(join(modules, '@preact'), { recursive: true });
        await symlink(join(runtime, 'node_modules/@preact/signals'), join(modules, '@preact/signals'), 'dir');
        await symlink(runtime, join(modules, '@aotui/runtime'), 'dir');
        appFile = join(temporary, 'app.mjs'); workerFile = join(runtime, 'dist/worker-runtime/index.js');
        const b0 = process.env.AOTUI_REF_COMPAT_BASELINE ?? resolve(runtime, '../rfcs/sdk-runtime-delivery/w00-20261024T090930Z');
        await build({ stdin: { contents: await readFile(join(runtime, 'src/e2e-test/fixtures/snapshot-value-sdk.mjs'), 'utf8'),
            resolveDir: runtime, sourcefile: 'snapshot-value-sdk.mjs', loader: 'js' }, outfile: appFile,
            alias: { '@fixture/sdk': join(runtime, '../sdk/dist'), '@fixture/old-sdk': join(b0, 'artifacts/rebuilt/sdk/dist') },
            bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    });
    afterEach(async () => {
        for (const x of running.splice(0)) {
            x.host.terminate(); await x.worker.terminate();
            expect(x.logs.join('')).not.toContain(SENTINEL);
            expect(x.logs.join('')).not.toContain('receivedArgs');
        }
    });
    afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

    it('executes one read-only Ref, preserves A for authorization and Handler, and isolates same-type Views', async () => {
        const x = await start(); let authorization: any;
        const args = { file: 'file', value: 'text', extra: { ordinary: [1, true] }, phase: 'not-entered' };
        const result = await x.host.executeSnapshotValueRefTool(x.request('read', 'aa', args), context => { authorization = context; return true; });
        expect(result).toMatchObject({ success: true, data: { owner: 'aa', calls: 1, args: {
            file: { owner: 'aa', text: 'A', secret: SENTINEL }, value: 'text', extra: args.extra, phase: 'not-entered' } } });
        expect(result.data?.args).toEqual(authorization.effectiveArgs);
        expect(Object.keys(authorization).sort()).toEqual(['effectiveArgs', 'refSources', 'source']);
        expect(authorization.refSources[0]).toMatchObject({ refType: 'unknown', viewId: 'aa', kind: 'snapshot-value' });
        expect(await x.host.executeSnapshotValueRefTool(x.request('read', 'bb'), () => true))
            .toMatchObject({ data: { owner: 'bb', calls: 2, args: { file: { owner: 'bb', text: 'A' } } } });
        expect(x.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE').map(m => m.terminal.phase)).toEqual(['entered-returned', 'entered-returned']); clean(x);
    });
    it('uses historical S1/A after a real Ref-only S2/B and then deletion in the Worker', async () => {
        const x = await start(); const s1 = x.request();
        await configure(x, { text: 'B' }); expect(x.snapshot().id).not.toBe(s1.snapshotId);
        const current = await x.host.executeSnapshotValueRefTool(x.request(), () => true);
        expect(current).toMatchObject({ data: { args: { file: { text: 'B' } } } });
        await configure(x, { showRef: false });
        expect(await x.host.executeSnapshotValueRefTool(s1, () => true)).toMatchObject({ data: { args: { file: { text: 'A' } } } });
        expect(await x.host.executeSnapshotValueRefTool(x.request(), () => true)).toMatchObject({ error: { code: 'REF_NOT_FOUND' } }); clean(x);
    });
    it('keeps actual old C1 SDK and new safe Wrapper in one Worker, without auto-qualifying the old one', async () => {
        const x = await start();
        expect(await x.host.executeSnapshotValueRefTool(x.request('read', 'legacy'), () => true)).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect((await x.host.executeSnapshotValueRefTool(x.request(), () => true)).success).toBe(true);
        expect(await x.host.executeReadOnlyViewTool(x.request('plain', 'legacy', { fail: true }), () => true)).toMatchObject({ error: { code: 'BUSINESS_FAILED' } });
        expect(await x.host.executeReadOnlyViewTool(x.request('plain', 'legacy', {}), () => true)).toMatchObject({ data: { oldCalls: 0, calls: 1 } });
        expect(await x.host.executeReadOnlyViewTool(x.request(), () => true)).toMatchObject({ error: { code: 'REF_CONTRACT_UNSUPPORTED' } }); clean(x);
    });
    it.each(['enum', 'pattern', 'type', 'ref'])('rejects %s with safe real IPC and zero Handler calls', async kind => {
        const x = await start(); const args: any = { file: 'file' };
        if (kind === 'enum') args.choice = SENTINEL;
        if (kind === 'pattern') args.text = SENTINEL;
        if (kind === 'type') args.value = { private: SENTINEL };
        if (kind === 'ref') args.file = SENTINEL;
        const result = await x.host.executeSnapshotValueRefTool(x.request('read', 'aa', args), () => true);
        expect(result.error?.code).toBe(kind === 'ref' ? 'REF_NOT_FOUND' : 'E_INVALID_ARGS');
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
        const terminals = x.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE');
        expect(JSON.stringify(terminals)).not.toContain(SENTINEL); if (kind !== 'ref') expect(terminals[0].terminal.phase).toBe('not-entered');
        expect(await x.host.executeReadOnlyViewTool(x.request('stats', 'aa', {}), () => true)).toMatchObject({ data: { calls: 0 } }); clean(x);
    });
    it.each(['false', 'throw', 'reject'])('preserves trustworthy entry for business %s without unsafe exception text', async mode => {
        const x = await start(); const result = await x.host.executeSnapshotValueRefTool(x.request('read', 'aa', { file: 'file', mode }), () => true);
        expect(result).toMatchObject({ success: false, error: { code: mode === 'false' ? 'E_INVALID_ARGS' : 'E_HANDLER_ERROR' } });
        expect(x.messages.find(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE').terminal.phase).toBe('entered-returned');
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
        expect(await x.host.executeReadOnlyViewTool(x.request('stats', 'aa', {}), () => true)).toMatchObject({ data: { calls: 1 } }); clean(x);
    });
    it.each(['non-json', 'invalid-result', 'oversize'])('reports unknown after business output %s cannot form a terminal, without retry', async mode => {
        const x = await start(); (x.host as any).timeout = 80;
        expect(await x.host.executeSnapshotValueRefTool(x.request('read', 'aa', { file: 'file', mode }), () => true)).toMatchObject({ error: { code: 'TOOL_OUTCOME_UNKNOWN' } });
        expect(x.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE')).toHaveLength(0);
        expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(1);
        await waitWire(x.worker, x.messages, m => m.type === 'TEST_READ_HANDLER_ENTERED');
        expect(x.messages.filter(m => m.type === 'TEST_READ_HANDLER_ENTERED')).toEqual([{ type: 'TEST_READ_HANDLER_ENTERED', owner: 'aa', calls: 1 }]);
        const authorize = vi.fn(() => true);
        expect((await x.host.executeReadOnlyViewTool(x.request('stats', 'aa', {}), authorize)).success).toBe(false);
        expect(authorize).not.toHaveBeenCalled();expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE')).toHaveLength(0);clean(x);
    });
    it('reports unknown when the actual Handler entered and the Worker exits before its terminal', async () => {
        const x = await start(); const pending = x.host.executeSnapshotValueRefTool(x.request('read', 'aa', { file: 'file', mode: 'barrier' }), () => true);
        await waitWire(x.worker, x.messages, m => m.type === 'TEST_HANDLER_ENTERED'); await x.worker.terminate();
        expect(await pending).toMatchObject({ error: { code: 'TOOL_OUTCOME_UNKNOWN' } });
        expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(1); clean(x);
    });
    it('does not retry a lost actual terminal or let its late/duplicate delivery finish a later call', async () => {
        const x = await start(); (x.host as any).timeout = 80;
        const deliver = x.worker.listeners('message')[0] as (m: any) => void;
        let dropped: any;
        const relay = (m: any) => {
            if (m.type === 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' && !dropped) dropped = m;
            else deliver(m);
        };
        x.worker.off('message', deliver); x.worker.on('message', relay);
        try {
            expect(await x.host.executeSnapshotValueRefTool(x.request(), () => true)).toMatchObject({ error: { code: 'TOOL_OUTCOME_UNKNOWN' } });
            expect(dropped.terminal.phase).toBe('entered-returned'); expect(dropped.terminal.result.data.calls).toBe(1); clean(x);
            const authorize = vi.fn(() => true);
            expect((await x.host.executeSnapshotValueRefTool(x.request(), authorize)).success).toBe(false);
            deliver(dropped);deliver(dropped);expect((x.host as any).pendingRequests.size).toBe(0);
            expect((await x.host.executeSnapshotValueRefTool(x.request(), authorize)).success).toBe(false);
            expect(authorize).not.toHaveBeenCalled();expect((x.host as any).interactionTransportUncertain).toBe(true);
            expect(x.messages.filter(m => m.type === 'TEST_READ_HANDLER_ENTERED')).toEqual([{ type: 'TEST_READ_HANDLER_ENTERED', owner: 'aa', calls: 1 }]);
            expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(1);clean(x);
            expect(await x.host.releaseWorker()).toBe(null);clean(x);
        } finally { x.worker.off('message', relay); x.worker.on('message', deliver); }
    });
    it('rechecks live binding after an async policy while real SDK disables the Tool', async () => {
        const x = await start(); let release!: (v: boolean) => void;
        const result = x.host.executeSnapshotValueRefTool(x.request(), () => new Promise<boolean>(resolve => { release = resolve; }));
        await configure(x, { enabled: false }); release(true);
        expect(await result).toMatchObject({ error: { code: 'TOOL_UNAVAILABLE' } });
        expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(0); clean(x);
    });
    it('enforces diagnostics limits across actual SDK and Worker IPC', async () => {
        const x = await start(); const result = await x.host.executeSnapshotValueRefTool(x.request('diagnostics'), () => true);
        const diagnostics = result.error?.context?.diagnostics as any[];
        expect(result.error?.code).toBe('E_INVALID_ARGS'); expect(diagnostics).toHaveLength(16);
        expect(diagnostics.every(d => d.param.length === 128 && d.reason.length <= 256)).toBe(true);
        expect(result.error?.message.length).toBe(512); expect(JSON.stringify(result)).not.toContain(SENTINEL);
        expect(await x.host.executeReadOnlyViewTool(x.request('stats', 'aa', {}), () => true)).toMatchObject({ data: { calls: 0 } }); clean(x);
    });
    it.each([
        ['optional', 'file', 'REF_CONTRACT_UNSUPPORTED'], ['multi', 'file', 'REF_CONTRACT_UNSUPPORTED'],
        ['typed', 'file', 'REF_TYPE_MISMATCH'], ['read', 'entity', 'REF_TARGET_UNSUPPORTED'],
        ['read', 'array', 'REF_VALUE_UNSUPPORTED'], ['read', 'bb_only', 'REF_NOT_FOUND'],
    ])('keeps declarations but denies %s / %s before policy with %s', async (name, ref, code) => {
        const x = await start(); let policyCalls = 0;
        expect(await x.host.executeSnapshotValueRefTool(x.request(name, 'aa', { file: ref, second: 'file' }), () => { policyCalls++; return true; }))
            .toMatchObject({ error: { code } });
        expect(policyCalls).toBe(0); expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(0); clean(x);
    });
    it('keeps default opt-in off even when real SDK bindings can support the mode', async () => {
        const x = await start({ experimentalSnapshotValueRefExecution: false });
        expect(await x.host.executeSnapshotValueRefTool(x.request(), () => true)).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(0); clean(x);
    });
});
