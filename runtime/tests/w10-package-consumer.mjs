import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const [consumer, factsPath] = process.argv.slice(2);
assert.ok(consumer && factsPath);
const facts = { consumer, startedAt: new Date().toISOString(), cases: [], passed: false };
const folder = path.join(consumer, 'public-checks-' + path.basename(factsPath, '.json')); await fs.mkdir(folder);
async function run(args, name) {
    try { const result = await execute(process.execPath, args, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
        facts.cases.push({ name, argv: [process.execPath, ...args], stdout: result.stdout, stderr: result.stderr, passed: true }); console.log('PASS', name); return result; }
    catch (error) { facts.cases.push({ name, passed: false, stdout: error.stdout, stderr: error.stderr }); throw error; }
}
try {
    const coreDoc = await fs.readFile(path.join(consumer, 'node_modules/@aotui/runtime/docs/core-public-entry.md'), 'utf8');
    const example = coreDoc.match(/<!-- b1-example:start -->\n```ts\n([\s\S]*?)\n```\n<!-- b1-example:end -->/)?.[1]; assert.ok(example);
    await fs.writeFile(path.join(folder, 'core-example.ts'), example);
    await fs.writeFile(path.join(folder, 'tool-types.ts'), `import type { RefTarget, OperationResult, ViewToolInvocationTerminal, SafeOrdinaryInvoker } from '@aotui/runtime/core';
// @ts-expect-error Removed entity-only transport type is not a public API.
import type { VersionedEntityResource } from '@aotui/runtime/core';
// @ts-expect-error Removed entity-only terminal is not a public API.
import type { VersionedEntityTerminal } from '@aotui/runtime/core';
// @ts-expect-error Removed entity-only callable is not a public API.
import type { SafeVersionedEntityInvoker } from '@aotui/runtime/core';
const entity: RefTarget = { kind: 'entity', entityType: 'Counter', entityId: 'one', entityVersion: '1' };
// @ts-expect-error Existing D5 entity references remain readonly.
entity.entityVersion = '2';
const result: OperationResult = { success: false, effects: 'partial', error: { code: 'PARTIAL', message: 'Application reports partial work' } };
// @ts-expect-error Only the existing none/partial effect declarations are accepted.
result.effects = 'verified';
const terminal: ViewToolInvocationTerminal = { phase: 'entered-returned', result: { success: false }, failureEffects: 'partial' };
const invoke: SafeOrdinaryInvoker = async _args => terminal;
void [entity, result, invoke];
`);
    const compiler = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false,
        lib: ['ES2022'], types: [], outDir: './core-out' };
    await fs.writeFile(path.join(folder, 'core-tsconfig.json'), JSON.stringify({ compilerOptions: compiler, files: ['./core-example.ts', './tool-types.ts'] }));
    const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
    await run([tsc, '-p', path.join(folder, 'core-tsconfig.json')], 'pure Core exact documentation and generic Tool types compile with ES2022 only; removed entity transport exports are absent');
    await run([path.join(folder, 'core-out/core-example.js')], 'pure Core exact package documentation executes');
    await fs.writeFile(path.join(folder, 'sdk-types.ts'), `import { h } from 'preact';
import { createRuntime, type InteractionMode } from '@aotui/runtime';
import { createTUIApp, View, useViewTypeTool, experimental_useAppLifecycle, type AppLifecycleCallbacks } from '@aotui/sdk';
// @ts-expect-error Removed entity-only Hook is not a public API.
import { experimental_useVersionedEntityTool } from '@aotui/sdk';
import type { AppLifecyclePort, AppCleanupReport } from '@aotui/runtime/spi';
import { ideEntryForRoute } from '@agentina/aotui-ide';
function Detail() {
 const [Increment] = useViewTypeTool('increment', { description: 'Increment counter', params: { amount: { type: 'number', required: true } }, isMutating: true }, async args => {
  args.amount.toFixed();
  // @ts-expect-error Numeric B1 inference remains precise.
  args.amount.toUpperCase();
  if (args.amount < 0) return { success: false, effects: 'none', error: { code: 'NEGATIVE', message: 'Application rejects a negative amount' } };
  return { success: true, data: { amount: args.amount } };
 });
 return h(Increment, { children: 'Increment' });
}
const owner: AppLifecycleCallbacks = { stop() {}, async close() {} };
function Root() { experimental_useAppLifecycle(owner); return h(View, { id: 'counter', type: 'Counter' }, h(Detail, {})); }
export default createTUIApp({ app_name: 'package_types', component: Root, experimentalAppLifecycle: true });
const mode: InteractionMode = 'ordinary-v2';
// @ts-expect-error There is no entity-only Worker interaction mode.
const removedMode: InteractionMode = 'versioned-entity-v1';
const entry: URL = ideEntryForRoute('scoped');
const lifecyclePort = (port: AppLifecyclePort, report: AppCleanupReport) => { const detach = port.register(owner); detach(); return report.state; };
void [mode, entry, lifecyclePort, createRuntime];
`);
    await fs.writeFile(path.join(folder, 'sdk-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './sdk-out' }, files: ['./sdk-types.ts'] }));
    await run([tsc, '-p', path.join(folder, 'sdk-tsconfig.json')], 'strict Runtime root SPI SDK IDE package entries and hook inference');
    await fs.writeFile(path.join(folder, 'adapter-types.ts'), `import { AOTUIDrivenSource, type AOTUIDrivenSourceOptions } from '@aotui/runtime/adapters';
import type { IDesktop, IKernel } from '@aotui/runtime/spi';
const options: AOTUIDrivenSourceOptions = { includeInstruction: false, instruction: 'fixture' };
// @ts-expect-error Adapter options retain their actual public type.
options.includeInstruction = 'yes';
export const source = (desktop: IDesktop, kernel: IKernel): AOTUIDrivenSource => new AOTUIDrivenSource(desktop, kernel, options);
`);
    await fs.writeFile(path.join(folder, 'adapter-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './adapter-out' }, files: ['./adapter-types.ts'] }));
    await run([tsc, '-p', path.join(folder, 'adapter-tsconfig.json')], 'legacy adapter public declaration graph compiles with skipLibCheck false');
    await fs.writeFile(path.join(folder, 'public-ide.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import path from 'node:path'; import {tmpdir} from 'node:os';
import {createRuntime} from '@aotui/runtime'; import {ideEntryForRoute} from '@agentina/aotui-ide';
const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-public-package-'))), root=path.join(base,'project'); await fs.mkdir(root);
const file=path.join(root,'example.ts'); await fs.writeFile(file,'export const answer = 1;\\n'); await fs.writeFile(path.join(root,'tsconfig.json'),'{}');
const runtime=createRuntime({worker:{timeoutMs:45000,pool:{initialSize:0,maxSize:1}}}); const outcomes=[]; let report;
const policy={project:({source,selection})=>{const ids=new Set(selection.viewIds);return {
 views:source.views.filter(v=>ids.has(v.id)).map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId})),
 refs:Object.values(source.refs).filter(r=>ids.has(r.ownerViewId)).map(r=>({viewId:r.ownerViewId,viewInstanceId:r.ownerViewInstanceId,refId:r.id})),
 targets:Object.values(source.tools).flatMap(t=>t.targets.filter(v=>ids.has(v.viewId)).map(target=>({toolId:t.id,target}))),content:source.views.filter(v=>ids.has(v.id)).map(v=>({view:{viewId:v.id,viewInstanceId:v.viewInstanceId},decision:'retain'}))};},authorize:()=>true,canReadReceipt:()=>true};
try {
 const desktop=await runtime.createDesktop('external'); const id=await runtime.installDynamicWorkerApp(desktop,ideEntryForRoute('scoped').href,{appId:'publicide',experimentalInteractionModes:['ordinary-v2'],config:{ideToolRoute:'scoped',projectPath:root,ideSessionKey:'publicide',ideHistoryPath:path.join(base,'history.json'),AOTUI_DATA_DIR:path.join(base,'state')}});
 const opened=runtime.experimentalCreateAppScope(desktop,id,policy); assert.equal(opened.status,'opened'); const client=opened.client;
 async function observe(view,condition=()=>true){const deadline=Date.now()+15000;let lastStatus;for(;;){
  const result=await client.observe({viewIds:[view]});
  if(result.status==='observed'){
   if(condition(result.observation))return result.observation;
   lastStatus={status:result.status,toolNames:result.observation.tools.map(t=>t.name),viewIds:result.observation.views.map(v=>v.id),conditionMatched:false};
   client.releaseObservation(result.observation.observationId);
  }else lastStatus=result;
  if(Date.now()>deadline)throw Error('Snapshot barrier '+JSON.stringify({view,lastStatus}));await new Promise(r=>setTimeout(r,20));
 }}
 async function fileDetailView(){const deadline=Date.now()+15000;let lastStatus;for(;;){
  const result=await client.observe({all:true});
  if(result.status==='observed'){
   const found=result.observation.views.find(view=>view.type==='FileDetail'&&view.name==='File: '+file);
   lastStatus={status:result.status,views:result.observation.views.map(view=>({id:view.id,type:view.type,name:view.name}))};
   client.releaseObservation(result.observation.observationId);if(found)return found.id;
  }else lastStatus=result;
  if(Date.now()>deadline)throw Error('FileDetail semantic barrier '+JSON.stringify({lastStatus}));await new Promise(r=>setTimeout(r,20));
 }}
 async function call(o,name,input){const tool=o.tools.find(t=>t.name===name),binding=o.bindings.find(b=>b.toolId===tool?.id);assert.ok(binding);assert.equal(tool.isMutating,true);const result=await client.invoke({invocationId:'public-'+outcomes.length,observationId:o.observationId,bindingId:binding.bindingId,input});outcomes.push(result);assert.equal(result.kind,'receipt');assert.equal(result.receipt.outcome.status,'succeeded',JSON.stringify(result));return result.receipt.outcome.value;}
 let observation=await observe('workspace',o=>o.tools.some(t=>t.name==='multi_open_file'));
 assert.equal(observation.refs.length,0,'Workspace Tools need no entity references');await call(observation,'multi_open_file',{filePaths:[file]});
 client.releaseObservation(observation.observationId);const view=await fileDetailView();
 observation=await observe(view,o=>o.tools.some(t=>t.name==='write_file'));
 await call(observation,'write_file',{content:'export const answer = 2;\\n'});assert.equal(await fs.readFile(file,'utf8'),'export const answer = 2;\\n');
 client.releaseObservation(observation.observationId);
 observation=await observe(view,o=>o.tools.some(t=>t.name==='lsp_hover')&&o.views.some(v=>v.content?.value.includes('answer = 2')));const hover=await call(observation,'lsp_hover',{file_path:file,line:1,character:15});
 assert.equal(hover.success,true);assert.ok(hover.data.documentVersion>0);assert.match(JSON.stringify(hover.data.value),/answer/,'Actual language-server hover contains the source symbol');
 client.close(); report=await runtime.beginShutdown().completion; assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.resourcesReleased,true);assert.equal(report.appCleanup?.managedApps,1);assert.equal(report.appCleanup?.completedApps,1);assert.equal(report.appCleanup?.failedApps,0);assert.equal(report.appCleanup?.legacyUnverifiedApps,0);
 console.log('PUBLIC_IDE',JSON.stringify({base,outcomes,report,defaultWorkerResolution:true,ordinaryMutation:true,actualLspHover:hover.data}));
} finally {await runtime.beginShutdown().completion;}
`);
    const publicResult = await run([path.join(folder, 'public-ide.mjs')], 'public default Runtime Worker installs full scoped IDE and executes ordinary mutation plus actual LSP');
    const line = publicResult.stdout.split('\n').find(line => line.startsWith('PUBLIC_IDE ')); assert.ok(line); facts.publicIDE = JSON.parse(line.slice(11));
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { facts.finishedAt = new Date().toISOString(); await fs.writeFile(factsPath, JSON.stringify(facts, null, 2)); console.log('PUBLIC_PACKAGE_FACTS', JSON.stringify({ passed: facts.passed, factsPath })); }
