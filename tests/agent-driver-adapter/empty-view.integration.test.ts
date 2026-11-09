import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import type { IDesktop, IKernel } from '../../runtime/src/spi/runtime/kernel.interface.js';
import type { ScopePolicy } from '../../runtime/src/core/invocation/scoped-interaction-types.js';
import { AppWorkerHost } from '../../runtime/src/engine/app/worker-host.js';

function appSource(): string {
    return `
        import { h } from 'preact';
        import { useState } from 'preact/hooks';
        import Type from 'typebox';
        import { createTUIApp, defineViewTypeTool, View, AppTools, ToolRef, defineToolSet } from '@aotui/sdk';


const fixtureTools0 = defineToolSet({
PingUI: defineViewTypeTool({
                viewType: 'EmptyType', name: 'ping', description: 'Ping the empty View type.',
                inputSchema: Type.Object({}, {additionalProperties:false}), }),
SetBodyUI: defineViewTypeTool({
                viewType: 'EmptyType', name: 'set_body', description: 'Update one View body.',
                inputSchema: Type.Object({ viewId: Type.String(), body: Type.String() }, {additionalProperties:false}), })
});
function Root() {
            const [bodies, setBodies] = useState({
                no_children: null,
                whitespace: '  \\n  ',
                hidden: null,
            });
            const PingUI = fixtureTools0.PingUI;
            const SetBodyUI = fixtureTools0.SetBodyUI;

            return h(AppTools, { definition: fixtureTools0, bindings: {
PingUI: { execute: async () => ({ success: true, data: { pong: true } }) },
SetBodyUI: { execute: async ({ viewId, body }) => {
                    setBodies(current => ({ ...current, [viewId]: body }));
                    return { success: true, data: { updated: viewId } };
                } }
} }, h('main', {}, [
                h(View, {kind: 'state', id: 'healthy_view', type: 'HealthyType' }, h('p', {}, 'HEALTHY_SIBLING_BODY')),
                h(View, {kind: 'state', id: 'no_children', type: 'EmptyType' }, bodies.no_children === null ? null : h('p', {}, bodies.no_children)),
                h(View, {kind: 'state', id: 'whitespace', type: 'EmptyType' }, bodies.whitespace === null ? null : h('span', {}, bodies.whitespace)),
                h(View, {kind: 'state', id: 'hidden', type: 'EmptyType' }, bodies.hidden === null
                    ? h('span', { 'data-state': 'hidden' }, 'HIDDEN_BODY')
                    : h('p', {}, bodies.hidden)),
                h(ToolRef, { tool: PingUI }, 'Ping'), h(ToolRef, { tool: SetBodyUI }, 'Set body'),
            ]));
        }

        export default createTUIApp({ app_name: 'empty_app', component: Root });
    `;
}

async function buildFixture(directory: string): Promise<{ app: string; workerScript: string }> {
    const runtime = fileURLToPath(new URL('../../runtime/', import.meta.url));
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
    const message = context.messages.find(item => String(item.content).startsWith(`<view id="${id}"`));
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
    it('keeps empty Views, matching Tools, healthy siblings and subsequent body updates', async () => {
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
                interactionModes: ['view-type-parameters-v1'],
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => expect(host!.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', lastViewCount: 4 }), { timeout: 4_000 });

            const desktop = {
                id: host.desktopId,
                getInstalledApps: () => [{ appId: host!.appId, appInstanceId: host!.appInstanceId, name: 'empty_app', status: 'running' as const }],
                getSystemLogs: () => [],
                openApp: async () => {}, closeApp: async () => {}, collapseApp: async () => {}, showApp: async () => {},
                output: { subscribe: vi.fn(), unsubscribe: vi.fn() },
            } as unknown as IDesktop;
            const kernel = {
                createAppScope: (_desktopId: string, _appId: string, policy: ScopePolicy) => host!.createInteractionScope(policy),
            } as unknown as IKernel;
            source = new SemanticAOTUIDrivenSource(desktop, kernel, { includeInstruction: false });
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
                'empty_app-EmptyType-ping', 'empty_app-EmptyType-set_body',
            ]));
            expect(current.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(4);
            expect(viewMessage(current, 'healthy_view')).toContain('HEALTHY_SIBLING_BODY');
            for (const id of ['no_children', 'whitespace', 'hidden']) {
                expect(viewBodyFromMessage(viewMessage(current, id))).toBe('');
            }
            const initialViews = latestSnapshot(host).views;
            expect(initialViews.find((view: any) => view.id === 'healthy_view')?.content.value).toContain('HEALTHY_SIBLING_BODY');
            expect(initialViews.filter((view: any) => view.id !== 'healthy_view').map((view: any) => view.content.value)).toEqual(['', '', '']);

            await result('empty_app-EmptyType-ping', {}, 'empty-ping');
            const initialRevision = latestSnapshot(host).revision;
            for (const [index, body] of ['EMPTY_VIEW_BODY_ONE', '', 'EMPTY_VIEW_BODY_TWO'].entries()) {
                current = await observe();
                expect(current.tools['empty_app-EmptyType-ping']).toBeDefined();
                expect(current.tools['empty_app-EmptyType-set_body']).toBeDefined();
                await result('empty_app-EmptyType-set_body', { viewId: 'no_children', body }, `set-body-${index}`);
                await vi.waitFor(() => {
                    const snapshot = latestSnapshot(host!);
                    expect(snapshot.revision).toBeGreaterThan(initialRevision + index);
                    expect(snapshot.views.find((view: any) => view.id === 'no_children')?.content.value)
                        .toBe(body ? `\n${body}\n` : '');
                }, { timeout: 4_000 });
                current = await observe();
                expect(current.tools['empty_app-EmptyType-ping']).toBeDefined();
                expect(viewBodyFromMessage(viewMessage(current, 'no_children'))).toBe(body ? `\n${body}\n` : '');
                expect(viewMessage(current, 'healthy_view')).toContain('HEALTHY_SIBLING_BODY');
                await current.release?.();
                context = undefined;
            }
            source.dispose();
            source = undefined;
            await host.close();
            expect(host.getResourceReport()).toMatchObject({ interactions: {
                closed: true, retainedScopes: 0, retainedBytes: 0,
            }, appCleanup: { support: 'managed', report: { state: 'completed', issues: [] } } });
            expect(await host.releaseWorker()).toBe(worker);
            expect(await host.waitForResourceRelease()).toMatchObject({
                state: 'settled', worker: 'transferred', resourcesReleased: true,
                interactions: { closed: true, retainedScopes: 0, retainedBytes: 0 },
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
