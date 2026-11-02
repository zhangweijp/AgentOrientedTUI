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
    await fs.writeFile(path.join(folder, 'tool-types.ts'), `import type { RefTarget, OperationResult, ViewToolInvocationTerminal, SafeOrdinaryInvoker, AppSnapshotV2, SnapshotRead } from '@aotui/runtime/core';
// @ts-expect-error AppSnapshotV2 is the only public snapshot type name.
import type { AppSnapshot } from '@aotui/runtime/core';
// @ts-expect-error Validation envelope details are not part of the Core package API.
import type { SnapshotDraftEnvelope } from '@aotui/runtime/core';
// @ts-expect-error Snapshot health is represented by SnapshotRead.status.
import type { SnapshotHealth } from '@aotui/runtime/core';
// @ts-expect-error Factory return types are inferred rather than exported as aliases.
import type { ViewOwnedTools } from '@aotui/runtime/core';
// @ts-expect-error Factory return types are inferred rather than exported as aliases.
import type { StateSession } from '@aotui/runtime/core';
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
const readySnapshot = (read: SnapshotRead): AppSnapshotV2 | undefined => read.status === 'ready' ? read.snapshot : undefined;
void [entity, result, invoke, readySnapshot];
`);
    const compiler = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false,
        lib: ['ES2022'], types: [], outDir: './core-out' };
    await fs.writeFile(path.join(folder, 'core-tsconfig.json'), JSON.stringify({ compilerOptions: compiler, files: ['./core-example.ts', './tool-types.ts'] }));
    const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
    await run([tsc, '-p', path.join(folder, 'core-tsconfig.json')], 'pure Core exact documentation and generic Tool types compile with ES2022 only; removed entity transport exports are absent');
    await run([path.join(folder, 'core-out/core-example.js')], 'pure Core exact package documentation executes');
    await fs.writeFile(path.join(folder, 'sdk-types.ts'), `import { h } from 'preact';
import { createRuntime, type InteractionMode } from '@aotui/runtime';
import { createTUIApp, View, useViewTypeTool, useAppLifecycle, type AppLifecycleCallbacks } from '@aotui/sdk';
import ideDefault from '@agentina/aotui-ide';
import type { TUIAppFactory } from '@aotui/runtime/spi';
// @ts-expect-error Removed entity-only Hook is not a public API.
import { experimental_useVersionedEntityTool } from '@aotui/sdk';
import type { AppLifecyclePort, AppCleanupReport } from '@aotui/runtime/spi';
// @ts-expect-error The IDE package has one default managed factory, not route-specific entries.
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
function Root() { useAppLifecycle(owner); return h(View, { id: 'counter', type: 'Counter' }, h(Detail, {})); }
const ideFactory: TUIAppFactory = ideDefault;
const persistenceSupport: 'state-session-v1' = ideFactory.persistenceSupport;
const ideLifecycleSupport: 'app-lifecycle-v2' = ideFactory.appLifecycleSupport;
const managedFactory = createTUIApp({ app_name: 'package_types', component: Root });
const lifecycleSupport: 'app-lifecycle-v2' = managedFactory.appLifecycleSupport;
// @ts-expect-error Managed lifecycle support is the default factory contract, not a config flag.
createTUIApp({ app_name: 'retired_lifecycle_flag', component: Root, experimentalAppLifecycle: true });
export default managedFactory;
const mode: InteractionMode = 'ordinary-v2';
const refMode: InteractionMode = 'snapshot-value-v2';
// @ts-expect-error Legacy ordinary-v1 is not a supported Host interaction mode.
const removedMode: InteractionMode = 'ordinary-v1';
// @ts-expect-error Entity-only transport is not a supported Host interaction mode.
const removedEntityMode: InteractionMode = 'versioned-entity-v1';
const lifecyclePort = (port: AppLifecyclePort, report: AppCleanupReport) => { const detach = port.register(owner); detach(); return report.state; };
void [mode, refMode, lifecyclePort, lifecycleSupport, persistenceSupport, ideLifecycleSupport, ideFactory, createRuntime, removedMode, removedEntityMode];
`);
    await fs.writeFile(path.join(folder, 'sdk-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './sdk-out' }, files: ['./sdk-types.ts'] }));
    await run([tsc, '-p', path.join(folder, 'sdk-tsconfig.json')], 'strict Runtime root SPI SDK IDE package entries and hook inference');
    await fs.writeFile(path.join(folder, 'adapter-types.ts'), `import { SemanticAOTUIDrivenSource, type SemanticAOTUIDrivenSourceOptions } from '@aotui/runtime/adapters';
import type { ContextDrivenSource } from '@aotui/agent-driver-v2';
import type { ScopePolicy } from '@aotui/runtime/core';
import type { DesktopID, IDesktop, IKernel } from '@aotui/runtime/spi';
// @ts-expect-error The split-read Legacy source is no longer a public adapter.
import type { AOTUIDrivenSource } from '@aotui/runtime/adapters';
const options: SemanticAOTUIDrivenSourceOptions = { includeInstruction: false, instruction: 'fixture' };
// @ts-expect-error Adapter options retain their actual public type.
options.includeInstruction = 'yes';
export const source = (desktop: IDesktop, kernel: IKernel): ContextDrivenSource => new SemanticAOTUIDrivenSource(desktop, kernel, options);
export async function releaseContext(instance: SemanticAOTUIDrivenSource): Promise<void> {
 const context = await instance.getContext();
 await context.release?.();
 instance.dispose();
}
export const createScope = (kernel: IKernel, desktopId: DesktopID, appId: string, policy: ScopePolicy) => kernel.createAppScope(desktopId, appId, policy);
`);
    await fs.writeFile(path.join(folder, 'adapter-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './adapter-out' }, files: ['./adapter-types.ts'] }));
    await run([tsc, '-p', path.join(folder, 'adapter-tsconfig.json')], 'Semantic Source, Context release, createAppScope, and public declarations compile with skipLibCheck false');
    await fs.writeFile(path.join(folder, 'public-ide.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import path from 'node:path'; import {tmpdir} from 'node:os';
import {createRuntime} from '@aotui/runtime'; import {SemanticAOTUIDrivenSource} from '@aotui/runtime/adapters'; import ideFactory from '@agentina/aotui-ide';
const ideModulePath=import.meta.resolve('@agentina/aotui-ide');
assert.equal(Object.getOwnPropertyDescriptor(ideFactory,'persistenceSupport')?.value,'state-session-v1');
assert.equal(Object.getOwnPropertyDescriptor(ideFactory,'appLifecycleSupport')?.value,'app-lifecycle-v2');
const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-public-package-'))), root=path.join(base,'project'); await fs.mkdir(root);
const file=path.join(root,'example.ts'); await fs.writeFile(file,'export const answer = 1;\\n'); await fs.writeFile(path.join(root,'tsconfig.json'),'{}');
const runtime=createRuntime({worker:{timeoutMs:45000,pool:{initialSize:0,maxSize:1}}}); const outcomes=[]; let source, context, report;
try {
 const desktopId=await runtime.createDesktop('external'); const appId=await runtime.installDynamicWorkerApp(desktopId,ideModulePath,{appId:'publicide',interactionModes:['ordinary-v2','snapshot-value-v2'],config:{projectPath:root,ideSessionKey:'publicide',ideHistoryPath:path.join(base,'history.json'),AOTUI_DATA_DIR:path.join(base,'state')}});
 source=new SemanticAOTUIDrivenSource(runtime.getDesktop(desktopId),runtime,{includeInstruction:false});
 async function capture(){context=await source.getContext();assert.equal(typeof context.executeTool,'function');return context;}
 async function captureWhenToolIsAvailable(suffix){
  const deadline=Date.now()+15000;let available=[];
  for(;;){
   const current=await capture();
   if(Object.keys(current.tools).some(name=>name.endsWith('-'+suffix)))return current;
   available=Object.keys(current.tools);
   await current.release?.();if(context===current)context=undefined;
   if(Date.now()>=deadline)throw new Error('Semantic context barrier expired waiting for '+suffix+'; available: '+available.join(', '));
   await new Promise(resolve=>setTimeout(resolve,20));
  }
 }
 async function invoke(current,suffix,input){const name=Object.keys(current.tools).find(key=>key.endsWith('-'+suffix));assert.ok(name,'Semantic context includes '+suffix+': '+Object.keys(current.tools));const result=await current.executeTool(name,input,'public-'+outcomes.length);assert.ok(result);outcomes.push(result);assert.equal(result.outcomeStatus,'succeeded',JSON.stringify(result));return result;}
 context=await captureWhenToolIsAvailable('multi_open_file');
 const opened=await invoke(context,'multi_open_file',{filePaths:[file]});assert.equal(opened.result?.message,'multi_open_file completed. Read the current IDE Views for the updated state.');
 await context.release?.();context=undefined;
 context=await capture();assert.ok(context.messages.some(message=>String(message.content).includes('export const answer = 1;')),'New Context observes the opened FileDetail');
 const written=await invoke(context,'write_file',{filePath:file,content:'export const answer = 2;\\n'});assert.ok(written.result);assert.equal(await fs.readFile(file,'utf8'),'export const answer = 2;\\n');
 await context.release?.();context=undefined;
 context=await capture();assert.ok(context.messages.some(message=>String(message.content).includes('export const answer = 2;')),'New Context observes the completed write');
 const hover=await invoke(context,'lsp_hover',{file_path:file,line:1,character:15});assert.match(hover.result?.message,/Read the current IDE Views/);
 await context.release?.();context=undefined;context=await capture();const currentView=context.messages.map(message=>String(message.content)).join('\\n');
 assert.match(currentView,/documentVersion[^0-9]*[1-9][0-9]*/,'The current FileDetail View contains an actual versioned LSP hover result');assert.match(currentView,/hover/);assert.match(currentView,/answer/);
 await context.release?.();context=undefined;source.dispose();source=undefined;
 report=await runtime.beginShutdown().completion; assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.resourcesReleased,true);assert.equal(report.appCleanup?.managedApps,1);assert.equal(report.appCleanup?.completedApps,1);assert.equal(report.appCleanup?.failedApps,0);
 console.log('PUBLIC_IDE',JSON.stringify({base,outcomes,report,defaultWorkerResolution:true,interactionModes:['ordinary-v2','snapshot-value-v2'],ordinaryMutation:true,actualLspHover:hover.result}));
} finally {await context?.release?.();source?.dispose();await runtime.beginShutdown().completion;}
`);
    const publicResult = await run([path.join(folder, 'public-ide.mjs')], 'public default Runtime Worker uses Semantic Context/release for ordinary IDE mutation, actual LSP, and managed shutdown');
    const line = publicResult.stdout.split('\n').find(line => line.startsWith('PUBLIC_IDE ')); assert.ok(line); facts.publicIDE = JSON.parse(line.slice(11));
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { facts.finishedAt = new Date().toISOString(); await fs.writeFile(factsPath, JSON.stringify(facts, null, 2)); console.log('PUBLIC_PACKAGE_FACTS', JSON.stringify({ passed: facts.passed, factsPath })); }
