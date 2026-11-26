import { createCandidateScope } from '../../runtime/src/engine/core/candidate-scope.js';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import type { IDesktop } from '../../runtime/src/spi/runtime/kernel.interface.js';
import { createTurnCoordinator } from '@aotui/core/host';
import { AppWorkerHost } from '../../runtime/src/engine/app/worker-host.js';

function appSource(): string {
    return `
        import Type from 'typebox';
        import { createApp, createView, defineViewType } from '@aotui/sdk';
        const EmptyType = defineViewType()({ multiplicity: 'multiple', name: 'EmptyType', tools: {
            ping: {
                description: 'Ping the empty View type.', inputSchema: Type.Object({}, { additionalProperties: false }),
                execute: async () => ({ success: true, data: { pong: true } }),
            },
            set_body: {
                description: 'Update one View body.',
                inputSchema: Type.Object({ body: Type.String() }, { additionalProperties: false }),
                async execute({ input, context: { setBody } }) {
                    setBody(input.body);
                    return { success: true };
                },
            },
        } });
        const HealthyType = defineViewType({ multiplicity: 'multiple', name: 'HealthyType' });

        export default createApp({ viewTypes: [EmptyType, HealthyType], app_name: 'empty_app',
            initialize({ prepareProjection }) {
                function page(idPrefix, initial) {
                    let body = initial;
                    return createView(EmptyType, { idPrefix, region: 'dynamic', render: () => ({
                        body, context: { setBody(next) { body = next; publish(); } },
                    }) });
                }
                const views = [
                    createView(HealthyType, { idPrefix: 'healthy_view', region: 'dynamic', render: () => ({ body: 'HEALTHY_SIBLING_BODY' }) }),
                    page('no_children', ''), page('whitespace', '  \\n  '), page('conditional', ''),
                ];
                function publish() { prepareProjection({ views }); }
                publish();
            }
        });
    `;
}

async function buildFixture(directory: string): Promise<{ app: string; workerScript: string }> {
    const runtime = fileURLToPath(new URL('../../runtime/', import.meta.url));
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

function latestSnapshot(host: AppWorkerHost): any {
    const state = (host as any).snapshotReceiver.core.store.readLatest(host.appId);
    if (state.status !== 'ready') throw new Error(`Expected a ready Snapshot; received ${state.status}`);
    return state.snapshot;
}

function viewMessage(context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>, id: string): string {
    const message = context.messages.find(item => String(item.content).startsWith(`<view view_id="${id}"`));
    if (!message) throw new Error(`Missing View message ${id}`);
    return String(message.content);
}

function viewBodyFromMessage(markup: string): string {
    const open = markup.indexOf('>\n');
    const close = markup.lastIndexOf('\n</view>');
    if (open < 0 || close < open) throw new Error('View message has no complete outer envelope');
    return markup.slice(open + 2, close);
}

describe('empty View projection in a real Worker and Semantic Source', () => {
    it('keeps empty and whitespace-only Views, their Tools and subsequent body updates', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-empty-view-'));
        let host: AppWorkerHost | undefined;
        let worker: Worker | undefined;
        let source: SemanticAOTUIDrivenSource | undefined;
        let context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>> | undefined;
        try {
            const fixture = await buildFixture(directory);
            worker = new Worker(fixture.workerScript);
            host = new AppWorkerHost({
                appId: 'empty_app' as any,
                desktopId: 'empty_desktop' as any,
                appModulePath: fixture.app,
                workerScriptPath: fixture.workerScript,
                existingWorker: worker,
                config: { AOTUI_DATA_DIR: directory },
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => expect(host!.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', lastViewCount: 4 }), { timeout: 4_000 });

            const turns = createTurnCoordinator();
            const desktop = {
                id: host.desktopId,
                adoptTurn: turns.adoptTurn, createCandidateScope,
                getRunningApp: () => {
                    const result = host!.getAppInteraction();
                    return result.status === 'ready' ? { status: 'ready', app: {
                        observe: () =>
                            host!.prepareObservation(instance => turns.prepareObservation(instance, () => host!.getAppInteraction().status === 'ready')),
                    } } : result;
                },
                listApps: () => [{ installationId: 'empty_app', appId: host!.appId, appInstanceId: host!.appInstanceId, name: 'empty_app', status: 'running' as const }],
                getAppWindows: () => undefined,
                getSystemLogs: () => [],
                openApp: async () => {}, collapseApp: async () => {}, expandApp: async () => {},
                output: { subscribe: vi.fn(), unsubscribe: vi.fn() },
            } as unknown as IDesktop;
            source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
            const observe = async () => {
                context = await source!.getContext();
                await context.adopt!();
                return context;
            };
            const result = async (name: string, input: Record<string, unknown>, callId: string) => {
                const current = context!;
                const value = await current.executeTool!(name, input, callId);
                expect(value).toMatchObject({ outcomeStatus: 'succeeded' });
                await current.release?.();
                context = undefined;
                return value;
            };

            let current = await observe();
            expect(Object.keys(current.tools)).toEqual(expect.arrayContaining([
                'empty_app-ping', 'empty_app-set_body',
            ]));
            expect(current.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(4);
            expect(viewMessage(current, 'healthy_view_1')).toContain('HEALTHY_SIBLING_BODY');
            const initialViews = latestSnapshot(host).views;
            expect(initialViews.find((view: any) => view.id === 'healthy_view_1')?.content.value).toContain('HEALTHY_SIBLING_BODY');
            for (const [id, value] of Object.entries({ no_children_1: '', whitespace_1: '  \n  ', conditional_1: '' })) {
                expect(viewBodyFromMessage(viewMessage(current, id))).toBe(value);
                expect(initialViews.find((view: any) => view.id === id)?.content.value).toBe(value);
            }

            await result('empty_app-ping', { view_id: 'no_children_1' }, 'empty-ping');
            const initialRevision = latestSnapshot(host).revision;
            for (const [index, body] of ['EMPTY_VIEW_BODY_ONE', '', 'EMPTY_VIEW_BODY_TWO'].entries()) {
                current = await observe();
                expect(current.tools['empty_app-ping']).toBeDefined();
                expect(current.tools['empty_app-set_body']).toBeDefined();
                await result('empty_app-set_body', { view_id: 'no_children_1', body }, `set-body-${index}`);
                current = await observe();
                await vi.waitFor(() => {
                    const snapshot = latestSnapshot(host!);
                    expect(snapshot.revision).toBeGreaterThan(initialRevision + index);
                    expect(snapshot.views.find((view: any) => view.id === 'no_children_1')?.content.value)
                        .toBe(body);
                }, { timeout: 4_000 });
                expect(current.tools['empty_app-ping']).toBeDefined();
                expect(viewBodyFromMessage(viewMessage(current, 'no_children_1'))).toBe(body);
                expect(viewMessage(current, 'healthy_view_1')).toContain('HEALTHY_SIBLING_BODY');
                await current.release?.();
                context = undefined;
            }
            source.dispose();
            source = undefined;
            await host.close();
            expect(host.getResourceReport()).toMatchObject({ interactions: {
                closed: true, retainedOperations: 0,
            }, appCleanup: { support: 'managed', report: { state: 'completed', issues: [] } } });
            expect(worker.threadId).toBe(-1);
            expect(await host.waitForResourceRelease()).toMatchObject({
                state: 'settled', worker: 'exited', resourcesReleased: true,
                interactions: { closed: true, retainedOperations: 0 },
            });
        } finally {
            await context?.release?.();
            source?.dispose();
            host?.terminate();
            if (worker) await worker.terminate();
            await rm(directory, { recursive: true, force: true });
        }
    }, 25_000);
});
