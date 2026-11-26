import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IDESession } from '../core/ide-session.js';
import { IDESessionStore } from '../core/ide-session-store.js';
import { withLocks } from '../core/observed-file-actions.js';

describe('IDE self-managed session storage', () => {
    let working: string;

    beforeEach(async () => {
        working = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-ide-session-test-')));
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(working, { recursive: true, force: true });
    });

    it('restores workspaceFolders, activeFiles, and expandedDirs on restart, and preserves explicit empty arrays', async () => {
        const root = path.join(working, 'workspace');
        const sub = path.join(root, 'sub');
        const file = path.join(sub, 'a.ts');
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(file, 'export const a = 1;\n', 'utf8');

        const sessionPath = path.join(working, 'state', 'session.json');
        const historyPath = path.join(working, 'state', 'history.json');

        // 1. First launch (no session.json): defaults to expanding workspace root.
        const first = new IDESession({ sessionKey: 's1', sessionPath, historyPath, projectPath: root }, () => {});
        await first.start();
        expect(first.expanded).toEqual([root]);
        expect((await first.invoke('multi_open_dirs', { dirPaths: [sub] })).success).toBe(true);
        expect((await first.invoke('multi_open_file', { filePaths: [file] })).success).toBe(true);
        await first.close();

        // 2. Restart restores roots, activeFiles, and expandedDirs.
        const second = new IDESession({ sessionKey: 's1', sessionPath, historyPath, projectPath: root }, () => {});
        await second.start();
        expect(second.roots.map(r => r.path)).toEqual([root]);
        expect([...second.files.keys()]).toEqual([file]);
        expect(second.expanded.sort()).toEqual([root, sub].sort());

        // 3. Explicitly collapse all dirs and close all files, then close cleanly.
        expect((await second.invoke('multi_close_dirs', { dirPaths: [root, sub] })).success).toBe(true);
        expect((await second.invoke('multi_close_file', { filePaths: [file] })).success).toBe(true);
        expect(second.expanded).toEqual([]);
        expect(second.files.size).toBe(0);
        await second.close();

        // 4. Restart must keep expandedDirs: [] and activeFiles: [] (must NOT default-expand root).
        const third = new IDESession({ sessionKey: 's1', sessionPath, historyPath, projectPath: root }, () => {});
        await third.start();
        expect(third.expanded).toEqual([]);
        expect(third.files.size).toBe(0);

        // 5. Explicitly remove workspace folder -> workspaceFolders: [].
        expect((await third.invoke('remove_folder_from_workspace', { folderPath: root })).success).toBe(true);
        await third.close();

        const fourth = new IDESession({ sessionKey: 's1', sessionPath, historyPath }, () => {});
        await fourth.start();
        expect(fourth.roots).toEqual([]);
        expect(fourth.expanded).toEqual([]);
        expect(fourth.files.size).toBe(0);
        await fourth.close();
    });

    it('cleans up temp files and leaves no partial session.json if first write fails mid-flight', async () => {
        const sessionPath = path.join(working, 'first-fail', 'session.json');
        const store = new IDESessionStore(sessionPath);
        const origOpen = fs.open.bind(fs);
        jest.spyOn(fs, 'open').mockImplementation(async (filePath, ...rest) => {
            const handle = await origOpen(filePath, ...rest);
            if (String(filePath).includes('.session.json.aotui-')) {
                const origWrite = handle.writeFile.bind(handle);
                handle.writeFile = async () => {
                    await origWrite('{"version":1,"partial":', 'utf8');
                    throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
                };
            }
            return handle;
        });

        await expect(store.save({ version: 1, workspaceFolders: [], activeFiles: [], expandedDirs: [] })).rejects.toMatchObject({
            code: 'SESSION_WRITE_FAILED',
        });

        const entries = await fs.readdir(path.dirname(sessionPath));
        expect(entries).toEqual(['session.json.sqlite-lock']);
    });

    it('detects concurrent / stale same-sessionPath writers before overwriting committed data', async () => {
        const root = path.join(working, 'shared-ws');
        const fileA = path.join(root, 'a.txt');
        const fileB = path.join(root, 'b.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(fileA, 'A', 'utf8');
        await fs.writeFile(fileB, 'B', 'utf8');

        const sessionPath = path.join(working, 'shared', 'session.json');
        const writerA = new IDESession({
            sessionKey: 'shared', sessionPath, historyPath: path.join(working, 'shared', 'h-a.json'), projectPath: root,
        }, () => {});
        const writerB = new IDESession({
            sessionKey: 'shared', sessionPath, historyPath: path.join(working, 'shared', 'h-b.json'), projectPath: root,
        }, () => {});

        await writerA.start();
        await writerA.sessionStore.flush();
        // writerB starts seeing the same initial session file, then writerA advances it.
        await writerB.start();

        expect((await writerA.invoke('multi_open_file', { filePaths: [fileA] })).success).toBe(true);
        await writerA.sessionStore.flush();

        // Now writerB tries to save fileB without having seen writerA's commit -> must fail before touching session.json.
        expect((await writerB.invoke('multi_open_file', { filePaths: [fileB] })).success).toBe(true);
        await writerB.sessionStore.flush();

        expect(writerB.warnings).toContain('SESSION_UPDATE_FAILED');
        const onDisk = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
        expect(onDisk.activeFiles).toEqual([fileA]);

        await writerA.close();
        await expect(writerB.close()).rejects.toMatchObject({ code: 'IDE_RESOURCE_CLEANUP_FAILED' });
    });

    it('detects concurrent update when another writer commits between read content and read() return', async () => {
        const root = path.join(working, 'toctou-ws');
        const originalFile = path.join(root, 'original.txt');
        const fileA = path.join(root, 'a.txt');
        const fileB = path.join(root, 'b.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(originalFile, 'ORIGINAL', 'utf8');
        await fs.writeFile(fileA, 'A', 'utf8');
        await fs.writeFile(fileB, 'B', 'utf8');

        const sessionPath = path.join(working, 'toctou', 'session.json');
        await fs.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.writeFile(sessionPath, JSON.stringify({
            version: 1,
            workspaceFolders: [root],
            activeFiles: [originalFile],
            expandedDirs: [root],
        }), 'utf8');

        let pausedOnce = false;
        let enteredClose!: () => void;
        let releaseClose!: () => void;
        const closeEntered = new Promise<void>(resolve => { enteredClose = resolve; });
        const closeRelease = new Promise<void>(resolve => { releaseClose = resolve; });
        const origOpen = fs.open.bind(fs);
        jest.spyOn(fs, 'open').mockImplementation(async (filePath, flags, ...rest) => {
            const handle = await origOpen(filePath, flags as any, ...rest);
            if (!pausedOnce && String(filePath) === sessionPath && typeof flags === 'number') {
                pausedOnce = true;
                const origClose = handle.close.bind(handle);
                handle.close = async () => {
                    enteredClose();
                    await closeRelease;
                    return origClose();
                };
            }
            return handle;
        });

        const writerA = new IDESession({
            sessionKey: 'toctou', sessionPath, historyPath: path.join(working, 'toctou', 'h-a.json'), projectPath: root,
        }, () => {});
        const writerB = new IDESession({
            sessionKey: 'toctou', sessionPath, historyPath: path.join(working, 'toctou', 'h-b.json'), projectPath: root,
        }, () => {});

        let savePromise: Promise<void> | undefined;
        const origSave = writerA.sessionStore.save.bind(writerA.sessionStore);
        jest.spyOn(writerA.sessionStore, 'save').mockImplementation(data => {
            savePromise = origSave(data);
            return savePromise;
        });

        const startA = writerA.start();
        await closeEntered;

        await writerB.start();
        expect((await writerB.invoke('multi_open_file', { filePaths: [fileB] })).success).toBe(true);
        await writerB.sessionStore.flush();
        expect(JSON.parse(await fs.readFile(sessionPath, 'utf8')).activeFiles).toEqual([originalFile, fileB]);

        releaseClose();
        await startA;
        expect([...writerA.files.keys()]).toEqual([originalFile]);

        expect((await writerA.invoke('multi_open_file', { filePaths: [fileA] })).success).toBe(true);
        await writerA.sessionStore.flush();

        await expect(savePromise).rejects.toMatchObject({ code: 'SESSION_IN_USE' });
        expect(writerA.warnings).toContain('SESSION_UPDATE_FAILED');
        await expect(writerA.close()).rejects.toMatchObject({ code: 'IDE_RESOURCE_CLEANUP_FAILED' });
        await writerB.close();

        const onDisk = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
        expect(onDisk.activeFiles).toEqual([originalFile, fileB]);
    });

    it('keeps diskCommitted: true on file create/edit when session save fails, warns SESSION_UPDATE_FAILED, and fails close()', async () => {
        const root = path.join(working, 'ws-save-fail');
        await fs.mkdir(root, { recursive: true });
        const sessionPath = path.join(working, 'fail', 'session.json');
        const session = new IDESession({
            sessionKey: 'fail', sessionPath, historyPath: path.join(working, 'fail', 'history.json'), projectPath: root,
        }, () => {});
        await session.start();
        await session.sessionStore.flush();

        // Corrupt session.json on disk and block rename, simulating external corruption / write failure.
        await fs.writeFile(sessionPath, '{corrupted', 'utf8');
        const created = await session.invoke('create_file', { filePath: path.join(root, 'note.txt'), content: 'saved body' });
        expect(created).toMatchObject({ success: true, data: { diskCommitted: true } });
        await session.sessionStore.flush();

        expect(session.warnings).toContain('SESSION_UPDATE_FAILED');
        expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('saved body');
        await expect(session.close()).rejects.toMatchObject({ code: 'IDE_RESOURCE_CLEANUP_FAILED' });
    });

    it('waits for an in-flight session save during close() and preserves it on restart', async () => {
        const root = path.join(working, 'ws-inflight');
        const file = path.join(root, 'item.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(file, 'hello', 'utf8');

        const sessionPath = path.join(working, 'inflight', 'session.json');
        const historyPath = path.join(working, 'inflight', 'history.json');
        const session = new IDESession({ sessionKey: 'inflight', sessionPath, historyPath, projectPath: root }, () => {});
        await session.start();
        await session.sessionStore.flush();

        let entered!: () => void;
        let release!: () => void;
        const gateEntered = new Promise<void>(r => { entered = r; });
        const gateRelease = new Promise<void>(r => { release = r; });
        const origRename = fs.rename.bind(fs);
        jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to) === sessionPath) {
                entered();
                await gateRelease;
            }
            return origRename(from, to);
        });

        expect((await session.invoke('multi_open_file', { filePaths: [file] })).success).toBe(true);
        await gateEntered;

        let closed = false;
        const closing = session.close().then(() => { closed = true; });
        await new Promise(r => setImmediate(r));
        expect(closed).toBe(false);

        release();
        await closing;
        expect(closed).toBe(true);

        const restarted = new IDESession({ sessionKey: 'inflight', sessionPath, historyPath, projectPath: root }, () => {});
        await restarted.start();
        expect([...restarted.files.keys()]).toEqual([file]);
        await restarted.close();
    });

    it.each(['', 'Other writer holds this lock'])('preserves an existing workspace lock marker (%p)', async marker => {
        const target = path.join(working, 'locked.txt');
        const lockPath = `${target}.aotui-lock`;
        await fs.writeFile(target, 'data', 'utf8');
        await fs.writeFile(lockPath, marker, 'utf8');
        await expect(withLocks([target], async () => ({ status: 'succeeded' as const }))).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
        expect(await fs.readFile(lockPath, 'utf8')).toBe(marker);
    });
});
