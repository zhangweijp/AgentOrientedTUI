import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

describe('Semantic Stage 1: actual WorkerHost + Runtime-issued View identity + SDK local Tool', () => {
    it('publishes trusted View identity and local Tool bindings across physical Worker reuse', async () => {
        const temp = await mkdtemp(join(tmpdir(), 'aotui-m4-viewowned-'));
        const root = resolve(process.cwd());
        const workerScript = join(temp, 'worker.mjs');
        const appScript = join(temp, 'app.mjs');
        let host: AppWorkerHost | undefined;
        try {
            const modules = join(temp, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');

            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerScript,
                bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { h } from 'preact';
                import { useState, useLayoutEffect } from 'preact/hooks';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { View } from './sdk/src/components/View.tsx';
                import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';
                import { useViewContext } from './sdk/src/hooks/useViewContext.ts';

                function Detail({ label }) {
                    const context = useViewContext();
                    const [identity, setIdentity] = useState('');
                    useLayoutEffect(() => {
                        setIdentity(context.viewInstanceId || 'NO_RUNTIME_INSTANCE');
                    }, []);
                    const [InspectUI] = useViewTypeTool('inspect', {
                        description: 'Inspect the selected file',
                        params: {}
                    }, async () => ({ success: true, data: { file: label } }));
                    return h('section', {}, [
                        h('p', {key:'info'}, label + ' Instance=' + identity),
                        h(InspectUI, {key:'tool'}, 'Inspect')
                    ]);
                }
                function App() {
                    return h('main', {}, [
                        h(View, {id:'fd_0',type:'FileDetail',key:'a'},
                            h(Detail, {label:'App.tsx'})),
                        h(View, {id:'fd_1',type:'FileDetail',key:'b'},
                            h(Detail, {label:'package.json'}))
                    ]);
                }
                export default createTUIApp({app_name:'m4_fixture',component:App});
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
            expect(firstMarkup).toContain('App.tsx Instance=vi:v1:');
            expect(firstMarkup).toContain('package.json Instance=vi:v1:');
            expect(firstMarkup).toContain(host.appInstanceId);
            expect(firstMarkup).not.toContain('NO_RUNTIME_INSTANCE');
            expect(new Set(first.views.map((view: any) => view.viewInstanceId)).size).toBe(2);
            const inspect = Object.values(first.tools).find((tool: any) => tool.name === 'inspect') as any;
            expect(inspect.targets).toHaveLength(2);
            expect(inspect.targets.map((target: any) => target.viewId).sort()).toEqual(['fd_0', 'fd_1']);
            for (const target of inspect.targets) {
                expect(first.views.find((view: any) => view.id === target.viewId).viewInstanceId)
                    .toBe(target.viewInstanceId);
            }

            // A managed close ends this port; remounting requires RESET and a new Host.
            const physical = (host as any).worker;
            const threadId = physical.threadId;
            await host.close();
            const posted = vi.spyOn(physical, 'postMessage');
            await expect(host.open()).rejects.toThrow(/shutdown is pending/);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(posted).not.toHaveBeenCalled();
            expect(host.getSemanticSnapshotReport()).toMatchObject({ health: 'stopped' });
            expect(host.getSemanticSnapshotReport()?.snapshotId).toBeUndefined();

            // Reuse the SAME physical Worker via RESET, but issue a new logical
            // AppInstanceId. Neither SDK view mount identities nor Tool bind
            // generations from the old run can be inherited.
            const oldExecution = host.appInstanceId;
            const previousWorker = await host.releaseWorker();
            expect(previousWorker).not.toBeNull();
            expect(previousWorker).toBe(physical);expect(previousWorker!.threadId).toBe(threadId);
            expect(posted.mock.calls.map(([message]) => (message as any).type)).toEqual(['RESET']);posted.mockRestore();
            host = new AppWorkerHost({
                appId: 'm4_app' as any, desktopId: 'desktop_m4' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
                existingWorker: previousWorker!,
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
                    expect(view.content.value).not.toContain('NO_RUNTIME_INSTANCE');
                }
            }, { timeout: 3_000 });
            const current = readSnapshot(host);
            const currentInspect = Object.values(current.tools).find((tool: any) => tool.name === 'inspect') as any;
            expect(currentInspect.targets).toHaveLength(2);
            expect(currentInspect.targets.every((target: any) => target.viewInstanceId.includes(host!.appInstanceId))).toBe(true);
        } finally {
            host?.terminate();
            await rm(temp, { recursive: true, force: true });
        }
    }, 12_000);
});
