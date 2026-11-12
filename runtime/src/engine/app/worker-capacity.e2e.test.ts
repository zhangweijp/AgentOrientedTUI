import { expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createRuntime } from '../../facades/facades.js';
import { invokeObservedTool } from '../../../tests/fixtures/semantic-worker-tools.js';

const repo = resolve(process.cwd(), '..'), url = (p: string) => pathToFileURL(p).href;
async function linkSDKPeers(dir: string) {
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await symlink(join(repo, 'sdk/node_modules/preact'), join(dir, 'node_modules/preact'), 'dir');
    await symlink(join(repo, 'sdk/node_modules/typebox'), join(dir, 'node_modules/typebox'), 'dir');
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
it('C1-08 two actual createRuntime instances execute their own A/B scripts; same Runtime Desktops share one bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-runtimes-')), app = join(dir, 'app.mjs');
    await linkSDKPeers(dir);
    await capture(app, `import {h} from 'preact';import Type from 'typebox';import {createTUIApp,defineViewTypeTool,useAppRuntimeContext,View,AppTools, defineToolSet} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};let launch;


const fixtureTools0 = defineToolSet({
Inspect: defineViewTypeTool({viewType:'Root',name:'inspect',description:'Inspect launch facts',inputSchema:Type.Object({}, {additionalProperties:false}),})
});
function Root(){launch=useAppRuntimeContext().launchConfig;return h(AppTools, { definition: fixtureTools0, bindings: {
Inspect: { execute: async()=>{const script=globalThis.__c1Script,forwarded=launch?.C1_LAUNCH;return {success:true,data:{script:typeof script==='string'?script:'<script:'+typeof script+'>',launch:{C1_LAUNCH:typeof forwarded==='string'?forwarded:'<C1_LAUNCH:'+typeof forwarded+'>'}}};} }
} }, h(View,{kind: 'instruction',id:'root',type:'Root'},'Worker capacity'));}
export default createTUIApp({app_name:'c1',component:Root});`);
    const runtimes = [createRuntime({ worker: { timeoutMs: 2345, maxWorkers: 1 } }), createRuntime({ worker: { maxWorkers: 1 } })] as any[];
    const sandboxes: any[] = [], workers: any[] = [];
    try {
        for (const [index, runtime] of runtimes.entries()) {
            const script = join(dir, index + '.mjs');await capture(script, `globalThis.__c1Script=${JSON.stringify(index ? 'B' : 'A')};await import(${JSON.stringify(url(join(repo, 'runtime/dist/worker-runtime/index.js')))});`);
            const d = await runtime.createDesktop();const id = await runtime.installDynamicWorkerApp(d, url(app), { workerScriptPath: relative(process.cwd(), script), config: { C1_LAUNCH: 'forwarded' } });
            const manager = runtime.desktopManager.get(d).appManager, sandbox = manager.workers.get(id);sandboxes.push(sandbox);workers.push(sandbox.workerHost.worker);
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
            expect(sandbox.config.workerCapacity).toBe(runtime.desktopManager.workerCapacity);expect((await inspect()).launch.C1_LAUNCH).toBe('forwarded');
            if (!index) {
                expect(sandbox.workerHost.timeout).toBe(2345);
                const other = await runtime.createDesktop();expect(runtime.desktopManager.get(other).appManager.workerCapacity).toBe(manager.workerCapacity);
                await expect(runtime.installDynamicWorkerApp(other, url(app), { workerScriptPath: script })).rejects.toHaveProperty('code', 'INSTALL_FAILED');
            }
        }
        const firstRuntimeClose = await runtimes[0].beginShutdown().completion;
        expect(firstRuntimeClose.ok).toBe(true);expect(firstRuntimeClose.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0 } });
        expect(workers[0].threadId).toBe(-1);
        const result = await invokeObservedTool((sandboxes[1] as any).workerHost, 'inspect', {}, 'root');
        expect((result as any).receipt.outcome.value.data.script).toBe('B');
        const secondRuntimeClose = await runtimes[1].beginShutdown().completion;
        expect(secondRuntimeClose.ok).toBe(true);expect(secondRuntimeClose.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0 } });
        expect(workers[1].threadId).toBe(-1);
        await fact('runtime-scripts', { scripts: ['A', 'B'], independentOwners: true, sameRuntimeDesktopCap: 1, reports: [firstRuntimeClose.workers.report, secondRuntimeClose.workers.report] });
    } finally {
        await Promise.all(runtimes.map(runtime => runtime.beginShutdown().completion));
        await rm(dir, { recursive: true, force: true });
    }
}, 20000);

it('C1-20 a standalone Sandbox close permits a fresh Node child to end naturally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-natural-')), app = join(dir, 'app.mjs'), driver = join(dir, 'driver.mjs');
    await capture(app, `import {createTUIApp,usePersistentState} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};function Root(){usePersistentState('value',3);return null;}export default createTUIApp({app_name:'natural',component:Root});`);
    const output = join(dir, 'result.json');
    await capture(driver, `import {WorkerSandbox} from ${JSON.stringify(url(join(repo, 'runtime/dist/engine/app/worker-sandbox.js')))};
import {defineRuntimeConfig} from ${JSON.stringify(url(join(repo, 'runtime/dist/spi/config/index.js')))};
import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const sandbox=new WorkerSandbox({appId:'natural',desktopId:'d',appModulePath:${JSON.stringify(url(app))},runtimeConfig:defineRuntimeConfig({worker:{maxWorkers:1}}),config:{AOTUI_DATA_DIR:${JSON.stringify(join(dir, 'data'))},AOTUI_APP_KEY:'natural'}});
await sandbox.installDynamic();const worker=sandbox.workerHost.worker;const report=await sandbox.disposeAsync();assert.equal(report.ok,true);assert.equal(report.resourcesReleased,true);assert.equal(worker.threadId,-1);
await writeFile(${JSON.stringify(output)},JSON.stringify({report,physicalThreadId:worker.threadId,proof:'natural child completion; no explicit process exit'}));
`);
    try {
        const child = await new Promise<{ stdout: string; stderr: string }>((yes, no) => execFile(process.execPath, [driver], { timeout: 20000 }, (error, stdout, stderr) => error ? no(Object.assign(error, { stdout, stderr })) : yes({ stdout, stderr })));
        const result = JSON.parse(await readFile(output, 'utf8'));expect(result.physicalThreadId).toBe(-1);expect(result.report.resourcesReleased).toBe(true);
        await fact('natural-child', { ...result, childExitCode: 0, signal: null, forciblyTerminated: false, stdout: child.stdout, stderr: child.stderr });
    } finally { await rm(dir, { recursive: true, force: true }); }
}, 25000);
