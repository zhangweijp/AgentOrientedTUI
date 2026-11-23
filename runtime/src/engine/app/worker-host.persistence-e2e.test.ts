import { readSqliteState } from '../../../tests/fixtures/sqlite-state.js';
import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { AppWorkerHost } from './worker-host.js';
import { createSqliteStateStorage } from '../../adapters/storage/sqlite-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from './state-storage-host.js';
import { invokeObservedTool, linkPreactPeer } from '../../../tests/fixtures/semantic-worker-tools.js';
const repo = path.resolve(process.cwd(), '..');
const url = (p: string) => pathToFileURL(p).href;
async function fixture(persistent = true) {
    const root = await mkdtemp(path.join(tmpdir(), 'aotui-b2-worker-'));
    await linkPreactPeer(root);
    const file = path.join(root, 'app.mjs');
    const body = `import { h } from 'preact';import Type from 'typebox';import { createTUIApp, useAppLifecycle, useAppRuntimeContext, useState, defineViewType, StaticView } from ${JSON.stringify(url(path.join(repo, 'sdk/dist/index.js')))};
let setter, port, value, draft;
const noArgs = Type.Object({}, {additionalProperties:false});
const RootType = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Root', tools: {
  set: {
    description: 'Set persisted value', inputSchema: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
    async execute({ input }) { draft = input.value; setter(draft); return { success: true }; },
  },
  flush: {
    description: 'Flush persisted state', inputSchema: noArgs,
    execute: async () => {
      if (draft === undefined) return { success: true, data: await port.flush() };
      const submitted = port.save('state',draft).then(() => null, error => error.code);
      draft = undefined;
      const report = await port.flush();
      return { success: true, data: { ...report, saveIssue: await submitted } };
    },
  },
  inspect: {
    description: 'Inspect persisted state', inputSchema: noArgs,
    execute: async () => ({ success: true, data: { value: port ? await port.load('state') : value } }),
  },
} });
function Root() {
  [value,setter] = useState(0);
  ${persistent ? `port = useAppRuntimeContext().persistence;
  useAppLifecycle({ async close() { if (draft !== undefined) await port.save('state',draft); } });` : ''}
  return h(StaticView, { idPrefix: 'root', type: RootType, context: {} }, 'Persistent state');
}
export default createTUIApp({persistence: ${persistent}, viewTypes:[RootType],  app_name: 'test', component: Root });
`;
    await writeFile(file, body);
    return { root, file, body, data: path.join(root, 'data'), read: (app = 'test') => readSqliteState(path.join(root, 'data/app-state'), 'd', app, 'state') };
}
const host = (f: Awaited<ReturnType<typeof fixture>>, extra: object = {}) => {
    const target = process.env.AOTUI_W08_B2_FACTS_DIR;
    if (target) {
        const body = readFileSync(f.file), hash = createHash('sha256').update(body).digest('hex'), folder = path.join(target, 'fixtures');
        mkdirSync(folder, { recursive: true });writeFileSync(path.join(folder, hash + '.mjs'), body);
        writeFileSync(path.join(folder, path.basename(f.root) + '-before.json'), JSON.stringify({ originalPath: f.file, sha256: hash, body: hash + '.mjs', capturedBeforeHostConstructionAndStart: true }));
    }
    return new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any,
    appModulePath: url(f.file), timeout: 5000, workerScriptPath: path.join(repo, 'runtime/dist/worker-runtime/index.js'),
    config: { AOTUI_DATA_DIR: f.data, AOTUI_APP_KEY: 'test' }, ...extra });
};
const invokeTool = async (h: AppWorkerHost, op: string, args = {}, timeoutMs?: number) => {
    const result = await invokeObservedTool(h, op, args, 'root', timeoutMs);
    if (result?.kind === 'receipt' && result.receipt.outcome.status === 'succeeded') return result.receipt.outcome.value;
    throw new Error(result?.kind === 'receipt' ? result.receipt.outcome.status : result?.code ?? 'Tool invocation failed');
};
async function stop(h: AppWorkerHost) { const worker: Worker | null = (h as any).worker;h.terminate();if (worker) await worker.terminate(); }
function facts(name: string, value: object) {
    const target = process.env.AOTUI_W08_B2_FACTS_DIR;
    if (target) return mkdir(target, { recursive: true }).then(() => writeFile(path.join(target, name + '.json'), JSON.stringify(value, null, 2)));
}
it('B02/B06/B17/B19 fresh Workers restore state across two independent managed rounds', async () => {
    const f = await fixture();const first = host(f);let second: AppWorkerHost | undefined;
    try {
        await first.start();await first.open();expect(first.getPersistenceReport().support).toBe('managed');
        expect((await invokeTool(first, 'set', { value: 1 })).success).toBe(true);
        const firstWorker = (first as any).worker as Worker;
        const close = first.close();expect(first.close()).toBe(close);await close;
        expect(JSON.parse(f.read()!).value).toBe(1);
        expect(firstWorker.threadId).toBe(-1);
        second = host(f);await second.start();await second.open();
        const secondWorker = (second as any).worker as Worker;expect(secondWorker).not.toBe(firstWorker);
        const restored: any = await invokeTool(second, 'inspect');expect(restored.data.value).toBe(1);
        expect((await invokeTool(second, 'set', { value: 2 })).success).toBe(true);await second.close();
        expect(JSON.parse(f.read()!).value).toBe(2);
        expect(secondWorker.threadId).toBe(-1);
        expect(first.appInstanceId).not.toBe(second.appInstanceId);expect(second.getPersistenceReport()).toMatchObject({ support: 'managed', unsafe: false, actualIO: 0, ownerRetained: false, release: { status: 'released' }, lifecycle: { ok: true } });
        await facts('two-rounds', { fixture: f.body, first: first.getPersistenceReport(), second: second.getPersistenceReport(), freshWorker: true, value: 2 });
    } finally { await stop(first);if (second) await stop(second);await rm(f.root, { recursive: true, force: true }); }
}, 30000);
it.each([false, true])('starts, reinitializes and closes with zero storage I/O (persistence: %s)', async persistent => {
    const f = await fixture(persistent);let opens = 0;
    const h = host(f, { persistenceBackend: { async open() { opens++;throw Error('storage must not open'); } } });
    try {
        await h.start();await h.open();await h.reinitialize('Test a new projection without storing it');await h.close();
        expect((await h.waitForResourceRelease()).worker).toBe('exited');expect(opens).toBe(0);
        await facts(persistent ? 'enabled-unused' : 'disabled', { opens, report: h.getPersistenceReport() });
    }
    finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B17/B18 a closed Host rejects ordinary business before dispatch after physical exit', async () => {
    const f = await fixture(), h = host(f);
    try {
        await h.start();await h.open();
        const physical: Worker = (h as any).worker, post = physical.postMessage.bind(physical);let sent = 0;
        physical.postMessage = ((...args: Parameters<Worker['postMessage']>) => { sent++;return post(...args); }) as any;
        await h.close();sent = 0;
        await expect(invokeTool(h, 'inspect')).rejects.toThrow('APP_INTERACTION_UNAVAILABLE');
        expect(sent).toBe(0);physical.postMessage = post;
        expect(h.getPersistenceReport()).toMatchObject({ support: 'managed', lifecycle: { ok: true }, actualIO: 0, ownerRetained: false });
        expect(physical.threadId).toBe(-1);
        await facts('closed-business-admission', { report: h.getPersistenceReport(), businessRejectedBeforeDispatch: true });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B04/B12 actual default Hosts share backend ownership while separate app namespaces keep the same key independent', async () => {
    const f = await fixture(), first = host(f), busy = host(f), other = host(f, { config: { AOTUI_DATA_DIR: f.data, AOTUI_APP_KEY: 'other' } });
    try {
        await first.start();await first.open();await invokeTool(first, 'set', { value: 1 });expect((await invokeTool(first, 'flush') as any).data.ok).toBe(true);
        await busy.start();await busy.open();await invokeTool(busy, 'set', { value: 2 });const denied: any = await invokeTool(busy, 'flush');
        expect(denied.data).toMatchObject({ ok: false, entries: [{ issue: { code: 'NAMESPACE_BUSY' } }] });
        await expect(busy.close()).rejects.toThrow('PERSISTENCE_CLOSE_FAILED');expect((await busy.waitForResourceRelease()).worker).toBe('exited');
        await other.start();await other.open();await invokeTool(other, 'set', { value: 3 });await other.close();
        expect(JSON.parse(f.read('other')!).value).toBe(3);
        expect(JSON.parse(f.read()!).value).toBe(1);await first.close();
        await facts('default-shared-hosts', { first: first.getPersistenceReport(), busy: busy.getPersistenceReport(), other: other.getPersistenceReport(), defaultBackendActuallyShared: true });
    } finally { for (const h of [first, busy, other]) await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B15/B18 actual SQLite commit with lost IPC reply stays unknown, keeps the close failure after Worker exit', async () => {
    const f = await fixture(), backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const h = host(f, { timeout: 1200, persistenceBackend: backend });
    try {
        await h.start();await h.open();await invokeTool(h, 'set', { value: 9 });
        const worker: Worker = (h as any).worker;const send = worker.postMessage.bind(worker);let lost = 0;
        worker.postMessage = ((message: any) => { if (message.type === 'STATE_STORAGE_RESPONSE' && message.action === 'replace') { lost++;return; }send(message); }) as any;
        await expect(h.close()).rejects.toThrow();expect(lost).toBe(1);expect(JSON.parse(f.read()!).value).toBe(9);
        expect(h.getPersistenceReport().unsafe).toBe(true);await h.close().catch(() => {});expect((await h.waitForResourceRelease()).worker).toBe('exited');
        await facts('lost-mutation-reply', { lost, report: h.getPersistenceReport(), backend: backend.getStats(), valueOnDisk: 9 });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('returns UNKNOWN_OUTCOME to the App after a committed save loses its reply and blocks the next save', async () => {
    const f = await fixture(), backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const h = host(f, { timeout: 1800, persistenceBackend: backend });
    try {
        await h.start();await h.open();
        const worker: Worker = (h as any).worker, send = worker.postMessage.bind(worker);
        let lost = 0;
        worker.postMessage = ((message: any) => {
            if (message.type === 'STATE_STORAGE_RESPONSE' && message.action === 'replace') { lost++;return; }
            send(message);
        }) as any;
        await invokeTool(h, 'set', { value: 9 });
        const first = await invokeTool(h, 'flush', {}, 6000);
        expect(first).toMatchObject({ success: true, data: { ok: false, saveIssue: 'UNKNOWN_OUTCOME',
            entries: [{ revision: 1, status: 'unknown', issue: { code: 'UNKNOWN_OUTCOME' } }] } });
        await invokeTool(h, 'set', { value: 10 });
        const next = await invokeTool(h, 'flush');
        expect(next).toMatchObject({ success: true, data: { ok: false, saveIssue: 'UNKNOWN_OUTCOME',
            entries: [{ revision: 1, status: 'unknown' }, { revision: 2, status: 'failed' }] } });
        expect(lost).toBe(1);expect(JSON.parse(f.read()!).value).toBe(9);
        await expect(h.close()).rejects.toThrow('PERSISTENCE_CLOSE_FAILED');
        const resources = await h.waitForResourceRelease();
        expect(resources).toMatchObject({ worker: 'exited', resourcesReleased: true });
        expect(backend.getStats()).toMatchObject({ ownerSlots: 0, pendingStorageIO: 0 });
        await facts('lost-confirmation-at-author', { first, next, lost, resources, report: h.getPersistenceReport(), valueOnDisk: 9 });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B05/B18 actual initial render failure does not save defaults and releases', async () => {
    const f = await fixture();f.body = f.body.replace("function Root() {", "function Root() { throw Error('controlled render failure');");await writeFile(f.file, f.body);
    const backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS), h = host(f, { persistenceBackend: backend });
    try {
        await h.start();await expect(h.open()).rejects.toMatchObject({ code: 'E_OPEN_FAILED', appId: 'app', phase: 'OPEN',
            cause: { name: 'Error', message: 'controlled render failure', stack: expect.stringContaining('Root') } });
        expect(h.getPersistenceReport()).toMatchObject({ unsafe: false, lifecycle: { ok: true, flush: { ok: true, entries: [] },
            dispose: { release: { status: 'released' } } } });
        expect(f.read()).toBeUndefined();await h.close().catch(() => {});
        expect(await h.waitForResourceRelease()).toMatchObject({ worker: 'exited', storage: { unsafe: false }, resourcesReleased: true });
        expect(backend.getStats().ownerSlots).toBe(0);await facts('failed-initial-commit', { fixture: f.body, report: h.getPersistenceReport(), backend: backend.getStats(), noDefaultRecord: true });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B18 actual unmount throw still disposes storage, reports failure and prevents pooling', async () => {
    const f = await fixture();f.body = f.body.replace('export default createTUIApp', 'const factory = createTUIApp') + `
const initialize = factory.initialize.bind(factory);
factory.initialize = async (...args) => { const renderer = await initialize(...args);return { ...renderer, close() { renderer.close();throw Error('private unmount detail'); } }; };
export default factory;
`;await writeFile(f.file, f.body);
    const backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS), h = host(f, { persistenceBackend: backend });
    try {
        await h.start();await h.open();await invokeTool(h, 'set', { value: 4 });await expect(h.close()).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED');
        const report = h.getPersistenceReport();expect(report).toMatchObject({ unsafe: false, lifecycle: { ok: true, unmount: 'failed',
            flush: { ok: true, entries: [{ status: 'saved' }] }, dispose: { release: { status: 'released' } } } });
        expect(JSON.parse(f.read()!).value).toBe(4);
        expect(JSON.stringify(report)).not.toContain('private unmount detail');expect(backend.getStats().ownerSlots).toBe(0);await h.close().catch(() => {});expect((await h.waitForResourceRelease()).worker).toBe('exited');
        await facts('unmount-failure', { fixture: f.body, report, backend: backend.getStats() });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B15/B18 real Worker termination does not release an owner while its admitted backend mutation is held', async () => {
    const f = await fixture(), backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS);
    let entered!: () => void, finish!: () => void;
    const barrier = new Promise<void>(resolve => { entered = resolve; }), completion = new Promise<void>(resolve => { finish = resolve; });
    const h = host(f, { persistenceBackend: { async open(input: any) {
        const result = await backend.open(input);if (result.status !== 'opened') return result;
        return { status: 'opened', storage: { ...result.storage, async replace(address: any, text: string) { entered();await completion;return result.storage.replace(address, text); } } };
    } } });
    try {
        await h.start();await h.open();await invokeTool(h, 'set', { value: 12 });const closed = h.close().then(() => 'success', () => 'failed');await barrier;
        expect(h.getPersistenceReport()).toMatchObject({ actualIO: 1, ownerRetained: true });
        const physical: Worker = (h as any).worker;h.terminate();const resources = h.waitForResourceRelease();
        let resourcesDone = false;void resources.then(() => { resourcesDone = true; });expect(await closed).toBe('failed');
        await vi.waitFor(() => expect(h.getPersistenceReport().closing).toBe(true), { timeout: 1000 });
        expect(backend.getStats().ownerSlots).toBe(1);expect(h.getPersistenceReport()).toMatchObject({ actualIO: 1, ownerRetained: true, closing: true, unsafe: true });
        expect(resourcesDone).toBe(false);expect(h.getResourceReport().resourcesReleased).toBe(false);
        finish();const resourceReport = await resources;
        expect(resourceReport).toMatchObject({ worker: 'exited', resourcesReleased: true });expect(physical.threadId).toBe(-1);
        expect(backend.getStats().ownerSlots).toBe(0);expect(h.getPersistenceReport()).toMatchObject({ actualIO: 0, ownerRetained: false, unsafe: true });
        expect(JSON.parse(f.read()!).value).toBe(12);
        await facts('terminated-held-mutation', { report: h.getPersistenceReport(), resourceReport, backend: backend.getStats(), actualEffectCompletedAfterDisconnect: true });
    } finally { finish();await stop(h);await h.waitForResourceRelease();await rm(f.root, { recursive: true, force: true }); }
}, 15000);
