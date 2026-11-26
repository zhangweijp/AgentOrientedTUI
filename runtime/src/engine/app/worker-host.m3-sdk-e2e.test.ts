import { committedSnapshot, fixtureHost } from './__tests__/worker-fixture.js';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { refKey } from '@aotui/core';

/**
 * M3 real Worker and bundled SDK with explicit Ref publication.
 * Task object A -> B after initial commit, while the Markdown body stays identical.
 */
describe('Semantic real Worker / SDK projection round trip', () => {
    it('advances the accepted Snapshot on a Ref-only update without changing the body', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'aotui-m3-'));
        const root = resolve(process.cwd()); // runtime/
        let host: AppWorkerHost | undefined;
        try {
            // Isolated module resolution: DO NOT write into the original node_modules.
            const modules = join(temporary, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
            await symlink(join(root, '../core/node_modules/acorn'), join(modules, 'acorn'), 'dir');
            await symlink(join(root, '../core'), join(modules, '@aotui/core'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            const workerPath = join(temporary, 'worker.mjs');
            const appPath = join(temporary, 'app.mjs');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerPath, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const sdkFixture = `
        import { parentPort } from 'node:worker_threads';
                import Type from 'typebox';
                import { createApp, createView, defineViewType, ref, arrayRef, formatRef } from './sdk/src/index.ts';

                const WorkspaceType = defineViewType()({ multiplicity: 'multiple', name: 'Workspace', tools: {
                    complete: {
                        description: 'Complete selected task', inputSchema: Type.Object({}, { additionalProperties: false }),
                        execute: async () => ({ success: true }),
                    },
                } });

                export default createApp({ viewTypes: [WorkspaceType], app_name: 'm3_integration',
                    initialize({ appId, prepareProjection, registerCleanup }) {
                        let target = { id: 'A' };
                        const page = createView(WorkspaceType, { idPrefix: 'workspace', region: 'dynamic', render() {
                            const selected = ref('selected', target, { schema: { type: 'object' }, scope: 'protected' });
                            const pending = arrayRef('pending', [target], {
                                schema: { type: 'array', items: { type: 'object' } }, scope: 'protected', itemType: 'Task',
                            });
                            return { refs: [selected, pending], body: [
                                formatRef('Stable task label', selected), formatRef('Stable list label', pending),
                                formatRef('Stable task label', pending, 0), 'App=' + appId,
                            ].join('\\n'), context: {} };
                        } });
                        const publish = () => prepareProjection({ views: [page] });
                        const onCommand = message => {
                            if (message.type === 'TEST_COMMAND' && message.command === 'replace-target') {
                                target = { id: message.data.id };
                                publish();
                            }
                        };
                        parentPort.on('message', onCommand);
                        registerCleanup({ stop() { parentPort.off('message', onCommand); } });
                        publish();
                    },
                });
            `;
            await build({
                stdin: {
                    contents: sdkFixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'm3-sdk-fixture.ts', loader: 'ts',
                },
                outfile: appPath, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            host = fixtureHost(AppWorkerHost, {
                appId: 'm3_app' as any, desktopId: 'desktop_m3' as any,
                appModulePath: appPath,
            }, { script: workerPath });
            await host.start();
            await host.open();
            const initial = committedSnapshot(host);
            expect(initial.revision).toBe(1);
            expect(initial.views).toHaveLength(1);
            expect(Object.keys(initial.refs)).toHaveLength(2);
            expect(Object.keys(initial.tools)).toHaveLength(1);
            const oldViewInstanceId = initial.views[0].viewInstanceId;
            const oldRefKey = refKey('workspace_1', oldViewInstanceId, 'pending');
            expect(initial.refs[oldRefKey].target.payload).toMatchObject([{ id: 'A' }]);
            const markup = initial.views[0].content.value;
            expect(markup).toContain('Stable task label');
            expect(markup).toContain('App=m3_app');
            host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'replace-target', data: { id: 'B' } });
            expect((await host.preview()).status).toBe('previewed');
            const changed = committedSnapshot(host);
            expect(changed.revision).toBeGreaterThan(initial.revision);
            expect(changed.id).not.toBe(initial.id);
            expect(changed.views).toHaveLength(1);
            expect(Object.keys(changed.refs)).toHaveLength(2);
            expect(Object.keys(changed.tools)).toHaveLength(1);
            expect(changed.views[0].viewInstanceId).toBe(oldViewInstanceId);
            const newRefKey = refKey('workspace_1', oldViewInstanceId, 'pending');
            expect(changed.refs[newRefKey].target.payload).toMatchObject([{ id: 'B' }]);
            const completeTool = Object.values(changed.tools).find((tool: any) => tool.name === 'complete') as any;
            expect(completeTool).toMatchObject({ viewType: 'Workspace' });
            expect(changed.views[0]!.toolBindings).toEqual([{ toolId: completeTool!.id, activationId: expect.any(String) }]);
            expect(completeTool).not.toHaveProperty('targets');
            // A historical Ref is pinned to its original object even when the
            // same visible Ref ID is reused in a new Snapshot.
            expect(initial.refs[oldRefKey].target.payload).toMatchObject([{ id: 'A' }]);
            expect(changed.views[0].content.value).toBe(markup);
        } finally {
            host?.terminate();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 12_000);
});
