import { committedSnapshot, committedState, fixtureHost } from './__tests__/worker-fixture.js';
import { invokeObservedTool } from '../../../tests/fixtures/semantic-worker-tools.js';
import { projectCompleteViews } from '@aotui/core/host';
import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { AppInteractionPolicy } from '@aotui/core';
import { AppWorkerHost } from './worker-host.js';

type Capture =
    | { type: 'SNAPSHOT_PREPARED'; draft: any }
    | { type: 'SNAPSHOT_PREPARE_FAILED'; producerSeq: number; error: { code: string; message: string } };

function appSource(): string {
    return `import { parentPort } from 'node:worker_threads';
        import Type from 'typebox';
        import { createApp, createView, defineViewType, ref, formatRef } from '@aotui/sdk';
        const inputSchema = Type.Object({}, { additionalProperties: false });
        const ParentType = defineViewType()({ multiplicity: 'multiple', name: 'Parent', tools: {
            parent_action: {
                description: 'Run the parent action', inputSchema,
                execute: async () => ({ success: true, data: { owner: 'parent' } }),
            },
        } });
        const SiblingType = defineViewType()({ multiplicity: 'multiple', name: 'Sibling', tools: {
            sibling_action: {
                description: 'Run the sibling action', inputSchema,
                execute: async () => ({ success: true, data: { owner: 'sibling' } }),
            },
        } });

        export default createApp({ viewTypes: [ParentType, SiblingType], app_name: 'nested_view_rejection',
            initialize({ publish: publishAuthorFrame, registerLifecycle }) {
                let parentText = 'PARENT_INITIAL_MARKER', invalid = false;
                const parent = (() => { const handle = createView(ParentType, { idPrefix: 'parent', region: 'dynamic' }); return { handle, frame: () => {
                    const selection = ref('parent_ref', { owner: 'parent' }, { schema: { type: 'object' }, scope: 'protected' });
                    return handle.frame({ body: ['PARENT_SECTION', formatRef('PARENT_REF_MARKER', selection), parentText].join('\\n'), refs: invalid ? [selection, selection] : [selection], context: {} });
                } }; })();
                const newSibling = () => (() => { const handle = createView(SiblingType, { idPrefix: 'sibling', region: 'dynamic' }); return { handle, frame: () => {
                    const selection = ref('sibling_ref', { owner: 'sibling' }, { schema: { type: 'object' }, scope: 'protected' });
                    return handle.frame({ body: formatRef('SIBLING_REF_MARKER', selection), refs: [selection], context: {} });
                } }; })();
                let sibling = newSibling();
                const publish = () => publishAuthorFrame(() => (sibling ? [parent, sibling] : [parent]).map(page => page.frame()));
                const receive = message => {
                    if (message.type !== 'TEST_COMMAND') return;
                    switch (message.command) {
                        case 'duplicate-ref': invalid = true; parentText = 'PARENT_INVALID_ATTEMPT'; break;
                        case 'repair': invalid = false; parentText = 'PARENT_RECOVERED_MARKER'; break;
                        case 'close-sibling': sibling = undefined; break;
                        case 'open-sibling': sibling = newSibling(); break;
                    }
                    try { publish(); } catch { /* Runtime reports the failed projection. */ }
                };
                parentPort.on('message', receive);
                registerLifecycle({ stop() { parentPort.off('message', receive); } });
                publish();
            },
        });
    `;
}

async function buildFixture(directory: string): Promise<{ app: string; workerScript: string }> {
    const runtime = resolve(process.cwd());
    const modules = join(directory, 'node_modules');
    await mkdir(modules, { recursive: true });
    await symlink(join(runtime, '../core/node_modules/acorn'), join(modules, 'acorn'), 'dir');
    await mkdir(join(modules, '@aotui'), { recursive: true });
    await symlink(resolve(runtime, '../core'), join(modules, '@aotui/core'), 'dir');
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
        project: projectCompleteViews,
        authorize: () => true,
        canReadReceipt: () => true,
    };
}

describe('R2 bad SDK Ref rejects the whole real Worker projection', () => {
    it('rejects duplicate Ref IDs, recovers atomically, and keeps the sibling lifecycle valid', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-r2-view-boundary-'));
        let host: AppWorkerHost | undefined;
        let worker: Worker | undefined;
        try {
            const { app, workerScript } = await buildFixture(directory);
            worker = new Worker(workerScript);
            host = fixtureHost(AppWorkerHost, { policy: policyForSelection(),
                appId: 'nested_app' as any,
                desktopId: 'nested_desktop' as any,
                appModulePath: app,

                config: { AOTUI_DATA_DIR: directory },
            }, { worker });
            const captures: Capture[] = [];
            const healthNotifications: Array<string | undefined> = [];
            host.onUpdate = reason => healthNotifications.push(reason);
            const starting = host.start();
            worker.on('message', message => {
                if (message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'SNAPSHOT_PREPARE_FAILED') {
                    captures.push(message);
                }
            });
            await starting;
            await host.open();
            expect(committedSnapshot(host).views).toHaveLength(2);

            const sendEvent = async (eventType: string): Promise<Capture> => {
                const after = sequence(captures.at(-1));
                const capture = waitForCapture(worker!, captures, after);
                worker!.postMessage({ type: 'TEST_COMMAND', command: eventType });
                if (eventType === 'close-sibling' || eventType === 'open-sibling' || eventType === 'repair') {
                    expect((await host!.preview()).status).toBe('previewed');
                }
                return capture;
            };

            const initial = committedSnapshot(host);
            expect(initial.views.map((view: any) => view.id).sort()).toEqual(['parent_1', 'sibling_1']);
            const parent = initial.views.find((view: any) => view.id === 'parent_1');
            expect(parent.content.value).toContain('PARENT_SECTION');
            expect(parent.content.value).toContain('PARENT_INITIAL_MARKER');
            expect(parent.content.value).not.toContain('PARENT_INVALID_ATTEMPT');
            expect(Object.values(initial.refs).find((ref: any) => ref.id === 'parent_ref'))
                .toMatchObject({ ownerViewId: 'parent_1', target: { payload: { owner: 'parent' } } });
            expect(Object.values(initial.refs).find((ref: any) => ref.id === 'sibling_ref'))
                .toMatchObject({ ownerViewId: 'sibling_1', target: { payload: { owner: 'sibling' } } });
            expect(await invokeObservedTool(host!, 'parent_action', {}, 'parent_1'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true, data: { owner: 'parent' } } } } });
            expect(await invokeObservedTool(host!, 'sibling_action', {}, 'sibling_1'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true, data: { owner: 'sibling' } } } } });

            expect((await sendEvent('close-sibling')).type).toBe('SNAPSHOT_PREPARED');
            expect(committedSnapshot(host).views).toHaveLength(1);
            expect(committedSnapshot(host).views.map((view: any) => view.id)).toEqual(['parent_1']);
            expect(await invokeObservedTool(host!, 'parent_action', {}, 'parent_1'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });

            expect((await sendEvent('open-sibling')).type).toBe('SNAPSHOT_PREPARED');
            expect(committedSnapshot(host).views).toHaveLength(2);
            expect(committedSnapshot(host).views.map((view: any) => view.id).sort()).toEqual(['parent_1', 'sibling_2']);

            const beforeInvalid = captures.length;
            const previousGood = committedSnapshot(host);
            const invalid = await sendEvent('duplicate-ref');
            expect(invalid).toMatchObject({ type: 'SNAPSHOT_PREPARE_FAILED', error: { code: 'SNAPSHOT_INVALID' } });
            if (invalid.type !== 'SNAPSHOT_PREPARE_FAILED') throw new Error('Expected duplicate Ref rejection');
            expect(invalid.error.message).toContain('Ref IDs must be unique');
            expect(invalid.error.path).toContain('parent');
            expect(captures.slice(beforeInvalid)).toEqual([invalid]);
            expect(committedState(host)).toMatchObject({
                status: 'degraded', issue: { code: 'SNAPSHOT_INVALID' }, lastGood: { id: previousGood.id },
            });
            expect(healthNotifications.filter(reason=>reason!=='app_runtime_changed').at(-1)).toBe('projection_failed');
            expect(previousGood.views.map((view: any) => view.id).sort()).toEqual(['parent_1', 'sibling_2']);
            expect(previousGood.views.some((view: any) => view.content.value.includes('PARENT_INVALID_ATTEMPT'))).toBe(false);

            const recovery = await sendEvent('repair');
            expect(recovery.type).toBe('SNAPSHOT_PREPARED');
            expect(committedSnapshot(host).views).toHaveLength(2);
            expect(committedSnapshot(host).views.find((view: any) => view.id === 'parent_1').content.value)
                .toContain('PARENT_RECOVERED_MARKER');
            expect(healthNotifications.filter(reason=>reason!=='app_runtime_changed').at(-1)).toBe('projection_recovered');
            expect(await invokeObservedTool(host!, 'parent_action', {}, 'parent_1'))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });

            await host.close();
            expect(host.getResourceReport()).toMatchObject({ interactions: {
                closed: true, retainedOperations: 0,
            }, appCleanup: { support: 'managed', report: { state: 'completed', issues: [] } } });
            expect(worker.threadId).toBe(-1);
            expect(await host.waitForResourceRelease()).toMatchObject({ state: 'settled', worker: 'exited',
                resourcesReleased: true, interactions: { closed: true, retainedOperations: 0 } });
        } finally {
            host?.terminate();
            if (worker) await worker.terminate();
            await rm(directory, { recursive: true, force: true });
        }
    }, 20_000);
});
