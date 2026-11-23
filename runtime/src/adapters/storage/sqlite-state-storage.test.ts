import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import type { StateStorage } from '@aotui/core';
import { decodeStateRecord } from '@aotui/core/internal';
import { readSqliteState } from '../../../tests/fixtures/sqlite-state.js';
import { DEFAULT_NODE_STATE_LIMITS } from '../../engine/app/state-storage-host.js';
import { DEFAULT_STATE_SESSION_LIMITS } from './state-storage-protocol.js';
import { createSqliteStateStorage, sqliteStateFile } from './sqlite-state-storage.js';

const Driver = createRequire(import.meta.url)('better-sqlite3');
const namespace = '["desk","app"]';
const address = (key = 'count', ns = namespace) => ({ namespace: ns, key });
const record = (value: number) => JSON.stringify({ version: 1, updatedAt: 123, value });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});

async function fixture(options = {}) {
    const folder = await fs.mkdtemp(path.join(tmpdir(), 'aotui-sqlite-state-'));
    cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
    const root = path.join(folder, 'app-state');
    const database = path.join(root, sqliteStateFile);
    const legacy = path.join(root, 'desk', 'app');
    const backend = createSqliteStateStorage({ ...DEFAULT_NODE_STATE_LIMITS, ...options });
    async function open(id: string, dir = root): Promise<StateStorage> {
        const result = await backend.open({ owner: id, rootDirectory: dir });
        expect(result.status, result.status === 'rejected' ? result.issue.code : '').toBe('opened');
        if (result.status !== 'opened') throw Error(result.issue.code);
        cleanups.push(result.storage.release);
        return result.storage;
    }
    function inspect(readonly = true) {
        const db = new Driver(database, { readonly, fileMustExist: true });
        cleanups.push(async () => { if (db.open) db.close(); });
        return db;
    }
    return { folder, root, database, legacy, backend, open, inspect };
}

it('shares one Worker for aliases and holds a namespace through real owner release', async () => {
    const f = await fixture({ maxRoots: 1, maxActiveOwners: 2 });
    expect(await fs.readdir(f.folder)).toEqual([]);
    const a = await f.open('a');
    const alias = path.join(f.folder, 'alias');
    await fs.symlink(f.root, alias, 'dir');
    const b = await f.open('b', alias);
    expect(f.backend.getStats()).toMatchObject({ roots: 1, ownerSlots: 2 });
    expect(await f.backend.open({ owner: 'c', rootDirectory: f.root })).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });
    expect(await a.replace(address(), record(7))).toEqual({ status: 'applied' });
    expect(readSqliteState(f.root, 'desk', 'app', 'count')).toBe(record(7));
    expect(await b.read(address())).toMatchObject({ issue: { code: 'NAMESPACE_BUSY' } });
    expect(await b.replace(address('count', '["desk","App"]'), record(9))).toEqual({ status: 'applied' });
    await a.release();
    expect(f.backend.getStats()).toMatchObject({ roots: 1, ownerSlots: 1 });
    expect(await b.read(address())).toEqual({ status: 'found', text: record(7) });
    const exit = vi.spyOn(Worker.prototype, 'emit');
    expect(await b.release()).toEqual({ status: 'released' });
    expect(exit.mock.calls.some(([event]) => event === 'exit')).toBe(true);
    expect(f.backend.getStats()).toEqual({ roots: 0, ownerSlots: 0, claimedNamespaces: 0, pendingStorageIO: 0, bufferedBytes: 0 });
    const c = await f.open('c');
    expect(await c.read(address('count', '["desk","App"]'))).toEqual({ status: 'found', text: record(9) });
    expect(f.inspect().pragma('journal_mode', { simple: true })).toBe('delete');
});

it('opens existing SQLite state without importing or altering old JSON files', async () => {
    const f = await fixture();
    await fs.mkdir(f.legacy, { recursive: true });
    const oldFile = path.join(f.legacy, 'count.json');
    const original = ' { "updatedAt": 123, "value": 4, "version": 1 }\n';
    await fs.writeFile(oldFile, original);
    const a = await f.open('a');
    expect(await a.read(address())).toEqual({ status: 'missing' });
    const db = f.inspect(false);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([{ name: 'aotui_state' }]);
    // A database installed by the previous Runtime can still contain this unused table.
    db.exec('CREATE TABLE aotui_legacy_import (namespace TEXT PRIMARY KEY) STRICT, WITHOUT ROWID');
    db.prepare('INSERT INTO aotui_legacy_import VALUES (?)').run(namespace);
    db.close();
    expect(await a.replace(address(), original)).toEqual({ status: 'applied' });
    await a.release();
    const b = await f.open('b');
    expect(await b.read(address())).toEqual({ status: 'found', text: original });
    expect(readSqliteState(f.root, 'desk', 'app', 'count')).toBe(original);
    expect(await b.remove(address())).toEqual({ status: 'applied' });
    await b.release();
    const c = await f.open('c');
    expect(await c.read(address())).toEqual({ status: 'missing' });
    expect(await fs.readFile(oldFile, 'utf8')).toBe(original);
    expect(f.inspect().prepare('SELECT namespace FROM aotui_legacy_import').all()).toEqual([{ namespace }]);
});

it('stores StateAddress strings independently of filesystem naming rules', async () => {
    const f = await fixture();
    const owner = await f.open('a');
    const id = address('CON /文件.😀', 'arbitrary namespace');
    expect(await owner.replace(id, record(7))).toEqual({ status: 'applied' });
    expect(await owner.read(id)).toEqual({ status: 'found', text: record(7) });
    expect(await owner.replace(address('\uFFFD'), record(5))).toEqual({ status: 'applied' });
    expect(await owner.replace(address('\uD800'), record(8))).toMatchObject({ issue: { code: 'ADDRESS_UNSUPPORTED' } });
    expect(await owner.read(address('\uFFFD'))).toEqual({ status: 'found', text: record(5) });
    expect(await owner.read(address('x'.repeat(DEFAULT_NODE_STATE_LIMITS.maxAddressBytes)))).toMatchObject({
        issue: { code: 'CAPACITY_EXCEEDED' },
    });
});

it('discerns corrupt, unsupported and oversized records directly from SQLite', async () => {
    const f = await fixture({ maxRecordBytes: 128 });
    const owner = await f.open('a');
    const db = f.inspect(false);
    const put = db.prepare('INSERT INTO aotui_state VALUES (?, ?, ?)');
    const unsupported = '{"version":44,"updatedAt":1,"value":99}';
    put.run(namespace, 'bad', Buffer.from([0xfe, 0xff]));
    put.run(namespace, 'future', Buffer.from(unsupported));
    put.run(namespace, 'oversize', Buffer.alloc(1024 * 1024));
    expect(await owner.read(address('bad'))).toMatchObject({ issue: { code: 'CORRUPT' } });
    expect(await owner.read(address('future'))).toEqual({ status: 'found', text: unsupported });
    expect(decodeStateRecord(unsupported, DEFAULT_STATE_SESSION_LIMITS)).toMatchObject({ issue: { code: 'UNSUPPORTED_FORMAT' } });
    expect(await owner.read(address('oversize'))).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });
});

it.each([['unknown', 'UNSUPPORTED_FORMAT'], ['corrupt', 'CORRUPT']])('rejects a %s database and preserves its bytes', async (kind, code) => {
    const f = await fixture();
    await fs.mkdir(f.root);
    if (kind === 'unknown') {
        const db = new Driver(f.database);
        db.pragma('user_version = 99');
        db.close();
    } else await fs.writeFile(f.database, Buffer.alloc(4096, 0x2a));
    const original = await fs.readFile(f.database);
    expect(await f.backend.open({ owner: 'owner', rootDirectory: f.root })).toMatchObject({ issue: { code } });
    expect(await fs.readFile(f.database)).toEqual(original);
    expect(f.backend.getStats()).toMatchObject({ roots: 0, ownerSlots: 0 });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a permission-denied write without changing committed state', async () => {
    const f = await fixture();
    const a = await f.open('a');
    expect(await a.replace(address(), record(2))).toEqual({ status: 'applied' });
    await a.release();
    await fs.chmod(f.database, 0o400);
    await fs.chmod(f.root, 0o500);
    cleanups.push(async () => { await fs.chmod(f.root, 0o700); await fs.chmod(f.database, 0o600); });
    const b = await f.open('b');
    expect(await b.replace(address(), record(8))).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'PERMISSION_DENIED' } });
    expect(await b.read(address())).toEqual({ status: 'found', text: record(2) });
});

it('bounds the queue while a real SQLite lock waits off the Host event loop', async () => {
    const f = await fixture({ maxPendingRequests: 1 });
    const owner = await f.open('owner');
    expect(await owner.read(address())).toEqual({ status: 'missing' });
    const blocker = f.inspect(false);
    blocker.exec('BEGIN IMMEDIATE');
    const write = owner.replace(address(), record(6));
    expect(await owner.replace(address('another'), record(1))).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });
    const release = owner.release();
    const heartbeat = new Promise(done => setTimeout(() => done('timer'), 30));
    expect(await Promise.race([release, heartbeat])).toBe('timer');
    expect(f.backend.getStats()).toMatchObject({ pendingStorageIO: 1, roots: 1, ownerSlots: 1 });
    expect(await write).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'STORAGE_BUSY' } });
    blocker.exec('ROLLBACK');
    expect(await release).toEqual({ status: 'released' });
    expect(readSqliteState(f.root, 'desk', 'app', 'count')).toBeUndefined();
}, 5000);

it('keeps a lost in-flight mutation unknown and still releases a physically exited Worker', async () => {
    const f = await fixture();
    const owner = await f.open('owner');
    expect(await owner.replace(address(), record(2))).toEqual({ status: 'applied' });
    const blocker = f.inspect(false);
    blocker.exec('BEGIN IMMEDIATE');
    let worker: Worker | undefined;
    const post = Worker.prototype.postMessage;
    const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message) {
        if (message.operation?.type === 'replace') worker = this;
        post.call(this, message);
    });
    const write = owner.replace(address(), record(7));
    const undispatched = owner.replace(address('queued'), record(8));
    await Promise.resolve();
    expect(worker).toBeDefined();
    const terminated = worker!.terminate();
    expect(await write).toMatchObject({ status: 'unknown', issue: { code: 'UNKNOWN_OUTCOME' } });
    expect(await undispatched).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'IO_FAILED' } });
    await terminated;
    spy.mockRestore();
    blocker.exec('ROLLBACK');
    expect(await owner.release()).toEqual({ status: 'released' });
    expect(worker!.threadId).toBe(-1);
    expect(f.backend.getStats()).toMatchObject({ roots: 0, ownerSlots: 0, pendingStorageIO: 0 });
    expect(readSqliteState(f.root, 'desk', 'app', 'count')).toBe(record(2));
});
