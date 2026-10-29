import { expect, it } from 'vitest';
import { linkArchivedSdkDependencies } from '../../../tests/fixtures/archived-sdk-dependencies.mjs';
import { mkdtemp, writeFile, readFile, mkdir, cp, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WorkerSandbox } from './worker-sandbox.js';
import { WorkerPool } from './worker-pool.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { createNodeStateStorage } from '../../adapters/storage/node-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from './state-storage-host.js';

const repo = resolve(process.cwd(), '..'), url = (p: string) => pathToFileURL(p).href;
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
async function capture(file: string, body: string) {
    await writeFile(file, body);const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) {
        const hash = createHash('sha256').update(body).digest('hex');await mkdir(join(folder, 'c1-inputs'), { recursive: true });
        await writeFile(join(folder, 'c1-inputs', hash), body);await writeFile(join(folder, 'c1-inputs', hash + '.json'), JSON.stringify({ path: file, sha256: hash, capturedBeforeSandboxConstruction: true }));
    }
}
async function facts(name: string, value: object) {
    const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) { await mkdir(folder, { recursive: true });await writeFile(join(folder, 'c1-' + name + '.json'), JSON.stringify(value, null, 2)); }
}
async function fixture(scenario = 'normal', sdk = join(repo, 'sdk/dist/index.js')) {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-sandbox-')), app = join(dir, 'app.mjs');
    const body = `import {createTUIApp,usePersistentState,useAppRuntimeContext} from ${JSON.stringify(url(sdk))};
let setter,value,port;const old=new Map();
function Root(){${scenario === 'initial-failure' ? "usePersistentState('value',0);" : ''}[value,setter]=usePersistentState('value',0);port=useAppRuntimeContext().persistence;if(port&&!old.has(port.instanceId))old.set(port.instanceId,setter);return null;}
const factory=createTUIApp({app_name:'c1',component:Root,onOperation:async(op,args)=>{
if(op==='set')setter(args.value);if(op==='flush')return {success:true,data:await port.flush()};
if(op==='old'){try{[...old.values()][0](()=>{throw Error('stale updater executed');});return {success:true,data:{code:'BAD'}};}catch(error){return {success:true,data:{code:error.code}};}}
return {success:true,data:{value}};}});
${scenario === 'unmount-failure' ? "const initialize=factory.initializeComponent.bind(factory);factory.initializeComponent=async(...args)=>{const renderer=await initialize(...args);return {...renderer,unmount(){renderer.unmount();throw Error('private unmount failure');}};};" : ''}
export default factory;`;
    await capture(app, body);
    const options = { appId: 'app' as any, desktopId: 'd' as any, appModulePath: url(app), workerScriptPath: join(repo, 'runtime/dist/worker-runtime/index.js'),
        runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 1500, pool: { initialSize: 0, maxSize: 1 } } }), config: { AOTUI_DATA_DIR: join(dir, 'data'), AOTUI_APP_NAME: 'c1' } };
    return { dir, app, options, record: join(dir, 'data/app-state/d/c1/value.json') };
}
it.each([false, true])('C1-09/16/17 actual SDK two Host rounds use one physical leased Worker, Shadow=%s', async snapshotShadow => {
    const f = await fixture(), pool = new WorkerPool({ initialSize: 0, maxSize: 1 }), sandboxes: WorkerSandbox[] = [];
    try {
        const a = new WorkerSandbox({ ...f.options, workerPool: pool, snapshotShadow });sandboxes.push(a);await a.installDynamic();
        await expect(a.installDynamic()).rejects.toHaveProperty('code', 'SANDBOX_ALREADY_INSTALLED');const worker = (a as any).lease.worker, firstHost = (a as any).workerHost;
        await a.executeOperation('set' as any, { value: 1 }, 's' as any);await a.close();const first = await a.disposeAsync();
        expect(first).toMatchObject({ ok: true, resourcesReleased: true, host: { worker: 'transferred', storage: { support: 'managed', lifecycle: { ok: true } } }, lease: { disposition: 'pooled' } });
        expect(pool.getReport()).toMatchObject({ total: 1, idle: 1 });expect(worker.threadId).toBeGreaterThan(0);
        const b = new WorkerSandbox({ ...f.options, workerPool: pool, snapshotShadow });sandboxes.push(b);await b.installDynamic();
        expect((b as any).lease.worker).toBe(worker);expect((b as any).workerHost.appInstanceId).not.toBe(firstHost.appInstanceId);
        const flush: any = await b.executeOperation('flush' as any, {}, 's' as any);expect(flush.data.ok).toBe(true);
        expect((await b.executeOperation('inspect' as any, {}, 's' as any) as any).data.value).toBe(1);
        expect(['STALE_BINDING', 'DISPOSED']).toContain((await b.executeOperation('old' as any, {}, 's' as any) as any).data.code);
        await (a as any).lease.release(false);a.dispose();firstHost.terminate();expect(pool.getReport().leased).toBe(1);
        expect((await b.executeOperation('inspect' as any, {}, 's' as any) as any).success).toBe(true);
        await b.executeOperation('set' as any, { value: 2 }, 's' as any);await b.close();const second = await b.disposeAsync();
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(2);expect(second.ok).toBe(true);await pool.destroy();expect(worker.threadId).toBe(-1);
        await facts('sandbox-reuse-' + snapshotShadow, { first, second, staleLeaseAndHostHarmless: true, samePhysicalWorker: true, closedPool: pool.getReport() });
    } finally { for (const s of sandboxes) await s.disposeAsync();await pool.destroy();await rm(f.dir, { recursive: true, force: true }); }
}, 20000);

it.each(['save-failure', 'lost-reply', 'unmount-failure', 'initial-failure'])('C1-15/16 actual SDK %s is retained and cannot return a healthy Worker', async scenario => {
    const f = await fixture(scenario), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const persistenceBackend = scenario === 'save-failure' ? { async open(input: any) { const result = await backend.open(input);return result.status !== 'opened' ? result : { status: 'opened', storage: { ...result.storage, async replace() { return { status: 'failed', issue: { code: 'IO_FAILED' } }; } } }; } } : backend;
    // Test-only internal Host adapter, passed through the existing constructor spread; no public Sandbox option is added.
    const sandbox = new WorkerSandbox({ ...f.options, persistenceBackend } as any);
    try {
        if (scenario === 'initial-failure') await expect(sandbox.installDynamic()).rejects.toHaveProperty('code', 'INSTALL_FAILED');
        else {
            await sandbox.installDynamic();await sandbox.executeOperation('set' as any, { value: 7 }, 's' as any);
            if (scenario === 'lost-reply') { const worker = (sandbox as any).lease.worker, post = worker.postMessage.bind(worker);worker.postMessage = (message: any) => { if (message.type !== 'STATE_STORAGE_RESPONSE' || message.operation !== 'replace') post(message); }; }
        }
        const worker = (sandbox as any).lease.worker, reportPromise = sandbox.disposeAsync();expect(sandbox.disposeAsync()).toBe(reportPromise);
        await expect(sandbox.close()).rejects.toHaveProperty('code', 'SANDBOX_CLOSE_FAILED');const report = await reportPromise;
        expect(report).toMatchObject({ state: 'settled', ok: false, resourcesReleased: true, ownedPool: { state: 'closed', total: 0 }, lease: { disposition: 'exited' }, host: { storage: { support: 'managed', unsafe: true } } });
        expect(worker.threadId).toBe(-1);expect(backend.getStats().ownerSlots).toBe(0);expect(report.issues.length).toBeLessThanOrEqual(5);expect(JSON.stringify(report)).not.toContain('private');
        expect(sandbox.getCloseReport()).toBe(report);if (scenario === 'lost-reply') expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(7);
        await facts('sandbox-' + scenario, { report, backend: backend.getStats(), physicalThreadId: worker.threadId });
    } finally { await sandbox.disposeAsync();await rm(f.dir, { recursive: true, force: true }); }
}, 20000);

it('C1-12 actual Sandbox keeps the Host owner while final save is held; healthy return waits for real completion', async () => {
    const f = await fixture(), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS), entered = defer(), finish = defer();
    const pool = new WorkerPool({ initialSize: 0, maxSize: 1 });
    const sandbox = new WorkerSandbox({ ...f.options, workerPool: pool, persistenceBackend: { async open(input: any) {
        const result = await backend.open(input);return result.status !== 'opened' ? result : { status: 'opened', storage: { ...result.storage,
            async replace(address: any, text: string) { entered.resolve();await finish.promise;return result.storage.replace(address, text); } } };
    } } } as any);
    try {
        await sandbox.installDynamic();await sandbox.executeOperation('set' as any, { value: 9 }, 's' as any);const closing = sandbox.disposeAsync();await entered.promise;
        const before = sandbox.getCloseReport();expect(before).toMatchObject({ state: 'closing', resourcesReleased: false, host: { storage: { actualIO: 1, ownerRetained: true } } });
        expect(pool.getReport()).toMatchObject({ total: 1, leased: 1 });expect(backend.getStats().ownerSlots).toBe(1);
        finish.resolve();const report = await closing;expect(report).toMatchObject({ ok: true, resourcesReleased: true, lease: { disposition: 'pooled' } });
        expect(backend.getStats().ownerSlots).toBe(0);expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(9);await pool.destroy();
        await facts('sandbox-held-save', { before, report, backend: backend.getStats(), parentPool: pool.getReport() });
    } finally { finish.resolve();await sandbox.disposeAsync();await pool.destroy();await rm(f.dir, { recursive: true, force: true }); }
}, 15000);

it('C1-17 actual archived SDK remains explicitly legacy-unverified through Sandbox close', async () => {
    const oldPacket = process.env.AOTUI_W08_B2_BASELINE ?? join(repo, 'rfcs/sdk-runtime-delivery/w08-b1-20261026T054703Z');
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-old-')), app = join(dir, 'app.mjs');await cp(join(oldPacket, 'artifacts/sdk/dist'), join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');await linkArchivedSdkDependencies(repo, dir);
    await capture(app, `import {createTUIApp} from ${JSON.stringify(url(join(dir, 'dist/index.js')))};export default createTUIApp({app_name:'old',component:()=>null});`);
    const sandbox = new WorkerSandbox({ appId: 'old' as any, desktopId: 'd' as any, appModulePath: url(app), workerScriptPath: join(repo, 'runtime/dist/worker-runtime/index.js'), runtimeConfig: defineRuntimeConfig({ worker: { pool: { initialSize: 0, maxSize: 1 } } }) });
    try { await sandbox.installDynamic();await sandbox.close();const report = await sandbox.disposeAsync();expect(report).toMatchObject({ ok: true, resourcesReleased: true, host: { storage: { support: 'legacy-unverified' } }, ownedPool: { state: 'closed' } });await facts('sandbox-old-sdk', { oldPacket, report, managedSaveClaimed: false }); }
    finally { await sandbox.disposeAsync();await rm(dir, { recursive: true, force: true }); }
}, 15000);
