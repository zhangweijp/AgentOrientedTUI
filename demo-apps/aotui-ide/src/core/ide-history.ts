import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { inside, readObservedFile } from './versioned-file-write.js';
import { replaceObservedFile, createFileWithParents, withLocks } from './observed-file-actions.js';
import { directoryIdentity } from './versioned-file-write.js';
import { IDEError, boundedJSON, requireIDE } from './ide-errors.js';
import type { FileInfo } from '../types.js';

export interface HistoryData { version: 1; workspaces: Record<string, FileInfo[]>;
    migration?: { digest: string; phase: 'history' | 'completed' } }
export async function readBoundedText(file: string, limit = 256 * 1024): Promise<string> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat({ bigint: true });
        requireIDE(before.isFile() && before.nlink === 1n && before.size <= BigInt(limit), 'PERSIST_SOURCE_UNSUPPORTED');
        const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
        while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
        const after = await handle.stat({ bigint: true });
        requireIDE(length === Number(before.size) && before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'PERSIST_SOURCE_CHANGED');
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally { try { await handle.close(); } catch { throw new IDEError('PERSIST_CLOSE_UNCERTAIN', 'unknown'); } }
}
export function pathList(value: unknown, max: number): string[] {
    requireIDE(Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0') && Buffer.byteLength(item) <= 4096), 'PERSIST_PATHS_INVALID');
    return [...new Set(value)];
}
function histories(value: unknown): Record<string, FileInfo[]> {
    requireIDE(value && typeof value === 'object' && !Array.isArray(value), 'HISTORY_INVALID');
    const entries = Object.entries(value); requireIDE(entries.length <= 16, 'HISTORY_CAPACITY');
    const result: Record<string, FileInfo[]> = Object.create(null);
    for (const [root, list] of entries) {
        pathList([root], 1); requireIDE(Array.isArray(list) && list.length <= 10, 'HISTORY_INVALID');
        result[root] = list.map(item => {
            requireIDE(item && typeof item === 'object' && Object.keys(item).length === 2 && typeof item.lastOpened === 'number' && Number.isFinite(item.lastOpened) && item.lastOpened >= 0, 'HISTORY_INVALID');
            const [file] = pathList([item.path], 1); requireIDE(inside(root, file!), 'HISTORY_OUTSIDE_WORKSPACE');
            return { path: file!, lastOpened: item.lastOpened };
        });
    }
    return result;
}
function parseHistory(text: string): HistoryData {
    const data = JSON.parse(text);
    requireIDE(data?.version === 1 && Object.keys(data).every(key => ['version', 'workspaces', 'migration'].includes(key)), 'HISTORY_INVALID');
    if (Object.prototype.hasOwnProperty.call(data, 'migration')) requireIDE(data.migration && typeof data.migration === 'object' && !Array.isArray(data.migration) && /^[a-f0-9]{64}$/.test(data.migration.digest) && ['history', 'completed'].includes(data.migration.phase) && Object.keys(data.migration).length === 2, 'HISTORY_INVALID');
    return { version: 1, workspaces: histories(data.workspaces), ...(data.migration ? { migration: data.migration } : {}) };
}
export async function readLegacyIDE(source: string) {
    requireIDE(path.isAbsolute(source), 'IMPORT_PATH_REQUIRED');
    const text = await readBoundedText(source), value = JSON.parse(text);
    requireIDE(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['workspaceFolders', 'workspaces'].includes(key)), 'IMPORT_SCHEMA_INVALID');
    const workspaceFolders = pathList(value.workspaceFolders ?? [], 16);
    requireIDE(value.workspaces && typeof value.workspaces === 'object' && !Array.isArray(value.workspaces), 'IMPORT_SCHEMA_INVALID');
    const raw = Object.fromEntries(Object.entries(value.workspaces).map(([root, entry]: [string, any]) => {
        requireIDE(entry && Object.keys(entry).length === 1 && Array.isArray(entry.openFiles), 'IMPORT_SCHEMA_INVALID');
        return [root, entry.openFiles];
    }));
    return { digest: createHash('sha256').update(text).digest('hex'), workspaceFolders, workspaces: histories(raw) };
}
export class IDEHistory {
    private live = true;
    private tail: Promise<unknown> = Promise.resolve();
    private pending = new Set<Promise<unknown>>();
    private uncertain = false;
    private cleanupFailed = false;
    constructor(readonly file: string) { requireIDE(path.isAbsolute(file), 'HISTORY_PATH_REQUIRED'); }
    private change(update: (current: HistoryData) => HistoryData): Promise<void> {
        requireIDE(this.live, 'HISTORY_CLOSED'); requireIDE(!this.uncertain, 'HISTORY_OUTCOME_UNKNOWN');
        const task = this.tail.catch(() => {}).then(async () => {
            requireIDE(this.live, 'HISTORY_CLOSED'); requireIDE(!this.uncertain, 'HISTORY_OUTCOME_UNKNOWN');
            const root = path.dirname(this.file); await fs.mkdir(root, { recursive: true });
            const guard = () => requireIDE(this.live, 'HISTORY_CLOSED');
            let observed: Awaited<ReturnType<typeof readObservedFile>> | undefined;
            try { observed = await readObservedFile(root, this.file, 256 * 1024); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
            const before: HistoryData = observed ? parseHistory(observed.content) : { version: 1, workspaces: Object.create(null) };
            const content = JSON.stringify(parseHistory(JSON.stringify(boundedJSON(update(before))))); guard();
            if (content === observed?.content) return;
            const result = observed ? await replaceObservedFile(observed, content, guard)
                : await withLocks([this.file], async () => createFileWithParents(root, await directoryIdentity(root), this.file, content, guard));
            if (result.cleanupWarning) { this.cleanupFailed = true; throw new IDEError('HISTORY_CLEANUP_FAILED', 'unknown'); }
        });
        this.tail = task; this.track(task); return task;
    }
    private track<T>(task: Promise<T>): Promise<T> {
        this.pending.add(task);
        void task.catch(error => {
            if (error instanceof IDEError && error.effects === 'unknown') this.uncertain = true;
            if (/CLOSE_UNCERTAIN|CLEANUP/.test(error?.code ?? '')) this.cleanupFailed = true;
        }).finally(() => this.pending.delete(task)); return task;
    }
    read(): Promise<HistoryData> {
        requireIDE(this.live, 'HISTORY_CLOSED');
        return this.track((async () => {
            await this.tail.catch(() => {}); requireIDE(this.live, 'HISTORY_CLOSED');
            try { return parseHistory(await readBoundedText(this.file)); }
            catch (error: any) { if (error.code === 'ENOENT') return { version: 1 as const, workspaces: Object.create(null) }; throw error; }
        })());
    }
    add(root: string, file: string): Promise<void> {
        return this.change(data => ({ ...data, workspaces: { ...data.workspaces, [root]: [{ path: file, lastOpened: Date.now() }, ...(data.workspaces[root] ?? []).filter(item => item.path !== file)].slice(0, 10) } }));
    }
    remove(root: string, file: string): Promise<void> {
        return this.change(data => ({ ...data, workspaces: { ...data.workspaces, [root]: (data.workspaces[root] ?? []).filter(item => item.path !== file) } }));
    }
    importHistory(source: Awaited<ReturnType<typeof readLegacyIDE>>): Promise<void> {
        return this.change(data => {
            requireIDE(!data.migration || data.migration.digest === source.digest, 'IMPORT_SOURCE_CONFLICT');
            if (data.migration?.phase === 'completed') return data;
            return { ...data, workspaces: { ...source.workspaces, ...data.workspaces }, migration: { digest: source.digest, phase: 'history' } };
        });
    }
    completeImport(digest: string): Promise<void> {
        return this.change(data => { requireIDE(data.migration?.digest === digest, 'IMPORT_CONFLICT'); return { ...data, migration: { digest, phase: 'completed' } }; });
    }
    stop(): void { this.live = false; }
    async close(): Promise<void> { this.stop(); await Promise.allSettled([...this.pending]); requireIDE(!this.cleanupFailed && !this.uncertain, 'HISTORY_CLEANUP_FAILED'); }
}
