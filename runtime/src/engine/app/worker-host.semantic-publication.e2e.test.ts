import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';

type SignalPolicy = 'auto' | 'never' | 'manual' | undefined;
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
        import { h } from 'preact';
        import Type from 'typebox';
        import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
        import { createTUIApp, defineViewTypeTool, View, useDataRef, AppTools, ToolRef, defineToolSet } from '@aotui/sdk';

        Date.now = () => 1700000000000;
        let businessCalls = 0;

        function Workspace({ state, setState }) {
            const selection = useMemo(() => state.invalidRef
                ? { value: () => 'not cloneable' }
                : { value: state.refValue }, [state.invalidRef, state.refValue]);
            const ref = useDataRef('selection', selection);
            return h('section', {}, h('p', {}, state.text + ' ' + ref('Selection')));
        }


const fixtureTools0 = defineToolSet({
RefreshUI: defineViewTypeTool({
                viewType: 'Workspace', name: 'refresh', description: 'Refresh the current view',
                inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
            }),
ExtraUI: defineViewTypeTool({
                viewType: 'Workspace', name: 'extra', description: 'Additional view action',
                inputSchema: Type.Object({ selector: Type.String() }, { additionalProperties: false }),
            }),
Fault: defineViewTypeTool({viewType: 'Workspace', name: 'fault_after_commit', description: 'Commit the fixture business change', inputSchema: Type.Object({reason: Type.String()}, {additionalProperties:false})}),
Stats: defineViewTypeTool({viewType: 'Workspace', name: 'stats', description: 'Read fixture business calls', inputSchema: Type.Object({query: Type.String()}, {additionalProperties:false})})
});
function Root() {
            const [state, setState] = useState({
                open: ${initiallyOpen}, text: 'initial', refValue: 'seed',
                toolEnabled: true, extraToolEnabled: false, invalidRef: false,
            });
            const RefreshUI = fixtureTools0.RefreshUI;
            const ExtraUI = fixtureTools0.ExtraUI;
            void RefreshUI; void ExtraUI;
            useLayoutEffect(() => {
                const onExternalEvent = event => {
                    const detail = event.detail || {};
                    switch (detail.type) {
                        case 'open': setState(current => ({ ...current, open: true })); break;
                        case 'close': setState(current => ({ ...current, open: false })); break;
                        case 'background':
                            setTimeout(() => setState(current => ({ ...current, text: detail.data.value })), 0);
                            break;
                        case 'ref': setState(current => ({ ...current, refValue: detail.data.value })); break;
                        case 'tool': setState(current => ({ ...current, extraToolEnabled: detail.data.enabled })); break;
                        case 'refresh-tool': setState(current => ({ ...current, toolEnabled: detail.data.enabled })); break;
                        case 'poison-ref': setState(current => ({ ...current, invalidRef: true })); break;
                        case 'recover-ref': setState(current => ({ ...current, invalidRef: false, refValue: 'recovered' })); break;
                    }
                };
                document.addEventListener('aotui:external-event', onExternalEvent);
                return () => document.removeEventListener('aotui:external-event', onExternalEvent);
            }, []);
            return h(AppTools, { definition: fixtureTools0, bindings: {
RefreshUI: { execute: async () => {
                    businessCalls++;
                    return { success: true, data: { calls: businessCalls } };
                }, enabled: state.toolEnabled },
ExtraUI: { execute: async () => ({ success: true }), enabled: state.extraToolEnabled },
Fault: {enabled: ${faultTools}, execute: async () => {businessCalls++; setState(current => ({...current, invalidRef: true})); return {success:true, data:{calls:businessCalls}};}},
Stats: {enabled: ${faultTools}, execute: async () => ({success:true, data:{calls:businessCalls}})}
} }, state.open
                ? h(View, {kind: 'state', id: 'workspace', type: 'Workspace', name: 'Workspace' }, h(Workspace, { state, setState }))
                : null);
        }

        export default createTUIApp({ app_name: 'publication_fixture', component: Root, ${policy} });
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
            '@aotui/runtime/spi': resolve(process.cwd(), 'src/spi/index.ts'),
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
    await symlink(join(runtime, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
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
        compileApplication('manual-open', 'manual', true),
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
    await x.host.sendExternalEvent('workspace' as any, eventType, data);
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

function allViewsPolicy(): ScopePolicy {
    return {
        project: ({ source, selection }) => {
            const ids = new Set(selection.viewIds);
            const views = source.views.filter(view => ids.has(view.id));
            return {
                views: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                refs: Object.values(source.refs).filter(ref => ids.has(ref.ownerViewId))
                    .map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
                toolBindings: Object.values(source.tools).flatMap(tool => 
                    views.some(view => view.type === tool.viewType) ? [{ toolId: tool.id, execution: tool.execution }] : []),
                content: views.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
            };
        },
        authorize: () => true,
        canReadReceipt: () => true,
    };
}

async function createToolCaller(host: AppWorkerHost, name: string, input: Record<string, unknown>) {
    const scope = host.createInteractionScope(allViewsPolicy());
    expect(scope.status).toBe('opened');
    if (scope.status !== 'opened') throw new Error(scope.issue.code);
    const observed = await scope.client.observe({ viewIds: ['workspace'] });
    if (observed.status === 'observed') expect(scope.client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
    expect(observed.status).toBe('observed');
    if (observed.status !== 'observed') throw new Error(observed.issue.code);
    const tool = observed.observation.tools.find(candidate => candidate.name === name);
    expect(tool).toBeDefined();
    const binding = observed.observation.bindings.find(candidate => candidate.toolId === tool!.id);
    expect(binding).toBeDefined();
    return {
        invoke: (invocationId: string) => scope.client.invoke({
            invocationId,
            observationId: observed.observation.observationId,
            bindingId: binding!.bindingId,
            input,
        }),
        close: () => scope.client.close(),
    };
}

describe('Semantic publication through the current SDK and a real Node Worker', () => {
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

    it('manual ignores automatic DOM/Ref/Tool changes until a valid current Tool commits the projection', async () => {
        const manual = await start('manual-open', {
            interactionModes: ['view-type-parameters-v1'],
        });
        await manual.host.open();
        expect(viewCount(manual.host)).toBe(1);
        expect(Object.values(latestSnapshot(manual.host).tools).some((tool: any) => tool.name === 'refresh')).toBe(true);
        const caller = await createToolCaller(manual.host, 'refresh', { query: 'manual flush' });
        const initialCaptureCount = manual.captures.length;
        const updateCount = manual.updates.length;
        await manual.host.sendExternalEvent('workspace' as any, 'background', { value: 'manual background' });
        await manual.host.sendExternalEvent('workspace' as any, 'ref', { value: 'manual ref' });
        await manual.host.sendExternalEvent('workspace' as any, 'tool', { enabled: true });
        // The following request is a Worker message barrier. Observer microtasks from
        // the preceding events have run, so any automatic Semantic push would be visible.
        await manual.host.sendExternalEvent('workspace' as any, 'barrier');
        expect(manual.captures).toHaveLength(initialCaptureCount);
        expect(manual.updates).toHaveLength(updateCount);

        const explicitCommit = await caller.invoke('manual-current-tool');
        expect(explicitCommit).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'entered-returned', outcome: { status: 'succeeded', value: { success: true, data: { calls: 1 } } },
        } });
        expect(manual.captures.at(-1)).toMatchObject({ type: 'SNAPSHOT_PREPARED', suppressSignal: false });
        expect(manual.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', published: 2, lastViewCount: 1 });
        const snapshot = latestSnapshot(manual.host);
        expect(snapshot.views[0].content.value).toContain('manual background');
        expect(Object.values(snapshot.refs).find((ref: any) => ref.id === 'selection')).toMatchObject({
            target: { payload: { value: 'manual ref' } },
        });
        expect(Object.values(snapshot.tools).some((tool: any) => tool.name === 'extra')).toBe(true);
        expect(manual.updates.at(-1)).toMatchObject({ health: 'ready' });
        caller.close();
    });

    it('auto reports a failed projection after a successful mutation and recovers from external state repair', async () => {
        const x = await start('auto-fault', { interactionModes: ['view-type-parameters-v1'] });
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
        await x.host.sendExternalEvent('workspace' as any, 'recover-ref');
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

    it('reuses one physical Worker with a fresh source identity and resets the default policy to auto', async () => {
        const first = await start('manual-open');
        await first.host.open();
        const originalInstance = first.host.appInstanceId;
        const physicalWorkerId = first.worker.threadId;
        const transferred = await first.host.releaseWorker();
        expect(transferred).toBe(first.worker);
        expect(first.host.getSemanticSnapshotReport()?.health).toBe('stopped');

        const secondWorker = transferred!;
        const second = await startOnWorker(secondWorker, 'default-empty');
        expect(second.worker.threadId).toBe(physicalWorkerId);
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

async function startOnWorker(worker: Worker, name: string) {
    const host = new AppWorkerHost({
        appId: 'publication_app' as any,
        desktopId: 'desktop' as any,
        appModulePath: appModules.get(name)!,
        workerScriptPath,
        existingWorker: worker,
        config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR! },
    });
    const captures: Capture[] = [];
    const updates: any[] = [];
    const messages: any[] = [];
    host.onUpdateRequest = () => updates.push(host.getSemanticSnapshotReport());
    temporaryHosts.push({ host, worker, messages });
    await host.start();
    worker.on('message', message => {
        messages.push(message);
        if (message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'SNAPSHOT_PREPARE_FAILED') captures.push(message);
    });
    return { host, worker, captures, updates, messages };
}
