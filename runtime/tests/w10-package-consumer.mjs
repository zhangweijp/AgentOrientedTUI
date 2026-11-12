import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const [consumer, factsPath, selection = 'full'] = process.argv.slice(2);
assert.ok(['full', 'ref-only'].includes(selection));
const refOnly = selection === 'ref-only';
assert.ok(process.env.AOTUI_DATA_DIR && path.isAbsolute(process.env.AOTUI_DATA_DIR), 'Explicit synthetic state root is required');
assert.ok(consumer && factsPath);
const facts = { consumer, selection, completeW10Claimed: false, skipped: refOnly ? ['Core documentation example (covered by its separate consumer)', 'IDE type/factory checks', 'real IDE/LSP run'] : [], startedAt: new Date().toISOString(), cases: [], passed: false };
const folder = path.join(consumer, 'public-checks-' + path.basename(factsPath, '.json')); await fs.mkdir(folder);
async function run(args, name) {
    try { const result = await execute(process.execPath, args, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
        facts.cases.push({ name, argv: [process.execPath, ...args], stdout: result.stdout, stderr: result.stderr, passed: true }); console.log('PASS', name); return result; }
    catch (error) { facts.cases.push({ name, passed: false, stdout: error.stdout, stderr: error.stderr }); throw error; }
}
try {
    if (!refOnly) {
    const coreDoc = await fs.readFile(path.join(consumer, 'node_modules/@aotui/runtime/docs/core-public-entry.md'), 'utf8');
    const example = coreDoc.match(/<!-- b1-example:start -->\n```ts\n([\s\S]*?)\n```\n<!-- b1-example:end -->/)?.[1]; assert.ok(example);
    await fs.writeFile(path.join(folder, 'core-example.ts'), example);
    }
    await fs.writeFile(path.join(folder, 'tool-types.ts'), `import type { RefTarget, ToolResult, ViewToolInvocationTerminal, SafeOrdinaryInvoker, AppSnapshotV3, SnapshotRead } from '@aotui/runtime/core';
// @ts-expect-error V3 is the sole public AppSnapshot DTO.
import type { AppSnapshotV2 } from '@aotui/runtime/core';
// @ts-expect-error AppSnapshotV3 is the only public AppSnapshot type name.
import type { AppSnapshot } from '@aotui/runtime/core';
// @ts-expect-error Validation envelope details are not part of the Core package API.
import type { SnapshotDraftEnvelope } from '@aotui/runtime/core';
// @ts-expect-error Snapshot health is represented by SnapshotRead.status.
import type { SnapshotHealth } from '@aotui/runtime/core';
// @ts-expect-error ToolResult is the sole business result format.
import type { ActionOutcome } from '@aotui/runtime/core';
// @ts-expect-error Generic background-task polling is no longer a Core contract.
import type { TaskProgressProvider } from '@aotui/runtime/core';
// @ts-expect-error The earlier provider name is also removed.
import type { OperationProvider } from '@aotui/runtime/core';
// @ts-expect-error A separately created Scope is no longer a public type.
import type { ScopeClient } from '@aotui/runtime/core';
import type { AppInteraction, AppInvocation } from '@aotui/runtime/core';
export const readOriginal = (client: AppInteraction, request: AppInvocation) => client.readReceipt(request);
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
const result: ToolResult = { success: false, effects: 'partial', error: { code: 'PARTIAL', message: 'Application reports partial work' } };
// @ts-expect-error Only the existing none/partial effect declarations are accepted.
result.effects = 'verified';
const terminal: ViewToolInvocationTerminal = { phase: 'entered-returned', result: { success: false, error: { code: 'PARTIAL', message: 'Application reports partial work' } }, failureEffects: 'partial' };
const invoke: SafeOrdinaryInvoker = async _args => terminal;
const readySnapshot = (read: SnapshotRead): AppSnapshotV3 | undefined => read.status === 'ready' ? read.snapshot : undefined;
void [entity, result, invoke, readySnapshot];
`);
    const compiler = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
        lib: ['ES2022'], types: [], outDir: './core-out' };
    await fs.writeFile(path.join(folder, 'core-tsconfig.json'), JSON.stringify({ compilerOptions: compiler, files: refOnly ? ['./tool-types.ts'] : ['./core-example.ts', './tool-types.ts'] }));
    const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
    await run([tsc, '-p', path.join(folder, 'core-tsconfig.json')], refOnly ? 'generic Core Tool types compile with ES2022 only; Core documentation covered by its separate consumer' : 'pure Core exact documentation and generic Tool types compile with ES2022 only; removed entity transport exports are absent');
    if (!refOnly) await run([path.join(folder, 'core-out/core-example.js')], 'pure Core exact package documentation executes');
    const ideTypeImports = `import ideDefault from '@agentina/aotui-ide';
// @ts-expect-error The IDE package has one default managed factory, not route-specific entries.
import { ideEntryForRoute } from '@agentina/aotui-ide';`;
    const ideTypeAssertions = `const ideFactory: TUIAppFactory = ideDefault;
const persistenceSupport: 'state-session-v1' = ideFactory.persistenceSupport;
const ideLifecycleSupport: 'app-lifecycle-v2' = ideFactory.appLifecycleSupport;
const ideToolAuthoringProtocol: 'view-type-tools-v4' = ideFactory.toolAuthoringProtocol;
void [persistenceSupport, ideLifecycleSupport, ideToolAuthoringProtocol, ideFactory];`;
    await fs.writeFile(path.join(folder, 'sdk-types.ts'), `import { h } from 'preact';
import { Type } from 'typebox';
import { createRuntime, type InteractionMode } from '@aotui/runtime';
import { createTUIApp, defineViewTypeTool, View, useDataRef, refParam, AppTools, defineToolSet, type ArgsOf, type ToolSetMap, type ToolBindings, useAppLifecycle, type AppLifecycleCallbacks } from '@aotui/sdk';
${refOnly ? '' : ideTypeImports}
import type { TUIAppFactory } from '@aotui/runtime/spi';
// @ts-expect-error Removed entity-only Hook is not a public API.
import { experimental_useVersionedEntityTool } from '@aotui/sdk';
import type { AppLifecyclePort, AppCleanupReport } from '@aotui/runtime/spi';
const incrementTool = defineViewTypeTool({ viewType: 'Counter', name: 'increment', description: 'Increment counter',
 inputSchema: Type.Object({ amount: Type.Number() }, { additionalProperties: false }), });
const inspectTool = defineViewTypeTool({ viewType: 'Counter', name: 'inspect_record', description: 'Inspect the displayed original record.', inputSchema: Type.Object({ record: refParam('Record', Type.Object({ id: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }) });
const tools = defineToolSet({ increment: incrementTool, inspect: inspectTool });
function Detail() { return 'Counter'; }
function RefDetail() {
 const current = useDataRef('current_record', { id: 'record-1' }, { refType: 'Record' });
 return h('p', {}, current('Current record'));
}
const inspectBinding: ToolBindings<ToolSetMap<typeof tools>>['inspect'] = { execute(args: ArgsOf<typeof inspectTool>) {
 const id: string = args.record.id;
 // @ts-expect-error Ref input is an object, not the model's name string.
 args.record.toUpperCase();
 // @ts-expect-error Resolved Ref object is recursively immutable.
 args.record.id = 'changed';
 // @ts-expect-error The whole handler parameter is immutable.
 args.record = { id: 'changed' };
 void id; return { success: true };
} };
const owner: AppLifecycleCallbacks = { stop() {}, async close() {} };
function Root() { useAppLifecycle(owner); return h(AppTools<ToolSetMap<typeof tools>, ToolBindings<ToolSetMap<typeof tools>>>, {definition: tools, bindings: {inspect: inspectBinding, increment: {async execute(args: ArgsOf<typeof tools.increment>): Promise<import('@aotui/sdk').ToolResult> {
  args.amount.toFixed();
  // @ts-expect-error Numeric B1 inference remains precise.
  args.amount.toUpperCase();
  if (args.amount < 0) return { success: false, effects: 'none', error: { code: 'NEGATIVE', message: 'Application rejects a negative amount' } };
  return { success: true, data: { amount: args.amount } };
 }}}}, h(View, {kind: 'state', id: 'counter', type: 'Counter' }, h(Detail, {}))); }
${refOnly ? '' : ideTypeAssertions}
const managedFactory = createTUIApp({ app_name: 'package_types', component: Root });
const lifecycleSupport: 'app-lifecycle-v2' = managedFactory.appLifecycleSupport;
const toolAuthoringProtocol: 'view-type-tools-v4' = managedFactory.toolAuthoringProtocol;
// @ts-expect-error Managed lifecycle support is the default factory contract, not a config flag.
createTUIApp({ app_name: 'retired_lifecycle_flag', component: Root, experimentalAppLifecycle: true });
export default managedFactory;
const mode: InteractionMode = 'view-type-parameters-v1';
const refMode: InteractionMode = 'view-type-parameters-v1';
// @ts-expect-error Legacy ordinary-v1 is not a supported Host interaction mode.
const removedMode: InteractionMode = 'ordinary-v1';
// @ts-expect-error Entity-only transport is not a supported Host interaction mode.
const removedEntityMode: InteractionMode = 'versioned-entity-v1';
const lifecyclePort = (port: AppLifecyclePort, report: AppCleanupReport) => { const detach = port.register(owner); detach(); return report.state; };
void [mode, refMode, lifecyclePort, lifecycleSupport, toolAuthoringProtocol, createRuntime, removedMode, removedEntityMode];
`);
    await fs.writeFile(path.join(folder, 'sdk-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './sdk-out' }, files: ['./sdk-types.ts'] }));
    await run([tsc, '-p', path.join(folder, 'sdk-tsconfig.json')], refOnly ? 'strict Runtime/SPI/SDK Ref subset; IDE types not executed' : 'strict Runtime/SPI/SDK plus original IDE assertions');
    await fs.writeFile(path.join(folder, 'adapter-types.ts'), `import { SemanticAOTUIDrivenSource, type SemanticAOTUIDrivenSourceOptions } from '@aotui/agent-driver-adapter';
import type { ContextDrivenSource } from '@aotui/agent-driver-v2';
import type { AppInteractionPolicy } from '@aotui/runtime/core';
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
export const interaction = (kernel: IKernel, desktopId: DesktopID, appId: string, instanceId: string, policy: AppInteractionPolicy) => kernel.getAppInteraction(desktopId, appId, instanceId, policy);
`);
    await fs.writeFile(path.join(folder, 'adapter-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './adapter-out' }, files: ['./adapter-types.ts'] }));
    try {
      await run([tsc, '-p', path.join(folder, 'adapter-tsconfig.json')], 'Semantic Source, Context release, getAppInteraction, and public declarations compile with skipLibCheck false');
    } catch {
      // The JS behavior below does not consume this failed TS output. Keep the
      // required type gate red while collecting the independent real call proof.
      facts.adapterTypeGateFailed = true;
    }
    const toolAppPath = path.join(folder, 'type-tool-app.mjs');
    const witnessPath = path.join(folder, 'ref-witness.jsonl');
    await fs.writeFile(witnessPath, '', { flag: 'wx' });
    await fs.writeFile(toolAppPath, `import { h } from 'preact';
import { useState } from 'preact/hooks';
import { appendFileSync } from 'node:fs';
import Type from 'typebox';
import { createTUIApp, defineViewTypeTool, useDataRef, refParam, AppTools, defineToolSet, View } from '@aotui/sdk';
const filePath = '/open/a.txt';
// This test-only witness is outside Tool Result and the App projection.
const witnessFile = ${JSON.stringify(witnessPath)};
const witness = data => appendFileSync(witnessFile, JSON.stringify(data) + '\\n');
const tools = defineToolSet({
 EditUI: defineViewTypeTool({ viewType: 'FileDetail', name: 'edit_file', description: 'Replace the contents of an opened file.', inputSchema: Type.Object({ filePath: Type.String(), content: Type.String() }, { additionalProperties: false }) }),
 InspectUI: defineViewTypeTool({ viewType: 'FileDetail', name: 'inspect_snapshot', description: 'Inspect a complete File Ref from the current View.', inputSchema: Type.Object({ record: refParam('File', Type.Object({ filePath: Type.String(), content: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }) }),
});
function FileDetail({ content }) {
 const current = useDataRef('current_file', { filePath, content }, { refType: 'File' });
 return h('section', {}, [h('p', {}, current('Current file')), h('pre', {}, content)]);
}
function App() {
 const [content, setContent] = useState('OLD_PACKAGE_VIEW_VALUE');
 return h(AppTools, { definition: tools, bindings: {
  EditUI: { execute: args => {
   witness({ stage: 'handler-entry', name: 'edit_file' });
   if (args.filePath !== filePath) { witness({ stage: 'app-guard', name: 'edit_file', stateBefore: content, stateAfter: content });
    return { success: false, effects: 'none', error: { code: 'FILE_NOT_OPEN', message: 'The selected file is not open.' } }; }
   setContent(args.content); witness({ stage: 'business', name: 'edit_file', previous: content, requested: args.content });
   return { success: true, data: { message: 'Editor state updated.' } };
  } },
  InspectUI: { execute: args => {
   witness({ stage: 'handler-entry', name: 'inspect_snapshot' });
   witness({ stage: 'ref-payload', name: 'inspect_snapshot', payload: args.record, frozen: Object.isFrozen(args.record) });
   return { success: true, data: { message: 'Snapshot inspected.' } };
  } },
 } }, h('main', {}, [h(View, {kind: 'instruction', id: 'root', type: 'Root' }, h('p', {}, 'Package consumer tool test.')),
  h(View, {kind: 'state', id: 'file_a', type: 'FileDetail' }, h(FileDetail, { content }))]));
}
export default createTUIApp({ app_name: 'package_type_tool_consumer', component: App });
`);
    await fs.writeFile(path.join(folder, 'public-tools.mjs'), `import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

const runtime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
const calls = [];
const readWitness = async () => (await readFile(${JSON.stringify(witnessPath)}, 'utf8')).trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
let source, context, report;
try {
 const desktopId = await runtime.createDesktop('package-tool-consumer');
 const appId = await runtime.installDynamicWorkerApp(desktopId, pathToFileURL(path.join(${JSON.stringify(folder)}, 'type-tool-app.mjs')).href, {
  appId: 'packagetools', interactionModes: ['view-type-parameters-v1'], config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR },
 });
 assert.equal(appId, 'packagetools');
 source = new SemanticAOTUIDrivenSource(runtime.getDesktop(desktopId), runtime, { includeInstruction: false, instruction: 'Isolated SDK and Runtime Ref consumer verification.' });
 async function captureReady() {
  const deadline = Date.now() + 15000;
  let names = [];
  for (;;) {
   context = await source.getContext();
   assert.equal(typeof context.executeTool, 'function');
   names = Object.keys(context.tools);
   if (names.some(name => name.endsWith('-edit_file')) && names.some(name => name.endsWith('-inspect_snapshot'))) { await context.adopt(); return context; }
   await context.release?.(); if (context) context = undefined;
   if (Date.now() >= deadline) throw new Error('Semantic Context did not expose package ordinary and Ref Tools: ' + names.join(', '));
   await new Promise(resolve => setTimeout(resolve, 20));
  }
 }
 function toolName(current, suffix) {
  const name = Object.keys(current.tools).find(candidate => candidate.endsWith('-' + suffix));
  assert.ok(name, 'Semantic Context includes ' + suffix + ': ' + Object.keys(current.tools).join(', '));
  return name;
 }
 context = await captureReady();
 const editName = toolName(context, 'edit_file'), refName = toolName(context, 'inspect_snapshot');
 const inspected = await context.executeTool(refName, { record: 'file_a.current_file' }, 'snapshot-before-edit');
 assert.equal(inspected?.outcomeStatus, 'succeeded', JSON.stringify(inspected));
 assert.equal(inspected.result?.message, 'Snapshot inspected.');
 assert.ok(!JSON.stringify(inspected).includes('OLD_PACKAGE_VIEW_VALUE'));
 const beforeWitness = (await readWitness()).filter(row => row.stage === 'ref-payload');
 assert.equal(beforeWitness.length, 1); assert.equal(beforeWitness[0].payload.filePath, '/open/a.txt');
 assert.equal(beforeWitness[0].payload.content, 'OLD_PACKAGE_VIEW_VALUE'); assert.equal(beforeWitness[0].frozen, true);
 calls.push({ name: 'inspect-before', result: inspected });
 const denied = await context.executeTool(editName, { filePath: '/open/b.txt', content: 'MUST_NOT_APPEAR' }, 'edit-closed-file');
 calls.push({ name: 'edit_file-b', result: denied });
 assert.equal(denied?.outcomeStatus, 'failed', JSON.stringify(denied));
 assert.equal(denied.error?.code, 'FILE_NOT_OPEN', JSON.stringify(denied));
 assert.ok(!JSON.stringify(denied).includes('MUST_NOT_APPEAR'));
 const changed = await context.executeTool(editName, { filePath: '/open/a.txt', content: 'NEW_PACKAGE_VIEW_VALUE' }, 'edit-open-file');
 calls.push({ name: 'edit_file-a', result: changed });
 assert.equal(changed?.outcomeStatus, 'succeeded', JSON.stringify(changed));
 assert.ok(!JSON.stringify(changed).includes('NEW_PACKAGE_VIEW_VALUE'), 'Tool receipt must not duplicate View data');
 await context.release?.(); context = undefined;
 context = await captureReady();
 const latest = context.messages.map(message => String(message.content)).join('\\n');
 assert.ok(latest.includes('NEW_PACKAGE_VIEW_VALUE'), 'A fresh Source context observes the updated FileDetail View');
 assert.ok(!latest.includes('OLD_PACKAGE_VIEW_VALUE'), 'The old FileDetail snapshot is not retained as current');
 const latestRef = await context.executeTool(toolName(context, 'inspect_snapshot'), { record: 'file_a.current_file' }, 'snapshot-after-edit');
 assert.equal(latestRef?.outcomeStatus, 'succeeded', JSON.stringify(latestRef));
 assert.equal(latestRef.result?.message, 'Snapshot inspected.');
 assert.ok(!JSON.stringify(latestRef).includes('NEW_PACKAGE_VIEW_VALUE'));
 const witnesses = await readWitness(), payloads = witnesses.filter(row => row.stage === 'ref-payload');
 assert.equal(payloads.length, 2); assert.equal(payloads[1].payload.filePath, '/open/a.txt');
 assert.equal(payloads[1].payload.content, 'NEW_PACKAGE_VIEW_VALUE'); assert.equal(payloads[1].frozen, true);
 assert.equal(witnesses.filter(row => row.stage === 'handler-entry').length, 4);
 assert.equal(witnesses.filter(row => row.stage === 'app-guard').length, 1);
 assert.equal(witnesses.filter(row => row.stage === 'business').length, 1);
 calls.push({ name: 'inspect-after', result: latestRef });
 await context.release?.(); context = undefined; source.dispose(); source = undefined;
 report = await runtime.beginShutdown().completion;
 assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.resourcesReleased, true);
 assert.equal(report.appCleanup?.managedApps, 1); assert.equal(report.appCleanup?.completedApps, 1); assert.equal(report.appCleanup?.failedApps, 0);
 console.log('PUBLIC_TOOLS', JSON.stringify({ calls, witnesses, report, cleanupKind: 'Runtime graceful shutdown', viewTypeTool: 'edit_file', refTool: 'inspect_snapshot', oldSnapshotReplaced: true }));
} finally { await context?.release?.(); source?.dispose(); await runtime.beginShutdown().completion; }
`);
    const toolsResult = await run([path.join(folder, 'public-tools.mjs')], 'packed SDK ordinary typed Ref through Runtime Worker and Semantic Source; short receipts and separate witnesses');
    const toolsLine = toolsResult.stdout.split('\n').find(line => line.startsWith('PUBLIC_TOOLS ')); assert.ok(toolsLine); facts.publicTools = JSON.parse(toolsLine.slice(13));
    if (!refOnly) {
    await fs.writeFile(path.join(folder, 'public-ide.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import path from 'node:path'; import {tmpdir} from 'node:os';
import {createRuntime} from '@aotui/runtime'; import {SemanticAOTUIDrivenSource} from '@aotui/agent-driver-adapter'; import ideFactory from '@agentina/aotui-ide';
const ideModulePath=import.meta.resolve('@agentina/aotui-ide');
assert.equal(Object.getOwnPropertyDescriptor(ideFactory,'persistenceSupport')?.value,'state-session-v1');
assert.equal(Object.getOwnPropertyDescriptor(ideFactory,'appLifecycleSupport')?.value,'app-lifecycle-v2');
const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-public-package-'))), root=path.join(base,'project'); await fs.mkdir(root);
const file=path.join(root,'example.ts'), unopenedFile=path.join(root,'not-open.ts'); await fs.writeFile(file,'export const answer = 1;\\n'); await fs.writeFile(path.join(root,'tsconfig.json'),'{}');
const runtime=createRuntime({worker:{timeoutMs:45000,maxWorkers: 1}}); const outcomes=[]; let source, context, report;
try {
 const desktopId=await runtime.createDesktop('external'); const appId=await runtime.installDynamicWorkerApp(desktopId,ideModulePath,{appId:'publicide',interactionModes:['view-type-parameters-v1'],config:{projectPath:root,ideSessionKey:'publicide',ideHistoryPath:path.join(base,'history.json'),AOTUI_DATA_DIR:path.join(base,'state')}});
 source=new SemanticAOTUIDrivenSource(runtime.getDesktop(desktopId),runtime,{includeInstruction:false,instruction:'Explicit full-mode IDE fixture instruction; full mode is not admitted in the Ref-only proof.'});
 async function capture(){context=await source.getContext();assert.equal(typeof context.executeTool,'function');await context.adopt();return context;}
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
 async function invoke(current,suffix,input,expectedStatus='succeeded'){const name=Object.keys(current.tools).find(key=>key.endsWith('-'+suffix));assert.ok(name,'Semantic context includes '+suffix+': '+Object.keys(current.tools));const result=await current.executeTool(name,input,'public-'+outcomes.length);assert.ok(result);outcomes.push(result);assert.equal(result.outcomeStatus,expectedStatus,JSON.stringify(result));return result;}
 context=await captureWhenToolIsAvailable('multi_open_file');
 const opened=await invoke(context,'multi_open_file',{filePaths:[file]});assert.equal(opened.result?.message,'multi_open_file completed. Read the current IDE Views for the updated state.');
 await context.release?.();context=undefined;
 context=await capture();assert.ok(context.messages.some(message=>String(message.content).includes('export const answer = 1;')),'New Context observes the opened FileDetail');
 const denied=await invoke(context,'write_file',{filePath:unopenedFile,content:'MUST_NOT_BE_CREATED'},'failed');
 assert.equal(denied.error?.code,'IDE_FILE_NOT_LOADED',JSON.stringify(denied));assert.equal(await fs.stat(unopenedFile).catch(error=>error.code),'ENOENT','write_file cannot create an unopened path');
 const written=await invoke(context,'write_file',{filePath:file,content:'export const answer = 2;\\n'});assert.ok(written.result);assert.equal(await fs.readFile(file,'utf8'),'export const answer = 2;\\n');
 await context.release?.();context=undefined;
 context=await capture();const updatedFileView=context.messages.map(message=>String(message.content)).join('\\n');
 assert.ok(updatedFileView.includes('export const answer = 2;'),'New Context observes the completed write');assert.ok(!updatedFileView.includes('export const answer = 1;'),'Only the latest FileDetail snapshot remains current');
 const hover=await invoke(context,'lsp_hover',{file_path:file,line:1,character:15});assert.match(hover.result?.message,/Read the current IDE Views/);
 await context.release?.();context=undefined;context=await capture();const currentView=context.messages.map(message=>String(message.content)).join('\\n');
 assert.match(currentView,/documentVersion[^0-9]*[1-9][0-9]*/,'The current FileDetail View contains an actual versioned LSP hover result');assert.match(currentView,/hover/);assert.match(currentView,/answer/);
 await context.release?.();context=undefined;source.dispose();source=undefined;
 report=await runtime.beginShutdown().completion; assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.resourcesReleased,true);assert.equal(report.appCleanup?.managedApps,1);assert.equal(report.appCleanup?.completedApps,1);assert.equal(report.appCleanup?.failedApps,0);
 console.log('PUBLIC_IDE',JSON.stringify({base,outcomes,report,defaultWorkerResolution:true,interactionModes:['view-type-parameters-v1'],ordinaryMutation:true,actualLspHover:hover.result}));
} finally {await context?.release?.();source?.dispose();await runtime.beginShutdown().completion;}
`);
    const publicResult = await run([path.join(folder, 'public-ide.mjs')], 'public default Runtime Worker uses Semantic Context/release for ordinary IDE mutation, actual LSP, and managed shutdown');
    const line = publicResult.stdout.split('\n').find(line => line.startsWith('PUBLIC_IDE ')); assert.ok(line); facts.publicIDE = JSON.parse(line.slice(11));
    }

    facts.passed = facts.cases.every(test => test.passed);
    if (!facts.passed) process.exitCode = 1;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { facts.finishedAt = new Date().toISOString(); await fs.writeFile(factsPath, JSON.stringify(facts, null, 2)); console.log('PUBLIC_PACKAGE_FACTS', JSON.stringify({ passed: facts.passed, factsPath })); }
