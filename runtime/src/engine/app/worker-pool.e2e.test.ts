import { expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { WorkerPool } from './worker-pool.js';
import { createRuntime } from '../../facades/facades.js';
import { invokeObservedTool } from '../../../tests/fixtures/semantic-worker-tools.js';

const repo = resolve(process.cwd(), '..'), url = (p: string) => pathToFileURL(p).href;
async function linkSDKPeers(dir: string) {
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await symlink(join(repo, 'sdk/node_modules/preact'), join(dir, 'node_modules/preact'), 'dir');
}
async function capture(file: string, body: string) {
    await writeFile(file, body);const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) {
        await mkdir(join(folder, 'c1-inputs'), { recursive: true });const hash = createHash('sha256').update(body).digest('hex');
        await writeFile(join(folder, 'c1-inputs', hash), body);
        await writeFile(join(folder, 'c1-inputs', hash + '.json'), JSON.stringify({ path: file, sha256: hash, capturedBeforeExecution: true }));
    }
}
async function fact(name: string, value: object) {
    const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) { await mkdir(folder, { recursive: true });await writeFile(join(folder, 'c1-' + name + '.json'), JSON.stringify(value, null, 2)); }
}
it('C1-02/03/04 real Node capacity, script identity, actual replacement exit, and immutable old lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-pool-'));
    const a = join(dir, 'a.cjs'), b = join(dir, 'b.cjs');
    for (const [file, marker] of [[a, 'A'], [b, 'B']]) await capture(file, `const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>parentPort.postMessage(${JSON.stringify(marker)}));`);
    const pool = new WorkerPool({ initialSize: 0, maxSize: 1, idleTimeoutMs: 5000 }), leases: any[] = [];
    const echo = (worker: any) => new Promise<string>(yes => { worker.once('message', yes);worker.postMessage('inspect'); });
    try {
        const first = await pool.acquireLease(a), oldId = first.worker.threadId;leases.push(first);
        expect(await echo(first.worker)).toBe('A');await expect(pool.acquireLease(a)).rejects.toHaveProperty('code', 'WORKER_POOL_CAPACITY_EXCEEDED');
        const returned = first.release();expect(first.release(false)).toBe(returned);await returned;
        expect([...(pool as any).slots][0].timer.hasRef()).toBe(false);
        const next = await pool.acquireLease(a);leases.push(next);expect(next.worker).toBe(first.worker);await first.release(false);expect(await echo(next.worker)).toBe('A');await next.release();
        const replacement = await pool.acquireLease(b);leases.push(replacement);expect(first.worker.threadId).toBe(-1);expect(await echo(replacement.worker)).toBe('B');
        expect(replacement.worker).not.toBe(first.worker);await replacement.release();const closed = await pool.destroy();
        expect(replacement.worker.threadId).toBe(-1);expect(closed).toMatchObject({ state: 'closed', total: 0 });
        await fact('pool-real', { oldId, oldActuallyExitedBeforeReplacement: true, staleLeaseHarmless: true, closed });
    } finally { await Promise.all(leases.map(l => l.release(false)));await pool.destroy();await rm(dir, { recursive: true, force: true }); }
}, 15000);

it('C1-08 two actual createRuntime instances execute their own A/B scripts; same Runtime Desktops share one bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-runtimes-')), app = join(dir, 'app.mjs');
    await linkSDKPeers(dir);
    await capture(app, `import {h} from 'preact';import {createTUIApp,useAppRuntimeContext,View,useViewTypeTool} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};let launch;
function Tools(){const [Inspect]=useViewTypeTool('inspect',{description:'Inspect launch facts',isMutating:false,params:{}},async()=>{const script=globalThis.__c1Script,forwarded=launch?.C1_LAUNCH;return {success:true,data:{script:typeof script==='string'?script:'<script:'+typeof script+'>',launch:{C1_LAUNCH:typeof forwarded==='string'?forwarded:'<C1_LAUNCH:'+typeof forwarded+'>'}}};});return h(Inspect);}
function Root(){launch=useAppRuntimeContext().launchConfig;return h(View,{id:'root',type:'Root'},h(Tools));}
export default createTUIApp({app_name:'c1',component:Root});`);
    const runtimes = [createRuntime({ worker: { timeoutMs: 2345, pool: { initialSize: 0, maxSize: 1 } } }), createRuntime({ worker: { pool: { initialSize: 0, maxSize: 1 } } })] as any[];
    const sandboxes: any[] = [], workers: any[] = [];
    try {
        for (const [index, runtime] of runtimes.entries()) {
            const script = join(dir, index + '.mjs');await capture(script, `globalThis.__c1Script=${JSON.stringify(index ? 'B' : 'A')};await import(${JSON.stringify(url(join(repo, 'runtime/dist/worker-runtime/index.js')))});`);
            const d = await runtime.createDesktop();const id = await runtime.installDynamicWorkerApp(d, url(app), { workerScriptPath: script, config: { C1_LAUNCH: 'forwarded' } });
            const manager = runtime.desktopManager.get(d).appManager, sandbox = manager.workers.get(id);sandboxes.push(sandbox);workers.push(sandbox.lease.worker);
            let inspectAttempt = 0;
            const inspect = async () => {
                const attempt = ++inspectAttempt;
                const result = await invokeObservedTool((sandbox as any).workerHost, 'inspect', {}, 'root');
                const outcome = result?.receipt?.outcome, data = outcome?.value?.data;
                if (result?.kind !== 'receipt' || outcome?.status !== 'succeeded') {
                    const dataSummary = data && typeof data === 'object' ? {
                        keys: Object.keys(data),
                        script: { present: Object.hasOwn(data, 'script'), value: data.script ?? null },
                        launch: { present: Object.hasOwn(data, 'launch'), keys: data.launch && typeof data.launch === 'object' ? Object.keys(data.launch) : [],
                            C1_LAUNCH: data.launch?.C1_LAUNCH ?? null },
                    } : null;
                    throw new Error(`Tool invocation failed at inspect ${attempt}: ${JSON.stringify({ kind: result?.kind ?? null,
                        outcome: outcome ?? null, code: result?.issue?.code ?? outcome?.error?.code ?? outcome?.code ?? null,
                        details: result?.issue?.details ?? outcome?.error?.details ?? outcome?.details ?? null, data: dataSummary })}`);
                }
                return result.receipt.outcome.value.data;
            };
            expect((await inspect()).script).toBe(index ? 'B' : 'A');
            expect(sandbox.pool).toBe(runtime.desktopManager.workerPool);expect((await inspect()).launch.C1_LAUNCH).toBe('forwarded');
            if (!index) {
                expect(sandbox.workerHost.timeout).toBe(2345);
                const other = await runtime.createDesktop();expect(runtime.desktopManager.get(other).appManager.workerPool).toBe(manager.workerPool);
                await expect(runtime.installDynamicWorkerApp(other, url(app), { workerScriptPath: script })).rejects.toHaveProperty('code', 'INSTALL_FAILED');
            }
        }
        const firstRuntimeClose = await runtimes[0].beginShutdown().completion;
        expect(firstRuntimeClose.ok).toBe(true);expect(firstRuntimeClose.pool).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0 } });
        expect(workers[0].threadId).toBe(-1);
        const result = await invokeObservedTool((sandboxes[1] as any).workerHost, 'inspect', {}, 'root');
        expect((result as any).receipt.outcome.value.data.script).toBe('B');
        const secondRuntimeClose = await runtimes[1].beginShutdown().completion;
        expect(secondRuntimeClose.ok).toBe(true);expect(secondRuntimeClose.pool).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0 } });
        expect(workers[1].threadId).toBe(-1);
        await fact('runtime-scripts', { scripts: ['A', 'B'], independentOwners: true, sameRuntimeDesktopCap: 1, reports: [firstRuntimeClose.pool.report, secondRuntimeClose.pool.report] });
    } finally {
        await Promise.all(runtimes.map(runtime => runtime.beginShutdown().completion));
        await rm(dir, { recursive: true, force: true });
    }
}, 20000);

it('C1-20 Pool and standalone Sandbox close permit a fresh Node child to end naturally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-natural-')), app = join(dir, 'app.mjs'), driver = join(dir, 'driver.mjs');
    await capture(app, `import {createTUIApp,usePersistentState} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};function Root(){usePersistentState('value',3);return null;}export default createTUIApp({app_name:'natural',component:Root});`);
    const output = join(dir, 'result.json');
    await capture(driver, `import {WorkerPool} from ${JSON.stringify(url(join(repo, 'runtime/dist/engine/app/worker-pool.js')))};
import {WorkerSandbox} from ${JSON.stringify(url(join(repo, 'runtime/dist/engine/app/worker-sandbox.js')))};
import {defineRuntimeConfig} from ${JSON.stringify(url(join(repo, 'runtime/dist/spi/config/index.js')))};
import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const pool=new WorkerPool({initialSize:2,maxSize:2});await pool.warmup();const closed=await pool.destroy();assert.equal(closed.total,0);
const sandbox=new WorkerSandbox({appId:'natural',desktopId:'d',appModulePath:${JSON.stringify(url(app))},runtimeConfig:defineRuntimeConfig({worker:{pool:{initialSize:0,maxSize:1}}}),config:{AOTUI_DATA_DIR:${JSON.stringify(join(dir, 'data'))},AOTUI_APP_NAME:'natural'}});
await sandbox.installDynamic();const worker=sandbox.lease.worker;const report=await sandbox.disposeAsync();assert.equal(report.ok,true);assert.equal(report.resourcesReleased,true);assert.equal(report.ownedPool.state,'closed');assert.equal(worker.threadId,-1);
await writeFile(${JSON.stringify(output)},JSON.stringify({closed,report,physicalThreadId:worker.threadId,proof:'natural child completion; no explicit process exit'}));
`);
    try {
        const child = await new Promise<{ stdout: string; stderr: string }>((yes, no) => execFile(process.execPath, [driver], { timeout: 20000 }, (error, stdout, stderr) => error ? no(Object.assign(error, { stdout, stderr })) : yes({ stdout, stderr })));
        const result = JSON.parse(await readFile(output, 'utf8'));expect(result.physicalThreadId).toBe(-1);expect(result.report.resourcesReleased).toBe(true);
        await fact('natural-child', { ...result, childExitCode: 0, signal: null, forciblyTerminated: false, stdout: child.stdout, stderr: child.stderr });
    } finally { await rm(dir, { recursive: true, force: true }); }
}, 25000);
