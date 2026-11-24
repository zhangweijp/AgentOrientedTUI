import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readAppManifest, createDesktopId, createRuntime } from '@aotui/runtime';
import type { JsonValue, Observation, AppInteractionPolicy } from '@aotui/core';
import { appClient, singleAppHost } from '../fixtures/batch-two-support.mjs';

type AppInteraction = ReturnType<typeof singleAppHost>;
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { fixtureProvider } from '../fixtures/batch-two-support.mjs';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../..');
const adapters = ['plain', 'preact'] as const;
let consumer: string;

beforeAll(async () => {
    consumer = await realpath(await mkdtemp(join(tmpdir(), 'aotui-p2a-consumer-')));
    await mkdir(join(consumer, 'node_modules/@aotui'), { recursive: true });
    for (const name of ['core', 'sdk', 'runtime']) {
        const source = join(repository, name), installed = join(consumer, 'node_modules/@aotui', name);
        await mkdir(installed);
        await cp(join(source, 'package.json'), join(installed, 'package.json'));
        await cp(join(source, 'dist'), join(installed, 'dist'), { recursive: true });
    }
    // Load an actual second SDK copy with independent module state.
    await cp(join(consumer, 'node_modules/@aotui/sdk'), join(consumer, 'node_modules/@aotui/sdk-copy'), { recursive: true });
    for (const [owner, name] of [['sdk', 'typebox'], ['core', 'acorn'], ['sdk', 'linkedom']]) {
        await symlink(join(repository, owner, 'node_modules', name), join(consumer, 'node_modules', name), 'dir');
    }
    for (const file of ['work-items.ts', 'work-items-plain.ts', 'work-items-preact.tsx', 'file-app.tsx', 'file-tools.ts']) {
        await cp(join(repository, 'sdk/tests/fixtures', file), join(consumer, file));
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
createView(ItemType, { idPrefix:'missing', region: 'dynamic',
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

function interaction(runtime: ReturnType<typeof createRuntime>, desktopId: ReturnType<typeof createDesktopId>, appId: string) {
    return appClient(runtime.getDesktop(desktopId), appId).client;
}

async function appFolder(name: string, code: string) {
    const folder = join(consumer, name);
    await mkdir(folder);
    await writeFile(join(folder, 'entry.mjs'), code);
    await writeFile(join(folder, 'aoapp.json'), JSON.stringify({
        app_name: name, version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v7',
        appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './entry.mjs' },
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
    return client.observe();
}

async function observe(client: AppInteraction): Promise<Observation> {
    const result = await frame(client);
    if (result.status !== 'observed') throw Error(JSON.stringify(result.issue));
    expect(client.adopt(result.observation.observationId).status).toBe('adopted');
    return result.observation;
}

const body = (observation: Observation, id = 'workspace_1') => observation.views.find(view => view.id === id)?.content?.value;
function request(observation: Observation, name: string, input: Readonly<Record<string, JsonValue>>, invocationId: string) {
    const tool = observation.tools.find(item => item.name === name);
    if (!tool) throw Error('Missing observed tool ' + name);
    const view = observation.views.find(page => page.type === tool.viewType &&
        (tool.eligibleViewIds === undefined || tool.eligibleViewIds.includes(page.id)));
    if (!view) throw Error('Missing receiver ' + name);
    const { view_id: selected, ...business } = input;
    return { invocationId, observationId: observation.observationId, toolId: tool.id,
        ...(tool.multiplicity === 'multiple' ? { viewId: typeof selected === 'string' ? selected : view.id } : {}), input: business };
}

it.each(adapters)('loads and exercises the published %s SDK App through manifest and fresh Worker', async adapter => {
    const name = 'work_' + adapter;
    const selectedId = 'billing_export_2026_11_1', otherId = 'b_1';
    const address = '$ref.' + name + '.';
    const selectedRef = address + selectedId + '.selected', otherRef = address + otherId + '.selected';
    const itemRef = (index?: number) => address + selectedId + '.items' + (index === undefined ? '' : '[' + index + ']');
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
    const desktopId = createDesktopId(name);
    let source: SemanticAOTUIDrivenSource | undefined;
    try {
        await runtime.createDesktop(desktopId);
        const desktop = runtime.getDesktop(desktopId);
        expect(await desktop.registerPendingApp({ installationId: name, localPath: folder,
            config: { AOTUI_DATA_DIR: join(folder, 'data') } })).toBe(name);
        expect(await trace(traceFile)).toEqual([]);
        const appId = (await desktop.openApp(name)).appId;
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
        expect(body(current, selectedId)).toContain('[Selected \\[work\\] \\\\ item](protected selected: Data)');
        expect(current.refs.filter(ref => ref.viewId === selectedId).map(ref => ref.refId)).toEqual(expect.arrayContaining(['items', 'selected']));

        success(await call('inspect', { selected: selectedRef, text: '$$value view.items[0]', elements: [itemRef(0), itemRef(1), itemRef(2)] }));
        current = await observe(client);
        expect(body(current)).toContain('{"selected":null,"elements":[0,false,""],"text":"$$value view.items[0]","readonly":true}');
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

        source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
        const model = await source.getContext();
        try {
            await model.adopt();
            const inspectName = name + '-inspect';
            const modelSchema = (model.tools[inspectName]!.inputSchema as { jsonSchema: unknown }).jsonSchema;
            expect(modelSchema).toMatchObject({ properties: {
                selected: { type: 'string', description: expect.stringContaining('$ref.app_id.view_id.ref_id') },
                elements: { type: 'array', items: { type: 'string',
                    description: expect.stringContaining('$ref.app_id.view_id.ref_id') }, maxItems: 3 },
                'x-aotui-ref-value': { anyOf: expect.arrayContaining([expect.objectContaining({
                    properties: { 'x-aotui-parameter-contract': { const: 'business', type: 'string' } },
                    default: { 'x-aotui-parameter-contract': 'business' },
                })]) },
            } });
            expect(modelSchema).not.toHaveProperty('x-aotui-parameter-contract');
            expect(modelSchema).not.toHaveProperty('properties.selected.x-aotui-ref-value');
            expect(modelSchema).not.toHaveProperty('properties.elements.items.x-aotui-ref-kind');
            const updateSchema = (model.tools[name + '-update']!.inputSchema as {
                jsonSchema: { properties: { options: { anyOf: unknown[] } } };
            }).jsonSchema;
            expect(updateSchema.properties.options.anyOf[0]).toMatchObject({
                type: 'object', properties: { 'x-aotui-ref-kind': { const: 'business', type: 'string' } },
            });
            expect(await model.executeTool(name + '-update', { operation: 'reset' }, 'missing-model-receiver'))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_INVALID_ARGS', message: expect.stringContaining('$.view_id') } });
            expect(await model.executeTool(name + '-update', { view_id: 'workspace_1', operation: 'reset', options: { mode: 'keep', numbers: [1, '2'] } }, 'model-error'))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_INVALID_ARGS', message: expect.stringContaining('$.options.numbers[1]') } });
        } finally { await model.release(); }

        // Use a current binding to update, then read the original captured value
        // until this consumer explicitly adopts the new Observation.
        current = await observe(client);
        const reset = request(current, 'update', { operation: 'reset', options: { mode: 'keep', numbers: [1, null], 'x-aotui-ref-kind': 'business' } }, 'reset');
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
            ['invalid', { code: 'SNAPSHOT_INVALID', path: 'Ref billing_export_2026_11.selected $', message: 'Value does not match any declared alternative.' }],
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
                if (result.status === 'observed') client.release(result.observation.observationId);
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
        expect(current.views.some(view => view.id.startsWith('billing_export_2026_11'))).toBe(false);
        expect(current.tools.some(tool => tool.name === 'inspect')).toBe(true);
        success(await call('update', { operation: 'open' })); current = await observe(client);
        const reopenedId = 'billing_export_2026_11_3';
        const reopenedRef = address + reopenedId + '.selected';
        expect(current.views.find(view => view.id === reopenedId)?.viewInstanceId).not.toBe(originalView);
        expect(await client.invoke(stale)).not.toMatchObject({ receipt: { outcome: { status: 'succeeded' } } });

        const held = request(current, 'update', { operation: 'wait' }, 'held');
        const waiting = client.invoke(held, 1_000);
        await waitFor(traceFile, 'handler-entered');
        const timedOut = {
            kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT',
            message: expect.stringMatching(/readReceipt.*observationId.*invocationId/),
            locator: { desktopId, appId, instanceId: current.source.instanceId,
                observationId: held.observationId, invocationId: held.invocationId },
        };
        expect(await waiting).toEqual(timedOut);
        expect(await client.invoke(held, 100)).toEqual(timedOut);
        expect(await call('count', { selected: reopenedRef })).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        expect((await trace(traceFile)).filter(line => line === 'handler-entered')).toHaveLength(1);
        const prior = current;
        current = await observe(client);
        await writeFile(gate('work'), '');
        const terminal = await client.readReceipt({ observationId: held.observationId, invocationId: held.invocationId });
        success(terminal);
        expect(await client.invoke(request(prior, 'count', { selected: reopenedRef }, 'old-unseen'))).toMatchObject({
            kind: 'refused', code: 'TURN_NOT_ACTIVE',
        });
        expect(terminal).toMatchObject({ receipt: { invocationId: held.invocationId, observationId: held.observationId,
            toolId: held.toolId, executionPhase: 'entered-returned' } });
        current = await observe(client);
        expect(body(current)).toContain('Prepared');
        const closing = desktop.getRunningApp(appId!, current.source.instanceId);
        if (closing.status !== 'ready') throw new Error(closing.issue.code);
        expect((await closing.app.beginClose().completion).ok).toBe(true);
        expect(await trace(traceFile)).toEqual(expect.arrayContaining(['stop', 'close']));
        await desktop.openApp(name);
        const fresh = interaction(runtime, desktopId, appId);
        const freshObservation = await observe(fresh);
        expect(freshObservation.source.instanceId).not.toBe(originalInstance);
        expect(await fresh.invoke(stale)).not.toMatchObject({ receipt: { outcome: { status: 'succeeded' } } });
        const workers = (await trace(traceFile)).filter(line => line.startsWith('thread:'));
        expect(new Set(workers).size).toBe(2);
        fresh.release(freshObservation.observationId);
        const reopened = await source.getContext();
        try {
            await reopened.adopt!();
            const inspectName = name + '-inspect';
            expect(await reopened.executeTool!('system-collapse_view', { app_id: appId, view_id: selectedId, note: 'Resume <selected>' }, 'fold-selected'))
                .toMatchObject({ outcomeStatus: 'succeeded' });
            expect(await reopened.executeTool!(inspectName, { view_id: selectedId, selected: selectedRef }, 'old-receiver'))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_UNAVAILABLE' } });
            const folded = await source.getContext();
            try {
                await folded.adopt!();
                expect(desktop.listApps()[0]?.status).toBe('running');
                const foldedPage = folded.messages.find(item => String(item.content).startsWith('<view view_id="' + selectedId + '"'));
                expect(String(foldedPage?.content)).toContain('Resume &lt;selected&gt;');
                expect(String(foldedPage?.content)).not.toContain('Available references');
                expect(Object.keys(folded.tools).filter(tool => tool === inspectName)).toHaveLength(1);
                expect(await folded.executeTool!(inspectName, { view_id: otherId, selected: selectedRef }, 'folded-ref'))
                    .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_NOT_VISIBLE' } });
                expect(await folded.executeTool!('system-expand_view', { app_id: appId, view_id: selectedId }, 'expand-selected'))
                    .toMatchObject({ outcomeStatus: 'succeeded' });
                expect(await folded.executeTool!(inspectName, { view_id: selectedId, selected: selectedRef }, 'not-restored-this-turn'))
                    .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_UNAVAILABLE' } });
            } finally { await folded.release?.(); }
        } finally { await reopened.release?.(); }
    } finally {
        await writeFile(gate('repair') + '-invalid', '');
        await writeFile(gate('repair') + '-oversized', '');
        await writeFile(gate('work'), '');
        await source?.dispose();
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true, workers: { report: { total: 0 } } });
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
const view = one.defineViewType()({ multiplicity: 'multiple', name:'View', tools:{ sample:{ description:'Sample',
    inputSchema:Type.Object({ n: Type.Integer() }), execute: () => ({ success:true }) } } });
const prepare = (api, viewType) => api.createApp({ app_name: 'registry_probe', viewTypes: [viewType], initialize() {} });
assert.doesNotThrow(() => prepare(two, view));
const witness = Object.getOwnPropertySymbols(view)[0];
const fake = { ...view, tools:{ sample:{ description:'Fake',
    inputSchema:{ type:'object', properties:{ v:{ type:'string', format:'unknown' } } } } } };
for (const symbol of Object.getOwnPropertySymbols(view))
    Object.defineProperty(fake, symbol, Object.getOwnPropertyDescriptor(view, symbol));
assert.throws(() => prepare(two, fake), { code:'TOOL_SCHEMA_UNSUPPORTED', path:'$.properties.v.format' });
const legacy = { ...view };
Object.defineProperty(legacy, witness, { value:'other-version' });
assert.throws(() => prepare(two, legacy), { code:'VIEW_TYPE_INVALID' });
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
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[], async initialize({ signal, registerCleanup, prepareProjection }) {
    await prepare(signal);
    registerCleanup({ stop, close });
    try { prepareProjection({ views: [] }); } catch (error) { trace(error.code); throw error; }
} });` : `
import { createTUIApp, useAppLifecycle } from '@aotui/sdk';
const factory = createTUIApp({ app_name: ${JSON.stringify(name)}, viewTypes: [], component: () => {
    useAppLifecycle({ stop, close }); return null;
} });
const initialize = factory.initialize;
factory.initialize = async context => { await prepare(context.signal); return initialize(context); };
export default factory;`}
`);
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 3_000 } });
    try {
        const desktopId = (await runtime.createDesktop(createDesktopId(name))).id, desktop = runtime.getDesktop(desktopId);
        const installationId = await desktop.registerPendingApp({ installationId: name, localPath: folder,
            config: { AOTUI_DATA_DIR: join(folder, 'data') } });
        const opening = desktop.openApp(installationId).then(() => 'opened', () => 'rejected');
        await waitFor(log, 'initializing');
        const closing = runtime.beginClose();
        await waitFor(log, 'stopping');
        expect(await closing.wait({ timeoutMs: 15 })).toMatchObject({ status: 'deadline',
            report: { resourcesReleased: false, workers: { report: { total: 1 } } } });
        expect(desktop.getRunningApp(name, 'closed').status).toBe('rejected');
        await writeFile(release, '');
        expect(await opening).toBe('rejected');
        expect(await closing.completion).toMatchObject({ resourcesReleased: true, workers: { report: { total: 0 } } });
        expect(await trace(log)).toEqual(['initializing', 'stopping', 'late:true', 'stop',
            ...(adapter === 'plain' ? ['PROJECTION_CLOSED'] : []), 'close']);
    } finally {
        await writeFile(release, '');
        await runtime.beginClose().completion;
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
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 2_000 } });
    try {
        const desktop = await runtime.createDesktop(createDesktopId(name));
        const installationId = await desktop.registerPendingApp({ installationId: name, localPath: folder,
            config: { AOTUI_DATA_DIR: join(folder, 'data') } });
        await desktop.openApp(installationId);
        const closing = runtime.beginClose();
        await waitFor(log, 'cleanup-entered');
        expect(await closing.wait({ timeoutMs: 15 })).toMatchObject({ status: 'deadline',
            report: { resourcesReleased: false, workers: { report: { total: 1 } } } });
        expect(await closing.completion).toMatchObject({ ok: false, resourcesReleased: true,
            appCleanup: { completedApps: 0 }, workers: { report: { total: 0 } } });
        expect(await trace(log)).toEqual(['cleanup-entered']);
    } finally { await runtime.beginClose().completion; }
}, 15_000);

it('keeps a real declaration error code and path across manifest loading and isolates the healthy App', async () => {
    const name = 'bad_schema', folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, defineViewType } from '@aotui/sdk/app';
defineViewType()({ multiplicity: 'multiple', name: 'Workspace', tools: { bad: { description: 'Invalid declaration',
    inputSchema: Type.Object({ nested: Type.Object({ entry: Type.String({ format: 'email' }) }) }),
    execute: () => ({ success: true }) } } });
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[], initialize({ prepareProjection }) { prepareProjection({ views: [] }); } });
`);
    const healthy = await appFolder('healthy_schema', `
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const Workspace = defineViewType({ multiplicity: 'multiple', name:'Workspace' });
export default createApp({ app_name: 'healthy_schema', viewTypes:[Workspace], initialize({ prepareProjection }) {
    prepareProjection({ views: [createView(Workspace, { idPrefix:'workspace', region: 'dynamic', render:() => ({body:'Healthy'}) })] });
} });
`);
    const runtime = createRuntime({ worker: { maxWorkers: 2, timeoutMs: 5_000 } });
    try {
        const desktopId = (await runtime.createDesktop(createDesktopId('schemas'))).id, desktop = runtime.getDesktop(desktopId);
        const data = { AOTUI_DATA_DIR: join(healthy, 'data') };
        const good = await desktop.registerPendingApp({ installationId: 'healthy_schema', localPath: healthy, config: data });
        const bad = await desktop.registerPendingApp({ installationId: name, localPath: folder, config: data });
        const appId = (await desktop.openApp(good)).appId;
        await expect(desktop.openApp(bad)).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'E_INIT_FAILED', cause: {
                code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.nested.properties.entry.format',
            } },
        });
        expect(desktop.listApps().map(app => [app.name, app.status])).toEqual([['healthy_schema', 'running'], [name, 'closed']]);
        const broken = await readAppManifest(folder);
        await expect(desktop.installDynamicWorkerApp(broken.modulePath, { name, installationId: 'direct_schema',
            config: { AOTUI_DATA_DIR: join(folder, 'data') } })).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'E_INIT_FAILED', cause: {
                code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.nested.properties.entry.format',
            } },
        });
        const client = interaction(runtime, desktopId, appId);
        expect(body(await observe(client))).toBe('Healthy');
    } finally { await runtime.beginClose().completion; }
}, 15_000);

it.each([
    { fault: 'context', errorName: 'TypeError', issue: {
        code: 'TOOL_BINDING_INVALID', path: 'View workspace.context', message: 'Supply the instance context object for this ViewType',
    } },
    { fault: 'schema', errorName: 'SnapshotDataError', issue: {
        code: 'TOOL_SCHEMA_UNSUPPORTED', path: 'Ref selected.schema.properties.value.format', message: 'Declaration uses unsupported tool parameter vocabulary.',
    } },
])('preserves a running App $fault diagnostic in observe and the Agent context', async ({ fault, errorName, issue }) => {
    const name = 'broken_' + fault, sibling = 'diagnostic_peer_' + fault;
    const log = join(consumer, name + '.trace'), gate = join(consumer, name + '.repair');
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref } from '@aotui/sdk/app';
const tool = {description:'Test publication', inputSchema:Type.Object({})};
const Workspace = defineViewType()({ multiplicity: 'multiple', name:'Workspace', tools:{
    change: { ...tool, execute: ({ context }) => context.change() },
    inspect: { ...tool, execute: () => ({ success:true }) },
} });
export default createApp({ app_name:${JSON.stringify(name)}, viewTypes:[Workspace], initialize({ prepareProjection, signal }) {
    let content = { body:'Committed diagnostic workspace',
        refs:[ref('selected', 'last good', { scope: 'protected', schema:Type.String() })] };
    function change() {
        const candidate = { ...content, body:'Rejected diagnostic candidate' };
        if (${JSON.stringify(fault)} === 'schema') candidate.refs = [ref('selected', { value:'item' }, { scope: 'protected',
            schema:Type.Object({ value:Type.String({ format:'uuid' }) }),
        })];
        const rejected = createView(Workspace, { idPrefix:'workspace', region: 'dynamic', render:() => ({
            ...candidate, context:${fault === 'context' ? 'undefined' : '{ change }'},
        }) });
        try {
            prepareProjection({ views:[rejected] });
        } catch (error) {
            appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name:error.name, code:error.code, path:error.path, message:error.message }) + '\\n');
            void (async () => {
                while (!signal.aborted && !existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
                if (!signal.aborted) prepareProjection({ views:[workspace] });
            })();
            return { success:true };
        }
        throw Error('Invalid frame committed');
    }
    const workspace = createView(Workspace, { idPrefix:'workspace', region: 'dynamic', render:() => ({ ...content, context: { change } }) });
    prepareProjection({ views:[workspace] });
} });
`);
    const healthy = await appFolder(sibling, `
import { workItemsApp } from '../dist/work-items-plain.js';
export default workItemsApp(${JSON.stringify(sibling)});
`);
    const runtime = createRuntime({ worker: { maxWorkers: 2, timeoutMs: 5_000 } });
    let source: SemanticAOTUIDrivenSource | undefined;
    try {
        const desktopId = (await runtime.createDesktop(createDesktopId(name))).id, desktop = runtime.getDesktop(desktopId);
        const config = { AOTUI_DATA_DIR: join(folder, 'data') };
        for (const localPath of [folder, healthy]) {
            const manifest = await readAppManifest(localPath);
            const installationId = await desktop.registerPendingApp({ installationId: manifest.metadata.app_name, localPath, config });
            await desktop.openApp(installationId);
        }
        expect(desktop.listApps().map(item => item.status)).toEqual(['running', 'running']);
        const client = interaction(runtime, desktopId, name);
        const before = await observe(client);
        expect(body(before)).toBe('Committed diagnostic workspace');
        expect(await client.invoke(request(before, 'change', {}, 'break-frame'))).toMatchObject({
            kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } },
        });
        expect((await trace(log)).map(line => JSON.parse(line))).toEqual([{
            name: errorName, code: issue.code, path: issue.path,
            message: fault === 'schema' ? issue.message : `${issue.code}: ${issue.message}`,
        }]);
        expect(await frame(client)).toEqual({ status: 'rejected', issue });

        source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
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
            if (result.status === 'observed') client.release(result.observation.observationId);
            return result.status;
        }, { timeout: 5_000 }).toBe('observed');
        const recovered = await observe(client);
        expect(recovered).toMatchObject({ source: before.source, views: before.views, refs: before.refs, tools: before.tools });
    } finally {
        await writeFile(gate, '');
        await source?.dispose();
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
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
const Workspace = defineViewType()({ multiplicity: 'multiple', name:'Workspace', tools:{
    change: {
        description:'Publish a frame', inputSchema:Type.Object({ operation:Type.Enum(['oversized', 'ref', 'marker', 'close', 'open', 'save']) }),
        execute: ({ input, context }) => context.change(input.operation),
    },
} });
const Item = defineViewType()({ multiplicity: 'multiple', name:'Item', tools:{
    inspect: {
        description:'Inspect selected item', inputSchema:Type.Object({selected:refParam('Text', schema)}),
        enabled: ({ canInspect }) => canInspect,
        execute({ input }) { trace('entered:' + input.selected); return { success:true }; },
    },
} });
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[Workspace, Item], initialize({ prepareProjection }) {
    let savedText = 'Item';
    const item = createView(Item, { idPrefix:'item_a', region: 'dynamic', render:() => ({ body:savedText,
        refs:[ref('selected', 'committed', { scope: 'protected', refType:'Text', schema })], context:{ canInspect:true },
    }) });
    const workspace = createView(Workspace, { idPrefix:'workspace', region: 'dynamic', render:() => ({
        body:'Workspace', context:{ change },
    }) });
    function change(operation) {
            if (operation === 'close' || operation === 'open') {
                prepareProjection({ views: operation === 'close' ? [workspace] : [workspace, item] });
                return { success:true };
            }
            if (operation === 'save') {
                const text = 'Saved business text';
                appendFileSync(${JSON.stringify(savedFile)}, text + '\\n');
                savedText = text;
            }
            const candidate = createView(Item, { idPrefix:'spill', region: 'dynamic',render:() => ({
                body: operation === 'ref' || operation === 'marker' ? 'Replacement' : 'x'.repeat((operation === 'save' ? 32 : 513) * 1024),
                refs: operation === 'marker' ? [ref('selected)', 'ambiguous', { scope: 'protected' })] :
                    operation === 'ref' ? [ref('selected', 2, { scope: 'protected', refType:'Text', schema })] : [],
                context: { canInspect:false },
            })});
            try {
                prepareProjection({ views:[workspace, candidate] });
                throw Error('Invalid App frame committed');
            } catch (error) {
                if (!error.code) throw error;
                trace(error.code + ':' + error.path);
            }
            const repair = async () => {
                while (!existsSync(${JSON.stringify(log)} + '-' + operation)) await new Promise(resolve => setTimeout(resolve, 5));
                prepareProjection({ views:[workspace, item] });
            };
            void repair();
            if (operation === 'save') return { success:true, data: { message:'File saved. View refresh failed.' } };
            return { success:true };
    }
    prepareProjection({ views:[workspace, item] });
} });
`);
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 5_000 } });
    try {
        const desktopId = (await runtime.createDesktop(createDesktopId(name))).id;
        const desktop = runtime.getDesktop(desktopId);
        const installationId = await desktop.registerPendingApp({ installationId: name, localPath: folder,
            config: { AOTUI_DATA_DIR: join(folder, 'data') },
            projectionLimits: { observation: { maxCanonicalBytes: 16 * 1024 } },
        });
        const client = interaction(runtime, desktopId, (await desktop.openApp(installationId)).appId);
        const before = await observe(client);
        const viewIdentity = (observation: Observation) => observation.views.find(view => view.id.startsWith('item_a_'))?.viewInstanceId;
        const entered = { kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } };

        for (const [operation, code, path] of [
            ['oversized', 'SNAPSHOT_SERIALIZATION_ERROR', '$.views[1].content.value'],
            ['ref', 'SNAPSHOT_INVALID', 'Ref spill.selected $'],
            ['marker', 'SNAPSHOT_INVALID', 'Ref selected)'],
        ] as const) {
            expect(await client.invoke(request(before, 'change', { operation }, operation))).toMatchObject(entered);
            expect(await trace(log)).toContain(code + ':' + path);
            expect(await frame(client)).toMatchObject({ status: 'rejected', issue: { code, path } });
            const inspect = (id: string) => client.invoke(request(before, 'inspect', { selected: '$ref.atomic_plain.item_a_1.selected' }, id));
            expect(await inspect(operation + '-degraded')).toMatchObject({ receipt: { outcome: { status: 'rejected' } } });
            await writeFile(log + '-' + operation, '');
            await expect.poll(async () => {
                const result = await frame(client);
                if (result.status === 'rejected') return result.status;
                client.release(result.observation.observationId);
                expect(result.observation.source.snapshotId).toBe(before.source.snapshotId);
                expect(viewIdentity(result.observation)).toBe(viewIdentity(before));
                return result.status;
            }).toBe('observed');
            expect(await inspect(operation + '-repaired')).toMatchObject(entered);
        }
        expect((await trace(log)).filter(line => line.startsWith('entered:'))).toEqual(Array(3).fill('entered:committed'));

        expect(await client.invoke(request(before, 'change', { operation: 'close' }, 'close'))).toMatchObject(entered);
        const closed = await observe(client);
        expect(viewIdentity(closed)).toBeUndefined();
        expect(closed.tools.some(tool => tool.name === 'inspect')).toBe(false);
        expect(await client.invoke(request(closed, 'change', { operation: 'open' }, 'open'))).toMatchObject(entered);
        const reopened = await observe(client);
        expect(viewIdentity(reopened)).not.toBe(viewIdentity(before));
        expect(reopened.views.some(view => view.id === 'item_a_2')).toBe(true);
        expect(reopened.tools.some(tool => tool.name === 'inspect')).toBe(true);

        const save = request(reopened, 'change', { operation: 'save' }, 'save-once');
        const result = await client.invoke(save);
        expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned',
            outcome: { status: 'succeeded', value: { success: true, data: { message: 'File saved. View refresh failed.' } } } } });
        expect(await readFile(savedFile, 'utf8')).toBe('Saved business text\n');
        const diagnostic = { status: 'rejected', issue: {
            code: 'OBSERVATION_CAPACITY', path: '$.observation',
        } };
        expect(await frame(client)).toMatchObject(diagnostic);
        expect(await client.preview()).toMatchObject(diagnostic);

        await writeFile(log + '-save', '');
        await expect.poll(async () => {
            const result = await frame(client);
            if (result.status === 'observed') client.release(result.observation.observationId);
            return result.status;
        }).toBe('observed');
        const repaired = await observe(client);
        expect(body(repaired, 'item_a_2')).toBe('Saved business text');
        expect(viewIdentity(repaired)).toBe(viewIdentity(reopened));
        expect(await client.readReceipt({ observationId: save.observationId, invocationId: save.invocationId })).toEqual(result);
        expect(await readFile(savedFile, 'utf8')).toBe('Saved business text\n');
    } finally {
        await writeFile(log + '-oversized', '');
        await writeFile(log + '-ref', '');
        await writeFile(log + '-marker', '');
        await writeFile(log + '-save', '');
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);

it.each(adapters)('enforces separate installed page and byte limits in %s while retaining the accepted page', async adapter => {
    const name = 'capacity_' + adapter;
    const gate = join(consumer, name + '-open-b');
    const lifecycle = join(consumer, name + '-lifecycle');
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam } from '@aotui/sdk/app';
${adapter === 'preact' ? `import { h } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { createTUIApp, useAppRuntimeContext, useDataRef, useState, DynamicView } from '@aotui/sdk';` : ''}
const Item = defineViewType()({ multiplicity: 'multiple', name:'Item', tools: {
    inspect: {
        description:'Inspect published data',
        inputSchema:Type.Object({ value:refParam('Data', Type.Object({})) }, {additionalProperties:false}),
        enabled: ({ canInspect }) => canInspect,
        execute({ input: { value }, context: { staging, projectionLimits } }) {
            if (staging) return { success: true, data: { staged: true } };
            let depth = 0;
            let current = value.nested;
            while (Array.isArray(current)) { current = current[0]; depth++; }
            const { maxViews, observation, metadata } = projectionLimits;
            const frozen = [projectionLimits, observation, metadata].every(Object.isFrozen);
            return { success: true, data: { size: current.length, depth, maxViews, bytes: observation.maxCanonicalBytes, frozen } };
        },
    },
    grow: {
        description:'Open another page, optionally closing this one first',
        inputSchema:Type.Object({ closeFirst:Type.Boolean(), asynchronous:Type.Optional(Type.Enum(['update', 'revert'])),
            rollback:Type.Optional(Type.Enum(['throw', 'different'])) }, {additionalProperties:false}),
        enabled: ({ canGrow }) => canGrow,
        execute: ({ input, context }) => context.grow(input),
    },
} });
const size = 20 * 1024;
let nested = 'x'.repeat(size);
for (let index = 0; index < 40; index++) nested = [nested];
const value = { nested };
const openingError = error => {
    if (error.code !== 'OBSERVATION_CAPACITY') throw error;
    return { success: false, error: { code: error.code, message: error.message, context: { path: error.path } } };
};
const waitForSwitch = async () => {
    while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
};
${adapter === 'plain' ? `
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[Item], initialize({ prepareProjection, prepareOpeningProjection, projectionLimits }) {
    let staging = false;
    async function grow({ closeFirst }) {
        if (closeFirst) {
            const closed = prepareProjection({ views: [] });
            await waitForSwitch();
            const opened = prepareOpeningProjection({ views: [second] });
            return { success: true, data: { closed: closed.status, opened: opened.status } };
        }
        staging = true;
        try {
            prepareOpeningProjection({ views: [first, second] });
            return { success: true };
        } catch (error) {
            return openingError(error);
        } finally { staging = false; }
    }
    const first = createView(Item, { idPrefix:'item_a', region: 'dynamic', render:() => ({ body:'a'.repeat(size),
        refs:[ref('data', value, { scope: 'protected', refType:'Data', schema:{type:'object'}})],
        context: { staging, grow, canInspect:true, canGrow:true, projectionLimits },
    }) });
    const second = createView(Item, { idPrefix:'item_b', region: 'dynamic', render:() => ({ body:'b'.repeat(size),
        context: { staging:false, grow, canInspect:false, canGrow:false },
    }) });
    prepareProjection({ views:[first] });
}});
` : `
const trace = entry => appendFileSync(${JSON.stringify(lifecycle)}, entry + '\\n');
function Details({ page, staging }) {
    useLayoutEffect(() => {
        trace('mount:' + page);
        return () => trace('unmount:' + page);
    }, [page]);
    useLayoutEffect(() => { if (staging) trace('candidate:' + page); }, [staging]);
    useDataRef('data', staging ? { nested: 'candidate only' } : value, { scope: 'protected', refType: 'Data', schema: { type: 'object' } });
    return (staging ? page.toUpperCase() : page).repeat(size);
}
function A({ controls, grow }) {
    const [state, setState] = useState('open');
    const { projectionLimits } = useAppRuntimeContext();
    controls.setA = setState;
    if (state === 'closed') return null;
    const staging = state === 'candidate';
    return h(DynamicView, { idPrefix: 'item_a', type: Item, context: { staging, grow, canInspect:true, canGrow:true, projectionLimits } },
        h(Details, { page: 'a', staging }));
}
function B({ controls, grow }) {
    const [opened, setOpened] = useState(false);
    controls.setB = setOpened;
    return opened ? h(DynamicView, { idPrefix: 'item_b', type: Item, context: { staging:false, grow, canInspect:false, canGrow:true } },
        h(Details, { page: 'b', staging: false })) : null;
}
function App() {
    const [controls] = useState(() => ({}));
    const { prepareProjection, prepareOpeningProjection } = useAppRuntimeContext();
    async function grow({ closeFirst, asynchronous, rollback }) {
        if (asynchronous) {
            const rejected = () => Promise.reject(new Error('Fixture callback rejection'));
            try {
                if (asynchronous === 'update') await prepareOpeningProjection(rejected, () => {});
                else await prepareOpeningProjection(() => controls.setA('open'), rejected);
                return { success: true };
            } catch (error) { return { success: false, error: { code: error.code, message: error.message } }; }
        }
        if (closeFirst) {
            const closed = await prepareProjection(() => controls.setA('closed'));
            await waitForSwitch();
            const opened = await prepareOpeningProjection(() => controls.setB(true), () => controls.setB(false));
            return { success: true, data: { closed: closed.status, opened: opened.status } };
        }
        try {
            await prepareOpeningProjection(() => { controls.setA('candidate'); controls.setB(true); },
                () => {
                    trace('revert:' + (rollback ?? 'normal'));
                    if (rollback === 'throw') throw Object.assign(new Error('The rollback callback failed'), {
                        code: 'ROLLBACK_CALLBACK_FAILED', path: '$.views.item_a',
                    });
                    if (rollback !== 'different') controls.setA('open');
                    controls.setB(false);
                });
            return { success: true };
        } catch (error) {
            if (!rollback || !(error instanceof AggregateError)) return openingError(error);
            return { success: false, error: { code: error.code, message: error.message }, data: {
                path: error.path, causes: error.errors.map(reason => ({ code: reason.code, path: reason.path, message: reason.message })),
            } };
        }
    }
    return [h(A, { key: 'a', controls, grow }), h(B, { key: 'b', controls, grow })];
}
export default createTUIApp({ app_name: ${JSON.stringify(name)}, component: App, viewTypes: [Item] });
`}
`);
    const open = vi.fn(async () => { throw Error('Non-persistent App accessed Host storage'); });
    const runtime = createRuntime({}, { storageBackend: { open } });
    try {
        const desktopId = (await runtime.createDesktop(createDesktopId(name))).id;
        const desktop = runtime.getDesktop(desktopId);
        const installationId = await desktop.registerPendingApp({ installationId: name, localPath: folder,
            projectionLimits: { maxViews: 1 },
            config: { AOTUI_DATA_DIR: join(folder, 'data'), projectionLimits: { maxViews: 256 } },
        });
        const client = interaction(runtime, desktopId, (await desktop.openApp(installationId)).appId);
        const first = await observe(client);
        expect(body(first, 'item_a_1')).toHaveLength(20 * 1024);
        const originalHandler = {
            kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: {
                size: 20 * 1024, depth: 40, maxViews: 1, frozen: true,
            } } } },
        };
        const itemAddress = '$ref.' + first.source.appId + '.item_a_1.data';
        expect(await client.invoke(request(first, 'inspect', { value: itemAddress }, 'large-ref'))).toMatchObject(originalHandler);
        const synchronousError = { receipt: { outcome: { status: 'failed', details: { result: { error: {
            code: 'SNAPSHOT_INVALID', message: expect.stringContaining('synchronous'),
        } } } } } };
        if (adapter === 'preact') {
            expect(await client.invoke(request(first, 'grow', { closeFirst: false, asynchronous: 'update' }, 'promise-update')))
                .toMatchObject(synchronousError);
            expect(await client.preview()).toMatchObject({ status: 'previewed', source: first.source });
        }
        const attempt = await client.invoke(request(first, 'grow', { closeFirst: false }, 'grow'));
        const preview = await client.preview(), next = await frame(client);
        expect({
            outcome: attempt.kind === 'receipt' ? attempt.receipt.outcome.status : attempt.code,
            preview: preview.status === 'previewed' ? preview.views.map(view => view.id) : preview.issue.code,
            observation: next.status === 'observed' ? next.observation.views.map(view => view.id) : next.issue.code,
        }).toEqual({ outcome: 'failed', preview: ['item_a_1'], observation: ['item_a_1'] });
        expect(attempt).toMatchObject({ receipt: { outcome: { details: { result: { error: {
            code: 'OBSERVATION_CAPACITY', message: expect.stringContaining('Close a View'), context: { path: '$.views' },
        } } } } } });
        expect(preview).toMatchObject({ source: first.source, views: first.views });
        if (adapter === 'preact') expect(await trace(lifecycle)).toEqual(['mount:a', 'candidate:a', 'mount:b', 'revert:normal', 'unmount:b']);
        expect(await client.invoke(request(first, 'inspect', { value: itemAddress }, 'still-current'))).toMatchObject(originalHandler);
        if (next.status !== 'observed') throw Error(next.issue.code);
        expect(next.observation).toMatchObject({ source: first.source, views: first.views, refs: first.refs, tools: first.tools });
        expect(client.adopt(next.observation.observationId)).toMatchObject({ status: 'adopted' });
        expect(await client.invoke(request(next.observation, 'inspect', { value: itemAddress }, 'new-observation'))).toMatchObject(originalHandler);

        const secondApp = (await desktop.installDynamicWorkerApp(join(folder, 'entry.mjs'), {
            installationId: 'byte_limited', projectionLimits: { maxViews: 2, observation: { maxApproxBytes: 32 * 1024, maxCanonicalBytes: 32 * 1024 } },
        })).appId;
        const bytes = interaction(runtime, desktopId, secondApp);
        const byteFrame = await observe(bytes);
        expect(await bytes.invoke(request(byteFrame, 'grow', { closeFirst: false }, 'open-over-byte-limit'))).toMatchObject({
            receipt: { outcome: { status: 'failed', details: { result: { error: {
                code: 'OBSERVATION_CAPACITY', context: { path: '$.observation' },
            } } } } },
        });
        expect(await bytes.preview()).toMatchObject({ status: 'previewed', source: byteFrame.source, views: byteFrame.views });
        const byteItemAddress = '$ref.' + byteFrame.source.appId + '.item_a_1.data';
        expect(await bytes.invoke(request(byteFrame, 'inspect', { value: byteItemAddress }, 'still-callable'))).toMatchObject({
            receipt: { outcome: { status: 'succeeded', value: { data: { maxViews: 2, bytes: 32 * 1024, frozen: true } } } },
        });

        const restart = await observe(client);
        const switching = client.invoke(request(restart, 'grow', { closeFirst: true }, 'close-then-open'));
        await expect.poll(async () => {
            const closed = await client.preview();
            return closed.status === 'previewed' ? closed.views.map(view => view.id) : closed.issue.code;
        }, { timeout: 5_000 }).toEqual([]);
        expect((await observe(client)).views).toEqual([]);
        await writeFile(gate, '');
        expect(await switching).toMatchObject({
            receipt: { outcome: { status: 'succeeded', value: { data: { closed: 'prepared', opened: 'prepared' } } } },
        });
        const second = await observe(client);
        expect(second.source.instanceId).toBe(first.source.instanceId);
        expect(second.views.map(view => view.id)).toEqual(['item_b_1']);
        expect(body(second, 'item_b_1')).toHaveLength(20 * 1024);
        if (adapter === 'preact') {
            expect(await client.invoke(request(second, 'grow', { closeFirst: false, asynchronous: 'revert' }, 'promise-revert')))
                .toMatchObject(synchronousError);
            expect(await client.preview()).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_INVALID',
                message: expect.stringContaining('synchronous') } });
            for (const [rollback, code, path, message] of [
                ['throw', 'ROLLBACK_CALLBACK_FAILED', '$.views.item_a', 'The rollback callback failed'],
                ['different', 'SNAPSHOT_INVALID', '$.views', 'did not restore the accepted projection'],
            ] as const) {
                const appId = (await desktop.installDynamicWorkerApp(join(folder, 'entry.mjs'), {
                    installationId: 'rollback_' + rollback, projectionLimits: { maxViews: 1 },
                })).appId;
                const failedRestore = interaction(runtime, desktopId, appId);
                const before = await observe(failedRestore);
                expect(await failedRestore.invoke(request(before, 'grow', { closeFirst: false, rollback }, 'rollback-' + rollback))).toMatchObject({
                    receipt: { executionPhase: 'entered-returned', outcome: { status: 'failed', details: { result: {
                        error: { code, message: expect.stringContaining(message) }, data: { path, causes: [
                            { code: 'OBSERVATION_CAPACITY', path: '$.views' }, { code, path, message: expect.stringContaining(message) },
                        ] },
                    } } } },
                });
                expect((await trace(lifecycle)).filter(line => line === 'revert:' + rollback)).toHaveLength(1);
                expect(await failedRestore.preview()).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_INVALID' } });
            }
        }
    } finally {
        await writeFile(gate, '');
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
        expect(open).not.toHaveBeenCalled();
    }
}, 15_000);

it('lists registered pending Apps while hiding a Worker whose first install is still in progress', async () => {
    const name = 'install_visibility', log = join(consumer, name + '.trace'), release = log + '.release';
    const folder = await appFolder(name, `
import { appendFileSync, existsSync } from 'node:fs';
import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: ${JSON.stringify(name)}, viewTypes:[], async initialize({ prepareProjection }) {
    appendFileSync(${JSON.stringify(log)}, 'initializing');
    while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
    prepareProjection({ views: [] });
}});
`);
    const runtime = createRuntime();
    let installing: Promise<unknown> | undefined;
    try {
        const desktopId = (await runtime.createDesktop(createDesktopId(name))).id;
        const desktop = runtime.getDesktop(desktopId);
        const pending = await desktop.registerPendingApp({ installationId: 'registered',
            localPath: join(folder, 'entry.mjs'), config: { projectPath: folder } });
        installing = desktop.installDynamicWorkerApp(join(folder, 'entry.mjs'), { installationId: name, name });
        await waitFor(log, 'initializing');
        const during = [{ installationId: pending, name, status: 'pending' }];
        const first = desktop.listApps();
        expect(first).toMatchObject(during);
        for (const key of ['appId', 'appInstanceId', 'modulePath', 'config', 'toolsEnabled', 'installedAt']) {
            expect(first[0]).not.toHaveProperty(key);
        }
        Object.assign(first[0]!, { name: 'changed' });
        expect(desktop.listApps()).toMatchObject(during);
        await writeFile(release, '');
        await installing;
        expect(desktop.listApps()).toMatchObject([...during, {
            appId: name, name, status: 'running', appInstanceId: expect.any(String),
        }]);
    } finally {
        await writeFile(release, '');
        await installing?.catch(() => {});
        await runtime.beginClose().completion;
    }
}, 15_000);

it('routes one shared Tool to the observed instance and keeps eligibility at Runtime while the model sees a stable receiver schema', async () => {
    const name = 'page_receivers';
    const folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam } from '@aotui/sdk/app';
const Counter = defineViewType()({ multiplicity: 'multiple', name:'Counter', tools:{
    add: {
        description:'Add to this counter',
        inputSchema:Type.Object({ delta:Type.Optional(refParam('Count', Type.Integer())) }, {additionalProperties:false}),
        enabled: ({ allowsAdd }) => allowsAdd,
        execute({ input, context }) {
            if (Object.hasOwn(input,'view_id')) throw Error('Router field reached the handler');
            return context.add(input.delta ?? 1);
        },
    },
} });
const Root = defineViewType()({ multiplicity: 'multiple', name:'Root', tools:{
    change: {
        description:'Change page membership or eligibility',
        inputSchema:Type.Object({ mode:Type.Enum(['disable','enable','replace','close','reopen']) }, {additionalProperties:false}),
        execute: ({ input, context }) => context.change(input.mode),
    },
} });
const Empty = defineViewType({ multiplicity: 'multiple', name:'Empty'});
const viewTypes = [Root, Counter, Empty];
export default createApp({ app_name:'page_receivers', viewTypes, initialize({prepareProjection}) {
    let enabled = true, open = true;
    const make = (id, initial) => {
        let count = initial;
        return createView(Counter, { idPrefix: id, region: 'dynamic', name:'Counter <' + id + '>', render:() => ({
            body:'Count: ' + count + ' & current',
            refs:[ref('count',count,{ scope: 'protected', refType:'Count', schema:{type:'number'}})],
            context: {
                allowsAdd: id === 'b' || enabled,
                add(delta) {
                    count += delta;
                    const {status} = commit();
                    return {success:true,data:{status}};
                },
            },
        })});
    };
    let a = make('a', 2);
    const b = make('b', 10);
    const empty = createView(Empty, { idPrefix:'empty', region: 'dynamic',render:() => ({body:''})});
    const root = createView(Root,{ idPrefix:'root', region: 'static',render:() => ({
        body:'Open a counter and select its current View.',
        context:{ change },
    })});
    function change(mode) {
        if (mode === 'disable') enabled = false;
        if (mode === 'enable') enabled = true;
        if (mode === 'replace') a = make('a', 100);
        if (mode === 'close') open = false;
        if (mode === 'reopen') open = true;
        const {status} = commit();
        return {success:true,data:{status}};
    }
    function commit() { return prepareProjection({ views: open ? [root,a,b,empty] : [root,b,empty] }); }
    commit();
}});
`);
    const peerName = 'budget_peer';
    const peerFolder = await appFolder(peerName, `
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const Peer = defineViewType()({ multiplicity: 'multiple', name: 'Peer', tools: {
    review: { description: 'Review the selected page', execute() { return { success: true }; } },
} });
export default createApp({ app_name: ${JSON.stringify(peerName)}, viewTypes: [Peer], initialize({ prepareProjection }) {
    const views = ['peer_first', 'peer_second'].map(id => createView(Peer, { idPrefix: id, region: 'dynamic',
        render: () => ({ body: 'Peer context ' + id + ' ' + 'x'.repeat(700), context: {} }),
    }));
    prepareProjection({ views });
}});
`);
    const runtime = createRuntime({});
    let source: SemanticAOTUIDrivenSource | undefined;
    let loopback: Awaited<ReturnType<typeof fixtureProvider>> | undefined;
    let driver: import('@aotui/agent-driver-v2').AgentDriverV2 | undefined;
    try {
        const id = (await runtime.createDesktop(createDesktopId(name))).id, desktop = runtime.getDesktop(id);
        const local = await desktop.registerPendingApp({ installationId: name, localPath: folder,
            projectionLimits: { maxViews: 4, maxTools: 2, observation: { maxCanonicalBytes: 12 * 1024 } },
        });
        const appId = (await desktop.openApp(local)).appId;
        const peer = await desktop.registerPendingApp({ installationId: peerName, localPath: peerFolder,
            projectionLimits: { maxViews: 2, maxTools: 1, observation: { maxCanonicalBytes: 8 * 1024 } },
        });
        const peerClient = interaction(runtime, id, (await desktop.openApp(peer)).appId);
        const client = interaction(runtime, id, appId);
        let first = await observe(client);
        const add = first.tools.find(tool => tool.name === 'add')!;
        expect(first.tools.filter(tool => tool.name === 'add')).toHaveLength(1);
        expect(add.eligibleViewIds).toBeUndefined();
        expect(first.views.every(view => !Object.hasOwn(view, 'toolBindings'))).toBe(true);
        expect(first.views.map(view => view.id)).toEqual(['root_1', 'a_1', 'b_1', 'empty_1']);
        const call = (name: string, view_id: string, serial: string, args = {}) =>
            client.invoke(request(first, name, { view_id, ...args }, serial));
        const entered = { kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } };
        expect(await call('add','a_1','a-1')).toMatchObject({ receipt: { outcome: { status:'succeeded', value: {
            data: { status:'prepared' },
        } } } });
        expect(await call('add','b_1','a-1')).toMatchObject({ kind:'refused', code:'INVOCATION_ID_CONFLICT' });
        expect(await call('add','b_1','b-1',{delta:'$ref.page_receivers.a_1.count'})).toMatchObject(entered);
        const preview = await client.preview();
        if (preview.status !== 'previewed') throw Error('Expected preview');
        expect(preview.views.find(view => view.id === 'a_1')?.content.value).toBe('Count: 3 & current');
        expect(preview.views.find(view => view.id === 'b_1')?.content.value).toBe('Count: 12 & current');
        for (const view_id of ['', '$ref.page_receivers.a_1.count', 'root_1', 'elsewhere']) {
            expect(await call('add',view_id,'bad-' + view_id)).toMatchObject({ receipt: {
                executionPhase:'not-dispatched', outcome:{ status:'rejected', path:'$.view_id' },
            } });
        }
        expect(await client.invoke({ invocationId:'missing',observationId:first.observationId,toolId:add.id,input:{} }))
            .toMatchObject({ receipt:{ outcome:{ code:'TOOL_INVALID_ARGS',path:'$.view_id' } } });
        expect(await call('change','root_1','disable',{mode:'disable'})).toMatchObject(entered);
        await client.preview();
        expect(await call('add','a_1','disabled')).toMatchObject({receipt:{outcome:{code:'TOOL_SOURCE_STALE'}}});
        expect(await call('add','b_1','still-eligible')).toMatchObject(entered);
        expect(await call('change','root_1','enable',{mode:'enable'})).toMatchObject(entered);
        await client.preview();
        expect(await call('add','a_1','old-activation')).toMatchObject({receipt:{outcome:{code:'TOOL_SOURCE_STALE'}}});
        first = await observe(client);
        const oldA = first.views.find(view => view.id === 'a_1')!.viewInstanceId;
        expect(await call('change','root_1','replace',{mode:'replace'})).toMatchObject(entered);
        await client.preview();
        expect(await call('add','a_1','old-mount')).toMatchObject({receipt:{outcome:{code:'VIEW_INSTANCE_REVOKED'}}});
        expect(await call('add','b_1','old-ref',{delta:'$ref.page_receivers.a_1.count'})).toMatchObject({receipt:{outcome:{code:'REF_VIEW_UNAVAILABLE'}}});
        first = await observe(client);
        expect(first.views.find(view => view.id === 'a_2')?.viewInstanceId).not.toBe(oldA);
        expect(await call('change','root_1','disable-again',{mode:'disable'})).toMatchObject(entered);
        first = await observe(client);
        expect(first.tools.find(tool => tool.name === 'add')?.eligibleViewIds).toEqual(['b_1']);
        const peerPrepared = await frame(peerClient);
        if (peerPrepared.status !== 'observed') throw Error(peerPrepared.issue.code);
        const peerFrame = peerPrepared.observation;
        const prior = desktop.adoptTurn({ apps: [
            { candidate: client.candidate(first.observationId)! },
            { candidate: peerClient.candidate(peerFrame.observationId)! },
        ] });
        if (prior.status !== 'adopted') throw Error(prior.issue.code);

        const { AgentDriverV2 } = await import('@aotui/agent-driver-v2');
        loopback = await fixtureProvider();
        const sent = loopback.requests;
        source = new SemanticAOTUIDrivenSource(desktop, {includeInstruction:false});
        let limit = 10_000;
        const adoptHistory = vi.fn(), releaseHistory = vi.fn();
        const history: import('@aotui/agent-driver-v2').ContextDrivenSource = {
            name: 'history', onUpdate: () => () => {},
            async getContext() {
                return { messages: [
                    { role: 'system', content: 'Host rules sentinel', timestamp: 1, region: 'static' },
                    { role: 'user', content: 'User history sentinel ' + 'h'.repeat(12_000), timestamp: 2 },
                ], tools: {}, adopt: adoptHistory, release: releaseHistory };
            },
        };
        const errors = vi.fn();
        driver = new AgentDriverV2({llm:{model:'local',provider:{id:'test',baseURL:loopback.url},apiKey:'unused',
            inputBudget:() => ({contextWindow:limit,maxOutputTokens:1000})},sources:[source, history],onRunError:errors});
        const run = async () => { await driver!.trigger(); await (driver as any).runInFlight; };
        await run();
        expect(sent).toHaveLength(0);
        expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code:'MODEL_INPUT_BUDGET_EXCEEDED',
            details: expect.objectContaining({ inputLimit: 9000, outputReserved: 1000 }),
        }));
        expect(adoptHistory).not.toHaveBeenCalled();
        expect(releaseHistory).toHaveBeenCalledOnce();
        expect(await prior.turn.invoke(appId, request(first, 'add', { view_id: 'b_1' }, 'after-budget-failure'))).toMatchObject(entered);
        expect(await prior.turn.invoke(peerFrame.source.appId, request(peerFrame, 'review', { view_id: 'peer_first_1' }, 'after-budget-failure'))).toMatchObject(entered);
        for (const active of [client, peerClient]) {
            const replacement = await frame(active);
            if (replacement.status !== 'observed') throw Error('Candidate not released: ' + replacement.issue.code);
            active.release(replacement.observation.observationId);
        }
        limit = 64_000;
        await run();
        expect(sent).toHaveLength(1);
        expect(adoptHistory).toHaveBeenCalledOnce();
        const wire = sent[0]!.body;
        const model: { tools: Array<{ name: string; inputSchema: any }> } = {
            tools: wire.tools.map((tool: any) => ({ name: tool.function.name, inputSchema: tool.function.parameters })),
        };
        const prompt = JSON.stringify(wire.messages);
        for (const id of ['root_1','a_2','b_1','empty_1','peer_first_1','peer_second_1']) expect(prompt).toContain('id=\\"' + id + '\\"');
        expect(prompt).toContain('Host rules sentinel');
        expect(prompt).toContain('User history sentinel');
        expect(prompt).toContain('view_type=\\"Counter\\"');
        expect(prompt).toContain('Open a counter and select its current View.');
        expect(prompt).not.toContain('toolBindings');
        expect(model.tools.find(tool => tool.name === name + '-add')?.inputSchema.properties.view_id).not.toHaveProperty('enum');
        expect(model.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({name:name + '-add',inputSchema:expect.objectContaining({
                required:['view_id'], properties:expect.objectContaining({
                    view_id:expect.objectContaining({type:'string'}),
                    delta:expect.objectContaining({description:expect.stringContaining('$ref.app_id.view_id.ref_id')}),
                }),
            })}),
            expect.objectContaining({name:'system-open_app',inputSchema:expect.not.objectContaining({
                required:expect.arrayContaining(['view_id']),
            })}),
            expect.objectContaining({name:peerName + '-review'}),
        ]));
    } finally {
        driver?.stop(); driver?.dispose(); source?.dispose();
        await loopback?.close();
        expect(await runtime.beginClose().completion).toMatchObject({ok:true,resourcesReleased:true,workers:{report:{total:0}}});
    }
}, 15_000);

it('disambiguates aliases from the current ViewTypes through real Worker observations and Source calls', async () => {
    const name = 'alias_selection';
    const folder = await appFolder(name, `
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const closed = { additionalProperties: false };
const NumberType = defineViewType()({ multiplicity: 'multiple', name: 'Numbers', tools: {
    set: {
        description: 'Set one number', inputSchema: Type.Object({ amount: Type.Integer() }, closed),
        execute({ input, context }) { context.value = input.amount; return context.finish(context.id); },
    },
    increment: {
        description: 'Increase one number',
        execute({ context }) { context.value++; return context.finish(context.id); },
    },
} });
const TextType = defineViewType()({ multiplicity: 'multiple', name: 'Text', tools: {
    set: {
        description: 'Set the text', inputSchema: Type.Object({ label: Type.String() }, closed),
        enabled: ({ canSet }) => canSet,
        execute: ({ input, context }) => context.setLabel(input.label),
    },
} });
const RootType = defineViewType()({ multiplicity: 'multiple', name: 'Root', tools: {
    set_mode: {
        description: 'Change the text page state', inputSchema: Type.Object({ mode: Type.Enum(['open', 'disabled', 'closed']) }, closed),
        execute: ({ input, context }) => context.setMode(input.mode),
    },
} });
export default createApp({ app_name: 'alias_selection', viewTypes: [RootType, NumberType, TextType], initialize({ prepareProjection }) {
    let mode = 'closed', label = 'Original';
    const finish = view => {
        prepareProjection({ views: mode === 'closed' ? [root, a, another] : [root, a, another, text] });
        return { success: true, data: { view } };
    };
    const numberView = (id, value) => {
        const context = { id, value, finish };
        return createView(NumberType, { idPrefix: id, region: 'dynamic', render: () => ({ body: 'Number: ' + context.value, context }) });
    };
    const a = numberView('a', 0), another = numberView('another', 10);
    const text = createView(TextType, { idPrefix: 'text', region: 'dynamic', render: () => ({
        body: 'Text: ' + label,
        context: { canSet: mode === 'open', setLabel(next) { label = next; return finish('text'); } },
    }) });
    const root = createView(RootType, { idPrefix: 'root', region: 'static', render: () => ({
        body: 'Change the text page state.',
        context: { setMode(next) { mode = next; return finish('root'); } },
    }) });
    finish('root');
} });
`);
    const runtime = createRuntime({});
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
        const id = (await runtime.createDesktop(createDesktopId(name))).id, desktop = runtime.getDesktop(id);
        const installationId = await desktop.registerPendingApp({ installationId: name, localPath: folder });
        const appId = (await desktop.openApp(installationId, { policy })).appId;
        const client = interaction(runtime, id, appId);
        const initial = await frame(client);
        if (initial.status !== 'observed') throw Error(JSON.stringify(initial.issue));
        expect(initial.observation.views.map(view => view.id)).toEqual(['root_1', 'a_1', 'another_1']);
        expect(initial.observation.tools.filter(tool => tool.name === 'set')).toMatchObject([
            { id: JSON.stringify([appId, 'Numbers', 'set']),  },
        ]);
        client.release(initial.observation.observationId);

        source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
        const refresh = async (names: string[]) => {
            await current?.release?.();
            current = await source!.getContext();
            await current.adopt!();
            expect(Object.keys(current.tools).filter(alias => alias.endsWith('-set')).sort(),
                current.messages.map(message => message.content).join('\n')).toEqual(names);
            return current;
        };
        const viewText = (id: string) => current!.messages.find(message => String(message.content).startsWith('<view view_id="' + id + '"'))?.content;
        const call = (tool: string, input: object, callId: string) => current!.executeTool!(tool, input, callId);
        const succeeded = (view: string) => ({ outcomeStatus: 'succeeded', result: { view } });

        const first = await refresh([name + '-set']);
        expect(Object.keys(first.tools).filter(alias => alias.endsWith('-increment'))).toEqual([increment]);
        expect(first.tools[name + '-set']?.inputSchema).toMatchObject({ jsonSchema: { required: ['view_id', 'amount'] } });
        expect(await call(increment, { view_id: 'a_1' }, 'increment-a')).toMatchObject(succeeded('a'));
        expect(await call(increment, { view_id: 'another_1' }, 'increment-another')).toMatchObject(succeeded('another'));
        await refresh([name + '-set']);
        expect(viewText('a_1')).toContain('Number: 1\n');
        expect(viewText('another_1')).toContain('Number: 11\n');
        expect(await call(name + '-set_mode', { view_id: 'root_1', mode: 'open' }, 'open-text')).toMatchObject(succeeded('root'));

        const both = await refresh([setNumber, setText]);
        expect(both.tools[setText]?.inputSchema).toMatchObject({ jsonSchema: { required: ['view_id', 'label'] } });
        expect(await call(setNumber, { view_id: 'text_1', amount: 7 }, 'wrong-view')).toMatchObject({
            outcomeStatus: 'rejected', error: { code: 'TOOL_UNAVAILABLE' },
        });
        expect(await call(setNumber, { view_id: 'a_1', amount: 7 }, 'set-number')).toMatchObject(succeeded('a'));
        expect(await call(setText, { view_id: 'text_1', label: 'Changed' }, 'set-text')).toMatchObject(succeeded('text'));
        await refresh([setNumber, setText]);
        expect(viewText('a_1')).toContain('Number: 7\n');
        expect(viewText('another_1')).toContain('Number: 11\n');
        expect(viewText('text_1')).toContain('Text: Changed');

        grantText = false;
        await refresh([name + '-set']);
        expect(viewText('text_1')).toContain('Text: Changed');
        grantText = true;
        await refresh([setNumber, setText]);
        expect(await call(name + '-set_mode', { view_id: 'root_1', mode: 'disabled' }, 'disable-text')).toMatchObject(succeeded('root'));
        await refresh([name + '-set']);
        expect(viewText('text_1')).toContain('Text: Changed');
        expect(await call(name + '-set_mode', { view_id: 'root_1', mode: 'closed' }, 'close-text')).toMatchObject(succeeded('root'));
        await refresh([name + '-set']);
        expect(viewText('text_1')).toBeUndefined();
        expect(await call(name + '-set', { view_id: 'a_1', amount: 8 }, 'after-close')).toMatchObject(succeeded('a'));
    } finally {
        await current?.release?.(); source?.dispose();
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);
