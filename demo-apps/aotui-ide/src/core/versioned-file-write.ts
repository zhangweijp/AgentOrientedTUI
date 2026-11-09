import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { IDEError } from './ide-errors.js';

const MAX_BYTES = 4 * 1024 * 1024;
const versionOf = (data: Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex');

async function inWorkspace(root: string, file: string): Promise<string> {
    const base = await fs.realpath(root);
    const absolute = path.resolve(root, file);
    const parent = await fs.realpath(path.dirname(absolute));
    if (parent !== base && !parent.startsWith(base + path.sep)) {
        throw new Error('RESOURCE_SCOPE_DENIED: file is outside the workspace');
    }
    return path.join(parent, path.basename(absolute));
}

async function readRegularFile(file: string, maxBytes = MAX_BYTES) {
    // O_NOFOLLOW checks the final component at open time, not only during lstat.
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > Math.min(MAX_BYTES, maxBytes)) {
            throw new Error('RESOURCE_UNSUPPORTED: expected an ordinary, non-hardlinked text file <= 4 MiB');
        }
        const precise = await handle.stat({ bigint: true });
        const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
        let length = 0;
        while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        if (length !== stat.size) throw new Error('RESOURCE_CHANGED_DURING_READ: file size changed');
        const bytes = buffer.subarray(0, length);
        const after = await handle.stat();
        if (stat.dev !== after.dev || stat.ino !== after.ino ||
            stat.size !== after.size || stat.mtimeMs !== after.mtimeMs ||
            stat.ctimeMs !== after.ctimeMs || stat.nlink !== after.nlink) {
            throw new Error('RESOURCE_CHANGED_DURING_READ: file changed during version capture');
        }
        const afterPrecise = await handle.stat({ bigint: true });
        const identity = (value: typeof precise) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.nlink].map(String).join(':');
        if (identity(precise) !== identity(afterPrecise)) throw new Error('RESOURCE_CHANGED_DURING_READ: file changed');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { content, version: versionOf(bytes), stat, identity: identity(precise) };
    } finally {
        try { await handle.close(); } catch { throw new IDEError('RESOURCE_CLOSE_UNCERTAIN', 'unknown'); }
    }
}

/**
 * A version is a content checksum, not an authorization token or a file lock.
 * Both write paths require the caller to name an existing trusted workspace.
 */
export async function readVersionedFile(workspaceRoot: string, filePath: string) {
    return readRegularFile(await inWorkspace(workspaceRoot, filePath));
}

export function inside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export async function directoryIdentity(directory: string): Promise<string> {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('RESOURCE_PARENT_INVALID');
    return `${stat.dev}:${stat.ino}`;
}
/** Strict route rejects aliases along the entire path, including parents. */
export async function checkedPath(root: string, input: string): Promise<string> {
    const file = path.resolve(root, input);
    if (!inside(root, file) || file === root) throw new Error('RESOURCE_SCOPE_DENIED');
    if (await fs.realpath(root) !== root) throw new Error('RESOURCE_SCOPE_CHANGED');
    await directoryIdentity(root);
    let current = root;
    for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
        current = path.join(current, part); await directoryIdentity(current);
    }
    return file;
}
export async function readObservedFile(root: string, input: string, maxBytes = MAX_BYTES) {
    const file = await checkedPath(root, input), parent = path.dirname(file);
    const rootIdentity = await directoryIdentity(root), parentIdentity = await directoryIdentity(parent);
    const read = await readRegularFile(file, maxBytes);
    if (await checkedPath(root, input) !== file || await directoryIdentity(root) !== rootIdentity ||
        await directoryIdentity(parent) !== parentIdentity) throw new Error('RESOURCE_SCOPE_CHANGED');
    const stamp = 'file:' + createHash('sha256').update([file, read.identity, read.version, rootIdentity, parentIdentity].join('\n')).digest('hex');
    return { ...read, path: file, root, parentIdentity, rootIdentity, stamp };
}
export type ObservedFile = Awaited<ReturnType<typeof readObservedFile>>;

/**
 * Versioned replacement for COOPERATING writers. A sibling O_EXCL lock
 * serializes users of this API; old content is checked under that lock, then
 * staged and atomically renamed into place.
 *
 * Uncooperative writers do NOT honor the lock and may race between the final
 * comparison and rename. Do not advertise this as an OS-wide atomic CAS.
 */
export async function replaceFileIfVersion(
    workspaceRoot: string,
    filePath: string,
    expectedVersion: string,
    nextContent: string,
    observed?: { readonly stamp: string; readonly current: () => void },
): Promise<
    | { status: 'written'; version: string; cleanupWarning?: string }
    | { status: 'conflict'; currentVersion: string }
> {
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedVersion)) {
        throw new Error('RESOURCE_VERSION_INVALID: expected SHA-256 content version');
    }
    const data = Buffer.from(nextContent, 'utf8');
    if (data.length > MAX_BYTES) throw new Error('RESOURCE_TOO_LARGE: new file exceeds 4 MiB');
    const file = await inWorkspace(workspaceRoot, filePath);
    if (observed) {
        const current = await readObservedFile(workspaceRoot, filePath);
        if (current.stamp !== observed.stamp) return { status: 'conflict', currentVersion: current.version };
    }
    const lockPath = file + '.aotui-lock';
    let lock: Awaited<ReturnType<typeof fs.open>>;
    try {
        lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('RESOURCE_BUSY: another versioned file write is in progress');
        }
        throw error;
    }
    let temporary: string | undefined;
    let lockOwner: { ino: number; dev: number } | undefined;
    let written: { status: 'written'; version: string; cleanupWarning?: string } | undefined;
    try {
        lockOwner = await lock.stat();
        const before = await readRegularFile(file);
        if (before.version !== expectedVersion) {
            return { status: 'conflict', currentVersion: before.version };
        }
        if (observed && (await readObservedFile(workspaceRoot, filePath)).stamp !== observed.stamp)
            return { status: 'conflict', currentVersion: before.version };

        temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.aotui-' + randomUUID());
        const staged = await fs.open(temporary, 'wx', before.stat.mode & 0o777);
        try {
            await staged.writeFile(data);
            await staged.sync();
        } finally {
            try { await staged.close(); } catch { throw new IDEError('RESOURCE_CLOSE_UNCERTAIN', 'unknown'); }
        }

        // Check again for best-effort detection of an uncooperative editor,
        // a swapped parent symlink, or a replacement lock inode.
        const lockedFile = await inWorkspace(workspaceRoot, filePath);
        if (lockedFile !== file) {
            throw new Error('RESOURCE_SCOPE_CHANGED: workspace path changed during mutation');
        }
        const lockNow = await fs.lstat(lockPath);
        if (!lockNow.isFile() || lockNow.dev !== lockOwner!.dev ||
            lockNow.ino !== lockOwner!.ino) {
            throw new Error('RESOURCE_LOCK_CHANGED: exclusive lock was replaced');
        }
        const now = await readRegularFile(file);
        if (now.version !== expectedVersion ||
            now.stat.dev !== before.stat.dev || now.stat.ino !== before.stat.ino) {
            return { status: 'conflict', currentVersion: now.version };
        }
        if (observed) {
            if ((await readObservedFile(workspaceRoot, filePath)).stamp !== observed.stamp)
                return { status: 'conflict', currentVersion: now.version };
            observed.current();
        }
        await fs.rename(temporary, file);
        temporary = undefined;
        written = { status: 'written', version: versionOf(data) };
        return written;
    } finally {
        const cleanupProblems: string[] = [];
        try {
            if (temporary) await fs.rm(temporary, { force: true });
        } catch {
            cleanupProblems.push('Temporary file cleanup failed');
        }
        try {
            const current = await fs.lstat(lockPath).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
            });
            // Never knowingly delete another actor's replacement lock.
            if (current && lockOwner && current.dev === lockOwner.dev &&
                current.ino === lockOwner.ino) {
                await fs.unlink(lockPath);
            } else {
                cleanupProblems.push('Exclusive lock owner changed or disappeared');
            }
        } catch {
            cleanupProblems.push('Exclusive lock cleanup failed');
        }
        try { await lock.close(); } catch {
            cleanupProblems.push('Exclusive lock handle close failed');
        }
        if (cleanupProblems.length) {
            if (written) {
                // The rename HAS committed. Cleanup must not turn a completed
                // disk write into a false business failure or prompt a retry.
                written.cleanupWarning = cleanupProblems.join('; ');
            } else {
                throw new Error('RESOURCE_CLEANUP_FAILED: ' + cleanupProblems.join('; '));
            }
        }
    }
}
