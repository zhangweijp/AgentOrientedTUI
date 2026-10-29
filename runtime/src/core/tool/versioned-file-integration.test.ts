import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotCore, refKey } from '../snapshot/index.js';
import { acquireVersionedEntitySource } from './source-binding.js';
import { fileSystemService } from '../../../../demo-apps/aotui-ide/src/core/file-system-service.js';

/**
 * Real temporary filesystem + real committed AppSnapshot V2.
 * No Worker ToolHandler/Agent route is authorized by this integration probe.
 */
describe('M4 Stage 5: pinned V2 versioned Ref through a real workspace CAS adapter', () => {
    const appId = 'isolated_ide';
    const instanceId = 'app_run_1';
    const toolId = JSON.stringify([appId, 'FileDetail', 'replace_file']);
    const viewInstanceId = 'vi:v1:["app_run_1",1]';

    const draft = (file: string, version: string, seq = 1, identity = viewInstanceId) => ({
        schemaVersion: 2,
        appId, instanceId,
        producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
        views: [{
            id: 'fd_0', viewInstanceId: identity, type: 'FileDetail', name: 'App.tsx',
            kind: 'state', content: { format: 'markdown-v1', value: 'File View ' + seq },
        }],
        refs: {
            [refKey('fd_0', identity, 'file')]: {
                id: 'file', ownerViewId: 'fd_0', ownerViewInstanceId: identity,
                refType: 'File', target: {
                    kind: 'entity', entityType: 'File',
                    entityId: file, entityVersion: version,
                },
            },
        },
        tools: {
            [toolId]: {
                id: toolId, name: 'replace_file', viewType: 'FileDetail',
                description: 'Replace current file with version precondition',
                inputSchema: { type: 'object', properties: {} },
                isMutating: true,
                targets: [{ viewId: 'fd_0', viewInstanceId: identity, bindingVersion: 1 }],
            },
        },
    });
    const testEnvironment = async (
        run: (resources: {
            root: string; file: string;
            core: ReturnType<typeof createSnapshotCore>;
            sourceId: string; observedVersion: string;
        }) => Promise<void>,
    ) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-source-file-'));
        const file = path.join(root, 'src', 'App.tsx');
        try {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, 'file version A\n', 'utf8');
            const read = await fileSystemService.readVersionedFile(root, file);
            const core = createSnapshotCore();
            core.lifecycle.startApp(appId, instanceId);
            const commit = core.committer.accept(draft(file, read.version));
            expect(commit.status).toBe('published');
            if (commit.status !== 'published') throw Error('Snapshot V2 failed to publish');
            await run({ root, file, core,
                sourceId: commit.snapshot.id, observedVersion: read.version });
            expect(core.store.inspect().activeLeases).toBe(0);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    };

    const resolve = (core: ReturnType<typeof createSnapshotCore>, snapshotId: string) =>
        acquireVersionedEntitySource(core.store, {
            snapshotId, appId, instanceId, toolId, viewId: 'fd_0', refId: 'file',
        });

    it('performs a verified write from a V2 entity Ref then refuses an old replay', async () => {
        await testEnvironment(async ({ root, file, core, sourceId }) => {
            const selected = resolve(core, sourceId);
            expect(selected).toMatchObject({ status: 'found', resource: {
                entityType: 'File', entityId: file,
            } });
            if (selected.status !== 'found') throw Error('Expected pinned entity version');
            try {
                const changed = await fileSystemService.replaceFileIfVersion(
                    root, selected.resource.entityId, selected.resource.entityVersion,
                    'file version B\n',
                );
                expect(changed).toMatchObject({ status: 'written' });
                expect(await fs.readFile(file, 'utf8')).toBe('file version B\n');

                // No new Snapshot has yet appeared: an old source is still
                // syntactically valid, but resource-level CAS must reject it.
                const replay = await fileSystemService.replaceFileIfVersion(
                    root, selected.resource.entityId, selected.resource.entityVersion,
                    'OLD AGENT REPLAY',
                );
                expect(replay).toMatchObject({ status: 'conflict' });
                expect(await fs.readFile(file, 'utf8')).toBe('file version B\n');
            } finally {
                selected.release();
            }
        });
    });

    it('rejects an external change made after the Snapshot was captured', async () => {
        await testEnvironment(async ({ root, file, core, sourceId }) => {
            await fs.writeFile(file, 'edited outside the Agent\n', 'utf8');
            const selected = resolve(core, sourceId);
            expect(selected.status).toBe('found');
            if (selected.status !== 'found') return;
            try {
                expect(await fileSystemService.replaceFileIfVersion(
                    root, selected.resource.entityId, selected.resource.entityVersion,
                    'unwanted agent change',
                )).toMatchObject({ status: 'conflict' });
                expect(await fs.readFile(file, 'utf8')).toBe('edited outside the Agent\n');
            } finally {
                selected.release();
            }
        });
    });

    it('rejects a stale ViewInstanceId before any file operation is attempted', async () => {
        await testEnvironment(async ({ file, core, sourceId, observedVersion }) => {
            const reopened = core.committer.accept(draft(file, observedVersion, 2, 'new-instance'));
            expect(reopened.status).toBe('published');
            const selected = resolve(core, sourceId);
            expect(selected).toMatchObject({
                status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' },
            });
            expect(await fs.readFile(file, 'utf8')).toBe('file version A\n');
        });
    });

    it('rejects a newer resource version in the latest committed Snapshot', async () => {
        await testEnvironment(async ({ root, file, core, sourceId }) => {
            await fs.writeFile(file, 'file version C\n');
            const latestVersion = (await fileSystemService.readVersionedFile(root, file)).version;
            expect(core.committer.accept(draft(file, latestVersion, 2)).status).toBe('published');
            expect(resolve(core, sourceId)).toMatchObject({
                status: 'rejected', issue: { code: 'RESOURCE_VERSION_STALE' },
            });
            expect(await fs.readFile(file, 'utf8')).toBe('file version C\n');
        });
    });

    it('two FileDetails may share the same Ref ID and Tool name without writing the wrong file', async () => {
        await testEnvironment(async ({ root, file, core, observedVersion }) => {
            const other = path.join(root, 'src', 'package.json');
            await fs.writeFile(other, '{"name":"unchanged"}\n');
            const second = await fileSystemService.readVersionedFile(root, other);
            const v2 = draft(file, observedVersion, 2) as any;
            const secondViewInstanceId = 'vi:v1:["app_run_1",2]';
            v2.views.push({
                id: 'fd_1', viewInstanceId: secondViewInstanceId,
                type: 'FileDetail', name: 'package.json',
                kind: 'state', content: { format: 'markdown-v1', value: 'Package View' },
            });
            v2.refs[refKey('fd_1', secondViewInstanceId, 'file')] = {
                id: 'file', ownerViewId: 'fd_1', ownerViewInstanceId: secondViewInstanceId,
                refType: 'File', target: {
                    kind: 'entity', entityType: 'File',
                    entityId: other, entityVersion: second.version,
                },
            };
            v2.tools[toolId].targets.push({
                viewId: 'fd_1', viewInstanceId: secondViewInstanceId,
                bindingVersion: 1,
            });
            const published = core.committer.accept(v2);
            expect(published.status).toBe('published');
            if (published.status !== 'published') throw Error('Expected two-View V2');
            const selectedA = acquireVersionedEntitySource(core.store, {
                snapshotId: published.snapshot.id, appId, instanceId, toolId,
                viewId: 'fd_0', refId: 'file',
            });
            const selectedB = acquireVersionedEntitySource(core.store, {
                snapshotId: published.snapshot.id, appId, instanceId, toolId,
                viewId: 'fd_1', refId: 'file',
            });
            expect(selectedA).toMatchObject({ status: 'found', resource: { entityId: file } });
            expect(selectedB).toMatchObject({ status: 'found', resource: { entityId: other } });
            if (selectedA.status !== 'found' || selectedB.status !== 'found') {
                throw Error('Missing target');
            }
            try {
                // A's trusted policy must refuse B's resource even though both
                // Views expose 'file' and the same 'replace_file' Tool schema.
                const authorizeA = (resourcePath: string) => resourcePath === selectedA.resource.entityId;
                expect(authorizeA(selectedB.resource.entityId)).toBe(false);
                const result = await fileSystemService.replaceFileIfVersion(
                    root, selectedB.resource.entityId, selectedB.resource.entityVersion,
                    '{"name":"updated"}\n',
                );
                expect(result.status).toBe('written');
                expect(await fs.readFile(file, 'utf8')).toBe('file version A\n');
                expect(await fs.readFile(other, 'utf8')).toBe('{"name":"updated"}\n');
                // Exercise the requested A -> B isolation direction as well:
                // use A's pinned source for a real write and re-read both files.
                expect(authorizeA(selectedA.resource.entityId)).toBe(true);
                const resultA = await fileSystemService.replaceFileIfVersion(
                    root, selectedA.resource.entityId, selectedA.resource.entityVersion,
                    'only FileDetail A changed\n',
                );
                expect(resultA.status).toBe('written');
                expect(await fs.readFile(file, 'utf8')).toBe('only FileDetail A changed\n');
                expect(await fs.readFile(other, 'utf8')).toBe('{"name":"updated"}\n');
            } finally {
                selectedA.release();
                selectedB.release();
            }
        });
    });

    it('fails closed when the snapshot resource URI points outside authorized workspace', async () => {
        await testEnvironment(async ({ root, file, core, sourceId }) => {
            const selected = resolve(core, sourceId);
            if (selected.status !== 'found') throw Error('Expected version');
            try {
                const other = await fs.mkdtemp(path.join(os.tmpdir(), 'not-my-workspace-'));
                const out = path.join(other, 'other.ts');
                try {
                    await fs.writeFile(out, 'private\n');
                    await expect(fileSystemService.replaceFileIfVersion(
                        root, out, selected.resource.entityVersion, 'unauthorized write',
                    )).rejects.toThrow(/RESOURCE_SCOPE_DENIED/);
                    expect(await fs.readFile(out, 'utf8')).toBe('private\n');
                    expect(await fs.readFile(file, 'utf8')).toBe('file version A\n');
                } finally {
                    await fs.rm(other, { recursive: true, force: true });
                }
            } finally {
                selected.release();
            }
        });
    });
});
