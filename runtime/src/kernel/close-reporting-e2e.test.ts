import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo=resolve(process.cwd(),'..'),url=(file:string)=>pathToFileURL(file).href;
const sdkDist=process.env.AOTUI_C03_SDK_DIST??join(repo,'sdk/dist/index.js');
const runtimeDist=process.env.AOTUI_C03_RUNTIME_DIST??join(repo,'runtime/dist');
const { createRuntime, createDesktopId }: typeof import('../index.js') = await import(url(join(runtimeDist, 'index.js')));
async function capture(file:string,body:string){
    await writeFile(file,body);const root=process.env.AOTUI_W08_C1_FACTS_DIR;
    if(root){const hash=createHash('sha256').update(body).digest('hex'),folder=join(root,'c2-inputs');await mkdir(folder,{recursive:true});await writeFile(join(folder,hash),body);await writeFile(join(folder,hash+'.json'),JSON.stringify({path:file,sha256:hash,capturedBeforeExecution:true}));}
}
async function facts(name:string,value:object){const root=process.env.AOTUI_W08_C1_FACTS_DIR;if(root){await mkdir(root,{recursive:true});await writeFile(join(root,'c2-kernel-'+name+'.json'),JSON.stringify(value,null,2));}}
async function fixture(scenario='normal', appName='close'){
    const dir=await mkdtemp(join(tmpdir(),'aotui-c2-kernel-')),app=join(dir,'app.mjs'),entered=join(dir,'entered'),release=join(dir,'release');
    await mkdir(join(dir,'node_modules'),{recursive:true});
    const body=`import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import { createApp, createView, defineViewType } from ${JSON.stringify(url(sdkDist))};
let setter, draft, stateFile;
function saveFile(file, next){ mkdirSync(join(file,'..'),{recursive:true}); writeFileSync(file, JSON.stringify({ value: next }), 'utf8'); }
function readSaved(file){ try { return JSON.parse(readFileSync(file,'utf8')).value; } catch { return undefined; } }
const DetailType = defineViewType()({ multiplicity: 'multiple', name: 'Detail', tools: {
    set: {
        description: 'Set persisted value', inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        async execute({ input }) {
            ${scenario==='held-write' ? `saveFile(stateFile, input.value);
            await writeFile(${JSON.stringify(entered)},'saved');
            while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));`
            : 'draft=input.value;setter(input.value);'}
            return { success: true, data: { value: input.value } };
        },
    },
} });
const factory = createApp({ viewTypes: [DetailType], app_name: ${JSON.stringify(appName)},
    initialize({ launchConfig, desktopId, registerCleanup, prepareProjection }) {
        stateFile = join(String(launchConfig.AOTUI_DATA_DIR), String(desktopId) + '-close.json');
        let value = readSaved(stateFile) ?? 0;
        const page = createView(DetailType, { idPrefix: 'detail', region: 'dynamic',
            render: () => ({ body: String(value), context: {} }) });
        const publish = () => prepareProjection({ views: [page] });
        setter = next => { value = next; publish(); };
        registerCleanup({ async close() { if (draft !== undefined) saveFile(stateFile, draft); } });
        publish();
    },
});
${scenario==='async-unmount'||scenario==='failed-unmount'?`const initialize=factory.initialize.bind(factory);factory.initialize=async(...args)=>{const renderer=await initialize(...args);return {...renderer,async close(){${scenario==='async-unmount'?`await writeFile(${JSON.stringify(entered)},'entered');while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));`:''}renderer.close();${scenario==='failed-unmount'?"throw Error('private unmount detail');":''}}};};`:''}
export default factory;`;
    await capture(app,body);
    return {dir,app,entered,release,data:join(dir,'data'),read:(desktop='d')=>{ try { return readFileSync(join(dir,'data',desktop+'-close.json'),'utf8'); } catch { return undefined; } }};
}
const makeRuntime=()=>createRuntime({worker:{timeoutMs:4000,maxWorkers: 4}});
function appRecord(runtime: any, desktop: string, installationId: string) {
    return runtime.getDesktop(desktop).listApps().find((item: any) => item.installationId === installationId);
}
function sandbox(runtime:any,id='d',app='app'):any{
    return (runtime.getDesktop(id) as any).appManager.getManagedApp(appRecord(runtime, id, app)?.appId ?? 'close');
}
async function install(runtime:any,f:Awaited<ReturnType<typeof fixture>>,id='d',app='app',extra={}){
    try { runtime.getDesktop(id); }
    catch (error) {
        expect(error).toHaveProperty('code', 'DESKTOP_NOT_FOUND');
        await runtime.createDesktop(id);
    }
    return (await runtime.getDesktop(id).installDynamicWorkerApp(url(f.app),{installationId:app,name:'close',config:{AOTUI_DATA_DIR:f.data},...extra})).appId;
}
async function invoke(runtime:any,id='d',app='app',name='set',input={value:1}){
    const current = appRecord(runtime, id, app);
    const desktop=runtime.getDesktop(id), opened=desktop.getRunningApp(current?.appId,current?.appInstanceId);
    if(opened.status!=='ready')throw new Error(opened.issue.code);
    let candidate:any, turn:any;
    try{
        await vi.waitFor(async()=>{const result=await opened.app.observe();expect(result.status).toBe('prepared');if(result.status==='prepared')candidate=result.candidate;},{timeout:6000});
        const adopted=desktop.adoptTurn({apps:[{candidate}]});expect(adopted.status).toBe('adopted');turn=adopted.turn;
        const {observation}=candidate, tool=observation.tools.find((item:any)=>item.name===name);
        if(!tool)throw new Error('Missing View Tool '+name);
        const result=await turn.invoke(opened.app.appId,{invocationId:randomUUID(),observationId:observation.observationId,toolId:tool.id,viewId: 'detail_1', input:{...input}});
        if(result.kind!=='receipt'||result.receipt.outcome.status!=='succeeded')return {success:false};
        return result.receipt.outcome.value as any;
    }finally{turn?.release();candidate?.discard();}
}
afterEach(()=>{vi.restoreAllMocks();});

it('C2-26 actual default Kernel/SDK saves two Desktop values and closes all physical Workers',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'a');await install(runtime,f,'b');const boxes=[sandbox(runtime,'a'),sandbox(runtime,'b')],workers=boxes.map(box=>box.host.worker);
        expect((await invoke(runtime,'a','app','set',{value:11})).success).toBe(true);expect((await invoke(runtime,'b','app','set',{value:22})).success).toBe(true);
        const closing=runtime.beginClose(),before=closing.inspect();const report=await closing.completion;await runtime.beginClose().completion;
        expect(report).toMatchObject({state:'settled',ok:true,verification:'managed',apps:{accepted:2,settled:2,pending:0,notVerifiedReleased:0},desktops:{accepted:2,settled:2,pending:0},resources:{pendingOperations:0,retainedOwners:0},workers:{ownership:'owned',report:{state:'closed',total:0}}});
        expect(report).not.toHaveProperty('persistence');
        expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);
        for (const id of ['a', 'b']) expect(() => runtime.getDesktop(createDesktopId(id))).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        expect(JSON.parse(f.read('a')!).value).toBe(11);expect(JSON.parse(f.read('b')!).value).toBe(22);expect(before.state).toBe('closing');await facts('normal',{before,report,physicalThreadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-25 Desktop close exits its own Worker and preserves other Desktops in the Runtime',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'first');await install(runtime,f,'second');const first=sandbox(runtime,'first'),second=sandbox(runtime,'second'),workers=[first.host.worker,second.host.worker];
        const closed=await runtime.getDesktop(createDesktopId('first')).beginClose().completion;expect(closed).toMatchObject({ok:true,resourcesReleased:true,workers:{ownership:'not-owned',report:null},apps:{accepted:1,settled:1}});
        expect(first.host.getResourceReport()).toMatchObject({worker:'exited'});expect(workers[0].threadId).toBe(-1);expect(workers[1].threadId).toBeGreaterThan(0);
        expect((await invoke(runtime,'second')).success).toBe(true);
        const report=await runtime.beginClose().completion;expect(report).toMatchObject({ok:true,apps:{accepted:1,settled:1},desktops:{accepted:1,settled:1},workers:{report:{state:'closed',total:0}}});expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);await facts('desktop-close',{closed,report,first:first.host.getResourceReport(),threadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('C2-25/26 Q02 real SDK async unmount keeps ownership before the terminal flush',async()=>{
    const f=await fixture('async-unmount'),runtime=makeRuntime();
    try{
        await install(runtime,f);await invoke(runtime,'d','app','set',{value:31});const box=sandbox(runtime),worker=box.host.worker,closing=runtime.beginClose();
        await vi.waitFor(()=>expect(existsSync(f.entered)).toBe(true),{timeout:3000});const before=closing.inspect();
        expect(before).toMatchObject({state:'closing',hasFailures:false,resourcesReleased:false});
        expect((await closing.wait({timeoutMs:5})).status).toBe('deadline');expect(worker.threadId).toBeGreaterThan(0);expect(f.read()).toBeUndefined();
        await writeFile(f.release,'go');const report=await closing.completion;expect(report.ok).toBe(true);expect(worker.threadId).toBe(-1);expect(JSON.parse(f.read()!).value).toBe(31);expect(before.state).toBe('closing');expect(before.hasFailures).toBe(false);await facts('async-unmount',{before,report,threadId:worker.threadId});
    }finally{await writeFile(f.release,'go');await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('forces actual Worker exit after a held cleanup outlives the grace period', async () => {
    const f = await fixture('async-unmount');
    const runtime = createRuntime({ worker: { timeoutMs: 1500, maxWorkers: 1 } });
    try {
        await install(runtime, f);
        await invoke(runtime, 'd', 'app', 'set', { value: 32 });
        const box = sandbox(runtime), worker = box.host.worker;
        const closing = runtime.beginClose();
        await vi.waitFor(() => expect(existsSync(f.entered)).toBe(true));
        const waiting = await closing.wait({ timeoutMs: 5 });
        expect(waiting).toMatchObject({ status: 'deadline', report: {
            resourcesReleased: false, workers: { report: { state: 'closing', total: 1 } },
        } });
        const final = await closing.completion;
        expect(final).toMatchObject({ hasFailures: true, resourcesReleased: true, appCleanup: { completedApps: 0 },
            workers: { report: { state: 'closed', total: 0 } } });
        expect(final.failures.flatMap(sample => sample.codes)).toContain('APP_CLOSE_DEADLINE_EXCEEDED');
        expect(worker.threadId).toBe(-1);
        expect(f.read()).toBeUndefined();
    } finally {
        await writeFile(f.release, 'go');
        await runtime.beginClose().completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 10000);

it.each(['confirmed', 'unknown'] as const)('reports the %s outcome of the final dispatched write on the App close handle', async mode => {
    const f = await fixture('held-write');
    const runtime = createRuntime({ worker: { timeoutMs: 1500, maxWorkers: 1 } });
    try {
        await install(runtime, f);
        const desktop = runtime.getDesktop(createDesktopId('d')), record = appRecord(runtime, 'd', 'app');
        const opened = desktop.getRunningApp(record.appId, record.appInstanceId);
        if (opened.status !== 'ready') throw Error(opened.issue.code);
        const observed = await opened.app.observe();
        if (observed.status !== 'prepared') throw Error(observed.issue.code);
        const { candidate } = observed, adopted = desktop.adoptTurn({ apps: [{ candidate }] });
        if (adopted.status !== 'adopted') throw Error(adopted.issue.code);
        const { observationId, tools } = candidate.observation, invocationId = 'last-write';
        const pending = adopted.turn.invoke(opened.app.appId, { observationId, invocationId,
            toolId: tools.find(tool => tool.name === 'set')!.id, viewId: 'detail_1', input: { value: 84 } });
        await vi.waitFor(() => expect(existsSync(f.entered)).toBe(true));
        const worker = sandbox(runtime).host.worker, handle = opened.app.beginClose();
        if (mode === 'confirmed') await writeFile(f.release, 'go');
        const report = await handle.completion;
        await pending;
        expect(report).toMatchObject({ resourcesReleased: true, worker: 'exited', ok: mode === 'confirmed',
            closingInvocation: { observationId, invocationId, executionPhase: mode === 'confirmed' ? 'entered-returned' : 'unknown',
                status: mode === 'confirmed' ? 'succeeded' : 'unknown' } });
        expect(worker.threadId).toBe(-1);
        expect(JSON.parse(f.read()!).value).toBe(84);
        await facts('last-write-' + mode, { report, threadId: worker.threadId, saved: 84 });
    } finally {
        await writeFile(f.release, 'go');
        await runtime.beginClose().completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 10000);

it('C2-28 two Runtime capacity owners / two Desktop IDs are isolated',async()=>{
    const f=await fixture();
    const a=makeRuntime(),b=makeRuntime();
    try{
        for(const runtime of [a,b]){await install(runtime,f,'one','app',{config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b')}});await install(runtime,f,'two','app',{config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b')}});}
        const aWorkers=['one','two'].map(id=>sandbox(a,id).host.worker),bWorkers=['one','two'].map(id=>sandbox(b,id).host.worker);expect(new Set([...aWorkers,...bWorkers]).size).toBe(4);
        const aReport=await a.beginClose().completion;expect(aReport.ok).toBe(true);expect(aWorkers.every(worker=>worker.threadId===-1)).toBe(true);expect(bWorkers.every(worker=>worker.threadId>0)).toBe(true);
        for(const id of ['one','two'])expect((await invoke(b,id,'app','set',{value:52})).success).toBe(true);
        const bReport=await b.beginClose().completion;expect(bReport.ok).toBe(true);expect(bWorkers.every(worker=>worker.threadId===-1)).toBe(true);await facts('isolation',{aReport,bReport,threadIds:[...aWorkers,...bWorkers].map(worker=>worker.threadId)});
    }finally{await Promise.all([a.beginClose().completion,b.beginClose().completion]);await rm(f.dir,{recursive:true,force:true});}
},30000);

it('C2-25/27 actual Kernel preserves unmount failure after real resource release',async()=>{
    const f=await fixture('failed-unmount');
    const runtime = makeRuntime();
    try{
        await install(runtime,f);await invoke(runtime,'d','app','set',{value:63});const box=sandbox(runtime),worker=box.host.worker,promise=runtime.beginClose().completion;
        expect(runtime.beginClose().completion).toBe(promise);
        const report=await runtime.beginClose().completion;expect(report).toMatchObject({state:'settled',hasFailures:true,resourcesReleased:true,workers:{report:{state:'closed',total:0}}});expect(worker.threadId).toBe(-1);
        expect(report.failures.flatMap(item=>item.codes)).toContain('APP_UNMOUNT_FAILED');
        expect(JSON.parse(f.read()!).value).toBe(63);
        expect(JSON.stringify(report)).not.toContain('private unmount detail');await facts('failure-unmount',{report,threadId:worker.threadId});
    }finally{await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-29 emitted createRuntime + real SDK naturally exits a fresh Node child',async()=>{
    const f=await fixture(),driver=join(f.dir,'driver.mjs');
    const script = [
        "import assert from 'node:assert/strict';",
        `import {createRuntime} from ${JSON.stringify(url(join(runtimeDist,'index.js')))};`,
        "const runtime=createRuntime({worker:{timeoutMs:4000,maxWorkers: 1}});",
        "const desktop=await runtime.createDesktop('d');",
        `await desktop.installDynamicWorkerApp(${JSON.stringify(url(f.app))},{installationId:'app',name:'close',config:{AOTUI_DATA_DIR:${JSON.stringify(f.data)}}});`,
        "const box=desktop.appManager.getManagedApp('close'),worker=box.host.worker;",
        "const opened=desktop.getRunningApp('close',box.appInstanceId);",
        "assert.equal(opened.status,'ready');",
        "const observed=await opened.app.observe();assert.equal(observed.status,'prepared');",
        "const adopted=desktop.adoptTurn({apps:[{candidate:observed.candidate}]});assert.equal(adopted.status,'adopted');",
        "const observation=observed.candidate.observation,tool=observation.tools.find(item=>item.name==='set');assert.ok(tool);",
        "const result=await adopted.turn.invoke(opened.app.appId,{invocationId:'child-call',observationId:observation.observationId,toolId:tool.id,viewId:'detail_1',input:{value:74}});",
        "assert.equal(result.kind,'receipt');assert.equal(result.receipt.outcome.status,'succeeded');adopted.turn.release();",
        "await runtime.beginClose().completion;const report=await runtime.beginClose().completion;",
        "assert.equal(report.ok,true);assert.equal(report.workers.report.total,0);assert.equal(worker.threadId,-1);",
        "console.log('C2_NATURAL_END '+JSON.stringify({report,threadId:worker.threadId,value:74}));",
    ].join('\n');
    await capture(driver,script);
    let guardUsed=false;
    try{
        const result=await new Promise<{code:number|null;signal:string|null;stdout:string;stderr:string}>((resolve,reject)=>{
            const child=spawn(process.execPath,[driver],{env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
            const guard=setTimeout(()=>{guardUsed=true;child.kill('SIGKILL');reject(Error('NATURAL_EXIT_GUARD_USED'));},15000);
            child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});child.on('error',error=>{clearTimeout(guard);reject(error);});child.on('exit',(code,signal)=>{clearTimeout(guard);resolve({code,signal,stdout,stderr});});
        });
        expect(JSON.parse(f.read()!).value).toBe(74);expect(guardUsed).toBe(false);expect(result).toMatchObject({code:0,signal:null});const line=result.stdout.split('\n').find(line=>line.startsWith('C2_NATURAL_END '));expect(line).toBeDefined();
        const final=JSON.parse(line!.slice('C2_NATURAL_END '.length));expect(final).toMatchObject({threadId:-1,value:74,report:{ok:true,workers:{report:{state:'closed',total:0}}}});await facts('natural-child',{...result,guardUsed,naturalExit:true});
    }finally{await rm(f.dir,{recursive:true,force:true});}
},20000);

it('keeps nested scopes independent and releases unadopted Worker observations after a cleanup error', async () => {
    const aFixture = await fixture('normal', 'scope_a');
    const bFixture = await fixture('normal', 'scope_b');
    const cFixture = await fixture('normal', 'scope_c');
    const runtime = makeRuntime();
    try {
        const desktop = await runtime.createDesktop();
        const a = await desktop.installDynamicWorkerApp(url(aFixture.app), {
            name: 'scope_a', config: { AOTUI_DATA_DIR: aFixture.data },
        });
        const b = await desktop.installDynamicWorkerApp(url(bFixture.app), {
            name: 'scope_b', config: { AOTUI_DATA_DIR: bFixture.data },
        });
        const c = await desktop.installDynamicWorkerApp(url(cFixture.app), {
            name: 'scope_c', config: { AOTUI_DATA_DIR: cFixture.data },
        });

        const late = desktop.createCandidateScope();
        const observing = late.observe(b);
        expect(late.discard()).toEqual([]);
        expect(await observing).toMatchObject({ status: 'rejected', issue: { code: 'CANDIDATE_SCOPE_CLOSED' } });

        const outer = desktop.createCandidateScope();
        const aPrepared = await outer.observe(a);
        if (aPrepared.status !== 'prepared') throw new Error(aPrepared.issue.code);
        {
            using inner = desktop.createCandidateScope();
            expect((await inner.observe(b)).status).toBe('prepared');
            expect(await b.observe()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        }

        const releaseError = Object.assign(new Error('B candidate cleanup callback failed'), {
            code: 'TEST_B_CANDIDATE_CLEANUP_FAILED', path: '$.scope_b',
        });
        const bPrepared = await outer.observe({
            async observe() {
                const result = await b.observe();
                if (result.status !== 'prepared') return result;
                const { candidate } = result;
                return {
                    status: 'prepared',
                    candidate: {
                        ...candidate,
                        discard() {
                            expect(candidate.discard()).toEqual([]);
                            throw releaseError;
                        },
                    },
                };
            },
        });
        if (bPrepared.status !== 'prepared') throw new Error(bPrepared.issue.code);
        const cPrepared = await outer.observe(c);
        if (cPrepared.status !== 'prepared') throw new Error(cPrepared.issue.code);
        const { candidate } = aPrepared;
        const { observation } = candidate;
        const view = observation.views.find(view => view.type === 'Detail')!;
        const windows = { activeViews: [{ viewId: view.id, viewInstanceId: view.viewInstanceId }] };
        const selected = { candidate, windows };
        const reduced = desktop.adoptTurn({ apps: [selected] });
        if (reduced.status !== 'adopted') throw new Error(reduced.issue.code);
        const cWhileHeld = await c.observe();
        expect(cWhileHeld).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        const cleanup = outer.discard();
        expect(cleanup).toEqual([{
            code: releaseError.code, message: releaseError.message, path: releaseError.path, cause: releaseError,
        }]);
        const [cleanupIssue] = cleanup;
        const preservedOriginalError = cleanupIssue !== undefined && 'cause' in cleanupIssue && cleanupIssue.cause === releaseError;
        expect(preservedOriginalError).toBe(true);
        expect(reduced.turn.isCurrent).toBe(true);

        const { observationId, tools } = observation;
        const tool = tools.find(tool => tool.name === 'set')!;
        const invocationId = 'after-scope-close';
        const invoked = await reduced.turn.invoke(a.appId, {
            invocationId, observationId, toolId: tool.id, viewId: view.id, input: { value: 42 },
        });
        expect(invoked).toMatchObject({
            kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: {
                status: 'succeeded', value: { success: true, data: { value: 42 } },
            } },
        });
        const receipt = await a.readReceipt({ invocationId, observationId });
        expect(receipt).toEqual(invoked);

        using retry = desktop.createCandidateScope();
        const availableC = await retry.observe(c);
        if (availableC.status !== 'prepared') throw new Error(availableC.issue.code);
        const newCObservationId = availableC.candidate.observation.observationId;
        expect(newCObservationId).not.toBe(cPrepared.candidate.observation.observationId);
        const availableB = await retry.observe(b);
        if (availableB.status !== 'prepared') throw new Error(availableB.issue.code);
        const nextA = await retry.observe(a);
        if (nextA.status !== 'prepared') throw new Error(nextA.issue.code);
        expect((await b.beginClose().completion).resourcesReleased).toBe(true);
        const retrySelection = { candidate: nextA.candidate, windows };
        expect(desktop.adoptTurn({ apps: [retrySelection, { candidate: availableB.candidate }] }).status).toBe('rejected');
        expect(reduced.turn.isCurrent).toBe(true);
        const adopted = desktop.adoptTurn({ apps: [retrySelection] });
        if (adopted.status !== 'adopted') throw new Error(adopted.issue.code);
        expect(retry.discard()).toEqual([]);
        expect(reduced.turn.isCurrent).toBe(false);
        expect(adopted.turn.release()).toEqual([]);
        const closed = await runtime.beginClose().completion;
        expect(closed).toMatchObject({ resourcesReleased: true, workers: { report: { state: 'closed', total: 0 } } });
        const saved = JSON.parse(aFixture.read(desktop.id)!);
        expect(saved).toEqual({ value: 42 });
        await facts('candidate-scope-release-error', {
            prepared: [aPrepared, bPrepared, cPrepared].map(({ candidate: { observation } }) => ({
                appId: observation.source.appId, observationId: observation.observationId,
            })),
            adoptedObservationId: observationId,
            cleanup, preservedOriginalError,
            cWhileHeld, newCObservationId, invoked, receipt, saved, closed,
        });
    } finally {
        await runtime.beginClose().completion;
        await Promise.all([aFixture, bFixture, cFixture].map(({ dir }) => rm(dir, { recursive: true, force: true })));
    }
}, 15000);
