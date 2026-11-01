import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

/** A real SDK/Worker race injected AFTER the producer epoch check and DURING V2 draft preparation. */
describe('Semantic producer regression: a mutation during V2 preparation cannot publish a torn Draft', () => {
    it('rejects the inconsistent prepare and recovers at a later stable epoch', async () => {
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
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerScript, bundle: true, platform: 'node',
                format: 'esm', target: 'node20',
                packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { writeFileSync } from 'node:fs';
                import { h } from 'preact';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { View } from './sdk/src/components/View.tsx';
                import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';

                function Detail() {
                    useViewTypeTool('inspect', {
                        description:'Read the current file metadata', params:{}, isMutating:false,
                    }, async () => ({success:true,data:{file:'App.tsx'}}));
                    return h('p',{},'Stable FileDetail');
                }
                const factory = createTUIApp({
                    app_name:'m4_epoch_race',
                    component:()=>h(View,{id:'fd_0',type:'FileDetail'},h(Detail,{})),
                });
                const initialize = factory.initializeComponent.bind(factory);
                factory.initializeComponent = async (container, ctx) => {
                    const initialized = await initialize(container, ctx);
                    const view = container.querySelector('[data-view-id="fd_0"]');
                    if (!view) throw new Error('Mounted FileDetail View was not found');
                    const getAttribute = view.getAttribute.bind(view);
                    let mutated = false;
                    view.getAttribute = ((name: string) => {
                        const value = getAttribute(name);
                        // captureDOMSnapshot reads this exact mounted identity only
                        // after it has copied the Tool inventory for the draft.
                        if (!mutated && name === 'data-view-instance-id' && value) {
                            mutated = true;
                            const before = ctx.projection.token();
                            const handler = async () => ({ success: true, data: { file: 'App.tsx' } });
                            const release = ctx.viewTools.registerTool(value, 'late_inspect', {
                                description: 'Inspect after a concurrent registration',
                                params: {}, isMutating: false,
                                handler,
                            }, {
                                safeOrdinaryParametersInvocationMode: 'ordinary-v2',
                                additionalProperties: false,
                                createSafeOrdinaryParametersInvoker: contract => async args => {
                                    const checked = contract.validate(args);
                                    return checked.ok
                                        ? { phase: 'entered-returned', result: await handler(checked.value) }
                                        : { phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS', message: 'Invalid Tool arguments' } } };
                                },
                            });
                            const after = ctx.projection.token();
                            writeFileSync(${JSON.stringify(raceTracePath)}, JSON.stringify({
                                hook: 'data-view-instance-id', viewInstanceId: value,
                                beforeEpoch: before.epoch, afterEpoch: after.epoch,
                                registered: typeof release === 'function', toolName: 'late_inspect',
                            }));
                        }
                        return value;
                    }) as typeof view.getAttribute;
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
            await vi.waitFor(() => {
                const report = host!.getSemanticSnapshotReport()!;
                expect(report).toMatchObject({
                    health: 'ready', lastViewCount: 1, lastToolCount: 2,
                });
                expect(report.prepareFailed).toBeGreaterThanOrEqual(1);
                expect(report.published).toBeGreaterThanOrEqual(1);
            }, { timeout: 4_000 });
            const report = host.getSemanticSnapshotReport()!;
            const raceTrace = JSON.parse(await readFile(raceTracePath, 'utf8'));
            expect(raceTrace).toMatchObject({
                hook: 'data-view-instance-id', registered: true, toolName: 'late_inspect',
            });
            expect(raceTrace.beforeEpoch).toEqual(expect.any(Number));
            expect(raceTrace.afterEpoch).toBe(raceTrace.beforeEpoch + 1);
            expect(report.rejected).toBeGreaterThanOrEqual(1);
            expect(report.lastIssueCode).toBeUndefined();
            const lookup = (host as any).snapshotReceiver.core.store.getById(report.snapshotId);
            expect(lookup).toMatchObject({ status:'found', snapshot:{
                schemaVersion:2, views:[{id:'fd_0', content:{value: expect.stringContaining('Stable FileDetail')}}],
            }});
            if (lookup.status === 'found') {
                expect(lookup.snapshot.revision).toBe(1);
                expect(Object.values(lookup.snapshot.tools).map((tool: any) => tool.name).sort())
                    .toEqual(['inspect', 'late_inspect']);
            }
        } finally {
            host?.terminate();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 12_000);
});
