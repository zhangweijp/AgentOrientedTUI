import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { AppInteractionPolicy } from '../../core/invocation/app-interaction-types.js';
import { AppWorkerHost } from './worker-host.js';

type Capture =
    | { type: 'SNAPSHOT_PREPARED'; draft: any }
    | { type: 'SNAPSHOT_PREPARE_FAILED'; producerSeq: number; error: { code: string; message: string } };

function appSource(): string {
    return `
        import { h } from 'preact';
        import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
        import Type from 'typebox';
        import { createTUIApp, defineViewTypeTool, View, useDataRef, AppTools, defineToolSet } from '@aotui/sdk';

        function Parent({ state }) {
            const ref = useDataRef('parent_ref', useMemo(() => ({ owner: 'parent' }), []));
            return h('section', {}, [
                h('div', {}, h('article', {}, 'ORDINARY_NESTED_DOM_MARKER')),
                h('p', {}, ref('PARENT_REF_MARKER')),
                h('p', {}, state.parentText),
                state.injectRawView
                    ? h('div', { 'data-view-id': 'raw_child', 'data-view-type': 'RawChild' },
                        h('p', {}, 'RAW_NESTED_VIEW_MARKER'))
                    : null,
            ]);
        }

        function Sibling() {
            const ref = useDataRef('sibling_ref', useMemo(() => ({ owner: 'sibling' }), []));
            return h('section', {}, [
                h('p', {}, ref('SIBLING_REF_MARKER')),
            ]);
        }


const fixtureTools0 = defineToolSet({
ParentActionUI: defineViewTypeTool({
                viewType: 'Parent', name: 'parent_action', description: 'Run the parent action',
                inputSchema: Type.Object({}, {additionalProperties:false}), }),
SiblingActionUI: defineViewTypeTool({
                viewType: 'Sibling', name: 'sibling_action', description: 'Run the sibling action',
                inputSchema: Type.Object({}, {additionalProperties:false}), })
});
function Root() {
            const [state, setState] = useState({
                parentText: 'PARENT_INITIAL_MARKER', injectRawView: false, siblingOpen: true,
            });
            useLayoutEffect(() => {
                const onExternalEvent = event => {
                    switch (event.detail?.type) {
                        case 'inject-raw-view':
                            setState(current => ({ ...current, parentText: 'PARENT_INVALID_ATTEMPT', injectRawView: true }));
                            break;
                        case 'repair':
                            setState(current => ({ ...current, parentText: 'PARENT_RECOVERED_MARKER', injectRawView: false }));
                            break;
                        case 'close-sibling': setState(current => ({ ...current, siblingOpen: false })); break;
                        case 'open-sibling': setState(current => ({ ...current, siblingOpen: true })); break;
                    }
                };
                document.addEventListener('aotui:external-event', onExternalEvent);
                return () => document.removeEventListener('aotui:external-event', onExternalEvent);
            }, []);
            return h(AppTools, { definition: fixtureTools0, bindings: {
ParentActionUI: { execute: async () => ({ success: true, data: { owner: 'parent' } }) },
SiblingActionUI: { execute: async () => ({ success: true, data: { owner: 'sibling' } }) }
} }, h('main', {}, [
                h(View, {kind: 'state', id: 'parent', type: 'Parent' }, h(Parent, { state })),
                state.siblingOpen ? h(View, {kind: 'state', id: 'sibling', type: 'Sibling' }, h(Sibling)) : null,
            ]));
        }

        export default createTUIApp({ app_name: 'nested_view_rejection', component: Root });
    `;
}

async function buildFixture(directory: string): Promise<{ app: string; workerScript: string }> {
    const runtime = resolve(process.cwd());
    const modules = join(directory, 'node_modules');
    await mkdir(modules, { recursive: true });
    await symlink(join(runtime, 'node_modules/preact'), join(modules, 'preact'), 'dir');
    await symlink(join(runtime, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
    await symlink(join(runtime, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
    const sourcePath = join(directory, 'app.mjs');
    const app = join(directory, 'app.bundle.mjs');
    const workerScript = join(directory, 'worker-runtime.mjs');
    await writeFile(sourcePath, appSource(), 'utf8');
    await build({
        entryPoints: [sourcePath], outfile: app, bundle: true, platform: 'node',
        format: 'esm', target: 'node20', packages: 'external',
        alias: {
            '@aotui/sdk': resolve(runtime, '../sdk/src/index.ts'),
            '@aotui/runtime/spi': resolve(runtime, 'src/spi/index.ts'),
            '@aotui/runtime/core': resolve(runtime, 'src/core/index.ts'),
            '@aotui/runtime/adapters/dom': resolve(runtime, 'src/adapters/dom-app.ts'),
        },
        logLevel: 'silent',
    });
    await build({
        entryPoints: [resolve(runtime, 'src/worker-runtime/index.ts')],
        outfile: workerScript, bundle: true, platform: 'node',
        format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
    });
    return { app, workerScript };
}

function sequence(capture: Capture | undefined): number {
    if (!capture) return 0;
    return capture.type === 'SNAPSHOT_PREPARED' ? capture.draft.producerSeq : capture.producerSeq;
}

function waitForCapture(worker: Worker, captures: Capture[], after: number): Promise<Capture> {
    const existing = captures.find(capture => sequence(capture) > after);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveCapture, reject) => {
        const timeout = setTimeout(() => {
            worker.off('message', receive);
            reject(new Error('Timed out waiting for a Semantic publication'));
        }, 3_000);
        const receive = (message: Capture) => {
            if (message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'SNAPSHOT_PREPARE_FAILED') {
                if (sequence(message) <= after) return;
                clearTimeout(timeout);
                worker.off('message', receive);
                resolveCapture(message);
            }
        };
        worker.on('message', receive);
    });
}

function policyForSelection(): AppInteractionPolicy {
    return {
        project: ({ source, selection }) => {
            const selected = new Set(selection.viewIds);
            const views = source.views.filter(view => selected.has(view.id));
            return {
                views: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                refs: Object.values(source.refs).filter(ref => selected.has(ref.ownerViewId))
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

describe('R2 DOM Producer rejects nested View identities in a real Worker', () => {
    it('rejects a raw nested data-view-id, recovers atomically, and keeps sibling lifecycle valid', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-r2-view-boundary-'));
        let host: AppWorkerHost | undefined;
        let worker: Worker | undefined;
        try {
            const { app, workerScript } = await buildFixture(directory);
            worker = new Worker(workerScript);
            host = new AppWorkerHost({
                appId: 'nested_app' as any,
                desktopId: 'nested_desktop' as any,
                appModulePath: app,
                workerScriptPath: workerScript,
                existingWorker: worker,
                config: { AOTUI_DATA_DIR: directory },
                interactionModes: ['view-type-parameters-v1'],
            });
            const captures: Capture[] = [];
            const healthNotifications: Array<string | undefined> = [];
            host.onUpdateRequest = () => healthNotifications.push(host!.getSemanticSnapshotReport()?.health);
            worker.on('message', message => {
                if (message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'SNAPSHOT_PREPARE_FAILED') {
                    captures.push(message);
                }
            });
            await host.start();
            await host.open();
            await waitUntil(() => host!.getSemanticSnapshotReport()?.health === 'ready' &&
                host!.getSemanticSnapshotReport()?.lastViewCount === 2);

            const readySnapshot = () => {
                const result = (host as any).snapshotReceiver.core.store.readLatest(host!.appId);
                if (result.status !== 'ready') throw new Error('Expected a ready Semantic source');
                return result.snapshot;
            };
            const sendEvent = async (eventType: string): Promise<Capture> => {
                const after = sequence(captures.at(-1));
                const capture = waitForCapture(worker!, captures, after);
                await host!.sendExternalEvent('parent' as any, eventType, {});
                return capture;
            };
            const policy = policyForSelection();
            const invoke = async (viewId: string, name: string, invocationId: string) => {
                const scope = host!.getAppInteraction(policy);
                expect(scope.status).toBe('ready');
                if (scope.status !== 'ready') throw new Error(scope.issue.code);
                const observed = await scope.interaction.observe({ viewIds: [viewId] });
                expect(observed.status).toBe('observed');
                if (observed.status !== 'observed') throw new Error(observed.issue.code);
                expect(scope.interaction.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
                const tool = observed.observation.tools.find(candidate => candidate.name === name);
                expect(tool).toBeDefined();
                const binding = observed.observation.bindings.find(candidate => candidate.toolId === tool?.id);
                expect(binding).toBeDefined();
                const result = await scope.interaction.invoke({
                    invocationId,
                    observationId: observed.observation.observationId,
                    bindingId: binding!.bindingId,
                    input: {},
                });
                scope.interaction.releaseObservation(observed.observation.observationId);
                return result;
            };

            const initial = readySnapshot();
            expect(initial.views.map((view: any) => view.id).sort()).toEqual(['parent', 'sibling']);
            const parent = initial.views.find((view: any) => view.id === 'parent');
            expect(parent.content.value).toContain('ORDINARY_NESTED_DOM_MARKER');
            expect(parent.content.value).toContain('PARENT_INITIAL_MARKER');
            expect(parent.content.value).not.toContain('RAW_NESTED_VIEW_MARKER');
            expect(Object.values(initial.refs).find((ref: any) => ref.id === 'parent_ref'))
                .toMatchObject({ ownerViewId: 'parent', target: { payload: { owner: 'parent' } } });
            expect(Object.values(initial.refs).find((ref: any) => ref.id === 'sibling_ref'))
                .toMatchObject({ ownerViewId: 'sibling', target: { payload: { owner: 'sibling' } } });
            expect(await invoke('parent', 'parent_action', 'parent-before-nesting'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true, data: { owner: 'parent' } } } } });
            expect(await invoke('sibling', 'sibling_action', 'sibling-before-close'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true, data: { owner: 'sibling' } } } } });

            expect((await sendEvent('close-sibling')).type).toBe('SNAPSHOT_PREPARED');
            await waitUntil(() => host!.getSemanticSnapshotReport()?.health === 'ready' &&
                host!.getSemanticSnapshotReport()?.lastViewCount === 1);
            expect(readySnapshot().views.map((view: any) => view.id)).toEqual(['parent']);
            expect(await invoke('parent', 'parent_action', 'parent-after-close'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });

            expect((await sendEvent('open-sibling')).type).toBe('SNAPSHOT_PREPARED');
            await waitUntil(() => host!.getSemanticSnapshotReport()?.health === 'ready' &&
                host!.getSemanticSnapshotReport()?.lastViewCount === 2);
            expect(readySnapshot().views.map((view: any) => view.id).sort()).toEqual(['parent', 'sibling']);

            const beforeInvalid = host.getSemanticSnapshotReport()!;
            const previousGood = readySnapshot();
            const invalid = await sendEvent('inject-raw-view');
            expect(invalid).toMatchObject({ type: 'SNAPSHOT_PREPARE_FAILED', error: { code: 'SNAPSHOT_INVALID' } });
            if (invalid.type !== 'SNAPSHOT_PREPARE_FAILED') throw new Error('Expected nested View rejection');
            expect(invalid.error.message).toContain('NESTED_VIEW_UNSUPPORTED');
            expect(invalid.error.message).toContain('parent');
            expect(invalid.error.message).toContain('raw_child');
            expect(invalid.error.message).toContain('Declare independent Views.');
            expect(invalid.error.message.length).toBeLessThanOrEqual(160);
            expect(host.getSemanticSnapshotReport()).toMatchObject({
                health: 'degraded',
                published: beforeInvalid.published,
                prepareFailed: beforeInvalid.prepareFailed + 1,
                rejected: beforeInvalid.rejected + 1,
                lastIssueCode: 'SNAPSHOT_INVALID',
                lastViewCount: 2,
            });
            expect(healthNotifications.at(-1)).toBe('degraded');
            expect(previousGood.views.map((view: any) => view.id).sort()).toEqual(['parent', 'sibling']);
            expect(previousGood.views.some((view: any) => view.content.value.includes('RAW_NESTED_VIEW_MARKER'))).toBe(false);

            const recovery = await sendEvent('repair');
            expect(recovery.type).toBe('SNAPSHOT_PREPARED');
            await waitUntil(() => host!.getSemanticSnapshotReport()?.health === 'ready' &&
                host!.getSemanticSnapshotReport()?.lastViewCount === 2);
            expect(readySnapshot().views.find((view: any) => view.id === 'parent').content.value)
                .toContain('PARENT_RECOVERED_MARKER');
            expect(healthNotifications.at(-1)).toBe('ready');
            expect(await invoke('parent', 'parent_action', 'parent-after-recovery'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });

            await host.close();
            expect(host.getResourceReport()).toMatchObject({ interactions: {
                closed: true, retainedOperations: 0, retainedBytes: 0,
            }, appCleanup: { support: 'managed', report: { state: 'completed', issues: [] } } });
            expect(worker.threadId).toBe(-1);
            expect(await host.waitForResourceRelease()).toMatchObject({ state: 'settled', worker: 'exited',
                resourcesReleased: true, interactions: { closed: true, retainedOperations: 0, retainedBytes: 0 } });
        } finally {
            host?.terminate();
            if (worker) await worker.terminate();
            await rm(directory, { recursive: true, force: true });
        }
    }, 20_000);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for Worker state');
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
}
