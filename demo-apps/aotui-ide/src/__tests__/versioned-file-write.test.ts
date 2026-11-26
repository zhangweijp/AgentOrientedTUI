import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { readObservedFile, replaceFileIfVersion } from '../core/versioned-file-write.js';

const observe = async (root: string, file: string) => ({
    ...await readObservedFile(root, file), current: () => {},
});
const missingObservation = { stamp: '', current: () => { throw new Error('Unexpected invocation'); } };

describe('scoped versioned file replacement on disk', () => {
    let root: string;
    let file: string;
    const original = 'const answer = 1;\n';
    const hash = (text: string) =>
        'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-m4-cas-')));
        file = path.join(root, 'src', 'App.tsx');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, original, 'utf8');
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('reads an exact content version and atomically replaces only that version', async () => {
        const observation = await observe(root, file);
        expect(observation.content).toBe(original);
        expect(observation.version).toBe(hash(original));
        expect(observation.stat.isFile()).toBe(true);

        const written = await replaceFileIfVersion(root, file, observation.version, 'const answer = 2;\n', observation);
        expect(written).toEqual({ status: 'written', version: hash('const answer = 2;\n') });
        expect(await fs.readFile(file, 'utf8')).toBe('const answer = 2;\n');
        expect(await fs.readdir(path.dirname(file))).toEqual(['App.tsx']);
    });

    it('stale observation after an external edit never overwrites the newer content', async () => {
        const observed = await observe(root, file);
        await fs.writeFile(file, 'EXTERNALLY EDITED\n', 'utf8');
        const result = await replaceFileIfVersion(root, file, observed.version, 'STALE AGENT WRITE\n', observed);
        expect(result).toEqual({ status: 'conflict', currentVersion: hash('EXTERNALLY EDITED\n') });
        expect(await fs.readFile(file, 'utf8')).toBe('EXTERNALLY EDITED\n');
        expect(await fs.readdir(path.dirname(file))).toEqual(['App.tsx']);
    });

    it('8 concurrent cooperating writers with the same version cannot overwrite the winner', async () => {
        const observed = await observe(root, file);
        const proposals = Array.from({ length: 8 }, (_, i) => 'complete content ' + i + '\n');
        const results = await Promise.allSettled(proposals.map(text =>
            replaceFileIfVersion(root, file, observed.version, text, observed),
        ));
        const successes = results.filter(result =>
            result.status === 'fulfilled' && result.value.status === 'written',
        );
        expect(successes).toHaveLength(1);
        for (const result of results) {
            if (result.status === 'rejected') {
                expect(String(result.reason)).toMatch(/RESOURCE_BUSY/);
            } else if (result.value.status === 'conflict') {
                expect(result.value.currentVersion).toMatch(/^sha256:/);
            }
        }
        expect(proposals).toContain(await fs.readFile(file, 'utf8'));
        expect(await fs.readdir(path.dirname(file))).toEqual(['App.tsx']);
    });

    it('a stale second call after the first successful write does not run again', async () => {
        const first = await observe(root, file);
        expect((await replaceFileIfVersion(root, file, first.version, 'B', first)).status).toBe('written');
        expect(await replaceFileIfVersion(root, file, first.version, 'C', first)).toEqual({
            status: 'conflict', currentVersion: hash('B'),
        });
        expect(await fs.readFile(file, 'utf8')).toBe('B');
    });

    it('does not allow writing a file outside the explicit workspace', async () => {
        const other = await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-outside-cas-'));
        const outside = path.join(other, 'victim.ts');
        try {
            await fs.writeFile(outside, 'SAFE');
            await expect(replaceFileIfVersion(root, outside, hash('SAFE'), 'DESTROY', missingObservation))
                .rejects.toThrow(/RESOURCE_SCOPE_DENIED/);
            await expect(readObservedFile(root, outside)).rejects.toThrow(/RESOURCE_SCOPE_DENIED/);
            expect(await fs.readFile(outside, 'utf8')).toBe('SAFE');
        } finally {
            await fs.rm(other, { recursive: true, force: true });
        }
    });

    it('disallows symlink parents escaping the workspace', async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-symlink-'));
        try {
            await fs.writeFile(path.join(outside, 'victim.ts'), 'SAFE');
            await fs.symlink(outside, path.join(root, 'escape'), 'dir');
            await expect(replaceFileIfVersion(root, path.join(root, 'escape', 'victim.ts'),
                hash('SAFE'), 'DESTROY', missingObservation)).rejects.toThrow(/RESOURCE_PARENT_INVALID/);
            expect(await fs.readFile(path.join(outside, 'victim.ts'), 'utf8')).toBe('SAFE');
        } finally {
            await fs.rm(outside, { recursive: true, force: true });
        }
    });

    it('refuses a symlink target even if it points inside workspace', async () => {
        const link = path.join(root, 'link.ts');
        await fs.symlink(file, link);
        await expect(readObservedFile(root, link)).rejects.toThrow();
        await expect(replaceFileIfVersion(root, link, hash(original), 'OVERWRITE', missingObservation))
            .rejects.toThrow();
        expect(await fs.readFile(file, 'utf8')).toBe(original);
        expect(await fs.readdir(root)).toEqual(['link.ts', 'src']);
    });

    it('refuses hardlinks, preserving any alias to the existing inode', async () => {
        const alias = path.join(root, 'src', 'alias.ts');
        await fs.link(file, alias);
        await expect(replaceFileIfVersion(root, file, hash(original), 'OVERWRITE', missingObservation))
            .rejects.toThrow(/RESOURCE_UNSUPPORTED/);
        expect(await fs.readFile(alias, 'utf8')).toBe(original);
    });

    it('does not replace an unexpectedly missing file', async () => {
        const observed = await observe(root, file);
        await fs.unlink(file);
        await expect(replaceFileIfVersion(root, file, observed.version, 'RECREATE', observed))
            .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readdir(path.dirname(file))).toEqual([]);
    });

    it('refuses malformed version, oversize text, and non-UTF8 files', async () => {
        await expect(replaceFileIfVersion(root, file, 'time:123', 'BAD', missingObservation))
            .rejects.toThrow(/RESOURCE_VERSION_INVALID/);
        await expect(replaceFileIfVersion(root, file, hash(original), 'x'.repeat(4 * 1024 * 1024 + 1), missingObservation))
            .rejects.toThrow(/RESOURCE_TOO_LARGE/);
        await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0xfd]));
        await expect(readObservedFile(root, file)).rejects.toThrow();
        expect(await fs.readFile(file)).toEqual(Buffer.from([0xff, 0xfe, 0xfd]));
    });

    it('existing lock never gets overridden or deleted by another writer', async () => {
        const lock = file + '.aotui-lock';
        await fs.writeFile(lock, 'Other writer holds this lock');
        await expect(replaceFileIfVersion(root, file, hash(original), 'C', await observe(root, file)))
            .rejects.toThrow(/RESOURCE_BUSY/);
        expect(await fs.readFile(lock, 'utf8')).toBe('Other writer holds this lock');
        expect(await fs.readFile(file, 'utf8')).toBe(original);
    });
});


describe('post-commit file mutation and cleanup', () => {
    let root: string;
    let file: string;
    const before = 'const value = 1;\n';
    const digest = (value: string) => 'sha256:' +
        createHash('sha256').update(value, 'utf8').digest('hex');

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-cleanup-result-')));
        file = path.join(root, 'App.tsx');
        await fs.writeFile(file, before);
    });
    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('preserves a SUCCESS with cleanup warning if releasing the lock fails after atomic rename', async () => {
        const close = DatabaseSync.prototype.close;
        const spy = jest.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
            close.call(this);
            throw new Error('Mocked lock release error');
        });
        try {
            const next = 'const value = 2;\n';
            const result = await replaceFileIfVersion(root, file, digest(before), next, await observe(root, file));
            expect(result).toMatchObject({
                status: 'written', version: digest(next),
                cleanupWarning: 'Exclusive lock close failed',
            });
            expect(await fs.readFile(file, 'utf8')).toBe(next);
            await expect(fs.lstat(file + '.aotui-lock')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            spy.mockRestore();
        }
    });

    it('failed atomic rename does not claim a write and cleans up its temporary file', async () => {
        const spy = jest.spyOn(fs, 'rename')
            .mockRejectedValueOnce(new Error('Simulated storage failure'));
        try {
            await expect(replaceFileIfVersion(
                root, file, digest(before), 'DO NOT WRITE', await observe(root, file),
            )).rejects.toThrow(/Simulated storage failure/);
            expect(await fs.readFile(file, 'utf8')).toBe(before);
            expect(await fs.readdir(root)).toEqual(['App.tsx']);
        } finally {
            spy.mockRestore();
        }
    });
});
