import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { refKey } from '../../core/snapshot/snapshot-support.js';
import { acquireToolSource } from '../../core/tool/source-binding.js';

describe('M4 Stage 2: real Worker Semantic source-bound publication', () => {
    it('publishes immutable View-instance/Tool targets in one accepted V2 commit', async () => {
        const tmp = await mkdtemp(join(tmpdir(), 'aotui-m4-v2-'));
        const root = resolve(process.cwd()); // runtime/
        const worker = join(tmp, 'worker.mjs');
        const app = join(tmp, 'app.mjs');
        let host: AppWorkerHost | undefined;
        try {
            const modules = join(tmp, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')], outfile: worker,
                bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });

            const fixture = `
                import { h } from 'preact';
                import { useState, useEffect } from 'preact/hooks';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { View } from './sdk/src/components/View.tsx';
                import { useDataRef } from './sdk/src/hooks/useRef.ts';
                import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';

                function Content() {
                    const [selected, select] = useState({ file: 'A' });
                    const [schemaChanged, setSchemaChanged] = useState(false);
                    useEffect(() => {
                        const refTimer = setTimeout(() => select({ file: 'B' }), 180);
                        const schemaTimer = setTimeout(() => setSchemaChanged(true), 300);
                        return () => { clearTimeout(refTimer); clearTimeout(schemaTimer); };
                    }, []);
                    const ref = useDataRef('selection', selected);
                    useViewTypeTool('replace_file', {
                        description: 'Apply an explicitly authorized mutation',
                        params: {},
                    }, async () => ({ success: true }));
                    const [InspectUI] = useViewTypeTool('inspect', {
                        description: 'Inspect current FileDetail',
                        params: schemaChanged ? { line: {type: 'number'} } : {},
                    }, async () => ({ success: true, data: { from: selected.file } }));
                    return h('section', {}, [
                        h('p', {key:'ref'}, ref('Stable label')),
                        h(InspectUI, {key:'tool'}, 'Inspect'),
                    ]);
                }
                function App() {
                    const [mounted, mount] = useState(true);
                    useEffect(() => {
                        const close = setTimeout(() => mount(false), 420);
                        const reopen = setTimeout(() => mount(true), 560);
                        return () => { clearTimeout(close); clearTimeout(reopen); };
                    }, []);
                    return mounted
                        ? h(View, {id:'fd_0',type:'FileDetail'}, h(Content,{}))
                        : h('p', {}, 'Closed');
                }
                export default createTUIApp({app_name:'m4_v2_fixture',component:App});
            `;
            await build({
                stdin: {
                    contents: fixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'm4-v2-sdk-fixture.tsx', loader: 'tsx',
                },
                outfile: app, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });

            host = new AppWorkerHost({
                appId: 'm4_app' as any, desktopId: 'desktop_m4' as any,
                appModulePath: app, workerScriptPath: worker,
            });
            await host.start();
            await host.open();
            const getV2 = () => {
                const report = host!.getSemanticSnapshotReport()!;
                expect(report?.health).toBe('ready');
                const store = (host as any).snapshotReceiver.core.store;
                const lookup = store.getById(report.snapshotId);
                expect(lookup.status).toBe('found');
                const snapshot = lookup.snapshot;
                expect(snapshot.schemaVersion).toBe(2);
                return snapshot;
            };
            await vi.waitFor(() => {
                const current = getV2();
                expect(current.tools).toHaveProperty(JSON.stringify(['m4_app', 'FileDetail', 'inspect']));
                expect(current.views).toHaveLength(1);
            }, { timeout: 3_000 });
            const old = getV2();
            const sourceStore = (host as any).snapshotReceiver.core.store;
            const toolId = JSON.stringify(['m4_app', 'FileDetail', 'inspect']);
            const request = (snapshotId: string) => ({
                snapshotId, appId: 'm4_app', instanceId: host!.appInstanceId,
                toolId, viewId: 'fd_0',
            });
            const initiallySelected = acquireToolSource(sourceStore, request(old.id));
            expect(initiallySelected).toMatchObject({
                status: 'found', target: { viewInstanceId: old.views[0].viewInstanceId },
            });
            if (initiallySelected.status === 'found') initiallySelected.release();
            const boundA = old.views[0].viewInstanceId;
            const targetA = old.tools[toolId].targets[0];
            expect(targetA).toMatchObject({ viewId: 'fd_0', viewInstanceId: boundA,
                bindingVersion: expect.any(Number),
            });
            expect(targetA.bindingVersion).toBeGreaterThan(0);
            expect(boundA).toContain(host.appInstanceId);
            expect(old.refs[refKey('fd_0', boundA, 'selection')].target.payload)
                .toMatchObject({ file: 'A' });
            expect(Object.isFrozen(old.tools[toolId].targets)).toBe(true);
            expect(JSON.stringify(old.tools[toolId])).not.toContain('handler');
            expect(old.views[0].content.value).toContain('Stable label');

            await vi.waitFor(() => {
                const current = getV2();
                expect(current.refs[refKey('fd_0', boundA, 'selection')].target.payload)
                    .toMatchObject({ file: 'B' });
            }, { timeout: 3_000 });
            const updated = getV2();
            expect(updated.id).not.toBe(old.id);
            expect(updated.views[0].viewInstanceId).toBe(boundA);
            expect(updated.tools[toolId].targets[0].bindingVersion).toBe(targetA.bindingVersion);
            expect(old.refs[refKey('fd_0', boundA, 'selection')].target.payload)
                .toMatchObject({ file: 'A' }); // prior source cannot be rebound
            // A Ref-only update does not revoke a still-identical Tool binding.
            const refOnly = acquireToolSource(sourceStore, request(old.id));
            expect(refOnly.status).toBe('found');
            if (refOnly.status === 'found') refOnly.release();

            // Tool schema/binding version changes WITHOUT changing the View
            // markup or Ref. The V2 Snapshot must publish a new Revision.
            await vi.waitFor(() => {
                const current = getV2();
                expect(current.views[0].viewInstanceId).toBe(boundA);
                expect(current.tools[toolId].targets[0].bindingVersion)
                    .toBeGreaterThan(targetA.bindingVersion);
                expect(current.tools[toolId].inputSchema)
                    .toMatchObject({ properties: { line: { type: 'number' } } });
            }, { timeout: 3_000 });
            const toolUpdated = getV2();
            expect(toolUpdated.revision).toBeGreaterThan(updated.revision);
            expect(updated.tools[toolId].targets[0].bindingVersion).toBe(targetA.bindingVersion);
            expect(acquireToolSource(sourceStore, request(old.id)))
                .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } });

            await vi.waitFor(() => {
                const current = getV2();
                expect(current.views[0].viewInstanceId).not.toBe(boundA);
            }, { timeout: 3_000 });
            const reopened = getV2();
            expect(reopened.tools[toolId].targets[0].viewInstanceId)
                .toBe(reopened.views[0].viewInstanceId);
            expect(reopened.revision).toBeGreaterThan(updated.revision);
            expect(host.getSemanticSnapshotReport()?.health).toBe('ready');
            expect(acquireToolSource(sourceStore, request(old.id)))
                .toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
            expect(sourceStore.getById(old.id)).toMatchObject({
                status: 'found', snapshot: { id: old.id },
            });
            expect(sourceStore.resolveRef({
                snapshotId: reopened.id, appId: 'm4_app', instanceId: host.appInstanceId,
                viewId: 'fd_0', viewInstanceId: boundA, refId: 'selection',
            })).toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
        } finally {
            host?.terminate();
            await rm(tmp, { recursive: true, force: true });
        }
    }, 12_000);
});
