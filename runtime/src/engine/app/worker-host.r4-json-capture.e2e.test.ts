import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';
import { AppWorkerHost } from './worker-host.js';

type Capture =
    | { type: 'SNAPSHOT_PREPARED'; draft: any }
    | { type: 'SNAPSHOT_PREPARE_FAILED'; producerSeq: number; error: { code: string; message: string } };

function appSource(): string {
    return `
        import { h } from 'preact';
        import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
        import { createTUIApp, View, useDataRef, useViewTypeTool } from '@aotui/sdk';

        let getterCalls = 0;
        const getterData = {};
        Object.defineProperty(getterData, 'secret', {
            enumerable: true,
            get() { getterCalls++; return 'GETTER_VALUE'; },
        });
        const oversizedData = { payload: 'x'.repeat(9 * 1024 * 1024) };

        function Detail({ state }) {
            const data = useMemo(() => state.mode === 'getter'
                ? getterData
                : state.mode === 'oversized' ? oversizedData : { value: 'valid' }, [state.mode]);
            const ref = useDataRef('payload', data);
            useViewTypeTool('stats', {
                description: 'Read the getter counter', isMutating: false, params: {},
            }, async () => ({ success: true, data: { getterCalls } }));
            return h('p', {}, [state.mode, ref('payload')]);
        }

        function Root() {
            const [state, setState] = useState({ mode: 'valid' });
            useLayoutEffect(() => {
                const onExternalEvent = event => {
                    const mode = event.detail?.type;
                    if (mode === 'getter' || mode === 'oversized' || mode === 'recover') {
                        setState({ mode: mode === 'recover' ? 'valid' : mode });
                    }
                };
                document.addEventListener('aotui:external-event', onExternalEvent);
                return () => document.removeEventListener('aotui:external-event', onExternalEvent);
            }, []);
            return h(View, { id: 'detail', type: 'Detail' }, h(Detail, { state }));
        }

        export default createTUIApp({ app_name: 'strict_json_capture', component: Root });
    `;
}

async function buildFixture(directory: string): Promise<{ app: string; workerScript: string }> {
    const runtime = resolve(process.cwd());
    await symlink(join(runtime, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const appSourcePath = join(directory, 'app.mjs');
    const app = join(directory, 'app.bundle.mjs');
    const workerScript = join(directory, 'worker-runtime.mjs');
    await writeFile(appSourcePath, appSource(), 'utf8');
    await build({
        entryPoints: [appSourcePath], outfile: app, bundle: true, platform: 'node',
        format: 'esm', target: 'node20', packages: 'external',
        alias: {
            '@aotui/sdk': resolve(runtime, '../sdk/src/index.ts'),
            '@aotui/runtime/spi': resolve(runtime, 'src/spi/index.ts'),
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
    const ready = captures.find(capture => sequence(capture) > after);
    if (ready) return Promise.resolve(ready);
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

function policyForSelection(): ScopePolicy {
    return {
        project: ({ source, selection }) => {
            const selected = new Set(selection.viewIds);
            const views = source.views.filter(view => selected.has(view.id));
            return {
                views: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                refs: Object.values(source.refs).filter(ref => selected.has(ref.ownerViewId))
                    .map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
                targets: Object.values(source.tools).flatMap(tool => tool.targets
                    .filter(target => selected.has(target.viewId)).map(target => ({ toolId: tool.id, target }))),
                content: views.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
            };
        },
        authorize: () => true,
        canReadReceipt: () => true,
    };
}

describe('R4 strict JSON capture in a real Worker', () => {
    it('rejects live accessors and over-budget Drafts before IPC, recovers, and closes resources', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-r4-json-capture-'));
        let host: AppWorkerHost | undefined;
        let worker: Worker | undefined;
        try {
            const { app, workerScript } = await buildFixture(directory);
            worker = new Worker(workerScript);
            host = new AppWorkerHost({
                appId: 'json_capture_app' as any,
                desktopId: 'json_capture_desktop' as any,
                appModulePath: app,
                workerScriptPath: workerScript,
                existingWorker: worker,
                config: { AOTUI_DATA_DIR: directory },
                interactionModes: ['ordinary-v2'],
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
            await waitUntil(() => host!.getSemanticSnapshotReport()?.health === 'ready');
            expect(host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', published: 1, lastRefCount: 1 });

            const publishEvent = async (type: string): Promise<Capture> => {
                const after = sequence(captures.at(-1));
                const result = waitForCapture(worker!, captures, after);
                await host!.sendExternalEvent('detail' as any, type, {});
                return result;
            };

            const accessorFailure = await publishEvent('getter');
            expect(accessorFailure).toMatchObject({ type: 'SNAPSHOT_PREPARE_FAILED',
                error: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
            if (accessorFailure.type !== 'SNAPSHOT_PREPARE_FAILED') throw new Error('Expected strict JSON rejection');
            expect(accessorFailure.error.message).toContain('secret');
            expect(host.getSemanticSnapshotReport()).toMatchObject({ health: 'degraded', prepareFailed: 1,
                published: 1, rejected: 1, lastIssueCode: 'SNAPSHOT_SERIALIZATION_ERROR' });
            expect(healthNotifications).toEqual(['ready', 'degraded']);

            const oversizedFailure = await publishEvent('oversized');
            expect(oversizedFailure).toMatchObject({ type: 'SNAPSHOT_PREPARE_FAILED',
                error: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
            if (oversizedFailure.type !== 'SNAPSHOT_PREPARE_FAILED') throw new Error('Expected bounded capture rejection');
            expect(oversizedFailure.error.message).toContain('budget');
            expect(host.getSemanticSnapshotReport()).toMatchObject({ health: 'degraded', prepareFailed: 2,
                rejected: 2, lastIssueCode: 'SNAPSHOT_SERIALIZATION_ERROR' });
            expect(healthNotifications).toEqual(['ready', 'degraded']);

            const recovery = await publishEvent('recover');
            expect(recovery.type).toBe('SNAPSHOT_PREPARED');
            expect(host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', published: 1, unchanged: 1,
                prepareFailed: 2, lastRefCount: 1 });
            expect(healthNotifications).toEqual(['ready', 'degraded', 'ready']);

            const openedScope = host.createInteractionScope(policyForSelection());
            expect(openedScope.status).toBe('opened');
            if (openedScope.status !== 'opened') throw new Error(openedScope.issue.code);
            const observed = await openedScope.client.observe({ viewIds: ['detail'] });
            expect(observed.status).toBe('observed');
            if (observed.status !== 'observed') throw new Error(observed.issue.code);
            const stats = observed.observation.tools.find(tool => tool.name === 'stats');
            expect(stats).toBeDefined();
            const binding = observed.observation.bindings.find(candidate => candidate.toolId === stats?.id);
            expect(binding).toBeDefined();
            const statsResult = await openedScope.client.invoke({
                invocationId: 'read-getter-counter',
                observationId: observed.observation.observationId,
                bindingId: binding!.bindingId,
                input: {},
            });
            expect(statsResult).toMatchObject({ kind: 'receipt', receipt: {
                outcome: { status: 'succeeded', value: { success: true, data: { getterCalls: 0 } } },
            } });
            openedScope.client.close();

            await host.close();
            expect(host.getSemanticSnapshotReport()?.health).toBe('stopped');
            expect(host.getResourceReport()).toMatchObject({ interactions: {
                closed: true, retainedScopes: 0, retainedBytes: 0,
            }, appCleanup: { support: 'managed', report: { state: 'completed', issues: [] } } });
            expect(await host.releaseWorker()).toBe(worker);
            expect(await host.waitForResourceRelease()).toMatchObject({ state: 'settled', worker: 'transferred',
                resourcesReleased: true, interactions: { closed: true, retainedScopes: 0, retainedBytes: 0 } });
        } finally {
            host?.terminate();
            if (worker) await worker.terminate();
            await rm(directory, { recursive: true, force: true });
        }
    }, 20_000);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for Worker state');
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
}
