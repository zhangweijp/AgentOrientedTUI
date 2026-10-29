import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerSandbox } from './worker-sandbox.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';

const repo = resolve(process.cwd(), '..'), url = (file: string) => pathToFileURL(file).href;
async function capture(file: string, body: string) {
    await writeFile(file, body);const root = process.env.AOTUI_W08_C1_FACTS_DIR;
    if (root) { const hash = createHash('sha256').update(body).digest('hex'), folder = join(root, 'c2-inputs');await mkdir(folder, { recursive: true });await writeFile(join(folder, hash), body);await writeFile(join(folder, hash+'.json'), JSON.stringify({ path: file, sha256: hash, beforeSandboxConstruction: true })); }
}
async function facts(name: string, value: object) { const root = process.env.AOTUI_W08_C1_FACTS_DIR;if (root) { await mkdir(root, { recursive: true });await writeFile(join(root, 'c2-app-'+name+'.json'), JSON.stringify(value, null, 2)); } }

it.each([['sync', false], ['async', true]] as const)('C2-18/20 actual SDK %s unmount failure is fixed and preserves confirmed flush (Shadow=%s)', async (mode, snapshotShadow) => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c2-unmount-')), app = join(dir, 'app.mjs');
    await capture(app, `import {createTUIApp,usePersistentState} from ${JSON.stringify(url(join(repo,'sdk/dist/index.js')))};
let set;function Root(){[,set]=usePersistentState('value',0);return null;}
const factory=createTUIApp({app_name:'close',component:Root,onOperation:async()=>{set(7);return {success:true};}});
const initialize=factory.initializeComponent.bind(factory);factory.initializeComponent=async(...args)=>{const renderer=await initialize(...args);return {...renderer,${mode === 'async' ? 'async ' : ''}unmount(){renderer.unmount();${mode === 'async' ? 'await Promise.resolve();' : ''}throw Error('private renderer detail');}};};export default factory;`);
    const sandbox = new WorkerSandbox({ appId: 'app', desktopId: 'd', appModulePath: url(app), snapshotShadow,
        workerScriptPath: join(repo,'runtime/dist/worker-runtime/index.js'), runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 3000, pool: { initialSize: 0, maxSize: 1 } } }), config: { AOTUI_DATA_DIR: join(dir,'data'), AOTUI_APP_NAME: 'close' } });
    try {
        await sandbox.installDynamic();await sandbox.executeOperation('set', {}, 'snapshot');const worker = (sandbox as any).lease.worker;
        const close = sandbox.close();await expect(close).rejects.toHaveProperty('code','SANDBOX_CLOSE_FAILED');const report = await sandbox.disposeAsync();
        expect(report).toMatchObject({ state:'settled', resourcesReleased:true, ok:false, host:{ storage:{ support:'managed', lifecycle:{ unmount:'failed', flush:{ok:true}, dispose:{release:{status:'released'}} } } }, ownedPool:{state:'closed',total:0} });
        expect(worker.threadId).toBe(-1);expect(JSON.parse(await readFile(join(dir,'data/app-state/d/close/value.json'),'utf8')).value).toBe(7);
        expect(JSON.stringify(report)).not.toContain('private renderer detail');await facts('unmount-'+mode,{report,threadId:worker.threadId,snapshotShadow});
    } finally { await sandbox.disposeAsync();await rm(dir,{recursive:true,force:true}); }
}, 15000);

it.each(['sync','async'] as const)('C2-20 actual SDK %s onDelete failure sends a fixed failed lifecycle response exactly once and still unmounts', async mode => {
    const dir=await mkdtemp(join(tmpdir(),'aotui-c2-delete-')),app=join(dir,'app.mjs'),deleted=join(dir,'delete.txt'),unmounted=join(dir,'unmount.txt');
    await capture(app, `import {appendFile,writeFile} from 'node:fs/promises';import {appendFileSync} from 'node:fs';import {createTUIApp} from ${JSON.stringify(url(join(repo,'sdk/dist/index.js')))};
const factory=createTUIApp({app_name:'delete',component:()=>null,onDelete:${mode==='async'?'async ':''}()=>{${mode==='async'?`await appendFile(${JSON.stringify(deleted)},'delete\\n');`:`appendFileSync(${JSON.stringify(deleted)},'delete\\n');`}throw Error('private delete detail');}});
const initialize=factory.initializeComponent.bind(factory);factory.initializeComponent=async(...args)=>{const renderer=await initialize(...args);return {...renderer,async unmount(){renderer.unmount();await writeFile(${JSON.stringify(unmounted)},'done');}};};export default factory;`);
    const sandbox=new WorkerSandbox({appId:'app',desktopId:'d',appModulePath:url(app),workerScriptPath:join(repo,'runtime/dist/worker-runtime/index.js'),runtimeConfig:defineRuntimeConfig({worker:{timeoutMs:3000,pool:{initialSize:0,maxSize:1}}})});
    try {
        await sandbox.installDynamic();const worker=(sandbox as any).lease.worker,replies:any[]=[];worker.on('message',(value:any)=>{if(value.type==='LIFECYCLE_RESPONSE'&&value.error?.code==='APP_DELETE_FAILED')replies.push(value);});
        const closing=sandbox.delete();expect(sandbox.delete()).toBe(closing);await expect(closing).rejects.toHaveProperty('code','SANDBOX_CLOSE_FAILED');
        const report=await sandbox.disposeAsync();expect(report.issues).toContain('DELETE_FAILED');expect(report.resourcesReleased).toBe(true);expect(worker.threadId).toBe(-1);
        expect(await readFile(deleted,'utf8')).toBe('delete\n');expect(await readFile(unmounted,'utf8')).toBe('done');expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({success:false,error:{code:'APP_DELETE_FAILED',message:'APP_DELETE_FAILED'}});expect(JSON.stringify(replies)).not.toContain('private delete detail');await facts('delete-'+mode,{report,replies,threadId:worker.threadId});
    } finally { await sandbox.disposeAsync();await rm(dir,{recursive:true,force:true}); }
},15000);
