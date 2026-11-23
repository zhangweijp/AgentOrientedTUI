import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

describe('Semantic WorkerHost View identity and instance Tool bindings', () => {
    it('publishes a new receiver identity across fresh Worker instances', async () => {
        const temp = await mkdtemp(join(tmpdir(), 'aotui-m4-viewowned-'));
        const root = resolve(process.cwd());
        const workerScript = join(temp, 'worker.mjs');
        const appScript = join(temp, 'app.mjs');
        let host: AppWorkerHost | undefined;
        try {
            const modules = join(temp, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
            await symlink(join(root, '../sdk/node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(join(root, '../core/node_modules/acorn'), join(modules, 'acorn'), 'dir');
            await symlink(join(root, '../core'), join(modules, '@aotui/core'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');

            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerScript,
                bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { h } from 'preact';
                import Type from 'typebox';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { DynamicView } from './sdk/src/components/View.tsx';

                import { defineViewType } from './sdk/src/tools/view-type-tool.ts';
                const FileDetail = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'FileDetail', tools: {
                    inspect: {
                        description: 'Inspect the selected file',
                        inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
                        execute: async ({ input }) => ({ success: true, data: { file: input.filePath } }),
                    },
                } });

                function Detail({ label }) {
                    return h('section', {}, [
                        h('p', {key:'info'}, label),
                    ]);
                }
                function App() {
                    return h('div', null, h('main', {}, [
                        h(DynamicView, { idPrefix: 'fd_0', type: FileDetail, context: {}, key: 'a' },
                            h(Detail, {label:'App.tsx'})),
                        h(DynamicView, { idPrefix: 'fd_1', type: FileDetail, context: {}, key: 'b' },
                            h(Detail, {label:'package.json'}))
                    ]));
                }
                export default createTUIApp({viewTypes:[FileDetail], app_name:'m4_fixture',component:App});
            `;
            await build({
                stdin: {
                    contents: fixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'm4-sdk-fixture.tsx', loader: 'tsx',
                },
                outfile: appScript, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });

            host = new AppWorkerHost({
                appId: 'm4_app' as any, desktopId: 'desktop_m4' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(host!.getSemanticSnapshotReport()).toMatchObject({
                    health: 'ready', lastViewCount: 2, lastToolCount: 1,
                });
            }, { timeout: 3_000 });

            const readSnapshot = (current: AppWorkerHost) => {
                const report = current.getSemanticSnapshotReport();
                if (!report?.snapshotId) throw new Error('Expected a Semantic snapshot');
                const result = (current as any).snapshotReceiver.core.store.getById(report.snapshotId);
                if (result.status !== 'found') throw new Error('Expected a retained Semantic snapshot');
                return result.snapshot;
            };
            const first = readSnapshot(host);
            const firstMarkup = first.views.map((view: any) => view.content.value).join('\n');
            expect(firstMarkup).toContain('App.tsx');
            expect(firstMarkup).toContain('package.json');
            expect(new Set(first.views.map((view: any) => view.viewInstanceId)).size).toBe(2);
            const firstViewsById = new Map(first.views.map((view: any) => [view.id, view]));
            for (const view of first.views) {
                expect(view.viewInstanceId).toContain(host.appInstanceId);
                expect(view.content.value).not.toContain(view.viewInstanceId);
            }
            const inspect = Object.values(first.tools).find((tool: any) => tool.name === 'inspect') as any;
            expect(first.views[0]!.toolBindings).toEqual([{ toolId: inspect.id, activationId: expect.any(String) }]);
            expect(inspect).not.toHaveProperty('targets');
            const firstIdentity = first.views[0]!.viewInstanceId;

            // A managed close retires this Host and Worker.
            const physical = (host as any).worker;
            await host.close();
            const posted = vi.spyOn(physical, 'postMessage');
            await expect(host.open()).rejects.toThrow(/shutdown is pending/);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(posted).not.toHaveBeenCalled();
            expect(host.getSemanticSnapshotReport()).toMatchObject({ health: 'stopped' });
            expect(host.getSemanticSnapshotReport()?.snapshotId).toBeUndefined();

            const oldExecution = host.appInstanceId;
            expect(physical.threadId).toBe(-1);
            posted.mockRestore();
            host = new AppWorkerHost({
                appId: 'm4_app' as any, desktopId: 'desktop_m4' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
            });
            expect(host.appInstanceId).not.toBe(oldExecution);
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                const current = readSnapshot(host!);
                expect(current.views).toHaveLength(2);
                for (const view of current.views) {
                    expect(view.viewInstanceId).toContain(host!.appInstanceId);
                    expect(view.viewInstanceId).not.toContain(oldExecution);
                }
            }, { timeout: 3_000 });
            const current = readSnapshot(host);
            for (const view of current.views) {
                expect(view.viewInstanceId).not.toBe(firstViewsById.get(view.id).viewInstanceId);
                expect(view.content.value).not.toContain(view.viewInstanceId);
            }
            const currentInspect = Object.values(current.tools).find((tool: any) => tool.name === 'inspect') as any;
            expect(current.views[0]!.toolBindings).toEqual([{ toolId: currentInspect.id, activationId: expect.any(String) }]);
            expect(current.views[0]!.viewInstanceId).not.toBe(firstIdentity);
            expect(currentInspect).not.toHaveProperty('targets');
        } finally {
            host?.terminate();
            await rm(temp, { recursive: true, force: true });
        }
    }, 12_000);
});
