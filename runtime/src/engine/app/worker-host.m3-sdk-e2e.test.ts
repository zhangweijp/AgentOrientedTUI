import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { refKey } from '../../core/snapshot/snapshot-support.js';

/**
 * M3 real Worker + bundled REAL SDK createTUIApp + Preact hooks.
 * Task object A -> B after initial commit, while rendered DOM stays identical.
 */
describe('Semantic real Worker / SDK projection round trip', () => {
    it('advances the accepted Snapshot on a Ref-only update without DOM mutation', async () => {
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
                import { useLayoutEffect, useState } from 'preact/hooks';
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
                    useLayoutEffect(() => {
                        const onExternalEvent = event => {
                            if (event.detail?.type === 'replace-target') {
                                setTarget({ id: event.detail.data.id });
                            }
                        };
                        document.addEventListener('aotui:external-event', onExternalEvent);
                        return () => document.removeEventListener('aotui:external-event', onExternalEvent);
                    }, []);
                    const selected = useDataRef('selected', target);
                    const [listLabel, itemLabel] = useArrayRef('pending', [target], { itemType: 'Task' });
                    const [ToolUI] = useViewTypeTool('complete', {
                        description: 'Complete selected task', params, isMutating: false,
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
            });
            await host.start();
            await host.open();
            await import('vitest').then(({ vi }) => vi.waitFor(() => {
                expect(host?.getSemanticSnapshotReport()).toMatchObject({
                    health: 'ready', revision: 1, lastViewCount: 1,
                    lastRefCount: 3, lastToolCount: 1,
                });
            }, { timeout: 3_000 }));
            const initial = host.getSemanticSnapshotReport()!;
            // Test-only inspection of the accepted Store; no production API
            // exposes mutable Ref payload or bypasses source-bound execution.
            const semanticCore = (host as any).snapshotReceiver.core;
            const oldRead = semanticCore.store.getById(initial.snapshotId);
            expect(oldRead.status).toBe('found');
            const oldViewInstanceId = oldRead.snapshot.views[0].viewInstanceId;
            const oldRefKey = refKey('workspace', oldViewInstanceId, 'Task:pending[0]');
            expect(oldRead.snapshot.refs[oldRefKey].target.payload).toMatchObject({ id: 'A' });
            const markup = oldRead.snapshot.views[0].content.value;
            expect(markup).toContain('Stable task label');
            expect(markup).toContain('App=m3_app');
            await host.sendExternalEvent('workspace' as any, 'replace-target', { id: 'B' });
            await import('vitest').then(({ vi }) => vi.waitFor(() => {
                const report = host?.getSemanticSnapshotReport();
                expect(report?.health).toBe('ready');
                expect(report?.revision).toBeGreaterThan(initial.revision);
                expect(report).toMatchObject({ lastViewCount: 1, lastRefCount: 3, lastToolCount: 1 });
            }, { timeout: 3_000 }));
            const changed = host.getSemanticSnapshotReport()!;
            expect(changed.published).toBeGreaterThanOrEqual(2);
            expect(changed.snapshotId).not.toBe(initial.snapshotId);
            const newRead = semanticCore.store.getById(changed.snapshotId);
            expect(newRead.status).toBe('found');
            expect(newRead.snapshot.views[0].viewInstanceId).toBe(oldViewInstanceId);
            const newRefKey = refKey('workspace', oldViewInstanceId, 'Task:pending[0]');
            expect(newRead.snapshot.refs[newRefKey].target.payload).toMatchObject({ id: 'B' });
            expect(Object.values(newRead.snapshot.tools).find((tool: any) => tool.name === 'complete')).toMatchObject({
                targets: [{ viewId: 'workspace', viewInstanceId: oldViewInstanceId }],
                viewType: 'Workspace',
            });
            // A historical Ref is pinned to its original object even when the
            // same visible Ref ID is reused in a new Snapshot.
            expect(oldRead.snapshot.refs[oldRefKey].target.payload).toMatchObject({ id: 'A' });
            expect(newRead.snapshot.views[0].content.value).toBe(markup);
            expect(changed.health).toBe('ready');
        } finally {
            host?.terminate();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 12_000);
});
