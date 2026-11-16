import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AppRegistry, createAppId, createDesktopId, createRuntime } from '@aotui/runtime';
import type { JsonValue, Observation, AppInteraction, AppInteractionPolicy } from '@aotui/runtime/core';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../..');
const adapters = ['plain', 'preact'] as const;
let consumer: string;

beforeAll(async () => {
    consumer = await realpath(await mkdtemp(join(tmpdir(), 'aotui-p2a-consumer-')));
    await mkdir(join(consumer, 'node_modules/@aotui'), { recursive: true });
    for (const name of ['sdk', 'runtime']) {
        const source = join(repository, name), installed = join(consumer, 'node_modules/@aotui', name);
        await mkdir(installed);
        await cp(join(source, 'package.json'), join(installed, 'package.json'));
        await cp(join(source, 'dist'), join(installed, 'dist'), { recursive: true });
    }
    // Load an actual second SDK copy with independent module state.
    await cp(join(consumer, 'node_modules/@aotui/sdk'), join(consumer, 'node_modules/@aotui/sdk-copy'), { recursive: true });
    for (const [owner, name] of [['sdk', 'typebox'], ['runtime', 'linkedom']]) {
        await symlink(join(repository, owner, 'node_modules', name), join(consumer, 'node_modules', name), 'dir');
    }
    for (const file of ['work-items.ts', 'work-items-plain.ts', 'work-items-preact.tsx', 'file-app.tsx', 'file-tools.ts']) {
        await cp(join(repository, 'sdk/docs/examples', file), join(consumer, file));
    }
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(consumer, 'type-contract.ts'), `
import { createView, type ArgsOf } from '@aotui/sdk/app';
import { ItemType, WorkspaceType } from './work-items.js';
function check(args: ArgsOf<typeof ItemType.tools.inspect>, count: ArgsOf<typeof ItemType.tools.count>) {
    const n: number = count.selected;
    const value = args.selected;
    if (value === null) return n;
    // @ts-expect-error Ref resolution passes a readonly value
    args.selected = false;
    // @ts-expect-error Integer Ref handler receives a number
    const text: string = count.selected;
    // @ts-expect-error Optional string is not nullable
    const invalid: ArgsOf<typeof ItemType.tools.inspect> = { selected: null, text: null };
    // @ts-expect-error Literal and nested array values preserve their inferred types
    const unsupported: ArgsOf<typeof WorkspaceType.tools.update> = { operation: 'null', options: { mode: 'other', numbers: [false] } };
    return { text, invalid, unsupported };
}
createView(ItemType, { id:'missing', kind:'state',
    // @ts-expect-error An instance must bind every operation on its descriptor
    render: () => ({ body:'Missing bindings' }),
});
`);
    for (const adapter of adapters) {
        if (adapter === 'preact') await symlink(join(repository, 'sdk/node_modules/preact'), join(consumer, 'node_modules/preact'), 'dir');
        const plain = adapter === 'plain';
        const config = join(consumer, 'tsconfig-' + adapter + '.json');
        await writeFile(config, JSON.stringify({
            compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, exactOptionalPropertyTypes: true,
                skipLibCheck: false, lib: plain ? ['ES2022'] : ['ES2022', 'DOM'], types: [],
                outDir: 'dist', ...(!plain && { jsx: 'react-jsx', jsxImportSource: 'preact' }) },
            files: ['work-items.ts', ...(plain ? ['work-items-plain.ts'] : ['work-items-preact.tsx', 'file-app.tsx']), 'type-contract.ts'],
        }));
        await execute(process.execPath, [join(repository, 'sdk/node_modules/@typescript/native/bin/tsc'), '-p', config, '--pretty', 'false']);
    }
    const shared = join(consumer, 'dist/work-items.js');
    const emitted = await readFile(shared, 'utf8');
    expect(emitted).toContain('@aotui/sdk/app');
    await writeFile(shared, emitted.replace('@aotui/sdk/app', '@aotui/sdk-copy/app'));
}, 20_000);

afterAll(async () => { if (consumer) await rm(consumer, { recursive: true, force: true }); });

function interaction(runtime: ReturnType<typeof createRuntime>, desktopId: ReturnType<typeof createDesktopId>, appId: string, policy?: AppInteractionPolicy) {
    const app = runtime.getDesktop(desktopId).getInstalledApps().find(item => item.appId === appId);
    if (!app?.appInstanceId) throw Error('Missing installed App instance ' + appId);
    const access = runtime.getAppInteraction(desktopId, appId, app.appInstanceId, policy);
    if (access.status !== 'ready') throw Error(JSON.stringify(access.issue));
    return access.interaction;
}

async function appFolder(name: string, code: string) {
    const folder = join(consumer, name);
    await mkdir(folder);
    await writeFile(join(folder, 'entry.mjs'), code);
    await writeFile(join(folder, 'aoapp.json'), JSON.stringify({
        app_name: name, version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v5',
        persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './entry.mjs' },
    }));
    return folder;
}

async function trace(path: string) {
    try { return (await readFile(path, 'utf8')).trim().split('\n'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function waitFor(path: string, value: string) {
    await expect.poll(() => trace(path), { timeout: 5_000 }).toContain(value);
}

function frame(client: AppInteraction) {
    return client.observe({ all: true });
}

async function observe(client: AppInteraction): Promise<Observation> {
    const result = await frame(client);
    if (result.status !== 'observed') throw Error(JSON.stringify(result.issue));
    expect(client.adoptObservation(result.observation.observationId).status).toBe('adopted');
    return result.observation;
}

const body = (observation: Observation, id = 'workspace') => observation.views.find(view => view.id === id)?.content?.value;
function request(observation: Observation, name: string, input: Readonly<Record<string, JsonValue>>, invocationId: string) {
    const tool = observation.tools.find(item => item.name === name);
    if (!tool) throw Error('Missing observed tool ' + name);
    const view = observation.views.find(page => page.type === tool.viewType &&
        (tool.eligibleViewIds === undefined || tool.eligibleViewIds.includes(page.id)));
    if (!view) throw Error('Missing receiver ' + name);
    return { invocationId, observationId: observation.observationId, toolId: tool.id, input: { view_id: view.id, ...input } };
}

it.each(adapters)('loads and exercises the published %s SDK App through manifest and fresh Worker', async adapter => {
    const name = 'work_' + adapter;
    const selectedId = 'billing_export_2026_11', otherId = 'b';
    const selectedRef = selectedId + '.selected', otherRef = otherId + '.selected';
    const itemRef = (index?: number) => selectedId + '.items' + (index === undefined ? '' : '[' + index + ']');
    const traceFile = join(consumer, name + '.trace'), gate = (which: string) => join(consumer, name + '-' + which);
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import { isMainThread, threadId } from 'node:worker_threads';
import { workItemsApp } from '../dist/work-items-${adapter}.js';
if (isMainThread) throw Error('DISCOVERY_IMPORTED_APP');
if (${JSON.stringify(adapter)} === 'plain' && 'document' in globalThis) throw Error('PLAIN_APP_HAS_DOM');
const trace = value => appendFileSync(${JSON.stringify(traceFile)}, value + '\\n');
trace('thread:' + threadId);
const wait = async (path, label) => {
    trace(label);
    while (!existsSync(path)) await new Promise(resolve => setTimeout(resolve, 5));
};
const factory = workItemsApp(${JSON.stringify(name)}, {
    prepare: () => wait(${JSON.stringify(gate('work'))}, 'handler-entered'),
    recover: fault => wait(${JSON.stringify(gate('repair'))} + '-' + fault, 'repair-pending:' + fault),
    onPublicationError: error => trace(error.code + ':' + error.path),
    onStop: () => trace('stop'),
    onClose() {
        if (${JSON.stringify(adapter)} === 'plain' && 'document' in globalThis) throw Error('PLAIN_APP_HAS_DOM');
        trace('close');
    },
});
export default factory;
`);
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 5_000 } });
    const registry = new AppRegistry();
    const desktopId = createDesktopId(name);
    let source: SemanticAOTUIDrivenSource | undefined;
    try {
        expect(await registry.registerTransient('local:' + folder)).toBe(name);
        expect(await trace(traceFile)).toEqual([]);
        await runtime.createDesktop(desktopId);
        const desktop = runtime.getDesktop(desktopId);
        const [installation] = await registry.installAll(desktop, { dynamicConfig: { AOTUI_DATA_DIR: join(folder, 'data') } });
        if (!installation || installation.status === 'failed') throw Error(JSON.stringify(installation));
        const { appId } = installation;
        expect(appId).toBeDefined();
        const client = interaction(runtime, desktopId, appId);
        let current = await observe(client), serial = 0;
        const originalInstance = current.source.instanceId;
        const originalView = current.views.find(view => view.id === selectedId)!.viewInstanceId;
        const call = (tool: string, input: Readonly<Record<string, JsonValue>>) => client.invoke(request(current, tool, input, 'work-' + ++serial));
        const success = (reply: Awaited<ReturnType<typeof call>>) => {
            expect(reply).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true } } } });
            expect(JSON.stringify(reply)).not.toContain('Inspections:');
        };
        expect(current.views.filter(view => view.type === 'Item').map(view => view.id)).toEqual([otherId, selectedId]);
        expect(current.tools.filter(tool => tool.name === 'inspect')).toHaveLength(1);
        expect(body(current, selectedId)).toContain('[Selected \\[work\\] \\\\ item](Data:selected)');
        expect(current.refs.filter(ref => ref.viewId === selectedId).map(ref => ref.refId)).toEqual(expect.arrayContaining(['items', 'items[0]', 'items[4]']));

        success(await call('inspect', { selected: selectedRef, text: '$value view.items[0]', elements: [itemRef(0), itemRef(1), itemRef(2)] }));
        current = await observe(client);
        expect(body(current)).toContain('{"selected":null,"elements":[0,false,""],"text":"$value view.items[0]","readonly":true}');
        for (const [selected, value] of [[otherRef, 'false'], [itemRef(2), '""'], [itemRef(3), 'null'],
            [itemRef(4), '{"nested":[1,[false]]}'], [itemRef(), '[0,false,"",null,{"nested":[1,[false]]}]']]) {
            success(await call('inspect', { selected: selected! }));
            current = await observe(client);
            expect(body(current)).toContain('"selected":' + value);
            expect(body(current)).not.toContain('"text":');
        }
        expect(await call('count', { selected: otherRef })).toMatchObject({ receipt: { executionPhase: 'not-dispatched',
            outcome: { status: 'rejected', code: 'REF_VALUE_UNSUPPORTED', path: '$.selected' } } });
        expect(await call('update', { operation: 'reset', options: { mode: 'keep', numbers: [1, 9] } })).toMatchObject({
            receipt: { executionPhase: 'not-dispatched', outcome: { code: 'TOOL_INVALID_ARGS', path: '$.options.numbers[1]' } },
        });
        for (const input of [{ operation: 'reset', extra: true }, { operation: 'reset', options: null },
            { operation: 'reset', options: { mode: 'keep', numbers: [0, null, 1] } }]) {
            expect(await call('update', input)).toMatchObject({ receipt: { executionPhase: 'not-dispatched', outcome: { code: 'TOOL_INVALID_ARGS' } } });
        }
        expect((await observe(client)).source.revision).toBe(current.source.revision);

        source = new SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: false });
        const model = await source.getContext();
        try {
            await model.adopt();
            const inspectName = name + '-inspect';
            const modelSchema = (model.tools[inspectName]!.inputSchema as { jsonSchema: unknown }).jsonSchema;
            expect(modelSchema).toMatchObject({ properties: {
                selected: { type: 'string', minLength: 1, description: expect.stringContaining('view_id.ref_id') },
                elements: { type: 'array', items: { type: 'string', minLength: 1,
                    description: expect.stringContaining('view_id.ref_id') }, maxItems: 3 },
                'x-aotui-ref-value': { properties: { 'x-aotui-parameter-contract': { const: 'business' } },
                    default: { 'x-aotui-parameter-contract': 'business' } },
            } });
            expect(modelSchema).not.toHaveProperty('x-aotui-parameter-contract');
            expect(modelSchema).not.toHaveProperty('properties.selected.x-aotui-ref-value');
            expect(modelSchema).not.toHaveProperty('properties.elements.items.x-aotui-ref-kind');
            expect(await model.executeTool(name + '-update', { view_id: 'workspace', operation: 'reset', options: { mode: 'keep', numbers: [1, '2'] } }, 'model-error'))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_INVALID_ARGS', message: expect.stringContaining('$.options.numbers[1]') } });
        } finally { await model.release(); }

        // Use a current binding to update, then read the original captured value
        // until this consumer explicitly adopts the new Observation.
        current = await observe(client);
        const reset = request(current, 'update', { operation: 'reset', options: { mode: 'keep', numbers: [1, null] } }, 'reset');
        success(await client.invoke(reset)); success(await client.invoke(reset));
        success(await call('inspect', { selected: selectedRef }));
        current = await observe(client);
        expect(body(current)).toContain('"selected":null');
        success(await call('count', { selected: selectedRef }));
        success(await call('update', { operation: 'null' })); current = await observe(client);
        success(await call('inspect', { selected: selectedRef })); current = await observe(client);
        expect(body(current)).toContain('"selected":null');
        success(await call('update', { operation: 'reset' })); current = await observe(client);
        success(await call('count', { selected: selectedRef }));

        for (const [operation, issue] of [
            ['invalid', { code: 'SNAPSHOT_INVALID', path: 'Ref ' + selectedRef + ' $', message: 'Value does not match any declared alternative.' }],
            ['oversized', { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[0].content.value', message: 'Serialized byte budget exceeded' }],
        ] as const) {
            const lastGood = current;
            const updated = await call('update', { operation });
            success(updated);
            await waitFor(traceFile, 'repair-pending:' + operation);
            expect(await frame(client)).toEqual({ status: 'rejected', issue });
            if (adapter === 'plain') {
                expect(await trace(traceFile)).toContain(issue.code + ':' + issue.path);
                expect(updated).toMatchObject({ receipt: { outcome: { value: { data: {
                    message: 'Change applied. View refresh failed.',
                } } } } });
            }
            const degraded = await source.getContext();
            try {
                const text = degraded.messages.map(message => String(message.content)).join('\n');
                expect(text).toContain(`Semantic status: ${issue.code}: ${issue.message} (at ${issue.path})`);
                expect(degraded.tools[name + '-inspect']).toBeUndefined();
            } finally { await degraded.release?.(); }
            await writeFile(gate('repair') + '-' + operation, '');
            await expect.poll(async () => {
                const result = await frame(client);
                if (result.status === 'observed') client.releaseObservation(result.observation.observationId);
                return result.status;
            }, { timeout: 5_000 }).toBe('observed');
            current = await observe(client);
            expect(current.source.snapshotId).toBe(lastGood.source.snapshotId);
            expect(current.views).toEqual(lastGood.views);
        }

        success(await call('update', { operation: 'reverse' })); current = await observe(client);
        expect(current.refs.some(ref => ref.viewId === selectedId && ref.refId === 'items[3]')).toBe(false);
        success(await call('inspect', { selected: itemRef(0) })); current = await observe(client);
        expect(body(current)).toContain('"selected":{"nested":[1,[false]]}');
        success(await call('update', { operation: 'empty' })); current = await observe(client);
        success(await call('inspect', { selected: itemRef() })); current = await observe(client);
        expect(body(current)).toContain('"selected":[]');

        const stale = request(current, 'inspect', { selected: selectedRef }, 'stale');
        success(await call('update', { operation: 'close' }));
        const closedPreview = await client.preview();
        expect(closedPreview).toMatchObject({ status: 'previewed' });
        expect(await client.invoke(stale)).toMatchObject({ receipt: { outcome: { code: 'REF_VIEW_UNAVAILABLE', path: '$.selected' } } });
        success(await call('update', { operation: 'open' }));
        expect((await client.preview()).status).toBe('previewed');
        expect(await client.invoke({ ...stale, invocationId: 'stale-reopened' })).toMatchObject({
            receipt: { outcome: { code: 'REF_VIEW_UNAVAILABLE', path: '$.selected' } },
        });
        success(await call('update', { operation: 'close' })); current = await observe(client);
        expect(body(current, selectedId)).toBeUndefined();
        expect(current.tools.some(tool => tool.name === 'inspect')).toBe(true);
        success(await call('update', { operation: 'open' })); current = await observe(client);
        expect(current.views.find(view => view.id === selectedId)?.viewInstanceId).not.toBe(originalView);
        expect(await client.invoke(stale)).not.toMatchObject({ receipt: { outcome: { status: 'succeeded' } } });

        const held = request(current, 'update', { operation: 'wait' }, 'held');
        const waiting = client.invoke(held, 1_000);
        await waitFor(traceFile, 'handler-entered');
        const timedOut = {
            kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT',
            message: expect.stringMatching(/readReceipt.*observationId.*invocationId/),
        };
        expect(await waiting).toEqual(timedOut);
        expect(await client.invoke(held, 100)).toEqual(timedOut);
        expect(await call('count', { selected: selectedRef })).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        expect((await trace(traceFile)).filter(line => line === 'handler-entered')).toHaveLength(1);
        const prior = current;
        current = await observe(client);
        await writeFile(gate('work'), '');
        const terminal = await client.readReceipt({ observationId: held.observationId, invocationId: held.invocationId });
        success(terminal);
        expect(await client.invoke(request(prior, 'count', { selected: selectedRef }, 'old-unseen'))).toMatchObject({
            kind: 'refused', code: 'OBSERVATION_UNAVAILABLE',
        });
        expect(terminal).toMatchObject({ receipt: { invocationId: held.invocationId, observationId: held.observationId,
            toolId: held.toolId, executionPhase: 'entered-returned' } });
        current = await observe(client);
        expect(body(current)).toContain('Prepared');
        await desktop.closeApp(appId!);
        expect(await trace(traceFile)).toEqual(expect.arrayContaining(['stop', 'close']));
        await desktop.openApp(appId!);
        const fresh = interaction(runtime, desktopId, appId);
        const freshObservation = await observe(fresh);
        expect(freshObservation.source.instanceId).not.toBe(originalInstance);
        expect(await fresh.invoke(stale)).not.toMatchObject({ receipt: { outcome: { status: 'succeeded' } } });
        const workers = (await trace(traceFile)).filter(line => line.startsWith('thread:'));
        expect(new Set(workers).size).toBe(2);
        fresh.releaseObservation(freshObservation.observationId);
    } finally {
        await writeFile(gate('repair') + '-invalid', '');
        await writeFile(gate('repair') + '-oversized', '');
        await writeFile(gate('work'), '');
        await source?.dispose();
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true, workers: { report: { total: 0 } } });
    }
    expect((await trace(traceFile)).filter(line => line === 'close')).toHaveLength(2);
}, 25_000);

it('revalidates a static declaration from a second installed SDK copy', async () => {
    const check = join(consumer, 'static-copy.mjs');
    await writeFile(check, `
import assert from 'node:assert/strict';
import Type from 'typebox';
import * as one from '@aotui/sdk/app';
import * as two from '@aotui/sdk-copy/app';
const view = one.defineViewType({ name:'View', tools:{ sample:{ description:'Sample',
    inputSchema:Type.Object({ n: Type.Integer() }) } } });
assert.deepEqual(two.getToolCatalog([view]), one.getToolCatalog([view]));
const witness = Object.getOwnPropertySymbols(view)[0];
const fake = { ...view, tools:{ sample:{ description:'Fake',
    inputSchema:{ type:'object', properties:{ v:{ type:'string', format:'unknown' } } } } } };
Object.defineProperty(fake, witness, Object.getOwnPropertyDescriptor(view, witness));
assert.throws(() => two.getToolCatalog([fake]), { code:'TOOL_SCHEMA_UNSUPPORTED', path:'$.properties.v.format' });
const legacy = { ...view };
Object.defineProperty(legacy, witness, { value:'other-version' });
assert.throws(() => two.getToolCatalog([legacy]), { code:'VIEW_TYPE_INVALID' });
`);
    await execute(process.execPath, [check]);
});

it.each(adapters)('joins late %s initialization and its registered cleanup before exit', async adapter => {
    const name = 'late_' + adapter, log = join(consumer, name + '.trace'), release = log + '.release';
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
const trace = value => appendFileSync(${JSON.stringify(log)}, value + '\\n');
const stop = () => trace('stop'), close = () => trace('close');
async function prepare(signal) {
    signal.addEventListener('abort', () => trace('stopping'), { once: true });
    trace('initializing');
    while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
    trace('late:' + signal.aborted);
}
${adapter === 'plain' ? `
import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[], async initialize({ signal, registerCleanup, publish }) {
    await prepare(signal);
    registerCleanup({ stop, close });
    try { publish({ views: [] }); } catch (error) { trace(error.code); throw error; }
} });` : `
import { createTUIApp, useAppLifecycle } from '@aotui/sdk';
const factory = createTUIApp({ app_name: ${JSON.stringify(name)}, viewTypes: [], component: () => {
    useAppLifecycle({ stop, close }); return null;
} });
const initialize = factory.initialize;
factory.initialize = async context => { await prepare(context.signal); return initialize(context); };
export default factory;`}
`);
    const registry = new AppRegistry();
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 3_000 } });
    try {
        await registry.loadFromEntries([{ name, source: 'local:' + folder, enabled: true, autoStart: false }]);
        const desktopId = await runtime.createDesktop(createDesktopId(name)), desktop = runtime.getDesktop(desktopId);
        const [installation] = await registry.installAll(desktop, { dynamicConfig: { AOTUI_DATA_DIR: join(folder, 'data') } });
        if (!installation || installation.status === 'failed') throw Error(JSON.stringify(installation));
        const { appId } = installation;
        const opening = desktop.openApp(appId!).then(() => 'opened', () => 'rejected');
        await waitFor(log, 'initializing');
        const closing = runtime.beginShutdown();
        await waitFor(log, 'stopping');
        expect(await closing.wait({ timeoutMs: 15 })).toMatchObject({ status: 'deadline',
            report: { resourcesReleased: false, workers: { report: { total: 1 } } } });
        expect(runtime.getAppInteraction(desktopId, appId, 'closed').status).toBe('rejected');
        await writeFile(release, '');
        expect(await opening).toBe('rejected');
        expect(await closing.completion).toMatchObject({ resourcesReleased: true, workers: { report: { total: 0 } } });
        expect(await trace(log)).toEqual(['initializing', 'stopping', 'late:true', 'stop',
            ...(adapter === 'plain' ? ['PROJECTION_CLOSED'] : []), 'close']);
    } finally {
        await writeFile(release, '');
        await runtime.beginShutdown().completion;
    }
}, 15_000);

it.each(adapters)('reports forced %s Worker exit without claiming held cleanup completed', async adapter => {
    const name = 'forced_' + adapter, log = join(consumer, name + '.trace');
    const folder = await appFolder(name, `
import { appendFileSync } from 'node:fs';
import { workItemsApp } from '../dist/work-items-${adapter}.js';
export default workItemsApp(${JSON.stringify(name)}, {
    async onClose() {
        appendFileSync(${JSON.stringify(log)}, 'cleanup-entered\\n');
        await new Promise(() => {});
    },
});
`);
    const registry = new AppRegistry();
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 2_000 } });
    try {
        await registry.registerTransient('local:' + folder);
        const desktop = runtime.getDesktop(await runtime.createDesktop(createDesktopId(name)));
        expect(await registry.installAll(desktop, { dynamicConfig: { AOTUI_DATA_DIR: join(folder, 'data') } })).toHaveLength(1);
        const closing = runtime.beginShutdown();
        await waitFor(log, 'cleanup-entered');
        expect(await closing.wait({ timeoutMs: 15 })).toMatchObject({ status: 'deadline',
            report: { resourcesReleased: false, workers: { report: { total: 1 } } } });
        expect(await closing.completion).toMatchObject({ ok: false, resourcesReleased: true,
            appCleanup: { completedApps: 0 }, workers: { report: { total: 0 } } });
        expect(await trace(log)).toEqual(['cleanup-entered']);
    } finally { await runtime.beginShutdown().completion; }
}, 15_000);

it('keeps a real declaration error code and path across manifest loading and isolates the healthy App', async () => {
    const name = 'bad_schema', folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, defineViewType } from '@aotui/sdk/app';
defineViewType({ name: 'Workspace', tools: { bad: { description: 'Invalid declaration',
    inputSchema: Type.Object({ nested: Type.Object({ entry: Type.String({ format: 'email' }) }) }) } } });
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[], initialize({ publish }) { publish({ views: [] }); } });
`);
    const healthy = await appFolder('healthy_schema', `
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const Workspace = defineViewType({ name:'Workspace', tools:{} });
export default createApp({ app_name: 'healthy_schema', viewTypes:[Workspace], initialize({ publish }) {
    publish({ views: [createView(Workspace, { id:'workspace', kind:'state', render:() => ({body:'Healthy'}) })] });
} });
`);
    const registry = new AppRegistry();
    const runtime = createRuntime({ worker: { maxWorkers: 2, timeoutMs: 5_000 } });
    try {
        await registry.registerTransient('local:' + healthy);
        await registry.registerTransient('local:' + folder);
        const desktopId = await runtime.createDesktop(createDesktopId('schemas')), desktop = runtime.getDesktop(desktopId);
        const [installed, failed] = await registry.installAll(desktop, { dynamicConfig: { AOTUI_DATA_DIR: join(healthy, 'data') } });
        expect(failed).toMatchObject({ name, status: 'failed', phase: 'install',
            issue: { code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.nested.properties.entry.format' } });
        if (!installed || installed.status === 'failed') throw Error(JSON.stringify(installed));
        const { appId } = installed;
        expect(desktop.getInstalledApps().map(app => app.name)).toEqual(['healthy_schema']);
        const broken = registry.get(name)!;
        await expect(desktop.installDynamicWorkerApp(broken.modulePath, { name, appId: createAppId(name),
            config: { AOTUI_DATA_DIR: join(folder, 'data') } })).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'INSTALL_FAILED', cause: { code: 'E_INIT_FAILED', cause: {
                code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.nested.properties.entry.format',
            } } },
        });
        const client = interaction(runtime, desktopId, appId);
        expect(body(await observe(client))).toBe('Healthy');
    } finally { await runtime.beginShutdown().completion; }
}, 15_000);

it.each([
    { fault: 'bindings', errorName: 'TypeError', issue: {
        code: 'TOOL_BINDING_INVALID', path: 'View workspace.bindings', message: 'View workspace.bindings must bind exactly change, inspect',
    } },
    { fault: 'schema', errorName: 'TypeBoxSchemaExportError', issue: {
        code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.value.format', message: 'Declaration uses unsupported ordinary parameter vocabulary.',
    } },
])('preserves a running App $fault diagnostic in observe and the Agent context', async ({ fault, errorName, issue }) => {
    const name = 'broken_' + fault, sibling = 'diagnostic_peer_' + fault;
    const log = join(consumer, name + '.trace'), gate = join(consumer, name + '.repair');
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref } from '@aotui/sdk/app';
const tool = {description:'Test publication', inputSchema:Type.Object({})};
const Workspace = defineViewType({ name:'Workspace', tools:{ change:tool, inspect:tool } });
export default createApp({ app_name:${JSON.stringify(name)}, viewTypes:[Workspace], initialize({ publish, signal }) {
    let content = { body:'Committed diagnostic workspace',
        refs:[ref('selected', 'last good', { schema:Type.String() })] };
    const bindings = { inspect: { execute: () => ({ success:true }) }, change: { execute() {
        const candidate = { ...content, body:'Rejected diagnostic candidate' };
        if (${JSON.stringify(fault)} === 'schema') candidate.refs = [ref('selected', { value:'item' }, {
            schema:Type.Object({ value:Type.String({ format:'uuid' }) }),
        })];
        const rejected = createView(Workspace, { id:'workspace', kind:'state', render:() => ({
            ...candidate, bindings:${fault === 'bindings' ? '{ change:bindings.change }' : 'bindings'},
        }) });
        try {
            publish({ views:[rejected] });
        } catch (error) {
            appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name:error.name, code:error.code, path:error.path, message:error.message }) + '\\n');
            void (async () => {
                while (!signal.aborted && !existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
                if (!signal.aborted) publish({ views:[workspace] });
            })();
            return { success:true };
        }
        throw Error('Invalid frame committed');
    } } };
    const workspace = createView(Workspace, { id:'workspace', kind:'state', render:() => ({...content,bindings}) });
    publish({ views:[workspace] });
} });
`);
    const healthy = await appFolder(sibling, `
import { workItemsApp } from '../dist/work-items-plain.js';
export default workItemsApp(${JSON.stringify(sibling)});
`);
    const registry = new AppRegistry();
    const runtime = createRuntime({ worker: { maxWorkers: 2, timeoutMs: 5_000 } });
    let source: SemanticAOTUIDrivenSource | undefined;
    try {
        await registry.registerTransient('local:' + folder);
        await registry.registerTransient('local:' + healthy);
        const desktopId = await runtime.createDesktop(createDesktopId(name)), desktop = runtime.getDesktop(desktopId);
        const installations = await registry.installAll(desktop, { dynamicConfig: { AOTUI_DATA_DIR: join(folder, 'data') } });
        expect(installations.map(item => item.status)).toEqual(['installed', 'installed']);
        const installed = installations.find(item => item.name === name);
        if (!installed || installed.status !== 'installed') throw Error(JSON.stringify(installed));
        const client = interaction(runtime, desktopId, installed.appId);
        const before = await observe(client);
        expect(body(before)).toBe('Committed diagnostic workspace');
        expect(await client.invoke(request(before, 'change', {}, 'break-frame'))).toMatchObject({
            kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } },
        });
        expect((await trace(log)).map(line => JSON.parse(line))).toEqual([{
            name: errorName, code: issue.code, path: issue.path,
            message: fault === 'schema' ? `${issue.code} at ${issue.path}: ${issue.message}` : `${issue.code}: ${issue.message}`,
        }]);
        expect(await frame(client)).toEqual({ status: 'rejected', issue });

        source = new SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: false });
        const degraded = await source.getContext();
        try {
            await degraded.adopt();
            const text = degraded.messages.map(message => String(message.content)).join('\n');
            expect(text).toContain(`Semantic status: ${issue.code}: ${issue.message} (at ${issue.path})`);
            expect(text).not.toContain('Rejected diagnostic candidate');
            expect(text).not.toContain('Committed diagnostic workspace');
            expect(text).toContain('Inspections: 0');
            expect(degraded.tools[name + '-change']).toBeUndefined();
            expect(degraded.tools[sibling + '-inspect']).toBeDefined();
        } finally { await degraded.release(); }

        await writeFile(gate, '');
        await expect.poll(async () => {
            const result = await frame(client);
            if (result.status === 'observed') client.releaseObservation(result.observation.observationId);
            return result.status;
        }, { timeout: 5_000 }).toBe('observed');
        const recovered = await observe(client);
        expect(recovered).toMatchObject({ source: before.source, views: before.views, refs: before.refs, tools: before.tools });
    } finally {
        await writeFile(gate, '');
        await source?.dispose();
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);

it('keeps committed plain View and Tool identities across rejected complete frames', async () => {
    const name = 'atomic_plain', log = join(consumer, name + '.trace');
    const savedFile = join(consumer, name + '.saved');
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam } from '@aotui/sdk/app';
const trace = value => appendFileSync(${JSON.stringify(log)}, value + '\\n');
const schema = Type.String();
const Workspace = defineViewType({ name:'Workspace', tools:{
    change:{description:'Publish a frame', inputSchema:Type.Object({ operation:Type.Enum(['oversized', 'ref', 'close', 'open', 'save']) })},
} });
const Item = defineViewType({ name:'Item', tools:{
    inspect:{description:'Inspect selected item', inputSchema:Type.Object({selected:refParam('Text', schema)})},
} });
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[Workspace, Item], initialize({ publish }) {
    let savedText = 'Item';
    const inspect = { execute({ selected }) { trace('entered:' + selected); return { success:true }; } };
    const item = createView(Item, { id:'item_a', kind:'state', render:() => ({ body:savedText,
        refs:[ref('selected', 'committed', { refType:'Text', schema })], bindings:{inspect},
    }) });
    const workspace = createView(Workspace, { id:'workspace', kind:'state', render:() => ({
        body:'Workspace', bindings:{ change: { execute({ operation }) {
            if (operation === 'close' || operation === 'open') {
                publish({ views: operation === 'close' ? [workspace] : [workspace, item] });
                return { success:true };
            }
            if (operation === 'save') {
                const text = 'Saved business text';
                appendFileSync(${JSON.stringify(savedFile)}, text + '\\n');
                savedText = text;
            }
            const candidate = createView(Item, {id:'spill',kind:'state',render:() => ({
                body: operation === 'ref' ? 'Replacement' : 'x'.repeat(513 * 1024),
                refs: operation === 'ref' ? [ref('selected', 2, { refType:'Text', schema })] : [],
                bindings: {inspect:{...inspect,enabled:false}},
            })});
            try {
                publish({ views:[workspace, candidate] });
                throw Error('Invalid App frame committed');
            } catch (error) {
                if (!error.code) throw error;
                trace(error.code + ':' + error.path);
            }
            const repair = async () => {
                while (!existsSync(${JSON.stringify(log)} + '-' + operation)) await new Promise(resolve => setTimeout(resolve, 5));
                publish({ views:[workspace, item] });
            };
            void repair();
            if (operation === 'save') return { success:true, data: { message:'File saved. View refresh failed.' } };
            return { success:true };
        } } },
    }) });
    publish({ views:[workspace, item] });
} });
`);
    const registry = new AppRegistry();
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 5_000 } });
    try {
        await registry.registerTransient('local:' + folder);
        const desktopId = await runtime.createDesktop(createDesktopId(name));
        const [installation] = await registry.installAll(runtime.getDesktop(desktopId), { dynamicConfig: { AOTUI_DATA_DIR: join(folder, 'data') } });
        if (!installation || installation.status === 'failed') throw Error(JSON.stringify(installation));
        const client = interaction(runtime, desktopId, installation.appId);
        const before = await observe(client);
        const viewIdentity = (observation: Observation) => observation.views.find(view => view.id === 'item_a')?.viewInstanceId;
        const entered = { kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } };

        for (const [operation, code, path] of [
            ['oversized', 'SNAPSHOT_SERIALIZATION_ERROR', '$.views[1].content.value'],
            ['ref', 'SNAPSHOT_INVALID', 'Ref spill.selected $'],
        ] as const) {
            expect(await client.invoke(request(before, 'change', { operation }, operation))).toMatchObject(entered);
            expect(await trace(log)).toContain(code + ':' + path);
            expect(await frame(client)).toMatchObject({ status: 'rejected', issue: { code, path } });
            const inspect = (id: string) => client.invoke(request(before, 'inspect', { selected: 'item_a.selected' }, id));
            expect(await inspect(operation + '-degraded')).toMatchObject({ receipt: { outcome: { status: 'rejected' } } });
            await writeFile(log + '-' + operation, '');
            await expect.poll(async () => {
                const result = await frame(client);
                if (result.status === 'rejected') return result.status;
                client.releaseObservation(result.observation.observationId);
                expect(result.observation.source.snapshotId).toBe(before.source.snapshotId);
                expect(viewIdentity(result.observation)).toBe(viewIdentity(before));
                return result.status;
            }).toBe('observed');
            expect(await inspect(operation + '-repaired')).toMatchObject(entered);
        }
        expect((await trace(log)).filter(line => line.startsWith('entered:'))).toEqual(['entered:committed', 'entered:committed']);

        expect(await client.invoke(request(before, 'change', { operation: 'close' }, 'close'))).toMatchObject(entered);
        const closed = await observe(client);
        expect(viewIdentity(closed)).toBeUndefined();
        expect(closed.tools.some(tool => tool.name === 'inspect')).toBe(false);
        expect(await client.invoke(request(closed, 'change', { operation: 'open' }, 'open'))).toMatchObject(entered);
        const reopened = await observe(client);
        expect(viewIdentity(reopened)).not.toBe(viewIdentity(before));
        expect(reopened.tools.some(tool => tool.name === 'inspect')).toBe(true);

        const save = request(reopened, 'change', { operation: 'save' }, 'save-once');
        const result = await client.invoke(save);
        expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned',
            outcome: { status: 'succeeded', value: { success: true, data: { message: 'File saved. View refresh failed.' } } } } });
        expect(await readFile(savedFile, 'utf8')).toBe('Saved business text\n');
        const diagnostic = { status: 'rejected', issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[1].content.value',
        } };
        expect(await frame(client)).toMatchObject(diagnostic);
        expect(await client.preview()).toMatchObject(diagnostic);

        await writeFile(log + '-save', '');
        await expect.poll(async () => {
            const result = await frame(client);
            if (result.status === 'observed') client.releaseObservation(result.observation.observationId);
            return result.status;
        }).toBe('observed');
        const repaired = await observe(client);
        expect(body(repaired, 'item_a')).toBe('Saved business text');
        expect(viewIdentity(repaired)).toBe(viewIdentity(reopened));
        expect(await client.readReceipt({ observationId: save.observationId, invocationId: save.invocationId })).toEqual(result);
        expect(await readFile(savedFile, 'utf8')).toBe('Saved business text\n');
    } finally {
        await writeFile(log + '-oversized', '');
        await writeFile(log + '-ref', '');
        await writeFile(log + '-save', '');
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);

it.each(adapters)('rejects opening a second 400 KiB View in %s and keeps the first fully observable and callable', async adapter => {
    const name = 'capacity_' + adapter;
    const gate = join(consumer, name + '-open-b');
    const lifecycle = join(consumer, name + '-lifecycle');
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam } from '@aotui/sdk/app';
${adapter === 'preact' ? `import { h } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { createTUIApp, View, useAppRuntimeContext, useDataRef, useState } from '@aotui/sdk';` : ''}
const Item = defineViewType({ name:'Item', tools: {
    inspect: { description:'Inspect published data',
        inputSchema:Type.Object({ value:refParam('Data', Type.Unknown()) }, {additionalProperties:false}) },
    grow: { description:'Open another page, optionally closing this one first',
        inputSchema:Type.Object({ closeFirst:Type.Boolean() }, {additionalProperties:false}) },
} });
const size = 400 * 1024;
let value = 'x'.repeat(size);
for (let index = 0; index < 40; index++) value = [value];
const inspect = { execute({ value }) {
    let depth = 0;
    while (Array.isArray(value)) { value = value[0]; depth++; }
    return { success: true, data: { size: value.length, depth } };
} };
const openingError = error => {
    if (error.code !== 'OBSERVATION_CAPACITY') throw error;
    return { success: false, error: { code: error.code, message: error.message, context: { path: error.path } } };
};
const waitForSwitch = async () => {
    while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
};
${adapter === 'plain' ? `
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[Item], initialize({ publish }) {
    let staging = false;
    const bindings = {
        inspect,
        grow: { async execute({ closeFirst }) {
            if (closeFirst) {
                const closed = publish({ views: [] });
                await waitForSwitch();
                const opened = publish({ views: [second] }, { opening: true });
                return { success: true, data: { closedEpoch: closed.sourceEpoch, openedEpoch: opened.sourceEpoch } };
            }
            staging = true;
            try {
                publish({ views: [first, second] }, { opening: true });
                return { success: true };
            } catch (error) {
                return openingError(error);
            } finally { staging = false; }
        } },
    };
    const first = createView(Item, { id:'item_a', kind:'state', render:() => ({ body:'a'.repeat(size),
        refs:[ref('data', value, {refType:'Data'})],
        bindings: staging ? { ...bindings, inspect: { execute: () => ({ success: true, data: { staged: true } }) } } : bindings,
    }) });
    const second = createView(Item, { id:'item_b', kind:'state', render:() => ({ body:'b'.repeat(size),
        bindings:{ ...bindings, inspect:{ ...bindings.inspect, enabled:false }, grow:{ ...bindings.grow, enabled:false } },
    }) });
    publish({ views:[first] });
}});
` : `
const trace = entry => appendFileSync(${JSON.stringify(lifecycle)}, entry + '\\n');
function Details({ page, staging }) {
    useLayoutEffect(() => {
        trace('mount:' + page);
        return () => trace('unmount:' + page);
    }, [page]);
    useDataRef('data', staging ? 'candidate only' : value, { refType: 'Data' });
    return page.repeat(size);
}
function App() {
    const [pages, setPages] = useState('a');
    const { prepareProjection: prepare } = useAppRuntimeContext();
    const grow = { async execute({ closeFirst }) {
        if (closeFirst) {
            const closed = await prepare(() => setPages(''));
            await waitForSwitch();
            const opened = await prepare(() => setPages('b'), { revert: () => setPages('') });
            return { success: true, data: { closedEpoch: closed.sourceEpoch, openedEpoch: opened.sourceEpoch } };
        }
        try {
            await prepare(() => setPages('ab'), { revert: () => setPages('a') });
            return { success: true };
        } catch (error) { return openingError(error); }
    } };
    return [...pages].map(page => h(View, { key: page, id: 'item_' + page, type: Item, kind: 'state', bindings: {
        grow: { ...grow, enabled: page === 'a' },
        inspect: page === 'b' ? { ...inspect, enabled: false } : pages === 'ab'
            ? { execute: () => ({ success: true, data: { staged: true } }) } : inspect,
    } }, h(Details, { page, staging: pages === 'ab' })));
}
export default createTUIApp({ app_name: ${JSON.stringify(name)}, component: App, viewTypes: [Item] });
`}
`);
    const open = vi.fn(async () => { throw Error('Non-persistent App accessed Host storage'); });
    const runtime = createRuntime({}, { storageBackend: { open } });
    const registry = new AppRegistry();
    try {
        await registry.registerTransient('local:' + folder);
        const desktopId = await runtime.createDesktop(createDesktopId(name));
        const desktop = runtime.getDesktop(desktopId);
        const [installed] = await registry.installAll(desktop, { dynamicConfig: { AOTUI_DATA_DIR: join(folder, 'data') } });
        if (!installed || installed.status !== 'installed') throw Error(JSON.stringify(installed));
        const client = interaction(runtime, desktopId, installed.appId);
        const first = await observe(client);
        expect(body(first, 'item_a')).toHaveLength(400 * 1024);
        const originalHandler = {
            kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { size: 400 * 1024, depth: 40 } } } },
        };
        expect(await client.invoke(request(first, 'inspect', { value: 'item_a.data' }, 'large-ref'))).toMatchObject(originalHandler);
        const attempt = await client.invoke(request(first, 'grow', { closeFirst: false }, 'grow'));
        const preview = await client.preview(), next = await frame(client);
        expect({
            outcome: attempt.kind === 'receipt' ? attempt.receipt.outcome.status : attempt.code,
            preview: preview.status === 'previewed' ? preview.views.map(view => view.id) : preview.issue.code,
            observation: next.status === 'observed' ? next.observation.views.map(view => view.id) : next.issue.code,
        }).toEqual({ outcome: 'failed', preview: ['item_a'], observation: ['item_a'] });
        expect(attempt).toMatchObject({ receipt: { outcome: { details: { result: { error: {
            code: 'OBSERVATION_CAPACITY', message: expect.stringContaining('Close a View'), context: { path: '$.observation' },
        } } } } } });
        expect(preview).toMatchObject({ source: first.source, views: first.views });
        if (adapter === 'preact') expect(await trace(lifecycle)).toEqual(['mount:a', 'mount:b', 'unmount:b']);
        expect(await client.invoke(request(first, 'inspect', { value: 'item_a.data' }, 'still-current'))).toMatchObject(originalHandler);
        if (next.status !== 'observed') throw Error(next.issue.code);
        expect(next.observation).toMatchObject({ source: first.source, views: first.views, refs: first.refs, tools: first.tools });
        expect(client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
        expect(await client.invoke(request(next.observation, 'inspect', { value: 'item_a.data' }, 'new-observation'))).toMatchObject(originalHandler);

        const switching = client.invoke(request(next.observation, 'grow', { closeFirst: true }, 'close-then-open'));
        await expect.poll(async () => {
            const closed = await client.preview();
            return closed.status === 'previewed' ? closed.views.map(view => view.id) : closed.issue.code;
        }, { timeout: 5_000 }).toEqual([]);
        expect((await observe(client)).views).toEqual([]);
        await writeFile(gate, '');
        expect(await switching).toMatchObject({
            receipt: { outcome: { status: 'succeeded', value: { data: { closedEpoch: 2, openedEpoch: 3 } } } },
        });
        const second = await observe(client);
        expect(second.source.instanceId).toBe(first.source.instanceId);
        expect(second.views.map(view => view.id)).toEqual(['item_b']);
        expect(body(second, 'item_b')).toHaveLength(400 * 1024);
    } finally {
        await writeFile(gate, '');
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
        expect(open).not.toHaveBeenCalled();
    }
}, 15_000);

it('lists registered pending Apps while hiding a Worker whose first install is still in progress', async () => {
    const name = 'install_visibility', log = join(consumer, name + '.trace'), release = log + '.release';
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[], async initialize({ publish }) {
    appendFileSync(${JSON.stringify(log)}, 'initializing');
    while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
    publish({ views: [] });
}});
`);
    const runtime = createRuntime();
    let installing: Promise<unknown> | undefined;
    try {
        const desktopId = await runtime.createDesktop(createDesktopId(name));
        const desktop = runtime.getDesktop(desktopId);
        const pending = await desktop.registerPendingApp({ appId: createAppId('registered'),
            name: 'registered', modulePath: join(folder, 'entry.mjs'), config: { projectPath: folder } });
        installing = desktop.installDynamicWorkerApp(join(folder, 'entry.mjs'), { appId: createAppId(name), name });
        await waitFor(log, 'initializing');
        const during = [{ appId: pending, name: 'registered', status: 'pending' }];
        const first = desktop.getInstalledApps();
        expect(first).toMatchObject(during);
        for (const key of ['appInstanceId', 'modulePath', 'config', 'toolsEnabled', 'installedAt']) {
            expect(first[0]).not.toHaveProperty(key);
        }
        Object.assign(first[0]!, { name: 'changed' });
        expect(desktop.getInstalledApps()).toMatchObject(during);
        await writeFile(release, '');
        await installing;
        expect(desktop.getInstalledApps()).toMatchObject([...during, {
            appId: name, name, status: 'running', appInstanceId: expect.any(String),
        }]);
    } finally {
        await writeFile(release, '');
        await installing?.catch(() => {});
        await runtime.beginShutdown().completion;
    }
}, 15_000);

it('routes one shared Tool to the observed instance and sends its real eligible IDs to the model', async () => {
    const name = 'page_receivers';
    const folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam, getToolCatalog } from '@aotui/sdk/app';
const Counter = defineViewType({ name:'Counter', tools:{
    add: { description:'Add to this counter', inputSchema:Type.Object({
        delta:Type.Optional(refParam('Count', Type.Integer())),
    }, {additionalProperties:false}) },
} });
const Root = defineViewType({ name:'Root', tools:{
    change: { description:'Change page membership or eligibility', inputSchema:Type.Object({
        mode:Type.Enum(['disable','enable','replace','close','reopen']),
    }, {additionalProperties:false}) },
} });
const Empty = defineViewType({name:'Empty',tools:{}});
const viewTypes = [Root, Counter, Empty];
export default createApp({ app_name:'page_receivers', viewTypes, initialize({publish}) {
    let enabled = true, open = true;
    const make = (id, initial) => {
        let count = initial;
        return createView(Counter, { id, kind:'state', name:'Counter <' + id + '>', render:() => ({
            body:'Count: ' + count + ' & current',
            refs:[ref('count',count,{refType:'Count'})],
            bindings:{add:{enabled:id === 'b' || enabled,execute(args) {
                if (Object.hasOwn(args,'view_id')) throw Error('Router field reached the handler');
                count += args.delta ?? 1;
                const {status, sourceEpoch} = commit();
                return {success:true,data:{status,sourceEpoch}};
            }}},
        })});
    };
    let a = make('a', 2);
    const b = make('b', 10);
    const empty = createView(Empty, {id:'empty',kind:'state',render:() => ({body:''})});
    const root = createView(Root,{id:'root',kind:'instruction',render:() => ({
        body:getToolCatalog(viewTypes).map(t => t.viewType + '.' + t.name).join('\\n'),
        bindings:{change:{ execute({mode}) {
            if (mode === 'disable') enabled = false;
            if (mode === 'enable') enabled = true;
            if (mode === 'replace') a = make('a', 100);
            if (mode === 'close') open = false;
            if (mode === 'reopen') open = true;
            const {status,sourceEpoch} = commit();
            return {success:true,data:{status,sourceEpoch}};
        }}},
    })});
    function commit() { return publish({ views: open ? [root,a,b,empty] : [root,b,empty] }); }
    commit();
}});
`);
    const runtime = createRuntime({});
    const registry = new AppRegistry();
    let source: SemanticAOTUIDrivenSource | undefined;
    let mock: ReturnType<typeof vi.spyOn> | undefined;
    let driver: import('@aotui/agent-driver-v2').AgentDriverV2 | undefined;
    try {
        const id = await runtime.createDesktop(createDesktopId(name)), desktop = runtime.getDesktop(id);
        await registry.registerTransient('local:' + folder);
        const [installed] = await registry.installAll(desktop);
        if (!installed || installed.status !== 'installed') throw Error(JSON.stringify(installed));
        const client = interaction(runtime, id, installed.appId);
        let first = await observe(client);
        const add = first.tools.find(tool => tool.name === 'add')!;
        expect(first.tools.filter(tool => tool.name === 'add')).toHaveLength(1);
        expect(add.eligibleViewIds).toBeUndefined();
        expect(first.views.every(view => !Object.hasOwn(view, 'toolBindings'))).toBe(true);
        expect(first.views.map(view => view.id)).toEqual(['root', 'a', 'b', 'empty']);
        const call = (name: string, view_id: string, serial: string, args = {}) =>
            client.invoke(request(first, name, { view_id, ...args }, serial));
        const entered = { kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } };
        expect(await call('add','a','a-1')).toMatchObject({ receipt: { outcome: { status:'succeeded', value: {
            data: { status:'prepared', sourceEpoch: expect.any(Number) },
        } } } });
        expect(await call('add','b','a-1')).toMatchObject({ kind:'refused', code:'INVOCATION_ID_CONFLICT' });
        expect(await call('add','b','b-1',{delta:'a.count'})).toMatchObject(entered);
        const preview = await client.preview();
        if (preview.status !== 'previewed') throw Error('Expected preview');
        expect(preview.views.find(view => view.id === 'a')?.content.value).toBe('Count: 3 & current');
        expect(preview.views.find(view => view.id === 'b')?.content.value).toBe('Count: 12 & current');
        for (const view_id of ['', 'a.count', 'root', 'elsewhere']) {
            expect(await call('add',view_id,'bad-' + view_id)).toMatchObject({ receipt: {
                executionPhase:'not-dispatched', outcome:{ status:'rejected', path:'$.view_id' },
            } });
        }
        expect(await client.invoke({ invocationId:'missing',observationId:first.observationId,toolId:add.id,input:{} }))
            .toMatchObject({ receipt:{ outcome:{ code:'TOOL_INVALID_ARGS',path:'$.view_id' } } });
        expect(await call('change','root','disable',{mode:'disable'})).toMatchObject(entered);
        await client.preview();
        expect(await call('add','a','disabled')).toMatchObject({receipt:{outcome:{code:'TOOL_SOURCE_STALE'}}});
        expect(await call('add','b','still-eligible')).toMatchObject(entered);
        expect(await call('change','root','enable',{mode:'enable'})).toMatchObject(entered);
        await client.preview();
        expect(await call('add','a','old-activation')).toMatchObject({receipt:{outcome:{code:'TOOL_SOURCE_STALE'}}});
        first = await observe(client);
        const oldA = first.views.find(view => view.id === 'a')!.viewInstanceId;
        expect(await call('change','root','replace',{mode:'replace'})).toMatchObject(entered);
        await client.preview();
        expect(await call('add','a','old-mount')).toMatchObject({receipt:{outcome:{code:'VIEW_INSTANCE_REVOKED'}}});
        expect(await call('add','b','old-ref',{delta:'a.count'})).toMatchObject({receipt:{outcome:{code:'REF_VIEW_UNAVAILABLE'}}});
        first = await observe(client);
        expect(first.views.find(view => view.id === 'a')?.viewInstanceId).not.toBe(oldA);
        expect(await call('change','root','disable-again',{mode:'disable'})).toMatchObject(entered);
        first = await observe(client);
        expect(first.tools.find(tool => tool.name === 'add')?.eligibleViewIds).toEqual(['b']);

        const { AgentDriverV2 } = await import('@aotui/agent-driver-v2');
        const { LLMClient } = await import('@aotui/agent-driver-v2/dist/core/llm-client.js');
        const sent: Array<{ prompt: unknown; tools: unknown }> = [];
        mock = vi.spyOn(LLMClient.prototype as unknown as { createProvider(): unknown }, 'createProvider')
            .mockReturnValue({
                specificationVersion:'v3', provider:'test', modelId:'local', supportedUrls:{},
                async doStream(input: typeof sent[number]) {
                    sent.push(input);
                    return { stream:new ReadableStream({ start(controller) {
                        controller.enqueue({type:'stream-start',warnings:[]});
                        controller.enqueue({type:'finish',finishReason:{unified:'stop',raw:'stop'},
                            usage:{inputTokens:{total:1},outputTokens:{total:1}}});
                        controller.close();
                    } }) };
                },
            });
        source = new SemanticAOTUIDrivenSource(desktop, runtime, {includeInstruction:false});
        let limit = 1500;
        const errors = vi.fn();
        driver = new AgentDriverV2({llm:{model:'local',provider:{id:'openai'},apiKey:'unused',
            inputBudget:() => ({contextWindow:limit,maxOutputTokens:1000})},sources:[source],onRunError:errors});
        const run = async () => { await driver!.trigger(); await (driver as any).runInFlight; };
        await run();
        expect(sent).toHaveLength(0);
        expect(errors).toHaveBeenCalledWith(expect.objectContaining({code:'MODEL_INPUT_BUDGET_EXCEEDED'}));
        // The failed request never adopted its candidate, so the previous observation still works.
        expect(await call('add','b','after-budget-failure')).toMatchObject(entered);
        limit = 64_000;
        await run();
        expect(sent).toHaveLength(1);
        const model = sent[0]!;
        const prompt = JSON.stringify(model.prompt);
        for (const id of ['root','a','b','empty']) expect(prompt).toContain('id=\\"' + id + '\\"');
        expect(prompt).toContain('Counter &lt;a&gt;');
        expect(prompt).toContain('Counter.add');
        expect(prompt).not.toContain('toolBindings');
        expect(model.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({name:name + '-add',inputSchema:expect.objectContaining({
                required:['view_id'], properties:expect.objectContaining({
                    view_id:expect.objectContaining({type:'string',enum:['b']}),
                    delta:expect.objectContaining({description:expect.stringContaining('view_id.ref_id')}),
                }),
            })}),
            expect.objectContaining({name:'system-open_app',inputSchema:expect.not.objectContaining({
                required:expect.arrayContaining(['view_id']),
            })}),
        ]));
    } finally {
        driver?.stop(); driver?.dispose(); mock?.mockRestore(); source?.dispose();
        expect(await runtime.beginShutdown().completion).toMatchObject({ok:true,resourcesReleased:true,workers:{report:{total:0}}});
    }
}, 15_000);

it('keeps aliases from all registered ViewTypes through real Worker observations and Source calls', async () => {
    const name = 'alias_selection';
    const folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const closed = { additionalProperties: false };
const NumberType = defineViewType({ name: 'Numbers', tools: {
    set: { description: 'Set one number', inputSchema: Type.Object({ amount: Type.Integer() }, closed) },
    increment: { description: 'Increase one number' },
} });
const TextType = defineViewType({ name: 'Text', tools: {
    set: { description: 'Set the text', inputSchema: Type.Object({ label: Type.String() }, closed) },
} });
const RootType = defineViewType({ name: 'Root', tools: {
    set_mode: { description: 'Change the text page state', inputSchema: Type.Object({ mode: Type.Enum(['open', 'disabled', 'closed']) }, closed) },
} });
export default createApp({ app_name: 'alias_selection', viewTypes: [RootType, NumberType, TextType], initialize({ publish }) {
    let mode = 'closed', label = 'Original';
    const finish = view => {
        publish({ views: mode === 'closed' ? [root, a, another] : [root, a, another, text] });
        return { success: true, data: { view } };
    };
    const numberView = (id, value) => createView(NumberType, { id, kind: 'state', render: () => ({
        body: 'Number: ' + value,
        bindings: {
            set: { execute({ amount }) { value = amount; return finish(id); } },
            increment: { execute() { value++; return finish(id); } },
        },
    }) });
    const a = numberView('a', 0), another = numberView('another', 10);
    const text = createView(TextType, { id: 'text', kind: 'state', render: () => ({
        body: 'Text: ' + label,
        bindings: { set: { enabled: mode === 'open', execute(input) { label = input.label; return finish('text'); } } },
    }) });
    const root = createView(RootType, { id: 'root', kind: 'instruction', render: () => ({
        body: 'Change the text page state.',
        bindings: { set_mode: { execute(input) { mode = input.mode; return finish('root'); } } },
    }) });
    finish('root');
} });
`);
    const runtime = createRuntime({});
    const registry = new AppRegistry();
    let source: SemanticAOTUIDrivenSource | undefined;
    let current: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>> | undefined;
    let grantText = true;
    const policy: AppInteractionPolicy = {
        project: ({ source }) => ({ refs: [], toolIds: Object.values(source.tools)
            .filter(tool => grantText || tool.viewType !== 'Text').map(tool => tool.id) }),
        authorize: () => true, canReadReceipt: () => true,
    };
    const setNumber = name + '-Numbers-set', setText = name + '-Text-set';
    const increment = name + '-increment';
    try {
        const id = await runtime.createDesktop(createDesktopId(name)), desktop = runtime.getDesktop(id);
        await registry.registerTransient('local:' + folder);
        const [installed] = await registry.installAll(desktop);
        if (installed?.status !== 'installed') throw Error(JSON.stringify(installed));
        const client = interaction(runtime, id, installed.appId, policy);
        const initial = await frame(client);
        if (initial.status !== 'observed') throw Error(JSON.stringify(initial.issue));
        expect(initial.observation.views.map(view => view.id)).toEqual(['root', 'a', 'another']);
        expect(initial.observation.tools.filter(tool => tool.name === 'set')).toMatchObject([
            { id: JSON.stringify([installed.appId, 'Numbers', 'set']), nameSharedAcrossViewTypes: true },
        ]);
        expect(initial.observation.tools.find(tool => tool.name === 'increment')?.nameSharedAcrossViewTypes).toBe(false);
        client.releaseObservation(initial.observation.observationId);

        source = new SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: false, policy: () => policy });
        const refresh = async (names: string[]) => {
            await current?.release?.();
            current = await source!.getContext();
            await current.adopt!();
            expect(Object.keys(current.tools).filter(alias => alias.endsWith('-set')).sort(),
                current.messages.map(message => message.content).join('\n')).toEqual(names);
            return current;
        };
        const viewText = (id: string) => current!.messages.find(message => String(message.content).startsWith('<view id="' + id + '"'))?.content;
        const call = (tool: string, input: object, callId: string) => current!.executeTool!(tool, input, callId);
        const succeeded = (view: string) => ({ outcomeStatus: 'succeeded', result: { view } });

        const first = await refresh([setNumber]);
        expect(Object.keys(first.tools).filter(alias => alias.endsWith('-increment'))).toEqual([increment]);
        expect(first.tools[setNumber]?.inputSchema).toMatchObject({ jsonSchema: { required: ['view_id', 'amount'] } });
        expect(await call(increment, { view_id: 'a' }, 'increment-a')).toMatchObject(succeeded('a'));
        expect(await call(increment, { view_id: 'another' }, 'increment-another')).toMatchObject(succeeded('another'));
        await refresh([setNumber]);
        expect(viewText('a')).toContain('Number: 1\n');
        expect(viewText('another')).toContain('Number: 11\n');
        expect(await call(name + '-set_mode', { view_id: 'root', mode: 'open' }, 'open-text')).toMatchObject(succeeded('root'));

        const both = await refresh([setNumber, setText]);
        expect(both.tools[setText]?.inputSchema).toMatchObject({ jsonSchema: { required: ['view_id', 'label'] } });
        expect(JSON.stringify(both.tools)).not.toContain('nameSharedAcrossViewTypes');
        expect(await call(setNumber, { view_id: 'text', amount: 7 }, 'wrong-view')).toMatchObject({
            outcomeStatus: 'rejected', error: { code: 'TOOL_UNAVAILABLE' },
        });
        expect(await call(setNumber, { view_id: 'a', amount: 7 }, 'set-number')).toMatchObject(succeeded('a'));
        expect(await call(setText, { view_id: 'text', label: 'Changed' }, 'set-text')).toMatchObject(succeeded('text'));
        await refresh([setNumber, setText]);
        expect(viewText('a')).toContain('Number: 7\n');
        expect(viewText('another')).toContain('Number: 11\n');
        expect(viewText('text')).toContain('Text: Changed');

        grantText = false;
        await refresh([setNumber]);
        expect(viewText('text')).toContain('Text: Changed');
        grantText = true;
        await refresh([setNumber, setText]);
        expect(await call(name + '-set_mode', { view_id: 'root', mode: 'disabled' }, 'disable-text')).toMatchObject(succeeded('root'));
        await refresh([setNumber]);
        expect(viewText('text')).toContain('Text: Changed');
        expect(await call(name + '-set_mode', { view_id: 'root', mode: 'closed' }, 'close-text')).toMatchObject(succeeded('root'));
        await refresh([setNumber]);
        expect(viewText('text')).toBeUndefined();
        expect(await call(setNumber, { view_id: 'a', amount: 8 }, 'after-close')).toMatchObject(succeeded('a'));
    } finally {
        await current?.release?.(); source?.dispose();
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);
