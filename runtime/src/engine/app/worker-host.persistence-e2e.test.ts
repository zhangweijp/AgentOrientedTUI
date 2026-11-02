import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { AppWorkerHost } from './worker-host.js';
import { createNodeStateStorage } from '../../adapters/storage/node-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from './state-storage-host.js';
import { invokeObservedTool, linkPreactPeer } from '../../../tests/fixtures/semantic-worker-tools.js';
const repo = path.resolve(process.cwd(), '..');
const url = (p: string) => pathToFileURL(p).href;
async function fixture(persistent = true) {
    const root = await mkdtemp(path.join(tmpdir(), 'aotui-b2-worker-'));
    await linkPreactPeer(root);
    const file = path.join(root, 'app.mjs');
    const body = `import { h } from 'preact';import { createTUIApp, usePersistentState, useAppRuntimeContext, View, useViewTypeTool } from ${JSON.stringify(url(path.join(repo, 'sdk/dist/index.js')))};
let setter, port, value; const generations = new Map();
function Root() {
  ${persistent ? `const tuple = usePersistentState('state', 0); [value, setter] = tuple;
  port = useAppRuntimeContext().persistence;
  if (port && !generations.has(port.instanceId)) generations.set(port.instanceId, setter);` : ''}
  return h(View,{id:'root',type:'Root'},h(Operations));
}
function Operations() {
  const [Set] = useViewTypeTool('set',{description:'Set persisted value',isMutating:true,params:{value:{type:'number',required:true}}},async args=>{setter(args.value);return {success:true};});
  const [Old] = useViewTypeTool('old',{description:'Check a previous setter',isMutating:false,params:{}},async()=>{const first=[...generations.values()][0];try{first(()=>{throw Error('old updater ran');});}catch(e){return {success:true,data:{code:e.code}};}return {success:true,data:{code:'BAD'}};});
  const [Flush] = useViewTypeTool('flush',{description:'Flush persisted state',isMutating:false,params:{}},async()=>({success:true,data:await port.flush()}));
  const [Inspect] = useViewTypeTool('inspect',{description:'Inspect persisted state',isMutating:false,params:{}},async()=>({success:true,data:{value}}));
  return h('section',{},[h(Set,{key:'set'}),h(Old,{key:'old'}),h(Flush,{key:'flush'}),h(Inspect,{key:'inspect'})]);
}
export default createTUIApp({ app_name: 'test', component: Root });
`;
    await writeFile(file, body);
    return { root, file, body, data: path.join(root, 'data'), record: path.join(root, 'data/app-state/d/test/state.json') };
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
    config: { AOTUI_DATA_DIR: f.data, AOTUI_APP_NAME: 'test' }, ...extra });
};
const operation = async (h: AppWorkerHost, op: string, args = {}) => {
    const result = await invokeObservedTool(h, op, args, 'root');
    if (result?.kind === 'receipt' && result.receipt.outcome.status === 'succeeded') return result.receipt.outcome.value;
    throw new Error(result?.kind === 'receipt' ? result.receipt.outcome.status : result?.code ?? 'Tool invocation failed');
};
async function stop(h: AppWorkerHost) { const worker: Worker | null = (h as any).worker;h.terminate();if (worker) await worker.terminate(); }
function facts(name: string, value: object) {
    const target = process.env.AOTUI_W08_B2_FACTS_DIR;
    if (target) return mkdir(target, { recursive: true }).then(() => writeFile(path.join(target, name + '.json'), JSON.stringify(value, null, 2)));
}
it('B02/B06/B17/B19 actual emitted Worker reused for two independent managed rounds', async () => {
    const f = await fixture();let first = host(f), second: AppWorkerHost | undefined, pooled: Worker | null = null;
    try {
        await first.start();await first.open();expect(first.getPersistenceReport().support).toBe('managed');
        expect((await operation(first, 'set', { value: 1 })).success).toBe(true);
        const close = first.close();expect(first.close()).toBe(close);await close;
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(1);
        pooled = await first.releaseWorker();expect(pooled).not.toBeNull();const threadId = pooled!.threadId;
        second = host(f, { existingWorker: pooled });await second.start();await second.open();
        const restored: any = await operation(second, 'flush');expect(restored.data.ok).toBe(true);
        const stale: any = await operation(second, 'old');expect(['STALE_BINDING', 'DISPOSED']).toContain(stale.data.code);
        expect((await operation(second, 'set', { value: 2 })).success).toBe(true);await second.close();
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(2);
        const returned = await second.releaseWorker();expect(returned!.threadId).toBe(threadId);
        expect(first.appInstanceId).not.toBe(second.appInstanceId);expect(second.getPersistenceReport()).toMatchObject({ support: 'managed', unsafe: false, actualIO: 0, ownerRetained: false, release: { status: 'released' }, lifecycle: { ok: true } });
        await facts('two-rounds', { fixture: f.body, first: first.getPersistenceReport(), second: second.getPersistenceReport(), samePhysicalThread: true, threadId, value: 2 });
        await returned!.terminate();pooled = null;
    } finally { await stop(first);if (second) await stop(second);if (pooled) await pooled.terminate();await rm(f.root, { recursive: true, force: true }); }
}, 30000);
it('B03/B17 actual new SDK factory without Hook starts/closes/resets with zero storage I/O', async () => {
    const f = await fixture(false);let opens = 0;
    const h = host(f, { persistenceBackend: { async open() { opens++;throw Error('storage must not open'); } } });
    try { await h.start();await h.open();await h.close();const worker = await h.releaseWorker();expect(worker).not.toBeNull();expect(opens).toBe(0);await worker!.terminate();await facts('unused', { opens, report: h.getPersistenceReport() }); }
    finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B17/B18 a closed Host rejects ordinary business before dispatch while its physical Worker awaits RESET', async () => {
    const f = await fixture(), h = host(f);
    try {
        await h.start();await h.open();await h.close();
        const physical: Worker = (h as any).worker, post = physical.postMessage.bind(physical);let sent = 0;
        physical.postMessage = ((...args: Parameters<Worker['postMessage']>) => { sent++;return post(...args); }) as any;
        await expect(operation(h, 'inspect')).rejects.toThrow('REF_EXECUTION_UNAVAILABLE');
        expect(sent).toBe(0);physical.postMessage = post;
        expect(h.getPersistenceReport()).toMatchObject({ support: 'managed', lifecycle: { ok: true }, actualIO: 0, ownerRetained: false });
        const worker = await h.releaseWorker();expect(worker).not.toBeNull();await worker!.terminate();
        await facts('closed-business-admission', { report: h.getPersistenceReport(), businessRejectedBeforeDispatch: true });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B04/B12 actual default Hosts share backend ownership while separate app namespaces keep the same key independent', async () => {
    const f = await fixture(), first = host(f), busy = host(f), other = host(f, { config: { AOTUI_DATA_DIR: f.data, AOTUI_APP_NAME: 'other' } });
    try {
        await first.start();await first.open();await operation(first, 'set', { value: 1 });expect((await operation(first, 'flush') as any).data.ok).toBe(true);
        await busy.start();await busy.open();const denied: any = await operation(busy, 'flush');
        expect(denied.data).toMatchObject({ ok: false, entries: [{ issue: { code: 'NAMESPACE_BUSY' } }] });
        await expect(busy.close()).rejects.toThrow('PERSISTENCE_CLOSE_FAILED');expect(await busy.releaseWorker()).toBeNull();
        await other.start();await other.open();await operation(other, 'set', { value: 3 });await other.close();
        expect(JSON.parse(await readFile(path.join(f.data, 'app-state/d/other/state.json'), 'utf8')).value).toBe(3);
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(1);await first.close();
        await facts('default-shared-hosts', { first: first.getPersistenceReport(), busy: busy.getPersistenceReport(), other: other.getPersistenceReport(), defaultBackendActuallyShared: true });
    } finally { for (const h of [first, busy, other]) await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B15/B18 actual rename with lost IPC reply stays unknown, fails close and cannot pool', async () => {
    const f = await fixture(), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const h = host(f, { timeout: 1200, persistenceBackend: backend });
    try {
        await h.start();await h.open();await operation(h, 'set', { value: 9 });
        const worker: Worker = (h as any).worker;const send = worker.postMessage.bind(worker);let lost = 0;
        worker.postMessage = ((message: any) => { if (message.type === 'STATE_STORAGE_RESPONSE' && message.operation === 'replace') { lost++;return; }send(message); }) as any;
        await expect(h.close()).rejects.toThrow();expect(lost).toBe(1);expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(9);
        expect(h.getPersistenceReport().unsafe).toBe(true);expect(await h.releaseWorker()).toBeNull();
        await facts('lost-mutation-reply', { lost, report: h.getPersistenceReport(), backend: backend.getStats(), valueOnDisk: 9 });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B05/B18 actual initial duplicate binding failure never saves partial defaults and releases admitted owner', async () => {
    const f = await fixture();f.body = f.body.replace("const tuple = usePersistentState('state', 0);", "usePersistentState('state', 0);const tuple = usePersistentState('state', 0);");await writeFile(f.file, f.body);
    const backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS), h = host(f, { persistenceBackend: backend });
    try {
        await h.start();await expect(h.open()).rejects.toThrow('Managed persistence did not complete');
        expect(h.getPersistenceReport()).toMatchObject({ unsafe: true, lifecycle: { ok: false, dispose: { release: { status: 'released' } } } });
        await expect(readFile(f.record)).rejects.toHaveProperty('code', 'ENOENT');expect(await h.releaseWorker()).toBeNull();
        expect(backend.getStats().ownerSlots).toBe(0);await facts('failed-initial-commit', { fixture: f.body, report: h.getPersistenceReport(), backend: backend.getStats(), noDefaultFile: true });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B18 actual unmount throw still disposes storage, reports failure and prevents pooling', async () => {
    const f = await fixture();f.body = f.body.replace('export default createTUIApp', 'const factory = createTUIApp') + `
const initialize = factory.initializeComponent.bind(factory);
factory.initializeComponent = async (...args) => { const renderer = await initialize(...args);return { ...renderer, unmount() { renderer.unmount();throw Error('private unmount detail'); } }; };
export default factory;
`;await writeFile(f.file, f.body);
    const backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS), h = host(f, { persistenceBackend: backend });
    try {
        await h.start();await h.open();await operation(h, 'set', { value: 4 });await expect(h.close()).rejects.toThrow('PERSISTENCE_CLOSE_FAILED');
        const report = h.getPersistenceReport();expect(report).toMatchObject({ unsafe: true, lifecycle: { ok: false, unmount: 'failed', dispose: { release: { status: 'released' } } } });
        expect(JSON.stringify(report)).not.toContain('private unmount detail');expect(backend.getStats().ownerSlots).toBe(0);expect(await h.releaseWorker()).toBeNull();
        await facts('unmount-failure', { fixture: f.body, report, backend: backend.getStats() });
    } finally { await stop(h);await rm(f.root, { recursive: true, force: true }); }
}, 15000);
it('B15/B18 real Worker termination does not release an owner while its admitted backend mutation is held', async () => {
    const f = await fixture(), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
    let entered!: () => void, finish!: () => void;
    const barrier = new Promise<void>(resolve => { entered = resolve; }), completion = new Promise<void>(resolve => { finish = resolve; });
    const h = host(f, { persistenceBackend: { async open(input: any) {
        const result = await backend.open(input);if (result.status !== 'opened') return result;
        return { status: 'opened', storage: { ...result.storage, async replace(address: any, text: string) { entered();await completion;return result.storage.replace(address, text); } } };
    } } });
    try {
        await h.start();await h.open();await operation(h, 'set', { value: 12 });const closed = h.close().then(() => 'success', () => 'failed');await barrier;
        expect(h.getPersistenceReport()).toMatchObject({ actualIO: 1, ownerRetained: true });
        const physical: Worker = (h as any).worker;h.terminate();const resources = h.waitForResourceRelease();
        let resourcesDone = false;void resources.then(() => { resourcesDone = true; });expect(await closed).toBe('failed');
        await vi.waitFor(() => expect(h.getPersistenceReport().closing).toBe(true), { timeout: 1000 });
        expect(backend.getStats().ownerSlots).toBe(1);expect(h.getPersistenceReport()).toMatchObject({ actualIO: 1, ownerRetained: true, closing: true, unsafe: true });
        expect(resourcesDone).toBe(false);expect(h.getResourceReport().resourcesReleased).toBe(false);
        finish();const resourceReport = await resources;
        expect(resourceReport).toMatchObject({ worker: 'exited', resourcesReleased: true });expect(physical.threadId).toBe(-1);
        expect(backend.getStats().ownerSlots).toBe(0);expect(h.getPersistenceReport()).toMatchObject({ actualIO: 0, ownerRetained: false, unsafe: true });
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(12);
        await facts('terminated-held-mutation', { report: h.getPersistenceReport(), resourceReport, backend: backend.getStats(), actualEffectCompletedAfterDisconnect: true });
    } finally { finish();await stop(h);await h.waitForResourceRelease();await rm(f.root, { recursive: true, force: true }); }
}, 15000);
