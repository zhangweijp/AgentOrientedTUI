import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AppRegistry, createAppId, createDesktopId, createRuntime } from '@aotui/runtime';
import type { JsonValue, Observation, AppInteraction } from '@aotui/runtime/core';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../..');
const adapters = ['plain', 'preact'] as const;
let consumer: string;

beforeAll(async () => {
    consumer = await mkdtemp(join(tmpdir(), 'aotui-p2a-consumer-'));
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
    for (const file of ['work-items.ts', 'work-items-plain.ts', 'work-items-preact.tsx']) {
        await cp(join(repository, 'sdk/docs/examples', file), join(consumer, file));
    }
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(consumer, 'type-contract.ts'), `
import { createApp, type ArgsOf } from '@aotui/sdk/app';
import { tools } from './work-items.js';
function check(args: ArgsOf<typeof tools.inspect>, count: ArgsOf<typeof tools.count>) {
    const n: number = count.selected;
    const value = args.selected;
    if (value === null) return n;
    // @ts-expect-error Ref resolution passes a readonly value
    args.selected = false;
    // @ts-expect-error Integer Ref handler receives a number
    const text: string = count.selected;
    // @ts-expect-error Optional string is not nullable
    const invalid: ArgsOf<typeof tools.inspect> = { selected: null, text: null };
    // @ts-expect-error Literal and nested array values preserve their inferred types
    const unsupported: ArgsOf<typeof tools.update> = { operation: 'null', options: { mode: 'other', numbers: [false] } };
    return { text, invalid, unsupported };
}
createApp({ app_name: 'type_test', tools, initialize({ publish }) {
    // @ts-expect-error The declared ToolSet requires its complete bindings
    publish({ views: [] });
}});
`);
    for (const adapter of adapters) {
        if (adapter === 'preact') await symlink(join(repository, 'sdk/node_modules/preact'), join(consumer, 'node_modules/preact'), 'dir');
        const plain = adapter === 'plain';
        const config = join(consumer, 'tsconfig-' + adapter + '.json');
        await writeFile(config, JSON.stringify({
            compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, exactOptionalPropertyTypes: true,
                skipLibCheck: false, lib: plain ? ['ES2022'] : ['ES2022', 'DOM'], types: [],
                outDir: 'dist', ...(!plain && { jsx: 'react-jsx', jsxImportSource: 'preact' }) },
            files: ['work-items.ts', plain ? 'work-items-plain.ts' : 'work-items-preact.tsx', 'type-contract.ts'],
        }));
        await execute(process.execPath, [join(repository, 'sdk/node_modules/@typescript/native/bin/tsc'), '-p', config, '--pretty', 'false']);
    }
    const shared = join(consumer, 'dist/work-items.js');
    const emitted = await readFile(shared, 'utf8');
    expect(emitted).toContain('@aotui/sdk/app');
    await writeFile(shared, emitted.replace('@aotui/sdk/app', '@aotui/sdk-copy/app'));
}, 20_000);

afterAll(async () => { if (consumer) await rm(consumer, { recursive: true, force: true }); });

function interaction(runtime: ReturnType<typeof createRuntime>, desktopId: ReturnType<typeof createDesktopId>, appId: string) {
    const app = runtime.getDesktop(desktopId).getInstalledApps().find(item => item.appId === appId);
    if (!app?.appInstanceId) throw Error('Missing installed App instance ' + appId);
    const access = runtime.getAppInteraction(desktopId, appId, app.appInstanceId);
    if (access.status !== 'ready') throw Error(JSON.stringify(access.issue));
    return access.interaction;
}

async function appFolder(name: string, code: string) {
    const folder = join(consumer, name);
    await mkdir(folder);
    await writeFile(join(folder, 'entry.mjs'), code);
    await writeFile(join(folder, 'aoapp.json'), JSON.stringify({
        app_name: name, version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v4',
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
    const binding = observation.bindings.find(item => item.toolId === tool?.id);
    if (!binding) throw Error('Missing observed tool ' + name);
    return { invocationId, observationId: observation.observationId, bindingId: binding.bindingId, input };
}

it.each(adapters)('loads and exercises the published %s SDK App through manifest and fresh Worker', async adapter => {
    const name = 'work_' + adapter;
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
        const originalView = current.views.find(view => view.id === 'item_a')!.viewInstanceId;
        const call = (tool: string, input: Readonly<Record<string, JsonValue>>) => client.invoke(request(current, tool, input, 'work-' + ++serial));
        const success = (reply: Awaited<ReturnType<typeof call>>) => {
            expect(reply).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true } } } });
            expect(JSON.stringify(reply)).not.toContain('Inspections:');
        };
        expect(current.views.filter(view => view.type === 'Item')).toHaveLength(2);
        expect(current.tools.filter(tool => tool.name === 'inspect')).toHaveLength(1);
        expect(body(current, 'item_a')).toContain('[Selected \\[work\\] \\\\ item](Data:selected)');
        expect(current.refs.filter(ref => ref.viewId === 'item_a').map(ref => ref.refId)).toEqual(expect.arrayContaining(['items', 'items[0]', 'items[4]']));

        success(await call('inspect', { selected: 'item_a.selected', text: '$value view.items[0]', elements: ['item_a.items[0]', 'item_a.items[1]', 'item_a.items[2]'] }));
        current = await observe(client);
        expect(body(current)).toContain('{"selected":null,"elements":[0,false,""],"text":"$value view.items[0]","readonly":true}');
        for (const [selected, value] of [['item_b.selected', 'false'], ['item_a.items[2]', '""'], ['item_a.items[3]', 'null'],
            ['item_a.items[4]', '{"nested":[1,[false]]}'], ['item_a.items', '[0,false,"",null,{"nested":[1,[false]]}]']]) {
            success(await call('inspect', { selected: selected! }));
            current = await observe(client);
            expect(body(current)).toContain('"selected":' + value);
            expect(body(current)).not.toContain('"text":');
        }
        expect(await call('count', { selected: 'item_b.selected' })).toMatchObject({ receipt: { executionPhase: 'not-dispatched',
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
            const inspectName = name + '-Item-inspect';
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
            expect(await model.executeTool(name + '-Workspace-update', { operation: 'reset', options: { mode: 'keep', numbers: [1, '2'] } }, 'model-error'))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_INVALID_ARGS', message: expect.stringContaining('$.options.numbers[1]') } });
        } finally { await model.release(); }

        // Use a current binding to update, then read the original captured value
        // until this consumer explicitly adopts the new Observation.
        current = await observe(client);
        const reset = request(current, 'update', { operation: 'reset', options: { mode: 'keep', numbers: [1, null] } }, 'reset');
        success(await client.invoke(reset)); success(await client.invoke(reset));
        success(await call('inspect', { selected: 'item_a.selected' }));
        current = await observe(client);
        expect(body(current)).toContain('"selected":null');
        success(await call('count', { selected: 'item_a.selected' }));
        success(await call('update', { operation: 'null' })); current = await observe(client);
        success(await call('inspect', { selected: 'item_a.selected' })); current = await observe(client);
        expect(body(current)).toContain('"selected":null');
        success(await call('update', { operation: 'reset' })); current = await observe(client);
        success(await call('count', { selected: 'item_a.selected' }));

        for (const [operation, issue] of [
            ['invalid', { code: 'SNAPSHOT_INVALID', path: 'Ref item_a.selected $', message: 'Value does not match any declared alternative.' }],
            ['oversized', { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[0].content.value', message: 'Serialized byte budget exceeded' }],
        ] as const) {
            const lastGood = current;
            success(await call('update', { operation }));
            await waitFor(traceFile, 'repair-pending:' + operation);
            expect(await frame(client)).toEqual({ status: 'rejected', issue });
            if (adapter === 'plain') expect(await trace(traceFile)).toContain(issue.code + ':' + issue.path);
            const degraded = await source.getContext();
            try {
                const text = degraded.messages.map(message => String(message.content)).join('\n');
                expect(text).toContain(`Semantic status: ${issue.code}: ${issue.message} (at ${issue.path})`);
                expect(degraded.tools[name + '-Item-inspect']).toBeUndefined();
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
        expect(current.refs.some(ref => ref.viewId === 'item_a' && ref.refId === 'items[3]')).toBe(false);
        success(await call('inspect', { selected: 'item_a.items[0]' })); current = await observe(client);
        expect(body(current)).toContain('"selected":{"nested":[1,[false]]}');
        success(await call('update', { operation: 'empty' })); current = await observe(client);
        success(await call('inspect', { selected: 'item_a.items' })); current = await observe(client);
        expect(body(current)).toContain('"selected":[]');

        const stale = request(current, 'inspect', { selected: 'item_a.selected' }, 'stale');
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
        expect(body(current, 'item_a')).toBeUndefined();
        expect(current.tools.some(tool => tool.name === 'inspect')).toBe(true);
        success(await call('update', { operation: 'open' })); current = await observe(client);
        expect(current.views.find(view => view.id === 'item_a')?.viewInstanceId).not.toBe(originalView);
        expect(await client.invoke(stale)).not.toMatchObject({ receipt: { outcome: { status: 'succeeded' } } });

        const held = request(current, 'update', { operation: 'wait' }, 'held');
        const waiting = client.invoke(held, 1_000);
        await waitFor(traceFile, 'handler-entered');
        const receipt = await waiting;
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'unknown' } } });
        expect(await client.invoke(held, 100)).toMatchObject({
            kind: 'receipt', receipt: { invocationId: held.invocationId, observationId: held.observationId,
                bindingId: held.bindingId, executionPhase: 'unknown', outcome: { status: 'unknown' } },
        });
        expect(await call('count', { selected: 'item_a.selected' })).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        expect((await trace(traceFile)).filter(line => line === 'handler-entered')).toHaveLength(1);
        const prior = current;
        current = await observe(client);
        await writeFile(gate('work'), '');
        const terminal = await client.readReceipt(held);
        success(terminal);
        expect(await client.invoke(request(prior, 'count', { selected: 'item_a.selected' }, 'old-unseen'))).toMatchObject({
            kind: 'refused', code: 'OBSERVATION_UNAVAILABLE',
        });
        expect(terminal).toMatchObject({ receipt: { invocationId: held.invocationId, executionPhase: 'entered-returned' } });
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
const tool = one.defineViewTypeTool({ viewType:'View', name:'sample', description:'Sample', inputSchema:Type.Object({ n: Type.Integer() }) });
const set = one.defineToolSet({ tool });
assert.deepEqual(two.getToolCatalog(set), one.getToolCatalog(two.defineToolSet({ tool })));
const witness = Object.getOwnPropertySymbols(tool)[0];
const fake = { ...tool, inputSchema: { type:'object', properties:{ v:{ type:'string', format:'unknown' } } } };
Object.defineProperty(fake, witness, Object.getOwnPropertyDescriptor(tool, witness));
assert.throws(() => two.defineToolSet({ fake: Object.freeze(fake) }), { code:'TOOL_SCHEMA_UNSUPPORTED', path:'$.properties.v.format' });
const legacy = { ...tool };
Object.defineProperty(legacy, witness, { value:'other-version' });
assert.throws(() => two.defineToolSet({ legacy: Object.freeze(legacy) }), { code:'TOOL_SET_INVALID' });
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
export default createApp({ app_name: ${JSON.stringify(name)}, async initialize({ signal, registerCleanup, publish }) {
    await prepare(signal);
    registerCleanup({ stop, close });
    try { publish({ views: [] }); } catch (error) { trace(error.code); throw error; }
} });` : `
import { createTUIApp, useAppLifecycle } from '@aotui/sdk';
const factory = createTUIApp({ app_name: ${JSON.stringify(name)}, component: () => {
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
import { createApp, defineViewTypeTool } from '@aotui/sdk/app';
defineViewTypeTool({ viewType: 'Workspace', name: 'bad', description: 'Invalid declaration',
    inputSchema: Type.Object({ nested: Type.Object({ entry: Type.String({ format: 'email' }) }) }) });
export default createApp({ app_name: ${JSON.stringify(name)}, initialize({ publish }) { publish({ views: [] }); } });
`);
    const healthy = await appFolder('healthy_schema', `
import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: 'healthy_schema', initialize({ publish }) {
    publish({ views: [{ id:'workspace', type:'Workspace', kind:'state', body:'Healthy' }] });
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
        code: 'TOOL_BINDING_INVALID', path: '$.bindings', message: 'bindings must contain exactly one entry for every ToolSet key',
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
import { createApp, defineToolSet, defineViewTypeTool, ref } from '@aotui/sdk/app';
const tool = name => defineViewTypeTool({ viewType:'Workspace', name, description:'Test publication', inputSchema:Type.Object({}) });
const tools = defineToolSet({ change: tool('change'), inspect: tool('inspect') });
export default createApp({ app_name:${JSON.stringify(name)}, tools, initialize({ publish, signal }) {
    const workspace = { id:'workspace', type:'Workspace', kind:'state', body:'Committed diagnostic workspace',
        refs:[ref('selected', 'last good', { schema:Type.String() })] };
    const bindings = { inspect: { execute: () => ({ success:true }) }, change: { execute() {
        const candidate = { ...workspace, body:'Rejected diagnostic candidate' };
        if (${JSON.stringify(fault)} === 'schema') candidate.refs = [ref('selected', { value:'item' }, {
            schema:Type.Object({ value:Type.String({ format:'uuid' }) }),
        })];
        try {
            publish({ views:[candidate], bindings: ${fault === 'bindings' ? '{ change:bindings.change }' : 'bindings'} });
        } catch (error) {
            appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name:error.name, code:error.code, path:error.path, message:error.message }) + '\\n');
            void (async () => {
                while (!signal.aborted && !existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
                if (!signal.aborted) publish({ views:[workspace], bindings });
            })();
            return { success:true };
        }
        throw Error('Invalid frame committed');
    } } };
    publish({ views:[workspace], bindings });
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
            expect(degraded.tools[name + '-Workspace-change']).toBeUndefined();
            expect(degraded.tools[sibling + '-Item-inspect']).toBeDefined();
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
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import Type from 'typebox';
import { createApp, defineToolSet, defineViewTypeTool, ref, refParam } from '@aotui/sdk/app';
const trace = value => appendFileSync(${JSON.stringify(log)}, value + '\\n');
const schema = Type.String();
const tools = defineToolSet({
    change: defineViewTypeTool({ viewType:'Workspace', name:'change', description:'Publish a frame',
        inputSchema:Type.Object({ operation:Type.Enum(['oversized', 'ref', 'close', 'open']) }) }),
    inspect: defineViewTypeTool({ viewType:'Item', name:'inspect', description:'Inspect selected item',
        inputSchema:Type.Object({ selected:refParam('Text', schema) }) }),
});
export default createApp({ app_name: ${JSON.stringify(name)}, tools, initialize({ publish }) {
    const workspace = { id:'workspace', type:'Workspace', kind:'state', body:'Workspace' };
    const item = { id:'item_a', type:'Item', kind:'state', body:'Item',
        refs:[ref('selected', 'committed', { refType:'Text', schema })] };
    const inspect = { execute({ selected }) { trace('entered:' + selected); return { success:true }; } };
    const bindings = { inspect, change: { execute({ operation }) {
        if (operation === 'close' || operation === 'open') {
            publish({ views: operation === 'close' ? [workspace] : [workspace, item], bindings });
            return { success:true };
        }
        const rejectedView = { id:'spill', type:'Other', kind:'state', body:'Replacement' };
        const candidate = operation === 'oversized'
            ? { ...rejectedView, body:'x'.repeat(513 * 1024) }
            : { ...rejectedView, refs:[ref('selected', 2, { refType:'Text', schema })] };
        try {
            publish({ views:[workspace, candidate], bindings: { ...bindings, inspect:{ ...inspect, enabled:false } } });
            throw Error('Invalid App frame committed');
        } catch (error) {
            if (!error.code) throw error;
            trace(error.code + ':' + error.path);
        }
        const repair = async () => {
            while (!existsSync(${JSON.stringify(log)} + '-' + operation)) await new Promise(resolve => setTimeout(resolve, 5));
            publish({ views:[workspace, item], bindings });
        };
        void repair();
        return { success:true };
    } } };
    publish({ views:[workspace, item], bindings });
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
        const activation = (observation: Observation) => observation.tools.find(tool => tool.name === 'inspect')?.execution.activationId;
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
                expect(activation(result.observation)).toBe(activation(before));
                return result.status;
            }).toBe('observed');
            expect(await inspect(operation + '-repaired')).toMatchObject(entered);
        }
        expect((await trace(log)).filter(line => line.startsWith('entered:'))).toEqual(['entered:committed', 'entered:committed']);

        expect(await client.invoke(request(before, 'change', { operation: 'close' }, 'close'))).toMatchObject(entered);
        const closed = await observe(client);
        expect(viewIdentity(closed)).toBeUndefined();
        expect(activation(closed)).toBeUndefined();
        expect(await client.invoke(request(closed, 'change', { operation: 'open' }, 'open'))).toMatchObject(entered);
        const reopened = await observe(client);
        expect(viewIdentity(reopened)).not.toBe(viewIdentity(before));
        expect(activation(reopened)).not.toBe(activation(before));
    } finally {
        await writeFile(log + '-oversized', '');
        await writeFile(log + '-ref', '');
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);

it('observes a 300 KiB View and carries one deep, large Ref to the real Worker without opening storage', async () => {
    const name = 'capacity_plain';
    const folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, defineToolSet, defineViewTypeTool, ref, refParam } from '@aotui/sdk/app';
const tools = defineToolSet({
    inspect: defineViewTypeTool({ viewType: 'Item', name: 'inspect', description: 'Inspect published data',
        inputSchema: Type.Object({ value: refParam('Data', Type.Unknown()) }, { additionalProperties: false }) }),
    grow: defineViewTypeTool({ viewType: 'Item', name: 'grow', description: 'Show another page',
        inputSchema: Type.Object({}, { additionalProperties: false }) }),
});
export default createApp({ app_name: ${JSON.stringify(name)}, tools, initialize({ publish }) {
    const size = 400 * 1024;
    let value = 'x'.repeat(size);
    for (let index = 0; index < 40; index++) value = [value];
    const first = { id: 'item_a', type: 'Item', kind: 'state', body: 'a'.repeat(300 * 1024),
        refs: [ref('data', value, { refType: 'Data' })] };
    const second = { id: 'item_b', type: 'Item', kind: 'state', body: 'b'.repeat(480 * 1024) };
    const bindings = {
        inspect: { execute({ value }) {
            let depth = 0;
            while (Array.isArray(value)) { value = value[0]; depth++; }
            return { success: true, data: { size: value.length, depth } };
        } },
        grow: { execute() { publish({ views: [first, second], bindings }); return { success: true }; } },
    };
    publish({ views: [first], bindings });
}});
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
        expect(String(body(first, 'item_a')).length).toBe(300 * 1024);
        expect(await client.invoke(request(first, 'inspect', { value: 'item_a.data' }, 'large-ref'))).toMatchObject({
            kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { size: 400 * 1024, depth: 40 } } } },
        });
        expect(await client.invoke(request(first, 'grow', {}, 'grow'))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(await frame(client)).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY', path: '$.observation' } });
        expect(await client.preview()).toMatchObject({ status: 'previewed', views: [expect.objectContaining({ id: 'item_a' }), expect.objectContaining({ id: 'item_b' })] });
        expect(await client.invoke(request(first, 'inspect', { value: 'item_a.data' }, 'still-current'))).toMatchObject({
            kind: 'receipt', receipt: { outcome: { status: 'succeeded' } },
        });
    } finally {
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
        expect(open).not.toHaveBeenCalled();
    }
}, 15_000);

it('serializes registered pending Apps while hiding a Worker whose first install is still in progress', async () => {
    const name = 'install_visibility', log = join(consumer, name + '.trace'), release = log + '.release';
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: ${JSON.stringify(name)}, async initialize({ publish }) {
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
        const pending = await desktop.registerPendingApp({ appId: createAppId('registered'), modulePath: join(folder, 'entry.mjs') });
        installing = desktop.installDynamicWorkerApp(join(folder, 'entry.mjs'), { appId: createAppId(name) });
        await waitFor(log, 'initializing');
        const during = [{ appId: pending, status: 'pending' }];
        expect(desktop.getInstalledApps()).toMatchObject(during);
        expect(runtime.serialize(desktopId).apps).toMatchObject(during);
        await writeFile(release, '');
        await installing;
        expect(runtime.serialize(desktopId).apps).toMatchObject([...during, { appId: name, status: 'running' }]);
    } finally {
        await writeFile(release, '');
        await installing?.catch(() => {});
        await runtime.beginShutdown().completion;
    }
}, 15_000);

it('runs the installed CLI with a custom manifest entry and previews the published View', async () => {
    const name = 'cli_manifest';
    const folder = await appFolder(name, `
import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: ${JSON.stringify(name)}, initialize({ publish }) {
    publish({ views: [{ id: 'current', type: 'Item', kind: 'state', body: 'View from the custom manifest entry' }] });
}});
`);
    const config = join(folder, 'registry.json'), preload = join(folder, 'cli-test-config.mjs');
    await writeFile(config, JSON.stringify({ version: 2, apps: { [name]: { source: 'local:' + folder, enabled: true, autoStart: false } } }));
    await writeFile(preload, `import { AppRegistry } from '@aotui/runtime';
AppRegistry.prototype.getDefaultConfigPath = () => ${JSON.stringify(config)};`);
    const cli = join(consumer, 'node_modules/@aotui/runtime/dist/cli.js');
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'run', name], {
        cwd: consumer, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finished = once(child, 'close');
    let output = '', errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    try {
        await expect.poll(() => output + errors, { timeout: 5_000 }).toContain('Runtime ready.');
        child.stdin.write('snapshot\n');
        await expect.poll(() => output, { timeout: 5_000 }).toContain('View from the custom manifest entry');
        expect(output).toContain('<view id="current"');
        child.stdin.end('exit\n');
        await expect(finished).resolves.toEqual([0, null]);
        expect(errors).toBe('');
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await finished;
    }
}, 15_000);
