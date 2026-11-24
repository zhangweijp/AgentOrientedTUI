import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { failedMutation, failedRead, stateIssue, unknownMutation } from '@aotui/core/persistence';
import type { StateIssueCode } from '@aotui/core';
import { sqliteStateFile } from './sqlite-state-storage.js';
import type { SqliteOperation, SqliteStateStorageLimits } from './sqlite-state-storage.js';

type Statement = {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
};
type Database = {
    pragma(source: string, options?: { simple: true }): unknown;
    prepare(source: string): Statement;
    transaction<T extends unknown[]>(run: (...params: T) => void): { immediate(...params: T): void };
    exec(source: string): void;
    close(): void;
};
type StateAccess = Exclude<SqliteOperation, { type: 'close' }>;
const require = createRequire(import.meta.url);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const busyTimeoutMs = 1000;
const schemaVersion = 1;
const { directory, limits } = workerData as { directory: string; limits: SqliteStateStorageLimits };
const maxRead = Math.min(limits.maxRecordBytes, limits.maxBufferedBytes);

class StorageFailure extends Error {
    constructor(readonly code: StateIssueCode) { super(code); }
}
function fail(code: StateIssueCode): never { throw new StorageFailure(code); }
function errorCode(error: unknown): string {
    if (error instanceof StorageFailure) return error.code;
    return String((error as NodeJS.ErrnoException | null)?.code ?? '');
}
function classify(error: unknown): StateIssueCode {
    if (error instanceof StorageFailure) return error.code;
    const code = errorCode(error);
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED') return 'STORAGE_DRIVER_UNAVAILABLE';
    switch (code.replace(/^SQLITE_/, '').split('_', 1)[0]) {
        case 'EACCES': case 'EPERM': case 'READONLY': case 'PERM': case 'AUTH': return 'PERMISSION_DENIED';
        case 'EBUSY': case 'BUSY': case 'LOCKED': return 'STORAGE_BUSY';
        case 'ENOSPC': case 'EDQUOT': case 'FULL': case 'TOOBIG': return 'CAPACITY_EXCEEDED';
        case 'CORRUPT': case 'NOTADB': return 'CORRUPT';
        case 'ELOOP': case 'ENOTDIR': case 'EISDIR': return 'RESOURCE_UNSUPPORTED';
        default: return 'IO_FAILED';
    }
}
function lstat(filename: string) {
    if (Buffer.byteLength(filename) > limits.maxPathBytes) fail('CAPACITY_EXCEEDED');
    try { return fs.lstatSync(filename, { bigint: true }); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
}
function prepareDatabase(db: Database) {
    const version = () => db.pragma('user_version', { simple: true });
    const hasSchema = () => db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
    const initialVersion = version();
    if (initialVersion !== schemaVersion && (initialVersion !== 0 || hasSchema())) fail('UNSUPPORTED_FORMAT');
    if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') fail('STORAGE_BUSY');
    db.pragma('synchronous = EXTRA');
    if (db.pragma('journal_mode', { simple: true }) !== 'delete' ||
        db.pragma('synchronous', { simple: true }) !== 3 ||
        db.pragma('busy_timeout', { simple: true }) !== busyTimeoutMs) fail('UNSUPPORTED_FORMAT');

    if (initialVersion === 0) db.transaction(() => {
        const currentVersion = version();
        if (currentVersion === schemaVersion) return;
        if (currentVersion !== 0 || hasSchema()) fail('UNSUPPORTED_FORMAT');
        db.exec(`
          CREATE TABLE aotui_state (
              namespace TEXT NOT NULL,
              key TEXT NOT NULL,
              record BLOB NOT NULL,
              PRIMARY KEY (namespace, key)
          ) STRICT, WITHOUT ROWID;
          PRAGMA user_version = ${schemaVersion};
        `);
    }).immediate();

    const read = db.prepare(`SELECT typeof(record) AS kind, length(record) AS size,
        CASE WHEN typeof(record) = 'blob' AND length(record) <= ? THEN record END AS data
        FROM aotui_state WHERE namespace = ? AND key = ?`);
    const replace = db.prepare(`INSERT INTO aotui_state (namespace, key, record) VALUES (?, ?, ?)
        ON CONFLICT (namespace, key) DO UPDATE SET record = excluded.record`);
    const remove = db.prepare('DELETE FROM aotui_state WHERE namespace = ? AND key = ?');

    return (operation: StateAccess) => {
        const { namespace, key } = operation.address;
        let writing = false;
        try {
            if (operation.type === 'read') {
                const row = read.get(maxRead, namespace, key) as { kind: string; size: number; data: Buffer | null } | undefined;
                if (!row) return { status: 'missing' };
                if (row.kind !== 'blob') return failedRead('CORRUPT');
                if (row.size > maxRead) return failedRead('CAPACITY_EXCEEDED');
                try { return { status: 'found', text: decoder.decode(row.data!) }; }
                catch { return failedRead('CORRUPT'); }
            }
            writing = true;
            if (operation.type === 'replace') replace.run(namespace, key, Buffer.from(operation.text, 'utf8'));
            else remove.run(namespace, key);
            return { status: 'applied' };
        } catch (error) {
            const issue = classify(error);
            if (operation.type === 'read') return failedRead(issue);
            if (!writing || issue === 'PERMISSION_DENIED' || issue === 'STORAGE_BUSY' || issue === 'CAPACITY_EXCEEDED') return failedMutation(issue);
            return unknownMutation();
        }
    };
}

function start() {
    const port = parentPort;
    if (!port) return;
    let db: Database | undefined;
    try {
        const filename = path.join(directory, sqliteStateFile);
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            const file = lstat(filename + suffix);
            if (file && (!file.isFile() || file.nlink !== 1n)) fail('RESOURCE_UNSUPPORTED');
        }
        const Driver = require('better-sqlite3') as new (filename: string, options: { timeout: number }) => Database;
        const database = db = new Driver(filename, { timeout: busyTimeoutMs });
        const execute = prepareDatabase(database);
        port.on('message', ({ id, operation }: { id: number; operation: SqliteOperation }) => {
            if (operation.type !== 'close') {
                port.postMessage({ id, result: execute(operation) });
                return;
            }
            try { database.close(); }
            catch (error) {
                port.postMessage({ id, result: { status: 'failed', issue: stateIssue(classify(error)) } });
                return;
            }
            port.postMessage({ id, result: { status: 'released' } });
            port.close();
        });
        port.postMessage({ id: 0 });
    } catch (error) {
        port.postMessage({ id: 0, issue: stateIssue(classify(error)) });
        try { db?.close(); } finally { port.close(); }
    }
}
start();
