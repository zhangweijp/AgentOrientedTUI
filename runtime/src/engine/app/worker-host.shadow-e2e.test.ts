import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

/**
 * Compiles the ACTUAL Worker entry into a disposable directory, then runs it
 * against a minimal test App implementing the Runtime component factory.
 * The fixture is not an SDK Hook test; that belongs to M3.
 */
describe('M2 real Worker Runtime shadow projection, opt-in', () => {
    it('publishes an AppSnapshot via versioned Worker IPC without replacing the legacy Snapshot', async () => {
        const temp = await mkdtemp(join(tmpdir(), 'aotui-m2-shadow-'));
        const root = resolve(process.cwd()); // Vitest package root = runtime/
        const workerScriptPath = join(temp, 'worker.mjs');
        const fixturePath = join(temp, 'fixture.mjs');
        let host: AppWorkerHost | undefined;
        try {
            await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerScriptPath,
                bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });
            await writeFile(fixturePath, `
                const fixture = {
                  kernelConfig: {
                    appName:'shadow_fixture', name:'Shadow fixture',
                    component: {},
                  },
                  async initializeComponent(container, ctx) {
                    const view = container.ownerDocument.createElement('div');
                    view.setAttribute('data-view-id','workspace');
                    view.setAttribute('data-view-type','Workspace');
                    view.setAttribute('data-view-name','Workspace');
                    view.textContent = 'Task A';
                    container.appendChild(view);
                    ctx.registerView({
                      id:'workspace', name:'Workspace', displayName:'Workspace',
                      render:()=>'Task A',
                      onMount:async()=>{}, onDismount:async()=>{},
                      onOperation:async()=>({success:true}),
                    });
                    ctx.refExporter.registerRef('workspace','selected',{id:'task_a'});
                    ctx.typeTools.registerTypeTool('Workspace','complete_task',{
                      description:'Complete a task',
                      params:{id:{type:'string',required:true}},
                      handler:async()=>({success:true}),
                    });
                    return {render(){},unmount(){}};
                  },
                };
                fixture.kernelConfig.component = fixture;
                export default fixture;
            `, 'utf8');
            host = new AppWorkerHost({
                appId: 'app_0' as any,
                desktopId: 'desktop_0' as any,
                appModulePath: fixturePath,
                workerScriptPath,
                snapshotShadow: true,
            });
            const legacyUpdate = vi.fn();
            host.onUpdateRequest = legacyUpdate;
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(host!.getSnapshotShadowReport()?.health).toBe('ready');
            }, { timeout: 3_000 });
            const report = host.getSnapshotShadowReport()!;
            expect(report).toMatchObject({
                appId: 'app_0',
                instanceId: host.appInstanceId,
                published: 1,
                lastViewCount: 1,
                lastRefCount: 1,
                lastToolCount: 1,
                pairedLegacyFrames: 1,
                unpairedPreparedFrames: 0,
                lastViewCountDelta: 0,
            });
            expect(report.snapshotId).toContain(host.appInstanceId);
            const legacy = host.getSnapshotFragment();
            expect(legacy?.markup).toContain('Task A');
            expect(Object.keys(legacy!.indexMap).some(key => key.includes('selected'))).toBe(true);
            expect(legacyUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);

            // Real physical Worker reuse: RESET must clear Worker shadow state,
            // while a NEW Runtime Host assigns a fresh logical instance token.
            const originalInstance = host.appInstanceId;
            const originalSnapshot = report.snapshotId;
            const reusedWorker = await host.releaseWorker();
            expect(reusedWorker).not.toBeNull();
            expect(host.getSnapshotShadowReport()?.health).toBe('stopped');
            host = new AppWorkerHost({
                appId: 'app_0' as any,
                desktopId: 'desktop_0' as any,
                appModulePath: fixturePath,
                workerScriptPath,
                existingWorker: reusedWorker!,
                snapshotShadow: true,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(host!.getSnapshotShadowReport()?.health).toBe('ready');
            }, { timeout: 3_000 });
            expect(host.appInstanceId).not.toBe(originalInstance);
            expect(host.getSnapshotShadowReport()?.snapshotId).not.toBe(originalSnapshot);
            expect(host.getSnapshotShadowReport()?.revision).toBe(1);
            // A strict-only Tool execution path does not exist here and is not invoked.
        } finally {
            host?.terminate();
            await rm(temp, { recursive: true, force: true });
        }
    }, 10_000);
});
