import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IDEError, requireIDE } from './ide-errors.js';

const SQLITE_BUSY = 5;

export function acquireWriteLock(lockFile: string) {
    const existing = lstatSync(lockFile, { throwIfNoEntry: false });
    requireIDE(!existing || (existing.isFile() && existing.nlink === 1), 'RESOURCE_BUSY');
    // This file stays in place. Only the connection owns the exclusive writer
    // reservation, which SQLite releases when the connection or Worker exits.
    const db = new DatabaseSync(lockFile);
    try {
        db.exec('BEGIN IMMEDIATE');
        const owner = lstatSync(lockFile, { bigint: true });
        requireIDE(owner.isFile() && owner.nlink === 1n, 'RESOURCE_BUSY');
        return {
            verify() {
                const current = lstatSync(lockFile, { bigint: true, throwIfNoEntry: false });
                requireIDE(current?.dev === owner.dev && current.ino === owner.ino, 'RESOURCE_LOCK_CHANGED');
            },
            close: () => db.close(),
        };
    } catch (error) {
        db.close();
        if ((error as { errcode?: number }).errcode === SQLITE_BUSY) throw new IDEError('RESOURCE_BUSY');
        throw error;
    }
}

export function acquireWorkspaceWriteLock(file: string) {
    const marker = file + '.aotui-lock';
    requireIDE(!lstatSync(marker, { throwIfNoEntry: false }), 'RESOURCE_BUSY');
    const uid = process.getuid?.();
    // Every Host under the same OS account must see the same reservation.
    const base = uid === undefined ? userInfo().homedir : '/tmp';
    const directory = path.join(base, `aotui-ide-write-locks-${uid ?? 'current-user'}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    requireIDE(stat.isDirectory() && (uid === undefined || (stat.uid === uid && (stat.mode & 0o077) === 0)), 'RESOURCE_BUSY');
    const parent = statSync(path.dirname(file), { bigint: true });
    let name: string;
    try {
        name = path.basename(realpathSync.native(file));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // An empty destination has no disk spelling. Reserve equivalent names
        // together until the first rename or creation chooses that spelling.
        name = path.basename(file).normalize('NFC').toLowerCase();
    }
    const key = createHash('sha256').update(`${parent.dev}:${parent.ino}:${name}`).digest('hex');
    const lock = acquireWriteLock(path.join(directory, key + '.sqlite'));
    return {
        close: lock.close,
        verify() {
            lock.verify();
            requireIDE(!lstatSync(marker, { throwIfNoEntry: false }), 'RESOURCE_LOCK_CHANGED');
        },
    };
}
