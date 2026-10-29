import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { AppWorkerHost } from './worker-host.js';
import { acquireVersionedEntitySource } from '../../core/tool/source-binding.js';
import { refKey } from '../../core/snapshot/index.js';
import { fileSystemService } from '../../../../demo-apps/aotui-ide/src/core/file-system-service.js';

/** Real SDK+Worker→V2 Store entity Ref→versioned IDE adapter, still NO Agent writes. */
describe('M4 Stage 5 real Worker source-to-file safety', () => {
    it('rejects stale files and mutating Worker Tool requests, then writes only via explicit filesystem CAS', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-real-versioned-worker-'));
        const workspace = join(directory, 'workspace');
        const file = join(workspace, 'src', 'App.tsx');
        const root = resolve(process.cwd());
        const workerScript = join(directory, 'worker.mjs');
        const appScript = join(directory, 'app.mjs');
        let host: AppWorkerHost | undefined;
        try {
            await mkdir(join(workspace, 'src'), { recursive: true });
            await fs.writeFile(file, 'const value = 1;\n');
            const source = await fileSystemService.readVersionedFile(workspace, file);

            const modules = join(directory, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerScript, bundle: true, platform: 'node', format: 'esm',
                target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { h } from 'preact';
                import { useLayoutEffect, useState } from 'preact/hooks';
                import { readFile } from 'node:fs/promises';
                import { createHash } from 'node:crypto';
                import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                import { View } from './sdk/src/components/View.tsx';
                import { useEntityRef } from './sdk/src/hooks/useRef.ts';
                import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';
                const path = ${JSON.stringify(file)};
                const version = ${JSON.stringify(source.version)};
                function Detail() {
                    const [versionObserved, setVersionObserved] = useState(version);
                    const [revision, setRevision] = useState(0);
                    useLayoutEffect(() => {
                        const onExternal = async (event) => {
                            if (event.detail?.viewId !== 'fd_0') return;
                            if (event.detail?.type === 'change_tool') {
                                setRevision(value => value + 1);
                                return;
                            }
                            if (event.detail?.type !== 'refresh_version') return;
                            const bytes = await readFile(path);
                            setVersionObserved('sha256:' + createHash('sha256').update(bytes).digest('hex'));
                        };
                        document.body.addEventListener('aotui:external-event', onExternal);
                        return () => document.body.removeEventListener('aotui:external-event', onExternal);
                    }, []);
                    const ref = useEntityRef('file', {
                        entityType:'File',entityId:path,entityVersion:versionObserved,
                    });
                    useViewTypeTool('delete_file', {
                        description:'Delete the file, not replace its content', params:{},
                        isMutating:true,
                    }, async () => ({success:false,error:{code:'DELETE_NOT_ALLOWED'}}));
                    useViewTypeTool('replace_file', {
                        description:revision ? 'Replace file revision 2' : 'Replace this file at its expected version',
                        params:{},isMutating:true,
                    }, async () => ({success:false,error:{
                        code:'UNEXPECTED_HANDLER',message:'Direct mutation must stay disabled',
                    }}));
                    return h('p',{},ref('Current file'));
                }
                function App() { return h(View,{id:'fd_0',type:'FileDetail'},h(Detail,{})); }
                export default createTUIApp({app_name:'versioned_fixture',component:App});
            `;
            await build({
                stdin: {
                    contents: fixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'm4-versioned-fixture.tsx', loader: 'tsx',
                },
                outfile: appScript, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });

            host = new AppWorkerHost({
                appId: 'versioned_app' as any,
                desktopId: 'versioned_desktop' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
                snapshotShadow: true, experimentalReadOnlyViewTools: true,
                experimentalVersionedMutations: true,
            });
            await host.start();
            await host.open();
            const toolId = JSON.stringify(['versioned_app', 'FileDetail', 'replace_file']);
            const latest = () => host!.getSnapshotShadowReport()!;
            await vi.waitFor(() => {
                expect(latest()).toMatchObject({
                    health: 'ready', lastViewCount: 1, lastToolCount: 2,
                });
                expect(latest().snapshotId).toContain(host!.appInstanceId);
            }, { timeout: 3_000 });

            const query = () => ({
                snapshotId: latest().snapshotId!,
                appId: 'versioned_app', instanceId: host!.appInstanceId,
                toolId, viewId: 'fd_0', refId: 'file',
            });
            const writeRequest = (newContent: string) => ({
                snapshotId: latest().snapshotId!,
                toolId, viewId: 'fd_0', refId: 'file', newContent,
            });
            const policy = vi.fn(async (scope: any) => {
                expect(scope).toMatchObject({
                    appId: 'versioned_app', appInstanceId: host!.appInstanceId,
                    filePath: file, expectedVersion: expect.stringMatching(/^sha256:/),
                    viewId: 'fd_0', toolId,
                    viewInstanceId: expect.stringContaining(host!.appInstanceId),
                });
                expect(Object.isFrozen(scope)).toBe(true);
                return true;
            });
            const adapter = vi.fn(async (src: {
                filePath: string; expectedVersion: string; newContent: string;
            }) => fileSystemService.replaceFileIfVersion(
                workspace, src.filePath, src.expectedVersion, src.newContent,
            ));
            const store = (host as any).shadowReceiver.core.store;
            const selected = acquireVersionedEntitySource(store, query());
            expect(selected).toMatchObject({
                status: 'found',
                resource: { entityType: 'File', entityId: file, entityVersion: source.version },
            });
            if (selected.status !== 'found') throw Error('Expected versioned source');
            let finalWritten = '';

            try {
                expect(await host.executeReadOnlyViewTool({
                    snapshotId: selected.snapshotId, toolId, viewId: 'fd_0', args: {},
                }, () => true)).toMatchObject({
                    success: false, error: { code: 'TOOL_PERMISSION_DENIED' },
                });
                expect(Object.keys(host.getSnapshotFragment()!.indexMap)
                    .some(key => key.startsWith('tool:') && key.includes('replace_file'))).toBe(false);

                expect(await host.executeVersionedFileReplace(
                    writeRequest('UNAUTHORIZED'), () => false, adapter,
                )).toMatchObject({ success: false,
                    error: { code: 'TOOL_PERMISSION_DENIED' } });
                expect(await host.executeVersionedFileReplace({
                    ...writeRequest('WRONG OPERATION'),
                    toolId: JSON.stringify(['versioned_app', 'FileDetail', 'delete_file']),
                }, () => true, adapter)).toMatchObject({
                    success: false, error: { code: 'TOOL_PERMISSION_DENIED' },
                });
                expect(adapter).not.toHaveBeenCalled();

                // Strictly copy the complete envelope before reading accessors
                // or awaiting a policy. A Proxy is not an isolation boundary:
                // reflection traps may run, but failures must never reach policy/IO.
                const invalidPolicy = vi.fn(() => true);
                let selectionGetterCalls = 0;
                const accessor = Object.defineProperty(writeRequest('BAD'), 'snapshotId', {
                    enumerable: true,
                    get() { selectionGetterCalls++; throw new Error('Must not read selector getter'); },
                });
                let proxyTraps = 0;
                const proxy = new Proxy(writeRequest('BAD'), {
                    getPrototypeOf() { proxyTraps++; throw new Error('Hostile reflection trap'); },
                });
                for (const invalid of [
                    accessor, proxy, null, [],
                    { ...writeRequest('BAD'), extra: true },
                    { ...writeRequest('BAD'), toolId: '' },
                    { ...writeRequest('BAD'), refId: 42 },
                    { ...writeRequest('BAD'), callback() {} },
                    { ...writeRequest('BAD'), nested: { value: { tooDeep: true } } },
                    { ...writeRequest('BAD'), [Symbol('hidden')]: true },
                ]) {
                    expect(await host.executeVersionedFileReplace(invalid as any, invalidPolicy, adapter))
                        .toMatchObject({ success: false, error: { code: 'OPERATION_INVALID_ARGS' } });
                }
                expect(selectionGetterCalls).toBe(0);
                expect(proxyTraps).toBe(1);
                expect(invalidPolicy).not.toHaveBeenCalled();
                expect(adapter).not.toHaveBeenCalled();
                expect(store.inspect().activeLeases).toBe(1);

                // Bytes, not JS character count: exactly 4 MiB can reach the
                // trusted policy; one UTF-8 byte over must be rejected first.
                const limitText = '🙂'.repeat(1024 * 1024);
                const denyAtLimit = vi.fn(() => false);
                expect(await host.executeVersionedFileReplace(writeRequest(limitText), denyAtLimit, adapter))
                    .toMatchObject({ success: false, error: { code: 'TOOL_PERMISSION_DENIED' } });
                expect(denyAtLimit).toHaveBeenCalledTimes(1);
                expect(await host.executeVersionedFileReplace(writeRequest(limitText + 'a'), invalidPolicy, adapter))
                    .toMatchObject({ success: false, error: { code: 'OPERATION_INVALID_ARGS' } });
                expect(invalidPolicy).not.toHaveBeenCalled();
                expect(adapter).not.toHaveBeenCalled();
                expect(await host.executeVersionedFileReplace(
                    { ...writeRequest('INVALID'), refId: 'unknown' }, policy, adapter,
                )).toMatchObject({ success: false,
                    error: { code: 'REF_NOT_FOUND' } });
                expect(await host.executeVersionedFileReplace(
                    { ...writeRequest('INVALID'), snapshotId: 'caller-invented' }, policy, adapter,
                )).toMatchObject({ success: false,
                    error: { code: 'SNAPSHOT_EXPIRED' } });
                expect(await host.executeVersionedFileReplace(
                    writeRequest('x'.repeat(4 * 1024 * 1024 + 1)), policy, adapter,
                )).toMatchObject({ success: false,
                    error: { code: 'OPERATION_INVALID_ARGS' } });
                expect(adapter).not.toHaveBeenCalled();

                // A JS caller could mutate its request while an async policy
                // is awaiting. Policy and adapter must see ONE immutable copy.
                const mutableRequest = writeRequest('ORIGINAL REQUEST CONTENT');
                const observedAdapter = vi.fn(async (write: {
                    filePath: string; expectedVersion: string; newContent: string;
                }) => {
                    expect(write).toMatchObject({
                        filePath: file, newContent: 'ORIGINAL REQUEST CONTENT',
                    });
                    expect(Object.isFrozen(write)).toBe(true);
                    return { status: 'conflict' as const, currentVersion: source.version };
                });
                const mutableResult = await host.executeVersionedFileReplace(
                    mutableRequest,
                    async scoped => {
                        expect(scoped.newContent).toBe('ORIGINAL REQUEST CONTENT');
                        mutableRequest.newContent = 'SWAPPED WHILE AUTHORIZING';
                        mutableRequest.viewId = 'fd_9';
                        mutableRequest.snapshotId = 'invented-during-policy';
                        mutableRequest.refId = 'different-file';
                        mutableRequest.toolId = 'different-tool';
                        await Promise.resolve();
                        expect(scoped.newContent).toBe('ORIGINAL REQUEST CONTENT');
                        return true;
                    },
                    observedAdapter,
                );
                expect(mutableResult).toMatchObject({
                    success: false, error: { code: 'RESOURCE_VERSION_STALE' },
                });
                expect(observedAdapter).toHaveBeenCalledTimes(1);
                expect(await fs.readFile(file, 'utf8')).toBe(source.content);

                // An accessor must be refused before its getter is ever read.
                let getterCalled = 0;
                const getterRequest = Object.defineProperty(
                    writeRequest('SHOULD NOT RUN'), 'newContent', {
                        enumerable: true,
                        get() { getterCalled++; return 'BAD'; },
                    },
                );
                expect(await host.executeVersionedFileReplace(
                    getterRequest, policy, adapter,
                )).toMatchObject({
                    success: false, error: { code: 'OPERATION_INVALID_ARGS' },
                });
                expect(getterCalled).toBe(0);
                expect(adapter).not.toHaveBeenCalled();

                // External edit after Agent observation. Snapshot alone does not
                // notice this; the filesystem adapter must reject the stale hash.
                await fs.writeFile(file, 'HUMAN EDIT\n');
                expect(await fileSystemService.replaceFileIfVersion(
                    workspace, selected.resource.entityId, selected.resource.entityVersion,
                    'STALE AGENT WRITE',
                )).toMatchObject({ status: 'conflict' });
                expect(await fs.readFile(file, 'utf8')).toBe('HUMAN EDIT\n');
                const changedExternally = await host.executeVersionedFileReplace(
                    writeRequest('AGENT LOST UPDATE'), policy, adapter,
                );
                expect(changedExternally).toMatchObject({
                    success: false, error: { code: 'RESOURCE_VERSION_STALE' },
                });
                expect(await fs.readFile(file, 'utf8')).toBe('HUMAN EDIT\n');

                // Policy evaluation may block until the SDK Tool changes. A source
                // that was valid before authorization must be rechecked AFTER it.
                const oldToolSnapshot = latest().snapshotId!;
                const beforeStale = adapter.mock.calls.length;
                const staleDuringPolicy = await host.executeVersionedFileReplace(
                    { ...writeRequest('DO NOT WRITE'), snapshotId: oldToolSnapshot },
                    async () => {
                        await host!.sendExternalEvent('fd_0' as any, 'change_tool', {});
                        await vi.waitFor(() => {
                            const current = latest();
                            expect(current.snapshotId).not.toBe(oldToolSnapshot);
                            const lookup = store.getById(current.snapshotId!);
                            expect(lookup.status).toBe('found');
                            if (lookup.status !== 'found' || lookup.snapshot.schemaVersion !== 2) {
                                throw Error('Expected updated V2');
                            }
                            expect(lookup.snapshot.tools[toolId].description)
                                .toBe('Replace file revision 2');
                        }, { timeout: 3_500 });
                        return true;
                    },
                    adapter,
                );
                expect(staleDuringPolicy).toMatchObject({
                    success: false, error: { code: 'TOOL_SOURCE_STALE' },
                });
                expect(adapter).toHaveBeenCalledTimes(beforeStale);
                expect(store.inspect().activeLeases).toBe(1); // Original pinned source still held.

                // If the content genuinely matches the source again, one
                // explicitly authorized adapter call can proceed.
                await fs.writeFile(file, source.content);
                const written = await host.executeVersionedFileReplace(
                    writeRequest('AGENT VERSIONED WRITE\n'), policy, adapter,
                );
                expect(written).toMatchObject({ success: true,
                    data: { filePath: file, version: expect.stringMatching(/^sha256:/) },
                });
                expect(await fs.readFile(file, 'utf8')).toBe('AGENT VERSIONED WRITE\n');
                const beforeReplay = adapter.mock.calls.length;
                expect(await host.executeVersionedFileReplace(
                    writeRequest('SECOND AGENT ATTEMPT'), policy, adapter,
                )).toMatchObject({ success: false,
                    error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
                });
                // No second CAS attempt before SDK re-observes the new file version.
                expect(adapter).toHaveBeenCalledTimes(beforeReplay);
                expect(await fs.readFile(file, 'utf8')).toBe('AGENT VERSIONED WRITE\n');

                // SDK explicitly re-reads the actual file after a trusted event.
                // Only a committed V2 Ref with the NEW version releases the
                // Host's post-write source barrier.
                const beforeRefresh = latest().snapshotId!;
                await host.sendExternalEvent('fd_0' as any, 'refresh_version', {});
                await vi.waitFor(() => {
                    const current = latest();
                    expect(current.snapshotId).not.toBe(beforeRefresh);
                    const lookup = store.getById(current.snapshotId!);
                    expect(lookup.status).toBe('found');
                    if (lookup.status !== 'found' || lookup.snapshot.schemaVersion !== 2) {
                        throw Error('Expected refreshed V2');
                    }
                    const identity = lookup.snapshot.views[0].viewInstanceId;
                    expect(lookup.snapshot.refs[refKey('fd_0', identity, 'file')].target)
                        .toMatchObject({ kind: 'entity',
                            entityVersion: (written.data as any).version });
                }, { timeout: 3_000 });
                // Four calls can select the same committed Source concurrently.
                // The filesystem CAS + Host post-write barrier must allow at
                // most one write to win; the winner's complete content survives.
                const candidates = [
                    'VERSION C 0\n', 'VERSION C 1\n',
                    'VERSION C 2\n', 'VERSION C 3\n',
                ];
                const results = await Promise.all(candidates.map(newContent =>
                    host!.executeVersionedFileReplace(writeRequest(newContent), policy, adapter)));
                expect(results.filter(result => result.success)).toHaveLength(1);
                finalWritten = await fs.readFile(file, 'utf8');
                expect(candidates).toContain(finalWritten);
                expect(results.filter(result => !result.success)).toHaveLength(3);
                expect(await host.executeVersionedFileReplace(
                    writeRequest('STALE REPLAY'), policy, adapter,
                )).toMatchObject({
                    success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
                });

                // The adapter can commit successfully but its response may be
                // lost afterward. This is UNKNOWN, not a false failed write.
                const beforeSecondRefresh = latest().snapshotId!;
                await host.sendExternalEvent('fd_0' as any, 'refresh_version', {});
                const observedWinnerVersion = (await fileSystemService.readVersionedFile(
                    workspace, file,
                )).version;
                await vi.waitFor(() => {
                    const current = latest();
                    expect(current.snapshotId).not.toBe(beforeSecondRefresh);
                    const lookup = store.getById(current.snapshotId!);
                    expect(lookup.status).toBe('found');
                    if (lookup.status !== 'found' || lookup.snapshot.schemaVersion !== 2) {
                        throw Error('Expected current V2');
                    }
                    const identity = lookup.snapshot.views[0].viewInstanceId;
                    expect(lookup.snapshot.refs[refKey('fd_0', identity, 'file')].target)
                        .toMatchObject({ kind: 'entity', entityVersion: observedWinnerVersion });
                }, { timeout: 3_000 });

                expect(await host.executeVersionedFileReplace(
                    writeRequest('COMMITTED BUT RESPONSE LOST\n'), policy,
                    async write => {
                        const done = await fileSystemService.replaceFileIfVersion(
                            workspace, write.filePath, write.expectedVersion, write.newContent,
                        );
                        expect(done.status).toBe('written');
                        throw new Error('Simulated adapter response loss AFTER the rename');
                    },
                )).toMatchObject({
                    success: false, error: { code: 'RESOURCE_OUTCOME_UNKNOWN' },
                });
                expect(await fs.readFile(file, 'utf8'))
                    .toBe('COMMITTED BUT RESPONSE LOST\n');
                const beforeUnknownRetry = adapter.mock.calls.length;
                expect(await host.executeVersionedFileReplace(
                    writeRequest('DO NOT RETRY UNKNOWN'), policy, adapter,
                )).toMatchObject({
                    success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
                });
                expect(adapter).toHaveBeenCalledTimes(beforeUnknownRetry);
                finalWritten = 'COMMITTED BUT RESPONSE LOST\n';
            } finally {
                selected.release();
            }
            expect(store.inspect().activeLeases).toBe(0);

            // RESET must revoke a capability granted to a previous App run.
            const previousRun = host.appInstanceId;
            const pooled = await host.releaseWorker();
            expect(pooled).not.toBeNull();
            host = new AppWorkerHost({
                appId: 'versioned_app' as any,
                desktopId: 'versioned_desktop' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
                existingWorker: pooled!,
                snapshotShadow: true, experimentalVersionedMutations: false,
            });
            expect(host.appInstanceId).not.toBe(previousRun);
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(latest()).toMatchObject({
                    health: 'ready', lastViewCount: 1, lastToolCount: 2,
                });
            }, { timeout: 3_000 });
            expect(await host.executeVersionedFileReplace(
                writeRequest('CAPABILITY LEAK'), policy, adapter,
            )).toMatchObject({
                success: false, error: { code: 'TOOL_UNAVAILABLE' },
            });
            expect(await fs.readFile(file, 'utf8')).toBe(finalWritten);

            // One more physical Worker reuse with the capability explicitly
            // enabled, then close the App WHILE its adapter Promise is pending.
            const reusedAgain = await host.releaseWorker();
            expect(reusedAgain).not.toBeNull();
            host = new AppWorkerHost({
                appId: 'versioned_app' as any,
                desktopId: 'versioned_desktop' as any,
                appModulePath: appScript, workerScriptPath: workerScript,
                existingWorker: reusedAgain!,
                snapshotShadow: true, experimentalVersionedMutations: true,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => {
                expect(latest()).toMatchObject({
                    health: 'ready', lastViewCount: 1, lastToolCount: 2,
                });
            }, { timeout: 3_000 });
            let enteredAdapter!: () => void;
            let finishAdapter!: () => void;
            const adapterEntered = new Promise<void>(resolve => { enteredAdapter = resolve; });
            const pausedAdapter = async () => new Promise<{
                status: 'conflict'; currentVersion: string;
            }>(resolve => {
                finishAdapter = () => resolve({ status: 'conflict', currentVersion: source.version });
                enteredAdapter();
            });
            const pendingWrite = host.executeVersionedFileReplace(
                writeRequest('BLOCKED UNTIL CLOSE'), policy, pausedAdapter,
            );
            await adapterEntered;
            expect((host as any).activeFileReplacements).toBe(1);
            let closeFinished = false;
            const closing = host.close().then(() => { closeFinished = true; });
            expect(host.getStatus()).toBe('closing');
            await Promise.resolve();
            expect(closeFinished).toBe(false);
            expect(await host.executeVersionedFileReplace(
                writeRequest('AFTER CLOSE'), policy, adapter,
            )).toMatchObject({ success: false, error: { code: 'TOOL_UNAVAILABLE' } });
            finishAdapter();
            expect(await pendingWrite).toMatchObject({
                success: false, error: { code: 'RESOURCE_VERSION_STALE' },
            });
            await closing;
            expect(closeFinished).toBe(true);
            expect(host.getStatus()).toBe('closed');
            expect(await fs.readFile(file, 'utf8')).toBe(finalWritten);

            // Close during an unresolved Controller policy does not wait for
            // permission, and its eventual grant cannot start disk IO.
            // A closed Shadow source is terminal. Reuse requires RESET and a
            // new Runtime-issued AppInstance, not reopening its stopped Store.
            const restartAfterClose = async () => {
                const worker = await host!.releaseWorker();
                expect(worker).not.toBeNull();
                host = new AppWorkerHost({
                    appId: 'versioned_app' as any, desktopId: 'versioned_desktop' as any,
                    appModulePath: appScript, workerScriptPath: workerScript, existingWorker: worker!,
                    snapshotShadow: true, experimentalVersionedMutations: true,
                });
                await host.start();
                await host.open();
                await vi.waitFor(() => expect(latest().health).toBe('ready'));
            };
            await restartAfterClose();
            let grantPolicy!: () => void;
            let policyStarted!: () => void;
            const policyEntered = new Promise<void>(resolve => { policyStarted = resolve; });
            const policyGate = new Promise<void>(resolve => { grantPolicy = resolve; });
            const afterAuthorizationCalls = adapter.mock.calls.length;
            const pendingAuthorization = host.executeVersionedFileReplace(writeRequest('LATE GRANT'), async () => {
                policyStarted();
                await policyGate;
                return true;
            }, adapter);
            await policyEntered;
            await host.close();
            grantPolicy();
            expect(await pendingAuthorization).toMatchObject({ success: false, error: { code: 'APP_STOPPED' } });
            expect(adapter).toHaveBeenCalledTimes(afterAuthorizationCalls);
            expect(await fs.readFile(file, 'utf8')).toBe(finalWritten);

            // A genuine successful disk write is reported even when two close
            // callers and a pool release arrive while that write is gated.
            await restartAfterClose();
            await host.sendExternalEvent('fd_0' as any, 'refresh_version', {});
            const currentVersion = (await fileSystemService.readVersionedFile(workspace, file)).version;
            await vi.waitFor(() => {
                const lookup = (host as any).shadowReceiver.core.store.getById(latest().snapshotId);
                expect(lookup.status).toBe('found');
                expect(Object.values(lookup.snapshot.refs)).toEqual(expect.arrayContaining([
                    expect.objectContaining({ target: expect.objectContaining({ entityVersion: currentVersion }) }),
                ]));
            });
            const oldSourceRequest = writeRequest('CLOSE MUST KEEP THIS SUCCESS\n');
            let diskStarted!: () => void;
            let allowDisk!: () => void;
            const diskEntered = new Promise<void>(resolve => { diskStarted = resolve; });
            const diskGate = new Promise<void>(resolve => { allowDisk = resolve; });
            const diskWrite = host.executeVersionedFileReplace(oldSourceRequest, policy, async write => {
                diskStarted();
                await diskGate;
                return adapter(write);
            });
            await diskEntered;
            const posted = vi.spyOn((host as any).worker, 'postMessage');
            const closeA = host.close();
            const closeB = host.close();
            expect(closeB).toBe(closeA);
            const releasing = host.releaseWorker();
            await expect(host.pause()).rejects.toThrow(/shutdown is pending/);
            await expect(host.reinitialize('late maintenance')).rejects.toThrow(/shutdown is pending/);
            await expect(host.executeOperation('replace_file' as any, {}, 'legacy' as any))
                .rejects.toThrow(/shutdown is pending/);
            expect(posted).not.toHaveBeenCalled();
            allowDisk();
            expect(await diskWrite).toMatchObject({ success: true, data: { filePath: file } });
            await Promise.all([closeA, closeB]);
            const returned = await releasing;
            expect(returned).not.toBeNull();
            expect(posted.mock.calls.map(([message]) => (message as any).type))
                .toEqual(['APP_SHUTDOWN', 'APP_CLOSE', 'STATE_STORAGE_RESPONSE', 'RESET']);
            const storageRelease = posted.mock.calls[2][0] as any;
            expect(storageRelease).toEqual({ type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId: host.appInstanceId,
                sequence: expect.any(Number), operation: 'release', result: { status: 'released' } });
            expect(Number.isSafeInteger(storageRelease.sequence)).toBe(true);
            expect(storageRelease.sequence).toBeGreaterThan(0);
            expect(await fs.readFile(file, 'utf8')).toBe(oldSourceRequest.newContent);
            posted.mockRestore();

            // RESET permits a fresh explicitly-enabled Controller, but an old
            // AppInstance's source may never authorize a new one.
            host = new AppWorkerHost({
                appId: 'versioned_app' as any, desktopId: 'versioned_desktop' as any,
                appModulePath: appScript, workerScriptPath: workerScript, existingWorker: returned!,
                snapshotShadow: true, experimentalVersionedMutations: true,
            });
            await host.start();
            await host.open();
            await vi.waitFor(() => expect(latest().health).toBe('ready'));
            const beforeOldSource = adapter.mock.calls.length;
            expect(await host.executeVersionedFileReplace(oldSourceRequest, policy, adapter))
                .toMatchObject({ success: false, error: { code: 'SNAPSHOT_EXPIRED' } });
            expect(adapter).toHaveBeenCalledTimes(beforeOldSource);
            expect(await fs.readFile(file, 'utf8')).toBe(oldSourceRequest.newContent);
        } finally {
            host?.terminate();
            await rm(directory, { recursive: true, force: true });
        }
    }, 12_000);
});
