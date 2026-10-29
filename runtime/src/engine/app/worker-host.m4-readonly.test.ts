import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

describe('M4 Stage 3: D5 SDK compatibility for source-bound READ-ONLY Worker Tools', () => {
    it('rejects unavailable, stale, mutating, unauthorized Tools and preserves the Handler result', async () => {
        const tmp = await mkdtemp(join(tmpdir(), 'aotui-m4-readonly-'));
        const root = resolve(process.cwd());
        const workerFile = join(tmp, 'worker.mjs');
        const appFile = join(tmp, 'app.mjs');
        let host: AppWorkerHost | undefined;
        try {
            const modules = join(tmp, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await mkdir(join(modules, '@preact'), { recursive: true });
            await symlink(join(root, 'node_modules/@preact/signals'), join(modules, '@preact/signals'), 'dir');

            // This is a legacy SDK compatibility check against the current Runtime/Worker.
            // Pin the original D5 package: today's SDK uses ordinary-v2 for parameterized
            // Tools, whose safe wrappers must not execute through this older M4 channel.
            const baseline = process.env.AOTUI_REF_COMPAT_BASELINE ??
                resolve(root, '../rfcs/sdk-runtime-delivery/w00-20261024T090930Z');
            const pack = resolve(baseline, '../w09-c-r1-20261026T223006Z/evidence/07-main-resume/c-packages/pack');
            const sdkArchives = (await readdir(pack)).filter(name => name.startsWith('aotui-sdk-') && name.endsWith('.tgz'));
            expect(sdkArchives).toHaveLength(1);
            const sdkArchive = join(pack, sdkArchives[0]);
            expect(createHash('sha256').update(await readFile(sdkArchive)).digest('hex'))
                .toBe('bdb410d22a2c3553418c60c447f3438959d51733287c33abdd634abdd0f0915d');
            const sdkPackage = join(modules, '@aotui/sdk');
            await mkdir(sdkPackage);
            execFileSync('tar', ['-xzf', sdkArchive, '-C', sdkPackage, '--strip-components=1']);
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerFile, bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { h } from 'preact';
                import { useEffect, useState } from 'preact/hooks';
                import { createTUIApp, View, useViewTypeTool } from '@aotui/sdk';

                function Content() {
                    const [phase, updatePhase] = useState(0);
                    useEffect(() => {
                        const timer = setTimeout(() => updatePhase(1), 600);
                        return () => clearTimeout(timer);
                    }, []);
                    useViewTypeTool('inspect', {
                        description: phase ? 'Inspect version B' : 'Inspect version A',
                        params: {line:{type:'number',required:true}},
                        isMutating:false,
                    }, async ({line}) => ({success:true,data:{file:'App.tsx',line,phase}}));
                    useViewTypeTool('failed', {
                        description:'Fail a read-only query',params:{},isMutating:false,
                    }, async () => ({success:false,error:{
                        code:'BUSINESS_FAILED',message:'Read-only query failed',
                    }}));
                    useViewTypeTool('write', {
                        description:'Mutating command',params:{},
                    }, async () => ({success:true,data:{incorrect:true}}));
                    return h('p',{},'Same markup');
                }
                function App() {
                    return h(View,{id:'fd_0',type:'FileDetail'},h(Content,{}));
                }
                export default createTUIApp({app_name:'m4_readonly',component:App});
            `;
            await build({
                stdin: { contents: fixture, resolveDir: tmp,
                    sourcefile: 'm4-readonly-fixture.tsx', loader: 'tsx' },
                outfile: appFile, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });

            const request = (snapshotId: string, toolName = 'inspect') => ({
                snapshotId,
                toolId: JSON.stringify(['m4_readonly_app', 'FileDetail', toolName]),
                viewId: 'fd_0',
                args: toolName === 'inspect' ? { line: 7 } : {},
            });
            const grant = vi.fn(async (source: any) => source.viewId === 'fd_0');

            // Even with V2 Shadow ready, READ-ONLY IPC is OFF unless separately opted-in.
            host = new AppWorkerHost({
                appId: 'm4_readonly_app' as any,
                desktopId: 'desktop_m4' as any,
                appModulePath: appFile, workerScriptPath: workerFile,
                snapshotShadow: true, experimentalReadOnlyViewTools: false,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(host?.getSnapshotShadowReport()).toMatchObject({
                    health:'ready',lastToolCount:3,
                });
            }, { timeout: 3_000 });
            const disabledSnapshot = host.getSnapshotShadowReport()!.snapshotId!;
            expect(await host.executeReadOnlyViewTool(request(disabledSnapshot), grant))
                .toMatchObject({ success:false,error:{code:'TOOL_UNAVAILABLE'} });
            expect(grant).not.toHaveBeenCalled();

            const worker = await host.releaseWorker();
            expect(worker).not.toBeNull();
            host = new AppWorkerHost({
                appId: 'm4_readonly_app' as any, desktopId: 'desktop_m4' as any,
                appModulePath: appFile, workerScriptPath: workerFile,
                existingWorker: worker!,
                snapshotShadow: true, experimentalReadOnlyViewTools: true,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(host?.getSnapshotShadowReport()).toMatchObject({
                    health:'ready',lastToolCount:3,
                });
            }, { timeout: 3_000 });
            const sourceId = host.getSnapshotShadowReport()!.snapshotId!;
            const readonlyRequest = request(sourceId);

            const noPolicy = await host.executeReadOnlyViewTool(readonlyRequest, () => false);
            expect(noPolicy).toMatchObject({
                success:false,error:{code:'TOOL_PERMISSION_DENIED'},
            });
            const read = await host.executeReadOnlyViewTool(readonlyRequest, grant);
            expect(read).toMatchObject({
                success:true,data:{file:'App.tsx',line:7,phase:0},
            });
            expect(grant).toHaveBeenCalledWith(expect.objectContaining({
                snapshotId: sourceId, viewId:'fd_0',
                viewInstanceId:expect.stringContaining(host.appInstanceId),
                args: { line: 7 },
            }));
            const policyWithResourceCheck = vi.fn((source: any) => {
                expect(Object.isFrozen(source.args)).toBe(true);
                return typeof source.args.line === 'number' && source.args.line <= 10;
            });
            expect(await host.executeReadOnlyViewTool({
                ...readonlyRequest, args: { line: 99 },
            }, policyWithResourceCheck)).toMatchObject({
                success:false,error:{code:'TOOL_PERMISSION_DENIED'},
            });
            expect(policyWithResourceCheck).toHaveBeenCalledTimes(1);

            expect(await host.executeReadOnlyViewTool({
                ...readonlyRequest, args: { line: 'seven' as any },
            }, grant)).toMatchObject({
                success:false,error:{code:'E_INVALID_ARGS'},
            });
            expect(await host.executeReadOnlyViewTool({
                ...readonlyRequest, viewId: 'fd_9',
            }, grant)).toMatchObject({
                success:false,error:{code:'TOOL_UNAVAILABLE'},
            });
            expect(await host.executeReadOnlyViewTool({
                ...readonlyRequest, snapshotId: 'caller-invented',
            }, grant)).toMatchObject({
                success:false,error:{code:'SNAPSHOT_EXPIRED'},
            });
            expect(await host.executeReadOnlyViewTool(readonlyRequest, async () => {
                throw new Error('Policy system unavailable');
            })).toMatchObject({
                success:false,error:{code:'VIEW_TOOL_DISPATCH_FAILED'},
            });

            const businessFail = await host.executeReadOnlyViewTool(request(sourceId, 'failed'), grant);
            expect(businessFail).toMatchObject({
                success:false,error:{code:'BUSINESS_FAILED'},
            });

            const mutating = await host.executeReadOnlyViewTool(request(sourceId, 'write'), grant);
            expect(mutating).toMatchObject({
                success:false,error:{code:'TOOL_PERMISSION_DENIED'},
            });

            const invalidArgs = await host.executeReadOnlyViewTool({
                ...readonlyRequest, args: { line: new Date() as any },
            }, grant);
            expect(invalidArgs).toMatchObject({
                success:false,error:{code:'OPERATION_INVALID_ARGS'},
            });

            // The trusted policy can be asynchronous. Source must be checked
            // AGAIN after policy completion, not only before the await.
            const changedDuringAuthorization = await host.executeReadOnlyViewTool(
                readonlyRequest, async () => {
                    await vi.waitFor(() => {
                        const report = host!.getSnapshotShadowReport()!;
                        expect(report.snapshotId).not.toBe(sourceId);
                        const store = (host as any).shadowReceiver.core.store;
                        const snapshot = store.getById(report.snapshotId).snapshot;
                        expect(snapshot.tools[readonlyRequest.toolId].description)
                            .toBe('Inspect version B');
                    }, { timeout: 3_000 });
                    return true;
                },
            );
            expect(changedDuringAuthorization).toMatchObject({
                success:false, error:{code:'TOOL_SOURCE_STALE'},
            });

            await vi.waitFor(() => {
                const current = host!.getSnapshotShadowReport()!;
                expect(current.snapshotId).not.toBe(sourceId);
                const store = (host as any).shadowReceiver.core.store;
                const snapshot = store.getById(current.snapshotId).snapshot;
                expect(snapshot.tools[readonlyRequest.toolId].description).toBe('Inspect version B');
            }, { timeout: 3_000 });
            const stale = await host.executeReadOnlyViewTool(readonlyRequest, grant);
            expect(stale).toMatchObject({
                success:false,error:{code:'TOOL_SOURCE_STALE'},
            });
            expect((await host.executeReadOnlyViewTool(
                request(host.getSnapshotShadowReport()!.snapshotId!), grant,
            ))).toMatchObject({success:true,data:{file:'App.tsx',phase:1}});

            // Diagnostic only: end-to-end Host policy + V2 lease validation +
            // Worker IPC + SDK Handler. No LSP, model, file IO or production SLA.
            const roundTrips: number[] = [];
            const currentId = host.getSnapshotShadowReport()!.snapshotId!;
            for (let i = 0; i < 25; i++) {
                const started = performance.now();
                const response = await host.executeReadOnlyViewTool(request(currentId), grant);
                expect(response.success).toBe(true);
                roundTrips.push(performance.now() - started);
            }
            const sorted = [...roundTrips].sort((a, b) => a - b);
            const percentile = (p: number) =>
                Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 1000) / 1000;
            console.log('M4_READONLY_WORKER_DIAGNOSTIC=' + JSON.stringify({
                count: roundTrips.length, p50_ms: percentile(0.50),
                p95_ms: percentile(0.95), max_ms: percentile(1),
                note: 'host policy + V2 leases + Worker IPC + SDK Handler; no IDE/LSP or model',
            }));
            expect(Object.keys(host.getSnapshotFragment()!.indexMap)
                .some(key => key.startsWith('tool:') && key.includes('inspect'))).toBe(false);

            // The physical Worker can be reused, but the opt-in execution
            // capability must not survive RESET into the next App instance.
            const priorAppInstance = host.appInstanceId;
            const reusedWorker = await host.releaseWorker();
            expect(reusedWorker).not.toBeNull();
            host = new AppWorkerHost({
                appId: 'm4_readonly_app' as any, desktopId: 'desktop_m4' as any,
                appModulePath: appFile, workerScriptPath: workerFile,
                existingWorker: reusedWorker!,
                snapshotShadow: true, experimentalReadOnlyViewTools: false,
            });
            expect(host.appInstanceId).not.toBe(priorAppInstance);
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(host!.getSnapshotShadowReport()).toMatchObject({
                    health:'ready',lastToolCount:3,
                });
            }, { timeout: 3_000 });
            expect(await host.executeReadOnlyViewTool(
                request(host.getSnapshotShadowReport()!.snapshotId!), grant,
            )).toMatchObject({ success:false,error:{code:'TOOL_UNAVAILABLE'} });
            expect(await host.executeReadOnlyViewTool(readonlyRequest, grant))
                .toMatchObject({ success:false,error:{code:'TOOL_UNAVAILABLE'} });
        } finally {
            host?.terminate();
            await rm(tmp, { recursive: true, force: true });
        }
    }, 15_000);
});
