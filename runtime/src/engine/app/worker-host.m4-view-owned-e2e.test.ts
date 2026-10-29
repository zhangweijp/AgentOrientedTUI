import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

describe('M4 Stage 1: actual WorkerHost + Runtime-issued View identity + SDK local Tool', () => {
    it('runs without Shadow, inherits trusted Host instance identity, and does NOT leak local Tools into Agent index', async () => {
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
                snapshotShadow: false,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                const fragment = host!.getSnapshotFragment();
                expect(fragment?.markup).toContain('App.tsx Instance=vi:v1:');
                expect(fragment?.markup).toContain('package.json Instance=vi:v1:');
                expect(fragment?.markup).toContain(host!.appInstanceId);
            }, { timeout: 3_000 });

            const legacy = host.getSnapshotFragment()!;
            expect(legacy.markup).toContain(host.appInstanceId);
            expect(legacy.markup).not.toContain('NO_RUNTIME_INSTANCE');
            expect(host.getSnapshotShadowReport()).toBeNull();
            expect(Object.keys(legacy.indexMap).some(key =>
                key.startsWith('tool:') && key.includes('inspect'))).toBe(false);

            // A managed close ends this port; remounting requires RESET and a new Host.
            const before = legacy.markup;
            const physical = (host as any).worker;
            const threadId = physical.threadId;
            await host.close();
            const posted = vi.spyOn(physical, 'postMessage');
            await expect(host.open()).rejects.toThrow(/shutdown is pending/);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(posted).not.toHaveBeenCalled();
            expect(host.getSnapshotFragment()?.markup).toBe(before);

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
                existingWorker: previousWorker!, snapshotShadow: false,
            });
            expect(host.appInstanceId).not.toBe(oldExecution);
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                const current = host!.getSnapshotFragment()?.markup;
                expect(current).toContain('App.tsx Instance=vi:v1:');
                expect(current).toContain('package.json Instance=vi:v1:');
                expect(current).toContain(host!.appInstanceId);
                expect(current).not.toContain(oldExecution);
                expect(current).not.toContain('NO_RUNTIME_INSTANCE');
                expect(current).not.toBe(before);
            }, { timeout: 3_000 });
            expect(host.getSnapshotShadowReport()).toBeNull();
            expect(Object.keys(host.getSnapshotFragment()!.indexMap).some(key => key.startsWith('tool:') && key.includes('inspect'))).toBe(false);
        } finally {
            host?.terminate();
            await rm(temp, { recursive: true, force: true });
        }
    }, 12_000);
});
