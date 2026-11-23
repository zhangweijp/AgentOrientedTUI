import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

/** A real SDK/Worker binding mutation attempted during V5 draft preparation. */
describe('Semantic producer regression: a mutation during V5 preparation cannot publish a torn Draft', () => {
    it('refuses reentrant writes during preparation and recovers on a real Tool commit', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'aotui-v2-prepare-race-'));
        const root = resolve(process.cwd());
        const workerScript = join(temporary, 'worker.mjs');
        const appScript = join(temporary, 'app.mjs');
        const raceTracePath = join(temporary, 'race-trace.json');
        let host: AppWorkerHost | undefined;
        try {
            const modules = join(temporary, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
            await symlink(join(root, '../sdk/node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(join(root, '../core/node_modules/acorn'), join(modules, 'acorn'), 'dir');
            await symlink(join(root, '../core'), join(modules, '@aotui/core'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerScript, bundle: true, platform: 'node',
                format: 'esm', target: 'node20',
                packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { writeFileSync } from 'node:fs';
        import { parentPort } from 'node:worker_threads';
                import { h } from 'preact';
                import { useState } from 'preact/hooks';
                import Type from 'typebox';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { DynamicView } from './sdk/src/components/View.tsx';
                import { defineViewType } from './sdk/src/tools/view-type-tool.ts';

                function Detail() {
                    return h('section',{},[
                        h('p',{},'Stable FileDetail'),
                    ]);
                }

                const inputSchema = Type.Object({}, { additionalProperties: false });
                const execute = async () => ({ success: true, data: { file: 'App.tsx' } });
                const FileDetail = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'FileDetail', tools: {
                    inspect: { description: 'Read the current file metadata', inputSchema, execute },
                    late_inspect: {
                        description: 'Read after enabling', inputSchema, execute,
                        enabled: context => context.enabled,
                    },
                } });
                let enable, attempt;
                function App() {
                    const [enabled, setEnabled] = useState(false);
                    const [, setRender] = useState(0);
                    attempt = () => setRender(value => value + 1);
                    enable = () => setEnabled(true);
                    return h(DynamicView, { idPrefix: 'fd_0', type: FileDetail, context: { enabled } }, h(Detail));
                }
                const factory = createTUIApp({
                    app_name:'m4_epoch_race',
                    component:App, viewTypes:[FileDetail],
                });
                const initialize = factory.initialize.bind(factory);
                factory.initialize = async ctx => {
                    const initialized = await initialize(ctx);
                    const view = document.querySelector('[data-aotui-view="FileDetail"]');
                    if (!view) throw new Error('Mounted FileDetail View was not found');
                    const getAttribute = view.getAttribute.bind(view);
                    let mutated = false;
                    view.getAttribute = ((name: string) => {
                        const value = getAttribute(name);
                        if (!mutated && name === 'data-aotui-view' && value) {
                            mutated = true;
                            let submitted = false;
                            try {
                                ctx.publishFrame(() => ({ views: [] }));
                                submitted = true;
                            } catch { /* swallowed deliberately; the batch must still fail */ }
                            writeFileSync(${JSON.stringify(raceTracePath)}, JSON.stringify({
                                viewType: value, submitted,
                            }));
                        }
                        return value;
                    }) as typeof view.getAttribute;
                    parentPort.on('message', message => {
                        if (message.type !== 'TEST_COMMAND') return;
                        if (message.command === 'attempt') attempt();
                        if (message.command === 'repair') enable();
                    });
                    return initialized;
                };
                export default factory;
            `;
            await build({
                stdin: {
                    contents: fixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'm4-producer-race.tsx', loader: 'tsx',
                },
                outfile: appScript, bundle: true, platform: 'node',
                format: 'esm', target: 'node20',
                packages: 'external', logLevel: 'silent',
            });
            host = new AppWorkerHost({
                appId: 'race_app' as any, desktopId: 'race_desktop' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
                config: { AOTUI_DATA_DIR: join(temporary, 'data') },
            });
            await host.start();
            await host.open();
            const first = host.getSemanticSnapshotReport()!;
            expect(first).toMatchObject({ health: 'ready', revision: 1, lastViewCount: 1, lastToolCount: 1 });
            host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'attempt' });
            await vi.waitFor(() => {
                expect(host!.getSemanticSnapshotReport()).toMatchObject({ health: 'degraded', prepareFailed: 1 });
            });
            const degraded = (host as any).snapshotReceiver.core.store.readLatest('race_app');
            expect(degraded).toMatchObject({ status: 'degraded', lastGood: { id: first.snapshotId } });
            const trace = JSON.parse(await readFile(raceTracePath, 'utf8'));
            expect(trace).toMatchObject({ viewType: 'FileDetail', submitted: false });
            host['worker']!.postMessage({ type: 'TEST_COMMAND', command: 'repair' });
            await vi.waitFor(() => {
                expect(host!.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', revision: 2, lastToolCount: 2 });
            });
            const report = host.getSemanticSnapshotReport()!;
            expect(report.lastIssueCode).toBeUndefined();
            const lookup = (host as any).snapshotReceiver.core.store.getById(report.snapshotId);
            expect(lookup).toMatchObject({ status:'found', snapshot:{
                schemaVersion:7, views:[{id:'fd_0', content:{value: expect.stringContaining('Stable FileDetail')}}],
            }});
            if (lookup.status === 'found') {
                expect(lookup.snapshot.revision).toBe(2);
                expect(Object.values(lookup.snapshot.tools).map((tool: any) => tool.name).sort())
                    .toEqual(['inspect', 'late_inspect']);
            }
        } finally {
            host?.terminate();
            await host?.waitForResourceRelease();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 12_000);
});
