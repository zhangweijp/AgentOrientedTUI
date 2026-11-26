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
const facts = { consumer, selection, completeW10Claimed: false, skipped: refOnly ? ['Pure Core scenario (covered by the package consumer)', 'IDE type/factory checks', 'real IDE/LSP run'] : [], startedAt: new Date().toISOString(), cases: [], passed: false };
const folder = path.join(consumer, 'public-checks-' + path.basename(factsPath, '.json')); await fs.mkdir(folder);
async function run(args, name) {
    try { const result = await execute(process.execPath, args, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
        facts.cases.push({ name, argv: [process.execPath, ...args], stdout: result.stdout, stderr: result.stderr, passed: true }); console.log('PASS', name); return result; }
    catch (error) { facts.cases.push({ name, passed: false, stdout: error.stdout, stderr: error.stderr }); throw error; }
}
try {
    if (!refOnly) {
        await fs.copyFile(path.join(consumer, 'node_modules/@aotui/core/examples/public-core.ts'), path.join(folder, 'public-core.ts'));
    }
    await fs.writeFile(path.join(folder, 'tool-types.ts'), `import type { RefTarget, ToolResult, ViewToolInvocationTerminal, ExecutionBinding, AppSnapshot, SnapshotRead } from '@aotui/core';
import { SNAPSHOT_SCHEMA_VERSION, type ToolParameterCompileResult, type SnapshotStoreOptions, type SnapshotLimits } from '@aotui/core';
import { createSnapshotCore } from '@aotui/core/host';
// @ts-expect-error The JSON copy budget reason is internal to Core.
import { JsonCopyLimitError } from '@aotui/core';
const identity = { appId: 'notes', instanceId: 'limits-check' };
export const defaultLimits: SnapshotStoreOptions = { ...identity, limits: undefined };
export const partialLimits: SnapshotStoreOptions = { ...identity, limits: { maxViews: 0, maxTools: undefined } };
export const copyLimits = (limits: Partial<SnapshotLimits>): SnapshotStoreOptions => ({ ...identity, limits });
export function snapshotLifecycle() {
  // @ts-expect-error A Core must bind its App and instance at construction.
  createSnapshotCore({ limits: {} });
  const core = createSnapshotCore(defaultLimits);
  // @ts-expect-error An existing Core cannot start a different instance.
  core.lifecycle.startApp('notes', 'next');
  core.lifecycle.stop();
  core.lifecycle.dispose();
}
export function declarationCategory(result: ToolParameterCompileResult) {
  if (result.ok) return 'accepted';
  const code = result.issue.code;
  switch (code) {
    case 'PARAMETER_DECLARATION_INVALID': return 'invalid';
    case 'PARAMETER_DECLARATION_UNSUPPORTED': return 'unsupported';
    case 'PARAMETER_DECLARATION_CAPACITY': return 'capacity';
  }
  const unreachable: never = code;
  return unreachable;
}
import type { AppInteraction, InstanceInteraction, ReceiptQuery } from '@aotui/core';
export const readOriginal = (client: AppInteraction, query: ReceiptQuery) => client.readReceipt(query);
export const inspect = (client: InstanceInteraction) => client.inspect();
export function forwardTransport(client: InstanceInteraction, request: unknown) {
  return [client.observe(), client.invoke(request)];
}
const ref: RefTarget = { kind: 'snapshot-value', payload: { id: 'one', version: 1 } };
// @ts-expect-error Snapshot Ref targets are readonly.
ref.payload = {};
// @ts-expect-error Business identity belongs inside the captured payload.
const oldRef: RefTarget = { kind: 'entity', entityId: 'one' };
const schemaVersion: 8 = SNAPSHOT_SCHEMA_VERSION;
const result: ToolResult = { success: false, error: { code: 'PARTIAL', message: 'Application reports partial work' } };
// @ts-expect-error The former Tool failure classification is retired.
const oldResult: ToolResult = { ...result, effects: 'none' };
const terminal: ViewToolInvocationTerminal = { phase: 'entered-returned', result };
// @ts-expect-error The former terminal field is retired.
const oldTerminal: ViewToolInvocationTerminal = { ...terminal, failureEffects: 'partial' };
const execute: ExecutionBinding['execute'] = ({ source }) => source.receiver.viewId
  ? { kind: 'tool-result', ...terminal }
  : { kind: 'unknown' };
const readySnapshot = (read: SnapshotRead): AppSnapshot | undefined => read.status === 'ready' ? read.snapshot : undefined;
void [ref, oldRef, schemaVersion, result, oldResult, oldTerminal, execute, readySnapshot];
`);
    const compiler = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
        lib: ['ES2022'], types: [], outDir: './core-out' };
    await fs.writeFile(path.join(folder, 'core-tsconfig.json'), JSON.stringify({ compilerOptions: compiler, files: refOnly ? ['./tool-types.ts'] : ['./public-core.ts', './tool-types.ts'] }));
    const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
    await run([tsc, '-p', path.join(folder, 'core-tsconfig.json')], 'Core Tool, SnapshotLimits and declaration types compile with ES2022 only');
    if (!refOnly) await run([path.join(folder, 'core-out/public-core.js')], 'public Core fixture executes');
    await fs.writeFile(path.join(folder, 'candidate-scope.mts'), `import { type CandidateScope, type IDesktop, type RunningApp } from '@aotui/runtime';
export function prepare(desktop: IDesktop, app: RunningApp) {
    const scope: CandidateScope = desktop.createCandidateScope();
    return { observation: scope.observe(app), discard: scope.discard };
}
// @ts-expect-error Importing Runtime does not add the disposable global library.
Symbol.dispose;
`);
    await fs.writeFile(path.join(folder, 'candidate-scope-using.mts'), `import { createRuntime } from '@aotui/runtime';
const runtime = createRuntime();
try {
    const desktop = await runtime.createDesktop();
    using scope = desktop.createCandidateScope();
    if (typeof scope[Symbol.dispose] !== 'function') throw new TypeError('Expected a disposable candidate scope');
} finally {
    if (!(await runtime.beginClose().completion).resourcesReleased) throw new Error('Runtime still owns resources');
}
`);
    const scopeCompiler = { ...compiler, outDir: './scope-out' };
    await fs.writeFile(path.join(folder, 'scope-tsconfig.json'), JSON.stringify({
        compilerOptions: scopeCompiler, files: ['./candidate-scope.mts'],
    }));
    await fs.writeFile(path.join(folder, 'scope-using-tsconfig.json'), JSON.stringify({
        compilerOptions: { ...scopeCompiler, lib: ['ES2022', 'ESNext.Disposable'] }, files: ['./candidate-scope-using.mts'],
    }));
    await run([tsc, '-p', path.join(folder, 'scope-tsconfig.json')], 'Runtime candidate scope compiles with strict ES2022 and no DOM or Node types');
    await run([tsc, '-p', path.join(folder, 'scope-using-tsconfig.json')], 'Runtime candidate scope using compiles with ESNext.Disposable');
    await run([path.join(folder, 'scope-out/candidate-scope-using.mjs')], 'installed Runtime candidate scope disposes with using');
    const ideTypeImports = `import ideDefault from '@agentina/aotui-ide';
// @ts-expect-error The IDE package has one default managed factory, not route-specific entries.
import { ideEntryForRoute } from '@agentina/aotui-ide';`;
    const ideTypeAssertions = `const ideFactory: TUIAppFactory = ideDefault;
const ideLifecycleSupport: 'app-lifecycle-v2' = ideFactory.appLifecycleSupport;
const ideToolAuthoringProtocol: 'view-type-tools-v8' = ideFactory.toolAuthoringProtocol;
void [ideLifecycleSupport, ideToolAuthoringProtocol, ideFactory];`;
    await fs.writeFile(path.join(folder, 'sdk-types.ts'), `import { Type } from 'typebox';
import { createRuntime, type AppInteractionOptions } from '@aotui/runtime';
import type {
  ActiveTurn, RunningApp, AppInteractionPolicy, AppInvocation, ReceiptQuery, ObservationCandidate, Observation,
  ObservationGrant, PrepareObservationResult, AppPreviewResult, InvocationReceipt,
  ReceiptAccess, InvokeResult, InvocationContext, ReceiptMetadata, InteractionIssue,
} from '@aotui/runtime';
import type { ReceiptQuery as CoreReceiptQuery } from '@aotui/core';
// @ts-expect-error Advanced assembly remains in Core.
import type { InstanceInteraction } from '@aotui/runtime';
export type HostTypes = [
  ActiveTurn, RunningApp, AppInteractionPolicy, AppInvocation, ReceiptQuery, ObservationCandidate, Observation,
  ObservationGrant, PrepareObservationResult, AppPreviewResult, InvocationReceipt,
  ReceiptAccess, InvokeResult, InvocationContext, ReceiptMetadata, InteractionIssue,
];
export function checkHostRequests(app: RunningApp, turn: ActiveTurn, raw: unknown): Promise<ReceiptAccess> {
  const request: AppInvocation = { observationId: 'observed', invocationId: 'invoke-1', toolId: 'inspect',
    viewId: 'detail', input: { record: '$ref.notes.list.selected' } };
  void app.observe();
  void turn.invoke(app.appId, request, 1000);
  // @ts-expect-error Observation prepares all open Views without a selector.
  void app.observe({ viewIds: ['detail'] });
  // The Runtime validates the receiver using the observed Tool contract.
  void turn.invoke(app.appId, { ...request, input: {} });
  // @ts-expect-error The retired binding id is not a request field.
  void turn.invoke(app.appId, { ...request, bindingId: 'retired' });
  // @ts-expect-error A typed Host call needs a request shape.
  void turn.invoke(app.appId, raw);
  const query: CoreReceiptQuery = { observationId: request.observationId, invocationId: request.invocationId };
  const hostQuery: ReceiptQuery = query;
  // @ts-expect-error Receipt lookup uses the original IDs and accepts no Tool field.
  void app.readReceipt({ ...hostQuery, toolId: 'inspect' });
  return app.readReceipt(hostQuery);
}
import { createApp, createView, defineViewType, formatRef, ref, refParam, type ArgsOf, type AppLifecycleCallbacks } from '@aotui/sdk';
${refOnly ? '' : ideTypeImports}
import type { AppFrameRef, AppProjectionFrame, ProjectionCommitResult, RuntimeContext, TUIAppFactory } from '@aotui/core';
export function publishCompleteFrame(context: RuntimeContext): ProjectionCommitResult {
  const selected: AppFrameRef = { valueSchema: { type: 'object', properties: { title: { type: 'string' } } }, id: 'selected', scope: 'protected', value: { title: 'Note' } };
  // @ts-expect-error Captured JSON values replace commit-local Ref tokens.
  const token: AppFrameRef = { id: 'selected', token: {} };
  // @ts-expect-error The renderer supplies a stable owner in each complete frame.
  void context.mountView('detail', 'File');
  const frame: AppProjectionFrame = { views: [{ id: 'detail', type: 'File', region: 'dynamic', name: 'Detail',
    content: { format: 'markdown-v1', value: '[Selected](selected)' }, owner: {}, bindings: [], refs: [selected] }] };
  void token;
  return context.publishFrame(() => frame);
}
import type { AppLifecyclePort } from '@aotui/core';
const Counter = defineViewType<object>()({ name: 'Counter', multiplicity: 'multiple', tools: {
 increment: {
  description: 'Increment counter', inputSchema: Type.Object({ amount: Type.Number() }, { additionalProperties: false }),
  async execute({ input }) {
   input.amount.toFixed();
   // @ts-expect-error Numeric inference remains precise.
   input.amount.toUpperCase();
   if (input.amount < 0) return { success: false, error: { code: 'NEGATIVE', message: 'Application rejects a negative amount' } };
   return { success: true, data: { amount: input.amount } };
  },
 },
 inspect_record: {
  description: 'Inspect the displayed record.',
  inputSchema: Type.Object({ record: refParam('Record', Type.Object({ id: Type.String() }, { additionalProperties: false })) },
   { additionalProperties: false }),
  execute({ input }) {
   const id: string = input.record.id;
   // @ts-expect-error Ref input is an object, not the model's name string.
   input.record.toUpperCase();
   // @ts-expect-error Resolved Ref object is recursively immutable.
   input.record.id = 'changed';
   // @ts-expect-error The whole handler parameter is immutable.
   input.record = { id: 'changed' };
   // @ts-expect-error The model receiver is not a business input.
   input.view_id;
   void id; return { success: true };
  },
 },
} });
export type CounterRefArgs = ArgsOf<typeof Counter.tools.inspect_record>;
const owner: AppLifecycleCallbacks = { stop() {}, async close() {} };
${refOnly ? '' : ideTypeAssertions}
const managedFactory = createApp({
 app_name: 'package_types', viewTypes: [Counter],
 initialize({ prepareProjection, registerCleanup }) {
  registerCleanup(owner);
  const page = createView(Counter, { idPrefix: 'counter', region: 'dynamic', render() {
   const selected = ref('current_record', { id: 'record-1' }, { scope: 'protected', refType: 'Record', schema: Type.Object({ id: Type.String() }) });
   return { body: formatRef('Current record', selected), refs: [selected], context: {} };
  } });
  prepareProjection({ views: [page] });
 },
});
const lifecycleSupport: 'app-lifecycle-v2' = managedFactory.appLifecycleSupport;
const toolAuthoringProtocol: 'view-type-tools-v8' = managedFactory.toolAuthoringProtocol;
// @ts-expect-error Managed lifecycle support is the default factory contract.
createApp({ app_name: 'retired_lifecycle_flag', initialize() {}, viewTypes: [Counter], experimentalAppLifecycle: true });
export default managedFactory;
const writable: AppInteractionOptions = { toolsEnabled: true };
const readOnly: AppInteractionOptions = { toolsEnabled: false };
// @ts-expect-error The retired array cannot select Host tool availability.
const oldOptions: AppInteractionOptions = { interactionModes: [] };
const lifecyclePort = (port: AppLifecyclePort) => { const detach = port.register(owner); detach(); };
void [writable, readOnly, oldOptions, lifecyclePort, lifecycleSupport, toolAuthoringProtocol, createRuntime];
`);
    await fs.writeFile(path.join(folder, 'sdk-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022'], types: ['node'], outDir: './sdk-out' }, files: ['./sdk-types.ts'] }));
    await run([tsc, '-p', path.join(folder, 'sdk-tsconfig.json')], refOnly ? 'strict Runtime Host types, SPI and SDK Ref declarations' : 'strict Runtime Host types, SPI and SDK with IDE declarations');
    await fs.writeFile(path.join(folder, 'adapter-types.ts'), `import { SemanticAOTUIDrivenSource, type SemanticAOTUIDrivenSourceOptions } from '@aotui/agent-driver-adapter';
import type { ContextDrivenSource } from '@aotui/agent-driver-v2';
import type { IDesktop } from '@aotui/runtime';
// @ts-expect-error The split-read Legacy source is no longer a public adapter.
import type { AOTUIDrivenSource } from '@aotui/runtime/adapters';
const options: SemanticAOTUIDrivenSourceOptions = { includeInstruction: false, instruction: 'fixture' };
// @ts-expect-error Adapter options retain their actual public type.
options.includeInstruction = 'yes';
export const source = (desktop: IDesktop): ContextDrivenSource => new SemanticAOTUIDrivenSource(desktop, options);
export async function releaseContext(instance: SemanticAOTUIDrivenSource): Promise<void> {
 const context = await instance.getContext();
 await context.release?.();
 instance.dispose();
}
export const findApp = (desktop: IDesktop, appId: string, instanceId: string) => desktop.getRunningApp(appId, instanceId);
`);
    await fs.writeFile(path.join(folder, 'adapter-tsconfig.json'), JSON.stringify({ compilerOptions: { ...compiler, lib: ['ES2022', 'DOM'], types: ['node'], outDir: './adapter-out' }, files: ['./adapter-types.ts'] }));
    try {
      await run([tsc, '-p', path.join(folder, 'adapter-tsconfig.json')], 'Semantic Source, RunningApp and Context release compile with skipLibCheck false');
    } catch {
      // The JS behavior below does not consume this failed TS output. Keep the
      // required type gate red while collecting the independent real call proof.
      facts.adapterTypeGateFailed = true;
    }
    const toolAppPath = path.join(folder, 'type-tool-app.mjs');
    const witnessPath = path.join(folder, 'ref-witness.jsonl');
    await fs.writeFile(witnessPath, '', { flag: 'wx' });
    await fs.writeFile(toolAppPath, `import { appendFileSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, refParam } from '@aotui/sdk';
const filePath = '/open/a.txt';
// This test-only witness is outside Tool Result and the App projection.
const witnessFile = ${JSON.stringify(witnessPath)};
const witness = data => appendFileSync(witnessFile, JSON.stringify(data) + '\\n');
const Guide = defineViewType({ multiplicity: 'multiple', name: 'Root' });
const File = defineViewType()({ multiplicity: 'multiple', name: 'FileDetail', tools: {
 edit_file: {
  description: 'Replace the contents of an opened file.',
  inputSchema: Type.Object({ filePath: Type.String(), content: Type.String() }, { additionalProperties: false }),
  execute({ input: args, context: { content, setContent } }) {
   witness({ stage: 'handler-entry', name: 'edit_file' });
   if (args.filePath !== filePath) { witness({ stage: 'app-guard', name: 'edit_file', stateBefore: content, stateAfter: content });
    return { success: false, error: { code: 'FILE_NOT_OPEN', message: 'The selected file is not open.' } }; }
   setContent(args.content); witness({ stage: 'business', name: 'edit_file', previous: content, requested: args.content });
   return { success: true, data: { message: 'Editor state updated.' } };
  },
 },
 inspect_snapshot: {
  description: 'Inspect a complete File Ref.',
  inputSchema: Type.Object({ record: refParam('File', Type.Object({ filePath: Type.String(), content: Type.String() }, { additionalProperties: false })) },
   { additionalProperties: false }),
  execute({ input: args }) {
   witness({ stage: 'handler-entry', name: 'inspect_snapshot' });
   witness({ stage: 'ref-payload', name: 'inspect_snapshot', payload: args.record, frozen: Object.isFrozen(args.record) });
   return { success: true, data: { message: 'Snapshot inspected.' } };
  },
 },
} });
export default createApp({
 app_name: 'package_type_tool_consumer', viewTypes: [Guide, File],
 initialize({ prepareProjection }) {
  let content = 'OLD_PACKAGE_VIEW_VALUE';
  const root = createView(Guide, { idPrefix: 'root', region: 'static', render: () => ({ body: 'Package consumer tool test.' }) });
  const page = createView(File, { idPrefix: 'file_a', region: 'dynamic', render() {
    const current = ref('current_file', { filePath, content }, { scope: 'protected', refType: 'File', schema: Type.Object({ filePath: Type.String(), content: Type.String() }) });
    return { body: formatRef('Current file', current) + '\\n\\n' + content, refs: [current],
      context: { content, setContent(value) { content = value; prepareProjection({ views: [root, page] }); } } };
  } });
  prepareProjection({ views: [root, page] });
 },
});
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
 const desktop = await runtime.createDesktop('package-tool-consumer');
 const { appId } = await desktop.installDynamicWorkerApp(pathToFileURL(path.join(${JSON.stringify(folder)}, 'type-tool-app.mjs')).href, {
  installationId: 'packagetools', name: 'package_type_tool_consumer', config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR },
 });
 assert.equal(appId, 'package_type_tool_consumer');
 source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false, instruction: 'Isolated SDK and Runtime Ref consumer verification.' });
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
 const inspected = await context.executeTool(refName, { view_id: 'file_a_1', record: '$ref.package_type_tool_consumer.file_a_1.current_file' }, 'snapshot-before-edit');
 assert.equal(inspected?.outcomeStatus, 'succeeded', JSON.stringify(inspected));
 assert.equal(inspected.result?.message, 'Snapshot inspected.');
 assert.ok(!JSON.stringify(inspected).includes('OLD_PACKAGE_VIEW_VALUE'));
 const beforeWitness = (await readWitness()).filter(row => row.stage === 'ref-payload');
 assert.equal(beforeWitness.length, 1); assert.equal(beforeWitness[0].payload.filePath, '/open/a.txt');
 assert.equal(beforeWitness[0].payload.content, 'OLD_PACKAGE_VIEW_VALUE'); assert.equal(beforeWitness[0].frozen, true);
 calls.push({ name: 'inspect-before', result: inspected });
 const denied = await context.executeTool(editName, { view_id: 'file_a_1', filePath: '/open/b.txt', content: 'MUST_NOT_APPEAR' }, 'edit-closed-file');
 calls.push({ name: 'edit_file-b', result: denied });
 assert.equal(denied?.outcomeStatus, 'failed', JSON.stringify(denied));
 assert.equal(denied.error?.code, 'FILE_NOT_OPEN', JSON.stringify(denied));
 assert.ok(!JSON.stringify(denied).includes('MUST_NOT_APPEAR'));
 const changed = await context.executeTool(editName, { view_id: 'file_a_1', filePath: '/open/a.txt', content: 'NEW_PACKAGE_VIEW_VALUE' }, 'edit-open-file');
 calls.push({ name: 'edit_file-a', result: changed });
 assert.equal(changed?.outcomeStatus, 'succeeded', JSON.stringify(changed));
 assert.ok(!JSON.stringify(changed).includes('NEW_PACKAGE_VIEW_VALUE'), 'Tool receipt must not duplicate View data');
 await context.release?.(); context = undefined;
 context = await captureReady();
 const latest = context.messages.map(message => String(message.content)).join('\\n');
 assert.ok(latest.includes('NEW_PACKAGE_VIEW_VALUE'), 'A fresh Source context observes the updated FileDetail View');
 assert.ok(!latest.includes('OLD_PACKAGE_VIEW_VALUE'), 'The old FileDetail snapshot is not retained as current');
 const latestRef = await context.executeTool(toolName(context, 'inspect_snapshot'), { view_id: 'file_a_1', record: '$ref.package_type_tool_consumer.file_a_1.current_file' }, 'snapshot-after-edit');
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
 report = await runtime.beginClose().completion;
 assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.resourcesReleased, true);
 assert.equal(report.appCleanup?.managedApps, 1); assert.equal(report.appCleanup?.completedApps, 1); assert.equal(report.appCleanup?.failedApps, 0);
 console.log('PUBLIC_TOOLS', JSON.stringify({ calls, witnesses, report, cleanupKind: 'Runtime graceful shutdown', viewTypeTool: 'edit_file', refTool: 'inspect_snapshot', oldSnapshotReplaced: true }));
} finally { await context?.release?.(); source?.dispose(); await runtime.beginClose().completion; }
`);
    const toolsResult = await run([path.join(folder, 'public-tools.mjs')], 'packed SDK ordinary typed Ref through Runtime Worker and Semantic Source; short receipts and separate witnesses');
    const toolsLine = toolsResult.stdout.split('\n').find(line => line.startsWith('PUBLIC_TOOLS ')); assert.ok(toolsLine); facts.publicTools = JSON.parse(toolsLine.slice(13));
    if (!refOnly) {
    await fs.writeFile(path.join(folder, 'public-ide.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import path from 'node:path'; import {tmpdir} from 'node:os';
import {createRuntime} from '@aotui/runtime'; import {SemanticAOTUIDrivenSource} from '@aotui/agent-driver-adapter'; import ideFactory from '@agentina/aotui-ide';
const ideModulePath=import.meta.resolve('@agentina/aotui-ide');
assert.equal(Object.getOwnPropertyDescriptor(ideFactory,'appLifecycleSupport')?.value,'app-lifecycle-v2');
const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-public-package-'))), root=path.join(base,'project'); await fs.mkdir(root);
const file=path.join(root,'example.ts'), unopenedFile=path.join(root,'not-open.ts'); await fs.writeFile(file,'export const answer = 1;\\n'); await fs.writeFile(path.join(root,'tsconfig.json'),'{}');
const runtime=createRuntime({worker:{timeoutMs:45000,maxWorkers: 1}}); const outcomes=[]; let source, context, report;
try {
 const desktop=await runtime.createDesktop('external'); const {appId}=await desktop.installDynamicWorkerApp(ideModulePath,{installationId:'publicide',name:'system_ide',config:{projectPath:root,ideSessionKey:'publicide',ideHistoryPath:path.join(base,'history.json'),AOTUI_DATA_DIR:path.join(base,'state')}});
 source=new SemanticAOTUIDrivenSource(desktop,{includeInstruction:false,instruction:'Explicit full-mode IDE fixture instruction; full mode is not admitted in the Ref-only proof.'});
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
 async function invoke(current,suffix,input,expectedStatus='succeeded'){const name=Object.keys(current.tools).find(key=>key.endsWith('-'+suffix));assert.ok(name,'Semantic context includes '+suffix+': '+Object.keys(current.tools));const receiver=suffix==='multi_open_file'?'workspace':current.messages.map(message=>String(message.content)).find(text=>text.startsWith('<view view_id=')&&text.includes('view_type="FileDetail"'))?.match(/view_id="([^"]+)"/)?.[1];assert.ok(receiver);const result=await current.executeTool(name,suffix==='multi_open_file'?input:{view_id:receiver,...input},'public-'+outcomes.length);assert.ok(result);outcomes.push(result);assert.equal(result.outcomeStatus,expectedStatus,JSON.stringify(result));return result;}
 context=await captureWhenToolIsAvailable('multi_open_file');
 const opened=await invoke(context,'multi_open_file',{filePaths:[file]});assert.equal(opened.result?.message,'multi_open_file completed. Read the current IDE Views for the updated state.');
 await context.release?.();context=undefined;
 context=await capture();assert.ok(context.messages.some(message=>String(message.content).includes('export const answer = 1;')),'New Context observes the opened FileDetail');
 const denied=await invoke(context,'write_file',{filePath:unopenedFile,content:'MUST_NOT_BE_CREATED'},'rejected');
 assert.equal(denied.error?.code,'TOOL_INVALID_ARGS',JSON.stringify(denied));assert.equal(await fs.stat(unopenedFile).catch(error=>error.code),'ENOENT','write_file cannot create an unopened path');
 const written=await invoke(context,'write_file',{content:'export const answer = 2;\\n'});assert.ok(written.result);assert.equal(await fs.readFile(file,'utf8'),'export const answer = 2;\\n');
 await context.release?.();context=undefined;
 context=await capture();const updatedFileView=context.messages.map(message=>String(message.content)).join('\\n');
 assert.ok(updatedFileView.includes('export const answer = 2;'),'New Context observes the completed write');assert.ok(!updatedFileView.includes('export const answer = 1;'),'Only the latest FileDetail snapshot remains current');
 const hover=await invoke(context,'lsp_hover',{line:1,character:15});
 const detailId=hover.result?.view_id;assert.match(detailId,/^fd_/);
 assert.equal(hover.result?.message,'Hover information available at 1:15. See FileDetail '+detailId+', hover section.');
 assert.deepEqual(Object.keys(hover.result).sort(),['message','view_id'],'Hover data stays in FileDetail');
 await context.release?.();context=undefined;context=await capture();
 const currentView=context.messages.map(message=>String(message.content)).find(message=>message.startsWith('<view view_id="'+detailId+'" view_type="FileDetail"'));
 const currentHover=currentView?.split('### hover')[1];assert.ok(currentHover,'The receipt points to the current FileDetail hover section');
 assert.match(currentHover,/documentVersion[^0-9]*[1-9][0-9]*/,'The current FileDetail View contains an actual versioned LSP hover result');assert.match(currentHover,/answer/);
 await context.release?.();context=undefined;source.dispose();source=undefined;
 report=await runtime.beginClose().completion; assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.resourcesReleased,true);assert.equal(report.appCleanup?.managedApps,1);assert.equal(report.appCleanup?.completedApps,1);assert.equal(report.appCleanup?.failedApps,0);
 console.log('PUBLIC_IDE',JSON.stringify({base,outcomes,report,defaultWorkerResolution:true,ordinaryMutation:true,actualLspHover:hover.result}));
} finally {await context?.release?.();source?.dispose();await runtime.beginClose().completion;}
`);
    const publicResult = await run([path.join(folder, 'public-ide.mjs')], 'public default Runtime Worker uses Semantic Context/release for ordinary IDE mutation, actual LSP, and managed shutdown');
    const line = publicResult.stdout.split('\n').find(line => line.startsWith('PUBLIC_IDE ')); assert.ok(line); facts.publicIDE = JSON.parse(line.slice(11));
    }

    facts.passed = facts.cases.every(test => test.passed);
    if (!facts.passed) process.exitCode = 1;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { facts.finishedAt = new Date().toISOString(); await fs.writeFile(factsPath, JSON.stringify(facts, null, 2)); console.log('PUBLIC_PACKAGE_FACTS', JSON.stringify({ passed: facts.passed, factsPath })); }
