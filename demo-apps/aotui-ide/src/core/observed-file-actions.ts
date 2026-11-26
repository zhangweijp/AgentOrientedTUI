import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireWorkspaceWriteLock } from './file-write-lock.js';
import { checkedPath, directoryIdentity, inside, readObservedFile, replaceFileIfVersion, type ObservedFile } from './versioned-file-write.js';
import { IDEError, requireIDE } from './ide-errors.js';
import { nativeOpenCode } from './conditional-file-create.js';

type Guard = () => void;
type Effect = { status: 'succeeded'; cleanupWarning?: string };

export async function withLocks<T extends Effect>(files: string[], action: (verifyLocks: () => void) => Promise<T>): Promise<T> {
    const owned: ReturnType<typeof acquireWorkspaceWriteLock>[] = [];
    let result: T | undefined;
    const warnings: string[] = [];
    try {
        for (const file of [...new Set(files)].sort()) owned.push(acquireWorkspaceWriteLock(file));
        result = await action(() => { for (const lock of owned) lock.verify(); });
        return result;
    } finally {
        for (const lock of owned.reverse()) {
            try { lock.close(); } catch { warnings.push('Exclusive lock close failed'); }
        }
        if (warnings.length) {
            if (result) result.cleanupWarning = warnings.join('; ');
            else throw new IDEError('RESOURCE_CLEANUP_FAILED', 'unknown');
        }
    }
}

async function same(observed: ObservedFile): Promise<void> {
    requireIDE((await readObservedFile(observed.root, observed.path)).stamp === observed.stamp, 'RESOURCE_CONFLICT');
}
async function requireAbsent(file: string): Promise<void> {
    try { await fs.lstat(file); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    throw new IDEError('RESOURCE_ALREADY_EXISTS');
}
export async function replaceObservedFile(observed: ObservedFile, content: string, current: Guard): Promise<Effect> {
    requireIDE(Buffer.from(content, 'utf8').toString('utf8') === content, 'IDE_CONTENT_INVALID');
    let entered = false;
    try {
        const result = await replaceFileIfVersion(observed.root, observed.path, observed.version, content,
            { stamp: observed.stamp, current: () => { current(); entered = true; } });
        requireIDE(result.status === 'written', 'RESOURCE_CONFLICT');
        return { status: 'succeeded', ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}) };
    } catch (error) {
        if (error instanceof IDEError) throw error;
        const known = error instanceof Error ? /^(RESOURCE_[A-Z_]+)/.exec(error.message)?.[1] : undefined;
        throw new IDEError(known ?? 'RESOURCE_WRITE_FAILED', entered || known === 'RESOURCE_CLEANUP_FAILED' ? 'unknown' : 'none');
    }
}
export async function deleteObservedFile(observed: ObservedFile, current: Guard): Promise<Effect> {
    await same(observed); current();
    return withLocks([observed.path], async verifyLocks => {
        await same(observed); verifyLocks(); current();
        try { await fs.unlink(observed.path); } catch { throw new IDEError('RESOURCE_DELETE_UNCERTAIN', 'unknown'); }
        return { status: 'succeeded' };
    });
}
export async function renameObservedFile(observed: ObservedFile, destination: string, current: Guard, targetRoot = observed.root, targetRootIdentity = observed.rootIdentity): Promise<Effect> {
    await same(observed); current();
    const created = await prepareParents(targetRoot, targetRootIdentity, destination, current);
    try {
    requireIDE(await directoryIdentity(targetRoot) === targetRootIdentity, 'WORKSPACE_ROOT_CHANGED');
    const target = await checkedPath(targetRoot, destination);
    requireIDE(target !== observed.path, 'RESOURCE_SAME_PATH');
    const parent = path.dirname(target), parentIdentity = await directoryIdentity(parent);
    requireIDE((await fs.stat(parent)).dev === observed.stat.dev, 'RESOURCE_CROSS_DEVICE');
    // An existing alias of the source must not make the reservation contend with itself.
    await requireAbsent(target);
    return await withLocks([observed.path, target], async verifyLocks => {
        await same(observed);
        requireIDE(await checkedPath(targetRoot, destination) === target && await directoryIdentity(parent) === parentIdentity, 'RESOURCE_SCOPE_CHANGED');
        await requireAbsent(target);
        verifyLocks(); requireIDE(await directoryIdentity(targetRoot) === targetRootIdentity, 'WORKSPACE_ROOT_CHANGED'); current();
        try { await fs.rename(observed.path, target); } catch { throw new IDEError('RESOURCE_RENAME_UNCERTAIN', 'unknown'); }
        return { status: 'succeeded' };
    });
    } catch (error) {
        if (created && (!(error instanceof IDEError) || error.effects === 'none')) throw new IDEError(error instanceof IDEError ? error.code : 'RESOURCE_RENAME_FAILED', 'partial');
        throw error;
    }
}

async function prepareParents(root: string, identity: string, input: string, current: Guard): Promise<number> {
    const file = path.resolve(root, input);
    requireIDE(inside(root, file) && file !== root && !file.includes('\0'), 'RESOURCE_SCOPE_DENIED');
    const parts = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
    requireIDE(parts.length <= 32, 'RESOURCE_PARENT_DEPTH');
    let parent = root, created = 0;
    try {
        requireIDE(await directoryIdentity(root) === identity, 'WORKSPACE_ROOT_CHANGED');
        for (const part of parts) {
            parent = path.join(parent, part);
            try { await directoryIdentity(parent); }
            catch (error: any) {
                if (error.code !== 'ENOENT') throw error;
                requireIDE(await directoryIdentity(root) === identity, 'WORKSPACE_ROOT_CHANGED');
                await checkedPath(root, parent); current();
                await fs.mkdir(parent); created++;
            }
        }
        return created;
    } catch (error) { throw new IDEError(error instanceof IDEError ? error.code : 'RESOURCE_PARENT_FAILED', created ? 'partial' : 'none'); }
}

/** Full IDE create-only branch. The accepted conditional slice remains unchanged. */
export async function createFileWithParents(root: string, rootIdentity: string, input: string, content: string, current: Guard): Promise<Effect & { createdDirectories: number }> {
    const file = path.resolve(root, input), data = Buffer.from(content, 'utf8');
    requireIDE(data.toString('utf8') === content, 'IDE_CONTENT_INVALID');
    requireIDE(inside(root, file) && file !== root && !file.includes('\0'), 'RESOURCE_SCOPE_DENIED');
    requireIDE(data.length <= 4 * 1024 * 1024, 'RESOURCE_TOO_LARGE');
    let created = 0; const parent = path.dirname(file);
    const check = async () => { requireIDE(await fs.realpath(root) === root && await directoryIdentity(root) === rootIdentity, 'WORKSPACE_ROOT_CHANGED'); current(); };
    try {
        created = await prepareParents(root, rootIdentity, file, current);
        const parentIdentity = await directoryIdentity(parent);
        await checkedPath(root, file); await check();
        requireIDE(await directoryIdentity(parent) === parentIdentity, 'RESOURCE_SCOPE_CHANGED'); current();
        let handle: Awaited<ReturnType<typeof fs.open>>;
        try { handle = await fs.open(file, 'wx', 0o600); }
        catch (error) {
            const code = nativeOpenCode(error, file);
            if (!code || !['EEXIST', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code)) throw new IDEError('RESOURCE_CREATE_UNCERTAIN', 'unknown');
            throw new IDEError(code === 'EEXIST' ? 'RESOURCE_ALREADY_EXISTS' : 'RESOURCE_OPEN_FAILED', created ? 'partial' : 'none');
        }
        let writeFailed = false;
        try { await handle.writeFile(data); await handle.sync(); } catch { writeFailed = true; }
        try { await handle.close(); } catch { throw new IDEError('RESOURCE_CLOSE_UNCERTAIN', 'unknown'); }
        if (writeFailed) throw new IDEError('RESOURCE_WRITE_FAILED', 'partial');
        return { status: 'succeeded', createdDirectories: created };
    } catch (error) {
        if (error instanceof IDEError && error.effects !== 'none') throw error;
        throw new IDEError(error instanceof IDEError ? error.code : 'RESOURCE_CREATE_FAILED', created ? 'partial' : 'none');
    }
}
