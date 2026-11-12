import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WorkerSandbox } from './worker-sandbox.js';
import { WorkerCapacity } from './worker-capacity.js';
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
    const body = `import {h} from 'preact';import Type from 'typebox';import {createTUIApp,defineViewTypeTool,usePersistentState,useAppRuntimeContext,View,AppTools, defineToolSet} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};
let setter,value,port;globalThis.__p1Probe=(globalThis.__p1Probe??0)+1;let inspections=0;const noArgs=Type.Object({}, {additionalProperties:false});





const fixtureTools0 = defineToolSet({
Set: defineViewTypeTool({viewType:'Root',name:'set',description:'Set persisted value',inputSchema:Type.Object({value:Type.Number()}, {additionalProperties:false}),}),
Flush: defineViewTypeTool({viewType:'Root',name:'flush',description:'Flush persisted state',inputSchema:noArgs,}),
Inspect: defineViewTypeTool({viewType:'Root',name:'inspect',description:'Inspect persisted state',inputSchema:noArgs,})
});
function Tools(){
return h(AppTools, { definition: fixtureTools0, bindings: {
Set: { execute: async args=>{setter(args.value);return {success:true};} },
Flush: { execute: async()=>({success:true,data:await port.flush()}) },
Inspect: { execute: async()=>({success:true,data:{value,inspections:++inspections,realm:globalThis.__p1Probe}}) }
} }, 'Persistent state');}
function Root(){${scenario === 'initial-failure' ? "usePersistentState('value',0);" : ''}[value,setter]=usePersistentState('value',0);port=useAppRuntimeContext().persistence;return h(View,{kind: 'instruction',id:'root',type:'Root'},h(Tools));}
const factory=createTUIApp({app_name:'c1',component:Root});
${scenario === 'unmount-failure' ? "const initialize=factory.initialize.bind(factory);factory.initialize=async(...args)=>{const renderer=await initialize(...args);return {...renderer,close(){renderer.close();throw Error('private unmount failure');}};};" : ''}
export default factory;`;
    await capture(app, body);
    const options = { appId: 'app' as any, desktopId: 'd' as any, appModulePath: url(app), workerScriptPath: join(repo, 'runtime/dist/worker-runtime/index.js'),
        runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 1500, maxWorkers: 1 } }), config: { AOTUI_DATA_DIR: join(dir, 'data'), AOTUI_APP_KEY: 'c1' } };
    return { dir, app, options, record: join(dir, 'data/app-state/d/c1/value.json') };
}
async function invokeTool(sandbox: WorkerSandbox, name: string, args: Record<string, unknown> = {}) {
    const result = await invokeObservedTool((sandbox as any).workerHost, name, args, 'root');
    if (result?.kind === 'receipt' && result.receipt.outcome.status === 'succeeded') return result.receipt.outcome.value;
    throw new Error(result?.kind === 'receipt' ? result.receipt.outcome.status : result?.code ?? 'Tool invocation failed');
}
it('starts A → B → A in fresh realms at capacity 1 and preserves only persisted data', async () => {
    const f = await fixture(), capacity = new WorkerCapacity(1), sandboxes: WorkerSandbox[] = [];
    const threads: import('node:worker_threads').Worker[] = [];
    try {
        const broken = new WorkerSandbox({ ...f.options, appModulePath: url(join(f.dir, 'missing.mjs')), workerCapacity: capacity });
        sandboxes.push(broken);
        await expect(broken.installDynamic()).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
        await broken.disposeAsync();
        expect(capacity.getReport().total).toBe(0);

        for (const [index, id] of ['A', 'B', 'A'].entries()) {
            const sandbox = new WorkerSandbox({ ...f.options, appId: id, workerCapacity: capacity });
            sandboxes.push(sandbox);
            await sandbox.installDynamic();
            const host = (sandbox as any).workerHost;
            threads.push(host.worker);
            expect((await invokeTool(sandbox, 'flush') as any).data.ok).toBe(true);
            expect((await invokeTool(sandbox, 'inspect') as any).data).toEqual({ value: index, inspections: 1, realm: 1 });
            expect((await invokeTool(sandbox, 'inspect') as any).data.inspections).toBe(2);
            await expect(sandbox.installDynamic()).rejects.toMatchObject({ code: 'SANDBOX_ALREADY_INSTALLED' });
            const competing = new WorkerSandbox({ ...f.options, workerCapacity: capacity });
            sandboxes.push(competing);
            await expect(competing.installDynamic()).rejects.toMatchObject({
                code: 'INSTALL_FAILED', cause: { code: 'WORKER_CAPACITY_EXCEEDED' },
            });
            expect(capacity.getReport().total).toBe(1);
            await invokeTool(sandbox, 'set', { value: index + 1 });
            const closing = sandbox.close();
            expect(sandbox.close()).toBe(closing);
            await closing;
            expect(await sandbox.disposeAsync()).toMatchObject({ ok: true, resourcesReleased: true, host: { worker: 'exited' } });
            expect(threads.at(-1)?.threadId).toBe(-1);
            expect(capacity.getReport().total).toBe(0);
        }
        expect(new Set(threads).size).toBe(3);
        expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(3);
    } finally {
        await Promise.all(sandboxes.map(sandbox => sandbox.disposeAsync()));
        await capacity.close();
        await rm(f.dir, { recursive: true, force: true });
    }
}, 20000);

it.each(['save-failure', 'lost-reply', 'unmount-failure', 'initial-failure'])('C1-15/16 actual SDK %s keeps failure facts after the Worker exits', async scenario => {
    const f = await fixture(scenario), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const persistenceBackend = scenario === 'save-failure' ? { async open(input: any) { const result = await backend.open(input);return result.status !== 'opened' ? result : { status: 'opened', storage: { ...result.storage, async replace() { return { status: 'failed', issue: { code: 'IO_FAILED' } }; } } }; } } : backend;
    const sandbox = new WorkerSandbox({ ...f.options, persistenceBackend } as any);
    try {
        if (scenario === 'initial-failure') await expect(sandbox.installDynamic()).rejects.toHaveProperty('code', 'INSTALL_FAILED');
        else {
            await sandbox.installDynamic();await invokeTool(sandbox, 'set', { value: 7 });
            if (scenario === 'lost-reply') { const worker = (sandbox as any).workerHost.worker, post = worker.postMessage.bind(worker);worker.postMessage = (message: any) => { if (message.type !== 'STATE_STORAGE_RESPONSE' || message.action !== 'replace') post(message); }; }
        }
        const worker = (sandbox as any).workerHost.worker, reportPromise = sandbox.disposeAsync();expect(sandbox.disposeAsync()).toBe(reportPromise);
        await expect(sandbox.close()).rejects.toHaveProperty('code', 'SANDBOX_CLOSE_FAILED');const report = await reportPromise;
        expect(report).toMatchObject({ state: 'settled', ok: false, resourcesReleased: true, host: { worker: 'exited', storage: { support: 'managed', unsafe: true } } });
        expect(worker.threadId).toBe(-1);expect(backend.getStats().ownerSlots).toBe(0);expect(report.issues.length).toBeLessThanOrEqual(5);expect(JSON.stringify(report)).not.toContain('private');
        expect(sandbox.getCloseReport()).toBe(report);if (scenario === 'lost-reply') expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(7);
        await facts('sandbox-' + scenario, { report, backend: backend.getStats(), physicalThreadId: worker.threadId });
    } finally { await sandbox.disposeAsync();await rm(f.dir, { recursive: true, force: true }); }
}, 20000);

it('C1-12 actual Sandbox keeps the Host owner while final save is held; graceful exit waits for real completion', async () => {
    const f = await fixture(), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS), entered = defer(), finish = defer();
    const capacity = new WorkerCapacity(1);
    const sandbox = new WorkerSandbox({ ...f.options, workerCapacity: capacity, persistenceBackend: { async open(input: any) {
        const result = await backend.open(input);return result.status !== 'opened' ? result : { status: 'opened', storage: { ...result.storage,
            async replace(address: any, text: string) { entered.resolve();await finish.promise;return result.storage.replace(address, text); } } };
    } } } as any);
    try {
        await sandbox.installDynamic();await invokeTool(sandbox, 'set', { value: 9 });const closing = sandbox.disposeAsync();await entered.promise;
        const before = sandbox.getCloseReport();expect(before).toMatchObject({ state: 'closing', resourcesReleased: false, host: { storage: { actualIO: 1, ownerRetained: true } } });
        expect(capacity.getReport()).toMatchObject({ total: 1 });expect(backend.getStats().ownerSlots).toBe(1);
        finish.resolve();const report = await closing;expect(report).toMatchObject({ ok: true, resourcesReleased: true, host: { worker: 'exited' } });
        expect(backend.getStats().ownerSlots).toBe(0);expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(9);await capacity.close();
        await facts('sandbox-held-save', { before, report, backend: backend.getStats(), capacity: capacity.getReport() });
    } finally { finish.resolve();await sandbox.disposeAsync();await capacity.close();await rm(f.dir, { recursive: true, force: true }); }
}, 15000);
