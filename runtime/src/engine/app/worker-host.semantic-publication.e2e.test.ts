import { projectCompleteViews } from '@aotui/core/internal';
import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import type { AppInteractionPolicy } from '@aotui/core';

type SignalPolicy = 'auto' | 'never' | undefined;
type Capture =
    | { type: 'SNAPSHOT_PREPARED'; draft: any; suppressSignal: boolean }
    | { type: 'SNAPSHOT_PREPARE_FAILED'; producerSeq: number; sourceEpoch: number; error: { code: string } };

const temporaryHosts: Array<{ host: AppWorkerHost; worker: Worker; messages: any[] }> = [];
let temporaryDirectory = '';
let workerScriptPath = '';
const appModules = new Map<string, string>();

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function applicationSource(signalPolicy: SignalPolicy, initiallyOpen: boolean, faultTools = false): string {
    const policy = signalPolicy ? `signalPolicy: '${signalPolicy}',` : '';
    return `
        import { parentPort } from 'node:worker_threads';
        import { h } from 'preact';
        import Type from 'typebox';
        import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
        import { createTUIApp, useDataRef, defineViewType, DynamicView } from '@aotui/sdk';

        Date.now = () => 1700000000000;
        let businessCalls = 0;
        const WorkspaceType = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Workspace', tools: {
            refresh: {
                description: 'Refresh the current view',
                inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
                enabled: ({ state }) => state.toolEnabled,
                execute: async () => ({ success: true, data: { calls: ++businessCalls } }),
            },
            extra: {
                description: 'Additional view action',
                inputSchema: Type.Object({ selector: Type.String() }, { additionalProperties: false }),
                enabled: ({ state }) => state.extraToolEnabled,
                execute: async () => ({ success: true }),
            },
            fault_after_commit: {
                description: 'Commit the fixture business change',
                inputSchema: Type.Object({ reason: Type.String() }, { additionalProperties: false }),
                enabled: () => ${faultTools},
                async execute({ context: { setState } }) {
                    businessCalls++;
                    setState(current => ({ ...current, invalidRef: true }));
                    return { success: true, data: { calls: businessCalls } };
                },
            },
            stats: {
                description: 'Read fixture business calls',
                inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
                enabled: () => ${faultTools},
                execute: async () => ({ success: true, data: { calls: businessCalls } }),
            },
        } });

        function Workspace({ state }) {
            const selection = useMemo(() => state.invalidRef
                ? { value: () => 'not cloneable' }
                : { value: state.refValue }, [state.invalidRef, state.refValue]);
            const ref = useDataRef('selection', selection, { scope: 'protected' });
            useLayoutEffect(() => { if (state.invalidLayout) throw new Error('Layout did not finish'); });
            return h('section', {}, h('p', {}, state.text + ' ' + ref('Selection')));
        }
        function Root() {
            const [state, setState] = useState({
                open: ${initiallyOpen}, text: 'initial', refValue: 'seed',
                toolEnabled: true, extraToolEnabled: false, invalidRef: false, invalidLayout: false,
            });
            useLayoutEffect(() => {
                const onCommand = message => {
                    if (message.type !== 'TEST_COMMAND') return;
                    const { command, data } = message;
                    switch (command) {
                        case 'open': setState(current => ({ ...current, open: true })); break;
                        case 'close': setState(current => ({ ...current, open: false })); break;
                        case 'background':
                            setTimeout(() => setState(current => ({ ...current, text: data.value })), 0);
                            break;
                        case 'ref': setState(current => ({ ...current, refValue: data.value })); break;
                        case 'tool': setState(current => ({ ...current, extraToolEnabled: data.enabled })); break;
                        case 'refresh-tool': setState(current => ({ ...current, toolEnabled: data.enabled })); break;
                        case 'poison-ref': setState(current => ({ ...current, invalidRef: true })); break;
                        case 'recover-ref': setState(current => ({ ...current, invalidRef: false, refValue: 'recovered' })); break;
                        case 'break-layout': setState(current => ({ ...current, invalidLayout: true, text: 'partial layout', refValue: 'partial ref' })); break;
                        case 'repair-layout': setState(current => ({ ...current, invalidLayout: false, text: 'repaired layout', refValue: 'repaired ref' })); break;
                    }
                };
                parentPort.on('message', onCommand);
                return () => parentPort.off('message', onCommand);
            }, []);
            return h('div', null, state.open
                ? h(DynamicView, { idPrefix: 'workspace', type: WorkspaceType, context: { state, setState }, name: 'Workspace' },
                    h(Workspace, { state }))
                : null);
        }

        export default createTUIApp({ viewTypes: [WorkspaceType], app_name: 'publication_fixture', component: Root, ${policy} });
    `;
}

async function compileApplication(name: string, signalPolicy: SignalPolicy, initiallyOpen: boolean, faultTools = false): Promise<string> {
    const sourcePath = join(temporaryDirectory, name + '.mjs');
    const outputPath = join(temporaryDirectory, name + '.bundle.mjs');
    await writeFile(sourcePath, applicationSource(signalPolicy, initiallyOpen, faultTools), 'utf8');
    await build({
        entryPoints: [sourcePath], outfile: outputPath, bundle: true,
        platform: 'node', format: 'esm', target: 'node20', packages: 'external',
        alias: {
            '@aotui/sdk': resolve(process.cwd(), '../sdk/src/index.ts'),
        },
        logLevel: 'silent',
    });
    appModules.set(name, outputPath);
    return outputPath;
}

beforeAll(async () => {
    const runtime = resolve(process.cwd());
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'aotui-semantic-publication-'));
    const modules = join(temporaryDirectory, 'node_modules');
    await mkdir(modules, { recursive: true });
    await symlink(join(runtime, 'node_modules/preact'), join(modules, 'preact'), 'dir');
    await symlink(join(runtime, '../sdk/node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
    await symlink(join(runtime, '../core/node_modules/acorn'), join(modules, 'acorn'), 'dir');
    await mkdir(join(modules, '@aotui'), { recursive: true });
    await symlink(resolve(runtime, '../core'), join(modules, '@aotui/core'), 'dir');
    await symlink(join(runtime, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
    workerScriptPath = join(temporaryDirectory, 'worker-runtime.mjs');
    await build({
        entryPoints: [join(runtime, 'src/worker-runtime/index.ts')],
        outfile: workerScriptPath, bundle: true, platform: 'node', format: 'esm',
        target: 'node20', packages: 'external', logLevel: 'silent',
    });
    await Promise.all([
        compileApplication('auto-empty', 'auto', false),
        compileApplication('never-empty', 'never', false),
        compileApplication('default-open', undefined, true),
        compileApplication('auto-fault', 'auto', true, true),
        compileApplication('default-empty', undefined, false),
    ]);
});

afterEach(async () => {
    for (const item of temporaryHosts.splice(0)) {
        expect(item.messages.some(message => message?.type === 'SNAPSHOT_FRAGMENT')).toBe(false);
        item.host.terminate();
        await item.worker.terminate();
        await item.host.waitForResourceRelease();
    }
});

afterAll(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function start(name: string, options: Record<string, unknown> = {}) {
    const worker = new Worker(workerScriptPath);
    const host = new AppWorkerHost({
        appId: 'publication_app' as any,
        desktopId: 'desktop' as any,
        appModulePath: appModules.get(name)!,
        workerScriptPath,
        existingWorker: worker,
        config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR! },
        ...options,
    });
    const captures: Capture[] = [];
    const updates: any[] = [];
    const messages: any[] = [];
    host.onUpdateRequest = () => updates.push(host.getSemanticSnapshotReport());
    temporaryHosts.push({ host, worker, messages });
    await host.start();
    // Install after AppWorkerHost's listener so each capture is already accepted
    // when this test observes the corresponding message.
    worker.on('message', message => {
        messages.push(message);
        if (message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'SNAPSHOT_PREPARE_FAILED') captures.push(message);
    });
    return { host, worker, captures, updates, messages };
}

function sequence(capture: Capture | undefined): number {
    if (!capture) return 0;
    return capture.type === 'SNAPSHOT_PREPARED' ? capture.draft.producerSeq : capture.producerSeq;
}

function waitForCapture(x: Awaited<ReturnType<typeof start>>, after: number): Promise<Capture> {
    const existing = x.captures.find(capture => sequence(capture) > after);
    if (existing) return Promise.resolve(existing);
    const result = deferred<Capture>();
    const timeout = setTimeout(() => {
        x.worker.off('message', receive);
        result.reject(new Error('Timed out waiting for a Semantic publication'));
    }, 2_000);
    const receive = (message: Capture) => {
        if ((message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'SNAPSHOT_PREPARE_FAILED') && sequence(message) > after) {
            clearTimeout(timeout);
            x.worker.off('message', receive);
            result.resolve(message);
        }
    };
    x.worker.on('message', receive);
    return result.promise;
}

async function change(x: Awaited<ReturnType<typeof start>>, eventType: string, data: Record<string, unknown> = {}) {
    const before = sequence(x.captures.at(-1));
    const capture = waitForCapture(x, before);
    x.worker.postMessage({ type: 'TEST_COMMAND', command: eventType, data: data });
    return capture;
}

function latestSnapshot(host: AppWorkerHost): any {
    const state = (host as any).snapshotReceiver.core.store.readLatest(host.appId);
    if (state.status !== 'ready') throw new Error('Expected a ready Semantic source; received ' + state.status);
    return state.snapshot;
}

function viewCount(host: AppWorkerHost): number {
    const report = host.getSemanticSnapshotReport();
    if (!report) throw new Error('Semantic snapshot receiver is unavailable');
    return report.lastViewCount ?? 0;
}

function allViewsPolicy(): AppInteractionPolicy {
    return {
        project: projectCompleteViews,
        authorize: () => true,
        canReadReceipt: () => true,
    };
}

const publicationPolicy = allViewsPolicy();

async function createToolCaller(host: AppWorkerHost, name: string, input: Record<string, unknown>) {
    const scope = host.getAppInteraction(publicationPolicy);
    expect(scope.status).toBe('ready');
    if (scope.status !== 'ready') throw new Error(scope.issue.code);
    const observed = await scope.interaction.observe({ all: true });
    if (observed.status === 'observed') expect(scope.interaction.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
    expect(observed.status).toBe('observed');
    if (observed.status !== 'observed') throw new Error(observed.issue.code);
    const tool = observed.observation.tools.find(candidate => candidate.name === name);
    expect(tool).toBeDefined();
    const target = observed.observation.views.find(view => view.type === tool?.viewType);
    expect(target).toBeDefined();
    return {
        invoke: (invocationId: string) => scope.interaction.invoke({
            invocationId,
            observationId: observed.observation.observationId,
            toolId: tool!.id,
            input: { view_id: target!.id, ...input },
        }),
        close: () => scope.interaction.releaseObservation(observed.observation.observationId),
    };
}

describe('Semantic publication through the current SDK and a real Node Worker', () => {
    it('keeps the Worker alive after a managed queued layout error and waits for a valid repair', async () => {
        const x = await start('auto-empty');
        await x.host.open();
        await change(x, 'open');
        const initial = latestSnapshot(x.host);
        const failed = await change(x, 'break-layout');
        expect(failed).toMatchObject({ type: 'SNAPSHOT_PREPARE_FAILED', error: { code: 'SNAPSHOT_INVALID' } });
        expect((x.host as any).snapshotReceiver.core.store.readLatest(x.host.appId)).toMatchObject({
            status: 'degraded', lastGood: { id: initial.id },
        });
        const recovered = await change(x, 'repair-layout');
        expect(recovered.type).toBe('SNAPSHOT_PREPARED');
        expect(latestSnapshot(x.host)).toMatchObject({
            views: [{ content: { value: expect.stringContaining('repaired layout') } }],
        });
        expect(Object.values(latestSnapshot(x.host).refs)).toMatchObject([{ target: { payload: { value: 'repaired ref' } } }]);
    });

    it('auto publishes empty, background DOM, Ref-only, Tool-only, same-ms generations, and final close', async () => {
        const x = await start('auto-empty');
        await x.host.open();
        expect(latestSnapshot(x.host).views).toEqual([]);
        expect(x.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', revision: 1, lastViewCount: 0 });
        expect(x.updates).toMatchObject([{ health: 'ready', revision: 1, lastViewCount: 0 }]);

        const opened = await change(x, 'open');
        expect(opened.type).toBe('SNAPSHOT_PREPARED');
        expect(viewCount(x.host)).toBe(1);
        let snapshot = latestSnapshot(x.host);
        expect(snapshot.views[0].content.value).toContain('initial');

        const beforeBackground = x.updates.length;
        const background = await change(x, 'background', { value: 'background completed' });
        expect(background.type).toBe('SNAPSHOT_PREPARED');
        snapshot = latestSnapshot(x.host);
        expect(snapshot.views[0].content.value).toContain('background completed');
        expect(x.updates).toHaveLength(beforeBackground + 1);

        const contentBeforeRef = snapshot.views[0].content.value;
        const refBefore = Object.values(snapshot.refs).find((ref: any) => ref.id === 'selection') as any;
        const refCapture = await change(x, 'ref', { value: 'ref-only update' });
        expect(refCapture.type).toBe('SNAPSHOT_PREPARED');
        snapshot = latestSnapshot(x.host);
        const refAfter = Object.values(snapshot.refs).find((ref: any) => ref.id === 'selection') as any;
        expect(refAfter.target.payload).toEqual({ value: 'ref-only update' });
        expect(refAfter.target).not.toEqual(refBefore.target);
        expect(snapshot.views[0].content.value).toBe(contentBeforeRef);

        const contentBeforeTool = snapshot.views[0].content.value;
        const refsBeforeTool = snapshot.refs;
        const toolCapture = await change(x, 'refresh-tool', { enabled: false });
        expect(toolCapture.type).toBe('SNAPSHOT_PREPARED');
        snapshot = latestSnapshot(x.host);
        expect(Object.values(snapshot.tools).some((tool: any) => tool.name === 'refresh')).toBe(false);
        expect(snapshot.views[0].content.value).toBe(contentBeforeTool);
        expect(snapshot.refs).toEqual(refsBeforeTool);

        const sequences = x.captures.filter(capture => capture.type === 'SNAPSHOT_PREPARED').map(capture => capture.draft);
        expect(new Set(sequences.map(draft => draft.capturedAt))).toEqual(new Set([1700000000000]));
        expect(new Set(sequences.map(draft => draft.producerSeq)).size).toBe(sequences.length);
        expect(new Set(sequences.map(draft => draft.sourceEpoch)).size).toBe(sequences.length);
        expect(x.updates.at(-1)).toMatchObject({ health: 'ready', revision: snapshot.revision, lastViewCount: 1 });

        const closed = await change(x, 'close');
        expect(closed.type).toBe('SNAPSHOT_PREPARED');
        expect(viewCount(x.host)).toBe(0);
        expect(latestSnapshot(x.host)).toMatchObject({ views: [], refs: {}, tools: {} });
        expect(x.updates.at(-1)).toMatchObject({ health: 'ready', revision: x.host.getSemanticSnapshotReport()?.revision,
            lastViewCount: 0, lastRefCount: 0, lastToolCount: 0 });
        expect(x.captures.every(capture => capture.type !== 'SNAPSHOT_PREPARED' || capture.suppressSignal === false)).toBe(true);
    });

    it('never publishes fresh snapshots without notifying', async () => {
        const passive = await start('never-empty');
        await passive.host.open();
        expect(latestSnapshot(passive.host).views).toEqual([]);
        expect(passive.updates).toHaveLength(0);
        const opened = await change(passive, 'open');
        expect(opened.type).toBe('SNAPSHOT_PREPARED');
        expect(opened.type === 'SNAPSHOT_PREPARED' && opened.suppressSignal).toBe(true);
        expect(viewCount(passive.host)).toBe(1);
        expect(passive.updates).toHaveLength(0);
        const passiveRef = await change(passive, 'ref', { value: 'quiet ref' });
        expect(passiveRef.type).toBe('SNAPSHOT_PREPARED');
        expect(passiveRef.type === 'SNAPSHOT_PREPARED' && passiveRef.suppressSignal).toBe(true);
        expect(Object.values(latestSnapshot(passive.host).refs).find((ref: any) => ref.id === 'selection')).toMatchObject({
            target: { payload: { value: 'quiet ref' } },
        });
        const passiveBackground = await change(passive, 'background', { value: 'quiet background' });
        expect(passiveBackground.type).toBe('SNAPSHOT_PREPARED');
        expect(passiveBackground.type === 'SNAPSHOT_PREPARED' && passiveBackground.suppressSignal).toBe(true);
        const passiveTool = await change(passive, 'tool', { enabled: true });
        expect(passiveTool.type).toBe('SNAPSHOT_PREPARED');
        expect(passiveTool.type === 'SNAPSHOT_PREPARED' && passiveTool.suppressSignal).toBe(true);
        expect(Object.values(latestSnapshot(passive.host).tools).some((tool: any) => tool.name === 'extra')).toBe(true);
        expect(passive.updates).toHaveLength(0);
    });

    it('auto reports a failed projection after a successful mutation and recovers from external state repair', async () => {
        const x = await start('auto-fault');
        await x.host.open();
        expect(x.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', published: 1, lastViewCount: 1 });
        const fault = await createToolCaller(x.host, 'fault_after_commit', { reason: 'commit then fail to present' });
        const businessResult = await fault.invoke('known-successful-business-effect');
        expect(businessResult).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'entered-returned', outcome: {
                status: 'succeeded', value: { success: true, data: { calls: 1 } },
            },
        } });
        expect(x.captures.at(-1)).toMatchObject({ type: 'SNAPSHOT_PREPARE_FAILED',
            error: { code: 'SNAPSHOT_SERIALIZATION_ERROR' }, suppressSignal: false });
        expect(x.host.getSemanticSnapshotReport()).toMatchObject({ health: 'degraded', prepareFailed: 1, published: 1 });
        expect(x.updates.at(-1)).toMatchObject({ health: 'degraded' });

        const replay = await fault.invoke('reject-old-binding-after-degradation');
        expect(replay).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'not-dispatched', outcome: { status: 'rejected' },
        } });

        const recoveryCapture = waitForCapture(x, sequence(x.captures.at(-1)));
        x.worker.postMessage({ type: 'TEST_COMMAND', command: 'recover-ref' });
        expect(await recoveryCapture).toMatchObject({ type: 'SNAPSHOT_PREPARED', suppressSignal: false });
        expect(x.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', published: 2, prepareFailed: 1 });
        expect(x.updates.at(-1)).toMatchObject({ health: 'ready' });

        const stats = await createToolCaller(x.host, 'stats', { query: 'business counter' });
        expect(await stats.invoke('confirm-business-effect-count')).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'entered-returned', outcome: {
                status: 'succeeded', value: { success: true, data: { calls: 1 } },
            },
        } });
        fault.close();
        stats.close();
    });

    it('uses a fresh Worker and source identity with the default auto signal policy', async () => {
        const first = await start('default-open');
        await first.host.open();
        const originalInstance = first.host.appInstanceId;
        await first.host.close();
        expect(first.worker.threadId).toBe(-1);
        expect(first.host.getSemanticSnapshotReport()?.health).toBe('stopped');

        const second = await start('default-empty');
        expect(second.worker).not.toBe(first.worker);
        expect(second.host.appInstanceId).not.toBe(originalInstance);
        await second.host.open();
        expect(second.host.getSemanticSnapshotReport()).toMatchObject({
            appId: 'publication_app', instanceId: second.host.appInstanceId, health: 'ready', lastViewCount: 0,
        });
        const opened = await change(second, 'open');
        expect(opened.type).toBe('SNAPSHOT_PREPARED');
        expect(opened.type === 'SNAPSHOT_PREPARED' && opened.draft.instanceId).toBe(second.host.appInstanceId);
        expect(second.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', lastViewCount: 1 });
        expect(second.updates.at(-1)).toMatchObject({ health: 'ready', lastViewCount: 1 });
    });
});
