import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppWorkerHost } from './worker-host.js';
import { readVersionedFile, replaceFileIfVersion } from '../../../../demo-apps/aotui-ide/src/core/versioned-file-write.js';

// Actual Core V2 source and isolated filesystem; live Worker identity is tested
// separately by worker-host.m4-versioned-file and m4-producer-race.
describe('Stage 8: file adapter outcome and in-flight replay boundaries', () => {
    let directory: string;
    let file: string;
    let host: AppWorkerHost;
    let version: string;
    let request: { snapshotId: string; toolId: string; viewId: string; refId: string; newContent: string };

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'aotui-stage8-outcome-'));
        file = join(directory, 'file.txt');
        await writeFile(file, 'original\n');
        version = (await readVersionedFile(directory, file)).version;
        host = new AppWorkerHost({
            appId: 'file_app' as any, desktopId: 'desktop_1' as any, appModulePath: 'not-loaded',
            snapshotShadow: true, experimentalVersionedMutations: true,
        });
        (host as any).status = 'running';
        vi.spyOn(host as any, 'sendRequest').mockResolvedValue({ success: true });
        const instanceId = host.appInstanceId;
        const viewInstanceId = 'vi:v1:' + JSON.stringify([instanceId, 1]);
        const toolId = JSON.stringify(['file_app', 'FileDetail', 'replace_file']);
        (host as any).shadowReceiver.acceptPrepared({
            schemaVersion: 2, appId: 'file_app', instanceId,
            producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{ id: 'fd_0', viewInstanceId, type: 'FileDetail', name: 'file.txt',
                kind: 'state', content: { format: 'markdown-v1', value: 'Current file' } }],
            refs: { [JSON.stringify(['fd_0', viewInstanceId, 'file'])]: {
                id: 'file', ownerViewId: 'fd_0', ownerViewInstanceId: viewInstanceId, refType: 'File',
                target: { kind: 'entity', entityType: 'File', entityId: file, entityVersion: version },
            } },
            tools: { [toolId]: { id: toolId, name: 'replace_file', viewType: 'FileDetail',
                description: 'Replace the observed file', inputSchema: { type: 'object' }, isMutating: true,
                targets: [{ viewId: 'fd_0', viewInstanceId, bindingVersion: 1 }],
            } },
        });
        expect(host.getSnapshotShadowReport()).toMatchObject({ health: 'ready' });
        request = { snapshotId: host.getSnapshotShadowReport()!.snapshotId!, toolId,
            viewId: 'fd_0', refId: 'file', newContent: 'committed\n' };
    });

    afterEach(async () => {
        host?.terminate();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('a committed write with an accessor response is unknown, never reads the getter, and cannot replay', async () => {
        let getterCalls = 0;
        const adapter = vi.fn(async (write: any) => {
            const result = await replaceFileIfVersion(directory, write.filePath, write.expectedVersion, write.newContent);
            expect(result.status).toBe('written');
            return Object.defineProperty({ status: 'written' }, 'version', {
                enumerable: true, get() { getterCalls++; throw new Error('Lost adapter response'); },
            }) as any;
        });
        expect(await host.executeVersionedFileReplace(request, () => true, adapter)).toMatchObject({
            success: false, error: { code: 'RESOURCE_OUTCOME_UNKNOWN' },
        });
        expect(getterCalls).toBe(0);
        expect(await readFile(file, 'utf8')).toBe('committed\n');
        expect(await host.executeVersionedFileReplace(request, () => true, adapter)).toMatchObject({
            success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
        });
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    it.each([
        { status: 'written', version: 'sha256:' + 'b'.repeat(64), cleanupWarning: 42 },
        { status: 'conflict', currentVersion: 'not-a-content-version' },
        { status: 'conflict', currentVersion: 'sha256:' + 'b'.repeat(64), unexpected: true },
    ])('invalid adapter response %j blocks reuse of the original source', async response => {
        const adapter = vi.fn(async () => response as any);
        expect(await host.executeVersionedFileReplace(request, () => true, adapter)).toMatchObject({
            success: false, error: { code: 'RESOURCE_OUTCOME_UNKNOWN' },
        });
        expect(await host.executeVersionedFileReplace(request, () => true, adapter)).toMatchObject({
            success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
        });
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(await readFile(file, 'utf8')).toBe('original\n');
    });

    it('reserves an in-flight same-hash write before awaiting its adapter', async () => {
        request.newContent = 'original\n';
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const adapter = vi.fn(async (write: any) => {
            if (adapter.mock.calls.length !== 1) throw new Error('Duplicate entered the disk adapter');
            entered();
            await gate;
            return replaceFileIfVersion(directory, write.filePath, write.expectedVersion, write.newContent);
        });
        const first = host.executeVersionedFileReplace(request, () => true, adapter);
        await started;
        try {
            expect(await host.executeVersionedFileReplace(request, () => true, adapter)).toMatchObject({
                success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
            });
            expect(adapter).toHaveBeenCalledTimes(1);
        } finally { finish(); await first; }
        expect(await first).toMatchObject({ success: true, data: { version } });
        expect(await readFile(file, 'utf8')).toBe('original\n');
        expect(await host.executeVersionedFileReplace(request, () => true, adapter)).toMatchObject({
            success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' },
        });
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('a valid conflict confirms no write, so it does not permanently consume a still-valid source', async () => {
        const conflict = vi.fn(async () => ({ status: 'conflict' as const, currentVersion: version }));
        expect(await host.executeVersionedFileReplace(request, () => true, conflict)).toMatchObject({
            success: false, error: { code: 'RESOURCE_VERSION_STALE' },
        });
        const written = await host.executeVersionedFileReplace(request, () => true, write =>
            replaceFileIfVersion(directory, write.filePath, write.expectedVersion, write.newContent));
        expect(written.success).toBe(true);
        expect(await readFile(file, 'utf8')).toBe('committed\n');
    });

    it.each([1, 'false', {}, null, undefined])('authorization must be literal true, received %j', async grant => {
        const adapter = vi.fn(async () => ({ status: 'conflict' as const, currentVersion: version }));
        expect(await host.executeVersionedFileReplace(request, (() => grant) as any, adapter)).toMatchObject({
            success: false, error: { code: 'TOOL_PERMISSION_DENIED' },
        });
        expect(adapter).not.toHaveBeenCalled();
        expect(await readFile(file, 'utf8')).toBe('original\n');
    });

    it('does not inspect a policy exception message accessor when returning a deterministic failure', async () => {
        const getter = vi.fn(() => { throw new Error('Exception message must not execute'); });
        const exception = Object.defineProperty(new Error(), 'message', { get: getter });
        const adapter = vi.fn();
        await expect(host.executeVersionedFileReplace(request, () => { throw exception; }, adapter))
            .resolves.toMatchObject({ success: false, error: { code: 'RESOURCE_MUTATION_FAILED' } });
        expect(getter).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
        expect(await readFile(file, 'utf8')).toBe('original\n');
    });

    it('a source selection exception is a deterministic rejection before authorization or disk IO', async () => {
        const authorize = vi.fn(() => true);
        const adapter = vi.fn();
        vi.spyOn((host as any).shadowReceiver, 'selectVersionedEntitySource').mockImplementation(() => {
            throw new Error('Injected Core source acquisition failure');
        });
        await expect(host.executeVersionedFileReplace(request, authorize, adapter)).resolves.toMatchObject({
            success: false, error: { code: 'RESOURCE_MUTATION_FAILED' },
        });
        expect(authorize).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });
});
