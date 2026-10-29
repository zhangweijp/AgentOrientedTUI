// Independent review only. Never edits production source or original tests.
// Compare archived pre-Wave2A Host vs current Host against the SAME real SDK/Worker.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = process.cwd();
const runtime = join(root, 'runtime');
const require = createRequire(join(runtime, 'package.json'));
const { build } = require('esbuild');
const { createSnapshotCore } = await import(pathToFileURL(join(runtime, 'dist/core/snapshot/index.js')).href);
const packet = join(root, 'Runtime Core Semantic Contract RFC/m4/wave2a-20261023T124740Z');
const temp = await mkdtemp(join(tmpdir(), 'aotui-independent-wave2a-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let release; const promise = new Promise(r => { release = r; }); return {promise, release}; };
async function until(check) {
    const deadline = Date.now() + 5000;
    let last;
    while (Date.now() < deadline) {
        try { return check(); } catch (error) { last = error; }
        await new Promise(resolve => setImmediate(resolve));
    }
    throw last ?? new Error('Review fixture did not reach its required state');
}
const results = [];
try {
    const modules = join(temp, 'node_modules');
    await mkdir(join(modules, '@aotui'), {recursive:true});
    await symlink(join(runtime, 'node_modules/preact'), join(modules, 'preact'), 'dir');
    await symlink(join(runtime, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
    await symlink(runtime, join(modules, '@aotui/runtime'), 'dir');
    const buildOptions = {bundle:true, platform:'node', format:'esm', target:'node20', packages:'external', logLevel:'silent'};
    const workerFile = join(temp, 'worker.mjs');
    await build({...buildOptions, entryPoints:[join(runtime, 'src/worker-runtime/index.ts')], outfile:workerFile});
    const fixture = `
        import {h} from 'preact';
        import {useLayoutEffect, useState} from 'preact/hooks';
        import {createTUIApp} from './sdk/src/app-factory/createTUIApp.ts';
        import {View} from './sdk/src/components/View.tsx';
        import {useViewTypeTool} from './sdk/src/hooks/useViewTypeTool.ts';
        const calls = {A:0,B:0};
        const options = {description:'Inspect selected file',params:{},isMutating:false};
        function File({who}) {
            useViewTypeTool('inspect',options,async () => {
                calls[who]++; return {success:true,data:{who}};
            });
            return h('p',{},who);
        }
        function Workspace() {
            const [revision,set] = useState(0);
            useLayoutEffect(() => {
                const on = event => {
                    if (event.detail?.viewId==='workspace' && event.detail?.type==='bump') set(n=>n+1);
                };
                document.body.addEventListener('aotui:external-event',on);
                return () => document.body.removeEventListener('aotui:external-event',on);
            },[]);
            useViewTypeTool('stats',{description:'Observe fixture counters',params:{},isMutating:false},
                async () => ({success:true,data:{...calls}}));
            return h('section',{},h('p',{},'revision '+revision),
                h(View,{id:'fd_A',type:'FileDetail',key:'A'},h(File,{who:'A'})),
                h(View,{id:'fd_B',type:'FileDetail',key:'B'},h(File,{who:'B'})));
        }
        export default createTUIApp({app_name:'audit_app',component:()=>
            h(View,{id:'workspace',type:'Workspace'},h(Workspace,{}))});
    `;
    const appFile = join(temp, 'app.mjs');
    await build({...buildOptions,stdin:{contents:fixture,resolveDir:root,sourcefile:'independent-fixture.tsx',loader:'tsx'},outfile:appFile});
    for (const [name,filename,expectedHash] of [
        ['before',join(packet,'baseline-readonly/runtime/src/engine/app/worker-host.ts'),'3326f6b0f84caae9d189e8856dcc71a1ed16cea61784df0bd140572820b3087e'],
        ['after',join(runtime,'src/engine/app/worker-host.ts'),'28ede7ca387b143e45cbb9df2da8c779ac9a82d5a22f75931d298a2cdfbbfeee'],
    ]) {
        const bytes=await readFile(filename);
        assert.equal(sha(bytes),expectedHash,'Review source mismatch');
        const hostFile=join(temp,`host-${name}.mjs`);
        await build({...buildOptions,stdin:{contents:bytes.toString(),resolveDir:join(runtime,'src/engine/app'),sourcefile:`host-${name}.ts`,loader:'ts'},outfile:hostFile});
        const {AppWorkerHost}=await import(pathToFileURL(hostFile).href);
        const host=new AppWorkerHost({appId:'audit_app',desktopId:'audit_desktop',appModulePath:appFile,
            workerScriptPath:workerFile,snapshotShadow:true,experimentalReadOnlyViewTools:true});
        let now=0;
        // Test clock only; the same real Core factory, set before INIT/capture.
        const core=createSnapshotCore({now:()=>now,historyTtlMs:20,leaseTtlMs:100});
        core.lifecycle.startApp('audit_app',host.appInstanceId);
        host.shadowReceiver.core=core;
        const latest=()=>{const value=core.store.readLatest('audit_app');assert.equal(value.status,'ready');return value.snapshot;};
        const entered=deferred(), grant=deferred();
        let pending;
        try {
            await host.start();await host.open();
            await until(()=>{const value=latest();assert.equal(value.schemaVersion,2);assert.equal(value.views.length,3);return value;});
            const old=latest().id;
            const input={snapshotId:old,toolId:JSON.stringify(['audit_app','FileDetail','inspect']),viewId:'fd_A',args:{}};
            pending=host.executeReadOnlyViewTool(input,async ()=>{entered.release();await grant.promise;return true;});
            await entered.promise;
            now=1;
            await host.sendExternalEvent('workspace','bump',{});
            await until(()=>{const value=latest();assert.notEqual(value.id,old);return value;});
            input.snapshotId=latest().id;input.viewId='fd_B';now=22;
            assert.equal(core.store.getById(old).status,'found','Old source must remain pinned data');
            const oldAcquire=core.store.acquire(old);
            assert.equal(oldAcquire.status,'rejected','But cannot be reacquired as valid source');
            assert.equal(oldAcquire.issue.code,'SNAPSHOT_EXPIRED');
            grant.release();
            const result=await pending;
            const stats=await host.executeReadOnlyViewTool({snapshotId:latest().id,
                toolId:JSON.stringify(['audit_app','Workspace','stats']),viewId:'workspace',args:{}},()=>true);
            assert.equal(stats.success,true);
            const record={version:name,hostSha256:expectedHash,success:result.success,
                error:result.error?.code??null,result:result.data??null,handlerCalls:stats.data,
                activeLeases:core.store.inspect().activeLeases};
            assert.equal(record.activeLeases,0);
            if(name==='before') {assert.equal(result.success,true);assert.deepEqual(stats.data,{A:1,B:0});}
            else {assert.equal(result.success,false);assert.equal(result.error?.code,'SNAPSHOT_EXPIRED');assert.deepEqual(stats.data,{A:0,B:0});}
            results.push(record);console.log('INDEPENDENT_REAL_SDK_TTL_DIFFERENTIAL='+JSON.stringify(record));
        } finally {
            grant.release();
            const worker=host.worker;
            host.terminate();
            await pending?.catch(()=>{});
            await worker?.terminate();
        }
    }
    console.log('DIFFERENTIAL_PASS='+JSON.stringify({baselineFailureReproduced:true,currentContractPass:true,productionSourcesEdited:false,testsExecuted:2}));
} finally {
    await rm(temp,{recursive:true,force:true});
}
