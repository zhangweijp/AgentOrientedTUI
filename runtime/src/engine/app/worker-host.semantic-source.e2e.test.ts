import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { refKey } from '../../core/snapshot/snapshot-support.js';
import { acquireToolSource } from '../../core/tool/source-binding.js';

describe('M4 Stage 2: real Worker Semantic source-bound publication', () => {
    it('publishes a ViewType Tool activation and Ref source in one accepted V3 commit', async () => {
        const tmp = await mkdtemp(join(tmpdir(), 'aotui-m4-v2-'));
        const root = resolve(process.cwd()); // runtime/
        const worker = join(tmp, 'worker.mjs');
        const app = join(tmp, 'app.mjs');
        let host: AppWorkerHost | undefined;
        let releaseSource: (() => void) | undefined;
        try {
            const modules = join(tmp, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')], outfile: worker,
                bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });

            const fixture = `
                import { h } from 'preact';
                import Type from 'typebox';
                import { useState, useEffect } from 'preact/hooks';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { View } from './sdk/src/components/View.tsx';
                import { useDataRef } from './sdk/src/hooks/useRef.ts';
                import { AppTools } from './sdk/src/components/AppTools.tsx';
                import { defineToolSet, defineViewTypeTool } from './sdk/src/tools/view-type-tool.ts';

                function Content({ selected }) {
                    const ref = useDataRef('selection', selected);
                    return h('section', {}, [
                        h('p', {key:'ref'}, ref('Stable label')),
                        h('span', {}, 'Replace file'),
                        h('span', {}, 'Inspect'),
                    ]);
                }

const fixtureToolSets = [false, true].map(schemaChanged => defineToolSet({
ReplaceUI: defineViewTypeTool({
                        viewType: 'FileDetail', name: 'replace_file',
                        description: 'Apply an explicitly authorized mutation',
                        inputSchema: Type.Object({}, {additionalProperties:false}), }),
InspectUI: defineViewTypeTool({
                        viewType: 'FileDetail', name: 'inspect', description: 'Inspect current FileDetail',
                        inputSchema: schemaChanged
                            ? Type.Object({line:Type.Number()}, {additionalProperties:false})
                            : Type.Object({}, {additionalProperties:false}),
                    })
}));
function App() {
                    const [mounted, mount] = useState(true);
                    const [selected, select] = useState({ file: 'A' });
                    const [schemaChanged, setSchemaChanged] = useState(false);
const fixtureTools0 = fixtureToolSets[Number(schemaChanged)];
                    useEffect(() => {
                        const refTimer = setTimeout(() => select({ file: 'B' }), 180);
                        const schemaTimer = setTimeout(() => setSchemaChanged(true), 300);
                        const close = setTimeout(() => mount(false), 420);
                        const reopen = setTimeout(() => mount(true), 560);
                        return () => { clearTimeout(refTimer); clearTimeout(schemaTimer); clearTimeout(close); clearTimeout(reopen); };
                    }, []);
                    return h('main', {}, [h(AppTools, { key: String(schemaChanged), ...({ definition: fixtureTools0, bindings: {
ReplaceUI: { execute: async () => ({ success: true }) },
InspectUI: { execute: async () => ({ success: true, data: { from: selected.file } }) }
} }) }), mounted
                        ? h(View, {kind: 'state',id:'fd_0',type:'FileDetail'}, h(Content,{selected}))
                        : h('p', {}, 'Closed')]);
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
            const getV3 = () => {
                const report = host!.getSemanticSnapshotReport()!;
                expect(report?.health).toBe('ready');
                const store = (host as any).snapshotReceiver.core.store;
                const lookup = store.getById(report.snapshotId);
                expect(lookup.status).toBe('found');
                const snapshot = lookup.snapshot;
                expect(snapshot.schemaVersion).toBe(3);
                return snapshot;
            };
            await vi.waitFor(() => {
                const current = getV3();
                expect(current.tools).toHaveProperty(JSON.stringify(['m4_app', 'FileDetail', 'inspect']));
                expect(current.views).toHaveLength(1);
            }, { timeout: 3_000 });
            const old = getV3();
            const sourceStore = (host as any).snapshotReceiver.core.store;
            const toolId = JSON.stringify(['m4_app', 'FileDetail', 'inspect']);
            const oldExecution = old.tools[toolId].execution;
            expect(oldExecution).toMatchObject({ kind: 'view-type', activationId: expect.any(String) });
            expect(old.tools[toolId]).not.toHaveProperty('targets');
            const request = (snapshotId: string, execution: any = oldExecution) => ({
                snapshotId, appId: 'm4_app', instanceId: host!.appInstanceId,
                toolId, execution,
            });
            const held = sourceStore.acquire(old.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
            releaseSource = held.lease.release;
            const initiallySelected = acquireToolSource(sourceStore, request(old.id));
            expect(initiallySelected).toMatchObject({
                status: 'found', execution: oldExecution,
            });
            if (initiallySelected.status === 'found') initiallySelected.release();
            const boundA = old.views[0].viewInstanceId;
            expect(boundA).toContain(host.appInstanceId);
            expect(old.refs[refKey('fd_0', boundA, 'selection')].target.payload)
                .toMatchObject({ file: 'A' });
            expect(Object.isFrozen(old.tools[toolId].execution)).toBe(true);
            expect(JSON.stringify(old.tools[toolId])).not.toContain('handler');
            expect(old.views[0].content.value).toContain('Stable label');

            await vi.waitFor(() => {
                const current = getV3();
                expect(current.refs[refKey('fd_0', boundA, 'selection')].target.payload)
                    .toMatchObject({ file: 'B' });
            }, { timeout: 3_000 });
            const updated = getV3();
            expect(updated.id).not.toBe(old.id);
            expect(updated.views[0].viewInstanceId).toBe(boundA);
            expect(updated.tools[toolId].execution).toEqual(oldExecution);
            expect(old.refs[refKey('fd_0', boundA, 'selection')].target.payload)
                .toMatchObject({ file: 'A' }); // prior source cannot be rebound
            // A Ref-only update does not revoke a still-identical Tool binding.
            const refOnly = acquireToolSource(sourceStore, request(old.id));
            expect(refOnly.status).toBe('found');
            if (refOnly.status === 'found') refOnly.release();

            // Tool schema/binding version changes WITHOUT changing the View
            // markup or Ref. The V2 Snapshot must publish a new Revision.
            await vi.waitFor(() => {
                const current = getV3();
                expect(current.views[0].viewInstanceId).toBe(boundA);
                expect(current.tools[toolId].execution).not.toEqual(oldExecution);
                expect(current.tools[toolId].inputSchema)
                    .toMatchObject({ properties: { line: { type: 'number' } } });
            }, { timeout: 3_000 });
            const toolUpdated = getV3();
            expect(toolUpdated.revision).toBeGreaterThan(updated.revision);
            expect(updated.tools[toolId].execution).toEqual(oldExecution);
            expect(acquireToolSource(sourceStore, request(old.id)))
                .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } });

            await vi.waitFor(() => {
                const current = getV3();
                expect(current.views[0].viewInstanceId).not.toBe(boundA);
            }, { timeout: 3_000 });
            const reopened = getV3();
            expect(reopened.tools[toolId].execution.kind).toBe('view-type');
            expect(reopened.tools[toolId].execution).not.toEqual(toolUpdated.tools[toolId].execution);
            expect(reopened.revision).toBeGreaterThan(updated.revision);
            expect(host.getSemanticSnapshotReport()?.health).toBe('ready');
            expect(acquireToolSource(sourceStore, request(old.id)))
                .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } });
            expect(sourceStore.getById(old.id)).toMatchObject({
                status: 'found', snapshot: { id: old.id },
            });
            expect(sourceStore.resolveRef({
                snapshotId: reopened.id, appId: 'm4_app', instanceId: host.appInstanceId,
                viewId: 'fd_0', viewInstanceId: boundA, refId: 'selection',
            })).toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
        } finally {
            releaseSource?.();
            host?.terminate();
            await rm(tmp, { recursive: true, force: true });
        }
    }, 12_000);
});
