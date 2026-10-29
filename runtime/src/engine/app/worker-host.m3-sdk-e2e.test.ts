import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { refKey } from '../../core/snapshot/index.js';

/**
 * M3 real Worker + bundled REAL SDK createTUIApp + Preact hooks.
 * Task object A -> B after initial commit, while rendered DOM stays identical.
 */
describe('M3 real Worker / SDK projection round trip', () => {
    it('advances the Shadow Snapshot on a Ref-only update without DOM mutation', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'aotui-m3-'));
        const root = resolve(process.cwd()); // runtime/
        let host: AppWorkerHost | undefined;
        try {
            // Isolated module resolution: DO NOT write into the original node_modules.
            const modules = join(temporary, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            const workerPath = join(temporary, 'worker.mjs');
            const appPath = join(temporary, 'app.mjs');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerPath, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const sdkFixture = `
                import { h } from 'preact';
                import { useEffect, useState } from 'preact/hooks';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { View } from './sdk/src/components/View.tsx';
                import { useAppRuntimeContext } from './sdk/src/context/AppRuntimeContext.tsx';
                import { useDataRef } from './sdk/src/hooks/useRef.ts';
                import { useArrayRef } from './sdk/src/hooks/useArrayRef.ts';
                import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';
                const params = {};
                function Content() {
                    const appId = useAppRuntimeContext().appId;
                    const [target, setTarget] = useState({ id: 'A' });
                    useEffect(() => {
                        const timer = setTimeout(() => setTarget({ id: 'B' }), 240);
                        return () => clearTimeout(timer);
                    }, []);
                    const selected = useDataRef('selected', target);
                    const [listLabel, itemLabel] = useArrayRef('pending', [target], { itemType: 'Task' });
                    const [ToolUI] = useViewTypeTool('Workspace', 'complete', {
                        description: 'Complete selected task', params,
                    }, async () => ({ success: true }));
                    return h('section', {}, [
                        h('p', {key:'selected'}, selected('Stable task label')),
                        h('p', {key:'list'}, listLabel('Stable list label')),
                        h('p', {key:'item'}, itemLabel(0, 'Stable task label')),
                        h('p', {key:'app-id'}, 'App=' + appId),
                        h(ToolUI, {key:'tool'}, 'Complete'),
                    ]);
                }
                function Root() {
                    return h(View, {id:'workspace',type:'Workspace'}, h(Content,{}));
                }
                export default createTUIApp({app_name:'m3_integration',component:Root});
            `;
            await build({
                stdin: {
                    contents: sdkFixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'm3-sdk-fixture.tsx', loader: 'tsx',
                },
                outfile: appPath, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            host = new AppWorkerHost({
                appId: 'm3_app' as any, desktopId: 'desktop_m3' as any,
                appModulePath: appPath, workerScriptPath: workerPath,
                snapshotShadow: true,
            });
            await host.start();
            await host.open();
            await import('vitest').then(({ vi }) => vi.waitFor(() => {
                expect(host?.getSnapshotShadowReport()).toMatchObject({
                    health: 'ready', revision: 1, lastViewCount: 1,
                    lastRefCount: 5, lastToolCount: 1,
                });
            }, { timeout: 3_000 }));
            const initial = host.getSnapshotShadowReport()!;
            // Test-only inspection of the private shadow Store; no production
            // API exposes Ref payload or enables Tool execution in Shadow mode.
            const shadowCore = (host as any).shadowReceiver.core;
            const oldRead = shadowCore.store.getById(initial.snapshotId);
            expect(oldRead.status).toBe('found');
            const oldGeneration = oldRead.snapshot.views[0].generation;
            const oldRefKey = refKey('workspace', oldGeneration, 'Task:pending[0]');
            expect(oldRead.snapshot.refs[oldRefKey].target.payload).toMatchObject({ id: 'A' });
            const markup = host.getSnapshotFragment()!.markup;
            expect(markup).toContain('Stable task label');
            expect(markup).toContain('App=m3_app');
            await import('vitest').then(({ vi }) => vi.waitFor(() => {
                expect(host?.getSnapshotShadowReport()).toMatchObject({
                    health: 'ready', revision: 2,
                    lastViewCount: 1, lastRefCount: 5, lastToolCount: 1,
                });
            }, { timeout: 3_000 }));
            const changed = host.getSnapshotShadowReport()!;
            expect(changed.published).toBeGreaterThanOrEqual(2);
            expect(changed.snapshotId).not.toBe(initial.snapshotId);
            const newRead = shadowCore.store.getById(changed.snapshotId);
            expect(newRead.status).toBe('found');
            expect(newRead.snapshot.views[0].generation).toBe(oldGeneration);
            const newRefKey = refKey('workspace', oldGeneration, 'Task:pending[0]');
            expect(newRead.snapshot.refs[newRefKey].target.payload).toMatchObject({ id: 'B' });
            expect(newRead.snapshot.tools['m3_app-Workspace-complete']).toMatchObject({
                declaredByViewId: 'workspace',
                declaredByViewGeneration: oldGeneration,
                viewType: 'Workspace',
                visible: true,
            });
            // A historical Ref is pinned to its original object even when the
            // same visible Ref ID is reused in a new Snapshot.
            expect(oldRead.snapshot.refs[oldRefKey].target.payload).toMatchObject({ id: 'A' });
            expect(host.getSnapshotFragment()?.markup).toBe(markup);
            expect(changed.producerConsistency).toBe('unverified'); // Still Shadow!
            expect(changed.strictEligible).toBe(false);

            // Verify the DEFAULT legacy path also responds to semantic-only
            // Ref updates; the Shadow flag must not be required for correctness.
            host.terminate();
            host = new AppWorkerHost({
                appId: 'm3_app' as any, desktopId: 'desktop_m3' as any,
                appModulePath: appPath, workerScriptPath: workerPath,
                snapshotShadow: false,
            });
            await host.start();
            await host.open();
            expect(host.getSnapshotShadowReport()).toBeNull();
            const originalLegacy = host.getSnapshotFragment()!;
            expect((originalLegacy.indexMap as any)['workspace:selected']?.id).toBe('A');
            await import('vitest').then(({ vi }) => vi.waitFor(() => {
                expect((host?.getSnapshotFragment()?.indexMap as any)['workspace:selected']?.id).toBe('B');
            }, { timeout: 3_000 }));
            expect(host.getSnapshotFragment()?.markup).toBe(originalLegacy.markup);
        } finally {
            host?.terminate();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 12_000);
});
