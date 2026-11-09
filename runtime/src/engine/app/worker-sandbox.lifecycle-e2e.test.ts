import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WorkerSandbox } from './worker-sandbox.js';
import { WorkerPool } from './worker-pool.js';
import { createNodeStateStorage } from '../../adapters/storage/node-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from './state-storage-host.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { invokeObservedTool, linkPreactPeer } from '../../../tests/fixtures/semantic-worker-tools.js';

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
async function fixture(scenario = 'normal') {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-sandbox-')), app = join(dir, 'app.mjs');
    await linkPreactPeer(dir);
    const body = `import {h} from 'preact';import Type from 'typebox';import {createTUIApp,defineViewTypeTool,usePersistentState,useAppRuntimeContext,View,AppTools, ToolRef, defineToolSet} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};
let setter,value,port;const old=new Map();const noArgs=Type.Object({}, {additionalProperties:false});





const fixtureTools0 = defineToolSet({
Set: defineViewTypeTool({viewType:'Root',name:'set',description:'Set persisted value',inputSchema:Type.Object({value:Type.Number()}, {additionalProperties:false}),}),
Flush: defineViewTypeTool({viewType:'Root',name:'flush',description:'Flush persisted state',inputSchema:noArgs,}),
Old: defineViewTypeTool({viewType:'Root',name:'old',description:'Check previous setter',inputSchema:noArgs,}),
Inspect: defineViewTypeTool({viewType:'Root',name:'inspect',description:'Inspect persisted state',inputSchema:noArgs,})
});
function Tools(){
const Set = fixtureTools0.Set;
const Flush = fixtureTools0.Flush;
const Old = fixtureTools0.Old;
const Inspect = fixtureTools0.Inspect;
return h(AppTools, { definition: fixtureTools0, bindings: {
Set: { execute: async args=>{setter(args.value);return {success:true};} },
Flush: { execute: async()=>({success:true,data:await port.flush()}) },
Old: { execute: async()=>{try{[...old.values()][0](()=>{throw Error('stale updater executed');});return {success:true,data:{code:'BAD'}};}catch(error){return {success:true,data:{code:error.code}};}} },
Inspect: { execute: async()=>({success:true,data:{value}}) }
} }, h('section',{},[h(ToolRef,{ tool: Set, ...({key:'set'}) }),h(ToolRef,{ tool: Flush, ...({key:'flush'}) }),h(ToolRef,{ tool: Old, ...({key:'old'}) }),h(ToolRef,{ tool: Inspect, ...({key:'inspect'}) })]));}
function Root(){${scenario === 'initial-failure' ? "usePersistentState('value',0);" : ''}[value,setter]=usePersistentState('value',0);port=useAppRuntimeContext().persistence;if(port&&!old.has(port.instanceId))old.set(port.instanceId,setter);return h(View,{kind: 'instruction',id:'root',type:'Root'},h(Tools));}
const factory=createTUIApp({app_name:'c1',component:Root});
${scenario === 'unmount-failure' ? "const initialize=factory.initializeComponent.bind(factory);factory.initializeComponent=async(...args)=>{const renderer=await initialize(...args);return {...renderer,unmount(){renderer.unmount();throw Error('private unmount failure');}};};" : ''}
export default factory;`;
    await capture(app, body);
    const options = { appId: 'app' as any, desktopId: 'd' as any, appModulePath: url(app), workerScriptPath: join(repo, 'runtime/dist/worker-runtime/index.js'),
        runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 1500, pool: { initialSize: 0, maxSize: 1 } } }), config: { AOTUI_DATA_DIR: join(dir, 'data'), AOTUI_APP_KEY: 'c1' } };
    return { dir, app, options, record: join(dir, 'data/app-state/d/c1/value.json') };
}
async function invokeTool(sandbox: WorkerSandbox, name: string, args: Record<string, unknown> = {}) {
    const result = await invokeObservedTool((sandbox as any).workerHost, name, args, 'root');
    if (result?.kind === 'receipt' && result.receipt.outcome.status === 'succeeded') return result.receipt.outcome.value;
    throw new Error(result?.kind === 'receipt' ? result.receipt.outcome.status : result?.code ?? 'Tool invocation failed');
}
it('C1-09/16/17 actual SDK two Host rounds use one physical leased Worker', async () => {
    const f = await fixture(), pool = new WorkerPool({ initialSize: 0, maxSize: 1 }), sandboxes: WorkerSandbox[] = [];
    try {
        const a = new WorkerSandbox({ ...f.options, workerPool: pool });sandboxes.push(a);await a.installDynamic();
        await expect(a.installDynamic()).rejects.toHaveProperty('code', 'SANDBOX_ALREADY_INSTALLED');const worker = (a as any).lease.worker, firstHost = (a as any).workerHost;
        await invokeTool(a, 'set', { value: 1 });await a.close();const first = await a.disposeAsync();
        expect(first).toMatchObject({ ok: true, resourcesReleased: true, host: { worker: 'transferred', storage: { support: 'managed', lifecycle: { ok: true } } }, lease: { disposition: 'pooled' } });
        expect(pool.getReport()).toMatchObject({ total: 1, idle: 1 });expect(worker.threadId).toBeGreaterThan(0);
        const b = new WorkerSandbox({ ...f.options, workerPool: pool });sandboxes.push(b);await b.installDynamic();
        expect((b as any).lease.worker).toBe(worker);expect((b as any).workerHost.appInstanceId).not.toBe(firstHost.appInstanceId);
        const flush: any = await invokeTool(b, 'flush');expect(flush.data.ok).toBe(true);
        expect((await invokeTool(b, 'inspect') as any).data.value).toBe(1);
        expect(['STALE_BINDING', 'DISPOSED']).toContain((await invokeTool(b, 'old') as any).data.code);
        await (a as any).lease.release(false);await a.disposeAsync();firstHost.terminate();expect(pool.getReport().leased).toBe(1);
        expect((await invokeTool(b, 'inspect') as any).success).toBe(true);
        await invokeTool(b, 'set', { value: 2 });await b.close();const second = await b.disposeAsync();
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(2);expect(second.ok).toBe(true);await pool.destroy();expect(worker.threadId).toBe(-1);
        await facts('sandbox-reuse', { first, second, staleLeaseAndHostHarmless: true, samePhysicalWorker: true, closedPool: pool.getReport() });
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
            await sandbox.installDynamic();await invokeTool(sandbox, 'set', { value: 7 });
            if (scenario === 'lost-reply') { const worker = (sandbox as any).lease.worker, post = worker.postMessage.bind(worker);worker.postMessage = (message: any) => { if (message.type !== 'STATE_STORAGE_RESPONSE' || message.action !== 'replace') post(message); }; }
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
        await sandbox.installDynamic();await invokeTool(sandbox, 'set', { value: 9 });const closing = sandbox.disposeAsync();await entered.promise;
        const before = sandbox.getCloseReport();expect(before).toMatchObject({ state: 'closing', resourcesReleased: false, host: { storage: { actualIO: 1, ownerRetained: true } } });
        expect(pool.getReport()).toMatchObject({ total: 1, leased: 1 });expect(backend.getStats().ownerSlots).toBe(1);
        finish.resolve();const report = await closing;expect(report).toMatchObject({ ok: true, resourcesReleased: true, lease: { disposition: 'pooled' } });
        expect(backend.getStats().ownerSlots).toBe(0);expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(9);await pool.destroy();
        await facts('sandbox-held-save', { before, report, backend: backend.getStats(), parentPool: pool.getReport() });
    } finally { finish.resolve();await sandbox.disposeAsync();await pool.destroy();await rm(f.dir, { recursive: true, force: true }); }
}, 15000);
