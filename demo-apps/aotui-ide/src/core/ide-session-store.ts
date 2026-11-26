import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { IDEError, boundedJSON, requireIDE } from './ide-errors.js';
import { pathList, readBoundedSnapshot, type BoundedSnapshot } from './ide-history.js';
import { acquireWriteLock } from './file-write-lock.js';

export interface SessionData {
    version: 1;
    workspaceFolders: string[];
    activeFiles: string[];
    expandedDirs: string[];
}

function parseSession(text: string): SessionData {
    const data = JSON.parse(text);
    requireIDE(data && typeof data === 'object' && !Array.isArray(data) && data.version === 1, 'IDE_RECOVERY_FAILED');
    return {
        version: 1,
        workspaceFolders: pathList(data.workspaceFolders, 16),
        activeFiles: pathList(data.activeFiles, 64),
        expandedDirs: pathList(data.expandedDirs, 512),
    };
}

async function fileStamp(file: string): Promise<string | null> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
        stat = await fs.lstat(file, { bigint: true });
    } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    requireIDE(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'PERSIST_SOURCE_UNSUPPORTED');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export class IDESessionStore {
    private tail: Promise<unknown> = Promise.resolve();
    private lastStamp: string | null = null;

    constructor(readonly file: string) {
        requireIDE(path.isAbsolute(file), 'IDE_SESSION_PATH_INVALID');
    }

    async read(): Promise<SessionData | undefined> {
        let snapshot: BoundedSnapshot;
        try {
            snapshot = await readBoundedSnapshot(this.file);
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                this.lastStamp = null;
                return undefined;
            }
            throw new IDEError('IDE_RECOVERY_FAILED');
        }
        try {
            const data = parseSession(snapshot.text);
            this.lastStamp = snapshot.stamp;
            return data;
        } catch {
            throw new IDEError('IDE_RECOVERY_FAILED');
        }
    }

    save(data: SessionData): Promise<void> {
        const task = this.tail.catch(() => {}).then(async () => {
            const content = JSON.stringify(parseSession(JSON.stringify(boundedJSON(data))));
            const dir = path.dirname(this.file);
            await fs.mkdir(dir, { recursive: true });
            try {
                const lock = acquireWriteLock(this.file + '.sqlite-lock');
                try {
                    const beforeStamp = await fileStamp(this.file);
                    requireIDE(beforeStamp === this.lastStamp, 'SESSION_IN_USE');
                    let tmp: string | undefined = path.join(dir, '.' + path.basename(this.file) + '.aotui-' + randomUUID());
                    try {
                        const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
                        let writeFailed = false;
                        try {
                            await handle.writeFile(content, 'utf8');
                            await handle.sync();
                        } catch {
                            writeFailed = true;
                        } finally {
                            try { await handle.close(); }
                            catch { throw new IDEError('SESSION_CLOSE_UNCERTAIN', 'unknown'); }
                        }
                        if (writeFailed) throw new IDEError('SESSION_WRITE_FAILED');
                        lock.verify();
                        const currentStamp = await fileStamp(this.file);
                        requireIDE(currentStamp === this.lastStamp, 'SESSION_IN_USE');
                        try {
                            await fs.rename(tmp, this.file);
                            tmp = undefined;
                        } catch {
                            throw new IDEError('SESSION_RENAME_UNCERTAIN', 'unknown');
                        }
                        this.lastStamp = await fileStamp(this.file);
                    } finally {
                        if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
                    }
                } finally {
                    try { lock.close(); }
                    catch { throw new IDEError('SESSION_CLEANUP_FAILED', 'unknown'); }
                }
            } catch (error: any) {
                if (error instanceof IDEError && error.code === 'RESOURCE_BUSY') {
                    throw new IDEError('SESSION_IN_USE');
                }
                throw error;
            }
        });
        this.tail = task;
        return task;
    }

    async flush(): Promise<void> {
        await this.tail.catch(() => {});
    }
}
