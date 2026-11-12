import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createNodeStateStorage } from './node-state-storage.js';
import type { NodeStateStorageLimits } from './node-state-storage.js';
import { createStateSession } from '../../core/persistence/state-session.js';
import { createDesktopId } from '../../spi/core/id-factory.js';
import type { StateStorage } from '../../core/persistence/state-storage.js';

const control = vi.hoisted(() => ({ handlers: {} as Record<string, (...args: any[]) => any>, calls: [] as { method: string; args: any[] }[], handles: [] as any[] }));
vi.mock('node:fs/promises', async load => {
    const actual = await load<typeof import('node:fs/promises')>();const wrapped: Record<string, unknown> = {};
    for (const method of ['mkdir', 'realpath', 'lstat', 'opendir', 'open', 'rename', 'unlink'] as const) wrapped[method] = vi.fn(async (...args: any[]) => {
        control.calls.push({ method, args });const result = await (control.handlers[method] ?? (actual[method] as any))(...args);
        if (method === 'open' || method === 'opendir') control.handles.push(result);return result;
    });
    return { ...actual, ...wrapped };
});
vi.mock('node:crypto', async load => { const actual = await load<typeof import('node:crypto')>();return { ...actual, randomUUID: vi.fn(actual.randomUUID) }; });
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const limits: NodeStateStorageLimits = { maxActiveOwners: 5, maxRoots: 3, maxClaimedNamespaces: 10, maxPendingRequests: 10, maxRecordBytes: 4096, maxAddressBytes: 512, maxPathBytes: 2048, maxSegmentBytes: 128, maxDirectoryEntries: 100, maxBufferedBytes: 32768 };
let folder: string;const address = (key = 'state', desktop = 'desktop', app = 'system_ide') => ({ namespace: JSON.stringify([desktop, app]), key });
const deferred = <T = void>() => { let resolve!: (v: T) => void;const promise = new Promise<T>(r => { resolve = r; });return { promise, resolve }; };
const errno = (code: string) => Object.assign(new Error('PRIVATE_FS_PATH_AND_CAUSE'), { code });
beforeEach(async () => { vi.restoreAllMocks();control.handlers = {};control.calls = [];control.handles = [];folder = await real.mkdtemp(path.join(tmpdir(), 'aotui-node-state-')); });
afterEach(async () => {
    vi.restoreAllMocks();for (const h of control.handles) { try { await h.close(); } catch { /* externally tear down deliberately retained test handles */ } }
    await real.rm(folder, { recursive: true, force: true });
});
async function setup(custom: Partial<NodeStateStorageLimits> = {}, owner = 'owner', rootDirectory = path.join(folder, 'app-state')) {
    const backend = createNodeStateStorage({ ...limits, ...custom }), opened = await backend.open({ owner, rootDirectory });expect(opened.status).toBe('opened');if (opened.status !== 'opened') throw Error('fixture open');
    const root = await real.realpath(rootDirectory);
    return { backend, storage: opened.storage, root, file: (key = 'state', desktop = 'desktop', app = 'system_ide') => path.join(root, desktop, app, key + '.json') };
}
async function seed(root: string, text: string | Uint8Array, key = 'state', desktop = 'desktop', app = 'system_ide') { const dir = path.join(root, desktop, app);await real.mkdir(dir, { recursive: true });await real.writeFile(path.join(dir, key + '.json'), text);return path.join(dir, key + '.json'); }
function expectEmpty(backend: ReturnType<typeof createNodeStateStorage>) { expect(backend.getStats()).toMatchObject({ ownerSlots: 0, roots: 0, claimedNamespaces: 0, pendingStorageIO: 0, ioInFlight: 0, retainedStorageIO: 0, fileHandles: 0, directoryHandles: 0, temporaryFiles: 0, bufferedBytes: 0 }); }

describe('N02–N05 configuration, root and namespace ownership', () => {
    it.each([1, 2].flatMap(barrier => [true, false].map(alias => ({ barrier, alias }))))('F01: root adoption remains single across last release / third open: %j', async ({ barrier, alias }) => {
        const f = await setup({ maxRoots: 1 });await f.storage.read(address());const entrance = path.join(folder, 'alias');if (alias) await real.symlink(f.root, entrance);
        const entered = deferred(), gate = deferred();let checks = 0;
        control.handlers.lstat = async (...args) => { const stat = await (real.lstat as any)(...args);if (String(args[0]) === f.root && ++checks === barrier) { entered.resolve();await gate.promise; }return stat; };
        const second = f.backend.open({ owner: 'second', rootDirectory: alias ? entrance : f.root });await entered.promise;await f.storage.release();expect(f.backend.getStats().roots).toBe(barrier === 1 ? 0 : 1);
        const third = await f.backend.open({ owner: 'third', rootDirectory: f.root });expect(third.status).toBe('opened');gate.resolve();const adopted = await second;if (adopted.status !== 'opened' || third.status !== 'opened') throw Error('open');
        expect(f.backend.getStats()).toMatchObject({ roots: 1, pendingOpens: 0 });expect(await adopted.storage.read(address())).toEqual({ status: 'missing' });expect(await third.storage.read(address())).toMatchObject({ issue: { code: 'NAMESPACE_BUSY' } });
        expect(await adopted.storage.replace(address(), 'second')).toEqual({ status: 'applied' });expect(await third.storage.replace(address(), 'third')).toMatchObject({ issue: { code: 'NAMESPACE_BUSY' } });
        expect(await third.storage.replace(address('state', 'other'), 'independent')).toEqual({ status: 'applied' });await adopted.storage.release();await f.storage.release();expect(f.backend.getStats().roots).toBe(1);
        expect(await third.storage.read(address())).toEqual({ status: 'found', text: 'second' });await third.storage.release();expectEmpty(f.backend);
    });
    it('F01: a failed last validation releases its own root pin without deleting another owner', async () => {
        const f = await setup({ maxRoots: 1 }), entered = deferred(), gate = deferred();let checks = 0;
        control.handlers.lstat = async (...args) => { const stat = await (real.lstat as any)(...args);if (String(args[0]) === f.root && ++checks === 2) { entered.resolve();await gate.promise;throw errno('EACCES'); }return stat; };
        const pending = f.backend.open({ owner: 'second', rootDirectory: f.root });await entered.promise;await f.storage.release();expect(f.backend.getStats()).toMatchObject({ roots: 1, pendingOpens: 1 });gate.resolve();expect(await pending).toMatchObject({ status: 'rejected', issue: { code: 'PERMISSION_DENIED' } });expectEmpty(f.backend);
        delete control.handlers.lstat;const next = await f.backend.open({ owner: 'next', rootDirectory: f.root });if (next.status !== 'opened') throw Error('open');await next.storage.release();expectEmpty(f.backend);
    });
    it('constructs without I/O; rejects all invalid/missing/extra/accessor limits', () => {
        createNodeStateStorage(limits);let reads = 0;expect(control.calls).toEqual([]);
        for (const key of Object.keys(limits)) for (const value of [0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => createNodeStateStorage({ ...limits, [key]: value })).toThrow('INVALID_INPUT');
        expect(() => createNodeStateStorage({ ...limits, maxSegmentBytes: 129 })).toThrow('INVALID_INPUT');
        expect(() => createNodeStateStorage({ ...limits, extra: 1 } as any)).toThrow('INVALID_INPUT');const missing = { ...limits } as any;delete missing.maxRoots;expect(() => createNodeStateStorage(missing)).toThrow('INVALID_INPUT');
        const getter = { ...limits };Object.defineProperty(getter, 'maxRoots', { enumerable: true, get() { reads++;return 1; } });expect(() => createNodeStateStorage(getter)).toThrow('INVALID_INPUT');expect(reads).toBe(0);expect(control.calls).toEqual([]);
    });
    it('rejects invalid open synchronously before filesystem entry and captures its inputs', async () => {
        const backend = createNodeStateStorage(limits);let getters = 0;
        for (const input of [{ owner: '', rootDirectory: folder }, { owner: 'x'.repeat(600), rootDirectory: folder }, { owner: 'ok', rootDirectory: 'relative' }, { owner: 'ok', rootDirectory: '/bad\0root' }, { owner: 'ok', rootDirectory: '/' + 'x'.repeat(2050) }]) expect((await backend.open(input)).status).toBe('rejected');
        expect((await backend.open({ owner: 'ok', get rootDirectory() { getters++;return folder; } })).status).toBe('rejected');expect(getters).toBe(0);expect(control.calls).toEqual([]);expectEmpty(backend);
        const config = { ...limits }, other = createNodeStateStorage(config);config.maxRoots = 1;const opts = { owner: 'ok', rootDirectory: path.join(folder, 'captured') }, pending = other.open(opts);opts.rootDirectory = '/never-used';expect((await pending).status).toBe('opened');
    });
    it('reserves pending owner/open slots; duplicate owner and capacity do not enter I/O', async () => {
        const entered = deferred(), gate = deferred();control.handlers.mkdir = async (...args) => { entered.resolve();await gate.promise;return (real.mkdir as any)(...args); };
        const backend = createNodeStateStorage({ ...limits, maxPendingRequests: 1, maxActiveOwners: 1 }), pending = backend.open({ owner: 'a', rootDirectory: folder });await entered.promise;const count = control.calls.length;
        expect(backend.getStats()).toMatchObject({ ownerSlots: 1, pendingOpens: 1, pendingStorageIO: 1, ioInFlight: 1 });expect(await backend.open({ owner: 'a', rootDirectory: folder })).toMatchObject({ status: 'rejected', issue: { code: 'OWNER_BUSY' } });expect((await backend.open({ owner: 'b', rootDirectory: folder })).status).toBe('rejected');expect(control.calls).toHaveLength(count);
        gate.resolve();const opened = await pending;if (opened.status !== 'opened') throw Error('open');await opened.storage.release();expectEmpty(backend);
    });
    it('coalesces canonical path and symlink aliases even at maxRoots=1, and reclaims roots', async () => {
        const root = path.join(folder, 'root');await real.mkdir(root);const alias = path.join(folder, 'alias');await real.symlink(root, alias);
        const backend = createNodeStateStorage({ ...limits, maxRoots: 1 });const one = await backend.open({ owner: 'a', rootDirectory: root }), two = await backend.open({ owner: 'b', rootDirectory: root + '/./' }), three = await backend.open({ owner: 'c', rootDirectory: alias });
        expect([one.status, two.status, three.status]).toEqual(['opened', 'opened', 'opened']);expect(backend.getStats().roots).toBe(1);expect((await backend.open({ owner: 'd', rootDirectory: path.join(folder, 'different') })).status).toBe('rejected');
        for (const r of [one, two, three]) if (r.status === 'opened') await r.storage.release();expectEmpty(backend);
    });
    it('missing read claims namespace without creating desktop/app folders; two owners never overwrite', async () => {
        const f = await setup(), other = await f.backend.open({ owner: 'other', rootDirectory: f.root });if (other.status !== 'opened') throw Error('open');
        expect(await f.storage.read(address())).toEqual({ status: 'missing' });expect(await real.readdir(f.root)).toEqual([]);expect(await other.storage.replace(address(), 'other')).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'NAMESPACE_BUSY' } });
        expect(await other.storage.replace(address('state', 'desktop', 'planning_app'), 'isolated')).toEqual({ status: 'applied' });expect(await f.storage.read(address('state', 'desktop', 'planning_app'))).toMatchObject({ status: 'failed', issue: { code: 'NAMESPACE_BUSY' } });
        await f.storage.release();expect(await other.storage.read(address())).toEqual({ status: 'missing' });await other.storage.release();expectEmpty(f.backend);
    });
    it('rejects same-owner namespace case aliases and different-app desktop aliases before modification', async () => {
        const f = await setup();await f.storage.read(address('x', 'Desk', 'App'));const count = control.calls.length;
        for (const a of [address('x', 'desk', 'App'), address('x', 'Desk', 'app'), address('x', 'desk', 'different')]) expect(await f.storage.replace(a, 'bad')).toMatchObject({ status: 'failed', issue: { code: 'ADDRESS_UNSUPPORTED' } });
        expect(control.calls.length).toBe(count);await f.storage.release();
    });
    it('release stops new work synchronously, shares its Promise and leaves old handles invalid after handoff', async () => {
        const f = await setup();await f.storage.replace(address(), 'raw');const closing = f.storage.release();expect(f.storage.release()).toBe(closing);expect(await f.storage.replace(address(), 'late')).toMatchObject({ issue: { code: 'OWNER_RELEASED' } });await closing;
        const next = await f.backend.open({ owner: 'owner', rootDirectory: f.root });if (next.status !== 'opened') throw Error('open');await f.storage.release();expect(await next.storage.read(address())).toEqual({ status: 'found', text: 'raw' });expect(await f.storage.remove(address())).toMatchObject({ issue: { code: 'OWNER_RELEASED' } });await next.storage.release();expectEmpty(f.backend);
    });
    it('detects canonical root identity replacement', async () => {
        const f = await setup();await real.rename(f.root, f.root + '-old');await real.mkdir(f.root);
        expect(await f.storage.read(address())).toMatchObject({ status: 'failed', issue: { code: 'RESOURCE_UNSUPPORTED' } });expect(await real.readdir(f.root)).toEqual([]);await f.storage.release();expectEmpty(f.backend);
    });
});

describe('N02/N03/N06/N07 actual paths, content and types', () => {
    it.each(['a/b', 'a\\b', '..', '.', 'x.', '-start', 'a\0b', '中文', 'CON', 'con.txt', 'PrN.json', 'COM1.x', 'lpt9', 'aux', 'nul'])('rejects unsupported segment %s without creating data folders', async key => {
        const f = await setup();expect(await f.storage.replace(address(key), 'x')).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'ADDRESS_UNSUPPORTED' } });expect(await real.readdir(f.root)).toEqual([]);expect(f.backend.getStats().claimedNamespaces).toBe(0);await f.storage.release();
    });
    it.each(['not-json', '["d"]', '["d","a","extra"]', '[1,"a"]', '["","a"]', '[ "d", "a" ]', '["\\u0064","a"]'])('rejects noncanonical namespace %s', async namespace => {
        const f = await setup();expect(await f.storage.read({ namespace, key: 'k' })).toMatchObject({ issue: { code: 'ADDRESS_UNSUPPORTED' } });expect(await real.readdir(f.root)).toEqual([]);await f.storage.release();
    });
    it('supports one-byte identity segments independently of .json/temporary basenames (Q01)', async () => {
        const f = await setup({ maxSegmentBytes: 1 }), a = address('k', 'd', 'a');expect(await f.storage.read(a)).toEqual({ status: 'missing' });expect(await f.storage.replace(a, '1')).toEqual({ status: 'applied' });expect(await f.storage.read(a)).toEqual({ status: 'found', text: '1' });expect(await f.storage.remove(a)).toEqual({ status: 'applied' });await f.storage.release();
    });
    it('uses real Desktop IDs and existing app/key spellings, preserving raw JSON/BOM without rewrite', async () => {
        const f = await setup(), desktop = createDesktopId();expect(desktop).toMatch(/^dt_/);
        for (const [app, key, raw] of [['system_ide', 'activeFiles', '{"version":1,"updatedAt":1,"value":["file.ts"]}'], ['system_ide', 'expandedDirs', '["workspace"]'], ['planning_app', 'activePlanId', '\ufeff{"value":"plan"}']]) {
            const file = await seed(f.root, raw!, key!, desktop, app!);const before = await real.stat(file);expect(await f.storage.read(address(key!, desktop, app!))).toEqual({ status: 'found', text: raw });expect(await real.readFile(file, 'utf8')).toBe(raw);expect((await real.stat(file)).mtimeMs).toBe(before.mtimeMs);
        }
        await f.storage.release();
    });
    it('never sanitizes a/b into the existing a_b record', async () => {
        const f = await setup(), file = await seed(f.root, 'keep', 'a_b');expect((await f.storage.read(address('a/b'))).status).toBe('failed');expect(await real.readFile(file, 'utf8')).toBe('keep');await f.storage.release();
    });
    it.each(['target-symlink', 'hardlink', 'directory', 'parent-symlink', 'fifo'])('rejects actual %s and closes all admitted handles', async kind => {
        const f = await setup(), target = await seed(f.root, 'keep');
        if (kind === 'target-symlink') { await real.unlink(target);await real.writeFile(path.join(folder, 'outside'), 'outside');await real.symlink(path.join(folder, 'outside'), target); }
        if (kind === 'hardlink') await real.link(target, target + '-link');
        if (kind === 'directory') { await real.unlink(target);await real.mkdir(target); }
        if (kind === 'parent-symlink') { await real.rename(path.dirname(target), path.join(folder, 'elsewhere'));await real.symlink(path.join(folder, 'elsewhere'), path.dirname(target)); }
        if (kind === 'fifo') { await real.unlink(target);execFileSync('mkfifo', [target]); }
        for (const op of [() => f.storage.read(address()), () => f.storage.replace(address(), 'bad'), () => f.storage.remove(address())]) expect(await op()).toMatchObject({ status: 'failed', issue: { code: 'RESOURCE_UNSUPPORTED' } });
        expect(f.backend.getStats()).toMatchObject({ fileHandles: 0, directoryHandles: 0, temporaryFiles: 0, pendingStorageIO: 0 });await f.storage.release();
    });
    it('rejects existing case aliases and in-flight empty-directory key aliases', async () => {
        const f = await setup();await seed(f.root, 'keep', 'Case');expect(await f.storage.read(address('case'))).toMatchObject({ issue: { code: 'ADDRESS_UNSUPPORTED' } });
        const entered = deferred(), gate = deferred();control.handlers.opendir = async (...args) => { entered.resolve();await gate.promise;return (real.opendir as any)(...args); };
        const first = f.storage.replace(address('Empty'), 'a');await entered.promise;expect(await f.storage.replace(address('empty'), 'b')).toMatchObject({ issue: { code: 'ADDRESS_UNSUPPORTED' } });gate.resolve();expect(await first).toEqual({ status: 'applied' });await f.storage.release();
    });
    it('strictly validates UTF-8, surrogate input and complete record size without rewriting', async () => {
        const f = await setup({ maxRecordBytes: 4 });const target = await seed(f.root, Uint8Array.from([0xc3, 0x28]));expect(await f.storage.read(address())).toMatchObject({ issue: { code: 'CORRUPT' } });expect(await real.readFile(target)).toEqual(Buffer.from([0xc3, 0x28]));
        const count = control.calls.length;expect(await f.storage.replace(address(), '\ud800')).toMatchObject({ issue: { code: 'INVALID_INPUT' } });expect(control.calls).toHaveLength(count);
        expect(await f.storage.replace(address(), '😀')).toEqual({ status: 'applied' });expect(await f.storage.read(address())).toEqual({ status: 'found', text: '😀' });expect(await f.storage.replace(address(), '12345')).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });await real.writeFile(target, '12345');expect(await f.storage.read(address())).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });await f.storage.release();
    });
    it('keeps existing permissions and creates private directories/files on this platform', async () => {
        const root = path.join(folder, 'app-state');await real.mkdir(root);await real.chmod(root, 0o750);const f = await setup({}, 'owner', root);await f.storage.replace(address(), 'x');
        expect((await real.stat(root)).mode & 0o777).toBe(0o750);expect((await real.stat(path.join(root, 'desktop'))).mode & 0o777).toBe(0o700);expect((await real.stat(f.file())).mode & 0o777).toBe(0o600);await f.storage.release();
    });
    it('observes actual permission enforcement without claiming mode bits override privileged access', async () => {
        const f = await setup(), target = await seed(f.root, 'private');await real.chmod(target, 0);
        let denied = false;try { const native = await real.open(target, 'r');await native.close(); } catch (error: any) { expect(['EACCES', 'EPERM']).toContain(error.code);denied = true; }
        const result = await f.storage.read(address());if (denied) expect(result).toMatchObject({ status: 'failed', issue: { code: 'PERMISSION_DENIED' } });else expect(result).toEqual({ status: 'found', text: 'private' });
        expect(f.backend.getStats()).toMatchObject({ pendingStorageIO: 0, fileHandles: 0, directoryHandles: 0 });await real.chmod(target, 0o600);await f.storage.release();
    });
});

describe('N08 exact mutation phases and retained resources', () => {
    it('confirms a temporary cleanup actually completed even when its Promise rejects afterwards', async () => {
        const f = await setup(), target = await seed(f.root, 'old');control.handlers.open = async (...args) => { const h = await (real.open as any)(...args);vi.spyOn(h, 'write').mockRejectedValue(errno('EIO'));return h; };
        control.handlers.unlink = async (...args) => { await (real.unlink as any)(...args);if (String(args[0]).endsWith('.tmp')) throw errno('EIO'); };
        expect(await f.storage.replace(address(), 'new')).toMatchObject({ status: 'failed', effects: 'none' });expect(await real.readFile(target, 'utf8')).toBe('old');expect(f.backend.getStats()).toMatchObject({ retainedStorageIO: 0, temporaryFiles: 0, fileHandles: 0 });expect(await f.storage.release()).toEqual({ status: 'released' });expectEmpty(f.backend);
    });
    it('never deletes a foreign object that replaced an owned temporary pathname', async () => {
        const f = await setup();let foreign = '';
        control.handlers.open = async (...args) => { const h = await (real.open as any)(...args);foreign = String(args[0]);vi.spyOn(h, 'write').mockImplementation(async () => { await real.rename(foreign, foreign + '-moved');await real.writeFile(foreign, 'foreign');throw errno('EACCES'); });return h; };
        expect(await f.storage.replace(address(), 'new')).toMatchObject({ status: 'failed', effects: 'none' });expect(await real.readFile(foreign, 'utf8')).toBe('foreign');expect(f.backend.getStats()).toMatchObject({ retainedStorageIO: 1, temporaryFiles: 1 });expect(await f.storage.release()).toMatchObject({ status: 'unknown' });
        expect(await f.storage.release()).toMatchObject({ status: 'unknown' });
        expect(await real.readFile(foreign, 'utf8')).toBe('foreign');
    });
    it.each(['rename', 'unlink'].flatMap(method => [true, false].map(committed => ({ method, committed }))))('F02: a prior unknown does not make zero-I/O rejected new requests unknown: %j', async ({ method, committed }) => {
        const f = await setup(), uncertain = await seed(f.root, 'uncertain-old', 'unknown'), healthy = await seed(f.root, 'healthy-old', 'healthy');
        control.handlers[method] = async (...args) => {
            if (String(args[method === 'rename' ? 1 : 0]) === uncertain) { if (committed) await (real[method as 'rename' | 'unlink'] as any)(...args);throw errno('EIO'); }
            return (real[method as 'rename' | 'unlink'] as any)(...args);
        };
        expect(await (method === 'rename' ? f.storage.replace(address('unknown'), 'new') : f.storage.remove(address('unknown')))).toMatchObject({ status: 'unknown' });const before = control.calls.length;
        for (const key of ['unknown', 'healthy']) for (const mutation of [() => f.storage.replace(address(key), 'blocked'), () => f.storage.remove(address(key))]) expect(await mutation()).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'UNKNOWN_OUTCOME' } });
        expect(control.calls).toHaveLength(before);expect(await real.readFile(healthy, 'utf8')).toBe('healthy-old');expect(await f.storage.replace(address('healthy', 'independent'), 'ok')).toEqual({ status: 'applied' });
        expect(await f.storage.release()).toMatchObject({ status: 'unknown' });expect(f.backend.getStats()).toMatchObject({ retainedOwners: 1, retainedStorageIO: 1, claimedNamespaces: 2, ioInFlight: 0 });
    });
    it('does not delete an exclusive temporary-name collision that it never owned', async () => {
        const f = await setup(), target = await seed(f.root, 'old'), uuid = '11111111-1111-1111-1111-111111111111';
        const foreign = path.join(path.dirname(target), '_s_' + uuid.replaceAll('-', '') + '.tmp');await real.writeFile(foreign, 'foreign');vi.mocked(crypto.randomUUID).mockReturnValueOnce(uuid);
        expect(await f.storage.replace(address(), 'new')).toMatchObject({ status: 'failed', effects: 'none' });expect(await real.readFile(foreign, 'utf8')).toBe('foreign');expect(await real.readFile(target, 'utf8')).toBe('old');expect(f.backend.getStats().temporaryFiles).toBe(0);await f.storage.release();
    });
    it.each(['partial-error', 'zero-write', 'closed-then-error'])('preserves target and cleans owned temp after %s', async phase => {
        const f = await setup(), target = await seed(f.root, 'old');
        control.handlers.open = async (...args) => {
            const h = await (real.open as any)(...args);if (!String(args[0]).endsWith('.tmp')) return h;
            if (phase === 'closed-then-error') { const close = h.close.bind(h);vi.spyOn(h, 'close').mockImplementation(async () => { await close();throw errno('EIO'); }); }
            else { const write = h.write.bind(h);let calls = 0;vi.spyOn(h, 'write').mockImplementation(async (buffer: any, offset: any, length: any, position: any) => { if (phase === 'zero-write') return { bytesWritten: 0, buffer };if (++calls === 1) return write(buffer, offset, Math.min(2, length), position);throw errno('EACCES'); }); }
            return h;
        };
        expect(await f.storage.replace(address(), 'new-data')).toMatchObject({ status: 'failed', effects: 'none' });expect(await real.readFile(target, 'utf8')).toBe('old');expect((await real.readdir(path.dirname(target))).filter(n => n.endsWith('.tmp'))).toEqual([]);
        expect(f.backend.getStats()).toMatchObject({ pendingStorageIO: 0, fileHandles: 0, directoryHandles: 0, temporaryFiles: 0, bufferedBytes: 0 });expect(await f.storage.release()).toEqual({ status: 'released' });
    });
    it.each([false, true])('rename rejection after entered => unknown (actual commit=%s)', async commit => {
        const f = await setup(), target = await seed(f.root, 'old');control.handlers.rename = async (...args) => { if (commit) await (real.rename as any)(...args);throw errno('EIO'); };
        expect(await f.storage.replace(address(), 'new')).toMatchObject({ status: 'unknown' });expect(await real.readFile(target, 'utf8')).toBe(commit ? 'new' : 'old');const count = control.calls.length;
        expect(await f.storage.replace(address('other'), 'blocked')).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'UNKNOWN_OUTCOME' } });expect(control.calls.length).toBe(count);delete control.handlers.rename;
        expect(await f.storage.replace(address('healthy', 'different', 'app'), 'healthy')).toEqual({ status: 'applied' });expect(f.backend.getStats()).toMatchObject({ activeStorageIO: 0, retainedStorageIO: 1, bufferedBytes: 0, fileHandles: 0, temporaryFiles: 0 });
        expect(await f.storage.release()).toMatchObject({ status: 'unknown' });expect(f.backend.getStats()).toMatchObject({ retainedOwners: 1, claimedNamespaces: 2 });
    });
    it.each([false, true])('target unlink rejection => unknown, not fake none (actual delete=%s)', async deleted => {
        const f = await setup(), target = await seed(f.root, 'old');control.handlers.unlink = async (...args) => { if (String(args[0]) === target) { if (deleted) await (real.unlink as any)(...args);throw errno('EIO'); }return (real.unlink as any)(...args); };
        expect(await f.storage.remove(address())).toMatchObject({ status: 'unknown' });expect(await real.stat(target).then(() => true, () => false)).toBe(!deleted);expect(await f.storage.release()).toMatchObject({ status: 'unknown' });
    });
    it('failed pre-commit temp cleanup keeps a known resource and StorageIO slot, release needs no new slot', async () => {
        const f = await setup({ maxPendingRequests: 1 }), target = await seed(f.root, 'old');
        control.handlers.open = async (...args) => { const h = await (real.open as any)(...args);vi.spyOn(h, 'write').mockRejectedValue(errno('EACCES'));return h; };
        control.handlers.unlink = async (...args) => { if (String(args[0]).endsWith('.tmp')) throw errno('EACCES');return (real.unlink as any)(...args); };
        expect(await f.storage.replace(address(), 'new')).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'PERMISSION_DENIED' } });expect(await real.readFile(target, 'utf8')).toBe('old');
        expect(f.backend.getStats()).toMatchObject({ activeStorageIO: 0, ioInFlight: 0, retainedStorageIO: 1, pendingStorageIO: 1, temporaryFiles: 1, bufferedBytes: 0 });
        expect(await f.storage.read(address('other'))).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });const releasing = f.storage.release();expect(f.storage.release()).toBe(releasing);expect(await releasing).toMatchObject({ status: 'failed', issue: { code: 'PERMISSION_DENIED' } });
        expect(f.backend.getStats()).toMatchObject({ retainedOwners: 1, claimedNamespaces: 1 });
        delete control.handlers.unlink;
        const mutationAttempts = control.calls.filter(call => call.method === 'open' || call.method === 'rename').length;
        const retry = f.storage.release();
        expect(f.storage.release()).toBe(retry);
        expect(await retry).toEqual({ status: 'released' });
        expect(f.storage.release()).toBe(retry);
        expect(await real.readFile(target, 'utf8')).toBe('old');
        expect(control.calls.filter(call => call.method === 'open' || call.method === 'rename')).toHaveLength(mutationAttempts);
        expectEmpty(f.backend);
    });
    it('failed file close does not drop the unconfirmed handle or grant namespace to another owner', async () => {
        const f = await setup(), target = await seed(f.root, 'old');control.handlers.open = async (...args) => { const h = await (real.open as any)(...args);vi.spyOn(h, 'close').mockRejectedValue(errno('EIO'));return h; };
        expect(await f.storage.replace(address(), 'new')).toMatchObject({ status: 'failed', effects: 'none' });expect(await real.readFile(target, 'utf8')).toBe('old');expect(f.backend.getStats()).toMatchObject({ fileHandles: 1, retainedStorageIO: 1, ioInFlight: 0 });expect(await f.storage.release()).toMatchObject({ status: 'unknown' });
        const next = await f.backend.open({ owner: 'next', rootDirectory: f.root });if (next.status !== 'opened') throw Error('open');expect(await next.storage.read(address())).toMatchObject({ issue: { code: 'NAMESPACE_BUSY' } });await next.storage.release();
    });
    it('confirmed rename remains applied when later directory cleanup fails', async () => {
        const f = await setup(), target = await seed(f.root, 'old');control.handlers.opendir = async (...args) => { const dir = await (real.opendir as any)(...args);if (String(args[0]) === path.dirname(target)) vi.spyOn(dir, 'close').mockRejectedValue(errno('EIO'));return dir; };
        expect(await f.storage.replace(address(), 'new')).toEqual({ status: 'applied' });expect(await real.readFile(target, 'utf8')).toBe('new');expect(f.backend.getStats()).toMatchObject({ directoryHandles: 1, retainedStorageIO: 1, ioInFlight: 0, fileHandles: 0, temporaryFiles: 0, bufferedBytes: 0 });expect(await f.storage.release()).toMatchObject({ status: 'unknown' });
    });
});

describe('N06/N09/N10 bounded resources and actual completion', () => {
    it.each(['read', 'write', 'rename', 'remove', 'directory-close'])('release waits for actual %s entry/completion, never an estimated delay', async phase => {
        const f = await setup(), target = await seed(f.root, 'old'), entered = deferred(), gate = deferred();
        if (phase === 'read' || phase === 'write') control.handlers.open = async (...args) => { const h = await (real.open as any)(...args), method = phase === 'read' ? 'read' : 'write', original = h[method].bind(h);vi.spyOn(h, method).mockImplementation(async (...input: any[]) => { entered.resolve();await gate.promise;return original(...input); });return h; };
        if (phase === 'rename') control.handlers.rename = async (...args) => { entered.resolve();await gate.promise;return (real.rename as any)(...args); };
        if (phase === 'remove') control.handlers.unlink = async (...args) => { if (String(args[0]) === target) { entered.resolve();await gate.promise; }return (real.unlink as any)(...args); };
        if (phase === 'directory-close') control.handlers.opendir = async (...args) => { const dir = await (real.opendir as any)(...args);if (String(args[0]) === path.dirname(target)) { const close = dir.close.bind(dir);vi.spyOn(dir, 'close').mockImplementation(async () => { entered.resolve();await gate.promise;return close(); }); }return dir; };
        const pending = phase === 'read' ? f.storage.read(address()) : phase === 'remove' ? f.storage.remove(address()) : f.storage.replace(address(), 'new');await entered.promise;
        let released = false;const closing = f.storage.release();closing.then(() => { released = true; });expect(f.storage.release()).toBe(closing);await Promise.resolve();expect(released).toBe(false);expect(f.backend.getStats()).toMatchObject({ closingOwners: 1, claimedNamespaces: 1, pendingStorageIO: 1, activeStorageIO: 1, ioInFlight: 1 });
        expect(await f.storage.read(address('late'))).toMatchObject({ issue: { code: 'OWNER_RELEASED' } });expect((await f.backend.open({ owner: 'owner', rootDirectory: f.root })).status).toBe('rejected');gate.resolve();expect((await pending).status).toBe(phase === 'read' ? 'found' : 'applied');expect(await closing).toEqual({ status: 'released' });expectEmpty(f.backend);
    });
    it('reads growth under a fixed limit and never substitutes malformed or oversized content', async () => {
        const f = await setup({ maxRecordBytes: 4 }), target = await seed(f.root, '1');let appended = false;
        control.handlers.open = async (...args) => { const h = await (real.open as any)(...args), read = h.read.bind(h);vi.spyOn(h, 'read').mockImplementation(async (...input: any[]) => { if (!appended) { appended = true;await real.appendFile(target, '23456'); }return read(...input); });return h; };
        expect(await f.storage.read(address())).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });expect(await real.readFile(target, 'utf8')).toBe('123456');expect(f.backend.getStats()).toMatchObject({ fileHandles: 0, directoryHandles: 0, bufferedBytes: 0, pendingStorageIO: 0 });await f.storage.release();
    });
    it('checks all directory entries even after finding the target', async () => {
        const f = await setup({ maxDirectoryEntries: 1 }), target = await seed(f.root, 'old');expect(await f.storage.read(address())).toEqual({ status: 'found', text: 'old' });await real.writeFile(path.join(path.dirname(target), 'unrelated'), 'x');
        expect(await f.storage.read(address())).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });expect(f.backend.getStats()).toMatchObject({ directoryHandles: 0, pendingStorageIO: 0 });await f.storage.release();
    });
    it('shares StorageIO and buffer capacity across owners and releases it only after work ends', async () => {
        const f = await setup({ maxBufferedBytes: 6, maxPendingRequests: 2 }), second = await f.backend.open({ owner: 'b', rootDirectory: f.root });if (second.status !== 'opened') throw Error('open');const entered = deferred(), gate = deferred();
        control.handlers.open = async (...args) => { entered.resolve();await gate.promise;return (real.open as any)(...args); };
        const first = f.storage.replace(address(), 'abc');await entered.promise;expect(f.backend.getStats().bufferedBytes).toBe(6);const count = control.calls.length;expect(await second.storage.replace(address('other', 'other'), 'x')).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });expect(control.calls.length).toBe(count);gate.resolve();await first;
        expect(f.backend.getStats().bufferedBytes).toBe(0);expect(await second.storage.replace(address('other', 'other'), 'x')).toEqual({ status: 'applied' });await second.storage.release();await f.storage.release();expectEmpty(f.backend);
    });
    it.each([5, 6, 7])('read simultaneous encoded bytes/text honor total buffer boundary %s', async maxBufferedBytes => {
        const f = await setup({ maxBufferedBytes });await seed(f.root, 'abc');expect((await f.storage.read(address())).status).toBe(maxBufferedBytes < 6 ? 'failed' : 'found');expect(f.backend.getStats().peakBufferedBytes).toBeLessThanOrEqual(maxBufferedBytes);expect(f.backend.getStats().bufferedBytes).toBe(0);await f.storage.release();
    });
    it('checks actual target/temp path lengths before creating data directories and permits max segment 128', async () => {
        const root = path.join(folder, 'app-state');await real.mkdir(root);const canonical = await real.realpath(root), targetBytes = Buffer.byteLength(path.join(canonical, 'd', 'a', 'k.json')), tempBytes = Buffer.byteLength(path.join(canonical, 'd', 'a', '_s_' + '0'.repeat(32) + '.tmp'));
        const f = await setup({ maxPathBytes: targetBytes, maxSegmentBytes: 1 }, 'o', root);expect(await f.storage.read(address('k', 'd', 'a'))).toEqual({ status: 'missing' });expect(await f.storage.replace(address('k', 'd', 'a'), 'x')).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });expect(await real.readdir(root)).toEqual([]);await f.storage.release();
        const g = await setup({ maxPathBytes: tempBytes, maxSegmentBytes: 1 }, 'o', root);expect(await g.storage.replace(address('k', 'd', 'a'), 'x')).toEqual({ status: 'applied' });await g.storage.release();
        const h = await setup({}, 'o', path.join(folder, 'long'));
        for (const length of [127, 128, 129]) expect((await h.storage.replace(address('k'.repeat(length)), 'x')).status).toBe(length > 128 ? 'failed' : 'applied');await h.storage.release();
    });
    it('bounds empty namespaces, live roots, owner IDs and address bytes without evicting old data', async () => {
        const f = await setup({ maxClaimedNamespaces: 1 });await f.storage.read(address());expect(await f.storage.read(address('k', 'other'))).toMatchObject({ issue: { code: 'CAPACITY_EXCEEDED' } });expect(f.backend.getStats().claimedNamespaces).toBe(1);await f.storage.release();expectEmpty(f.backend);
        const a = address(), size = Buffer.byteLength(JSON.stringify([a.namespace, a.key]));for (const maxAddressBytes of [size - 1, size, size + 1]) { const g = await setup({ maxAddressBytes });expect((await g.storage.read(a)).status).toBe(maxAddressBytes < size ? 'failed' : 'missing');await g.storage.release(); }
    });
    it('returns fixed permission failures without paths/stack/cause and does not confuse them with missing', async () => {
        const f = await setup();control.handlers.opendir = async () => { throw errno('EACCES'); };const result = await f.storage.read(address());expect(result).toMatchObject({ status: 'failed', issue: { code: 'PERMISSION_DENIED' } });expect(JSON.stringify(result)).not.toContain('PRIVATE_FS_PATH_AND_CAUSE');await f.storage.release();expectEmpty(f.backend);
    });
});

describe('N11 real accepted A session + real Node filesystem', () => {
    const sessionLimits = { maxKeys: 5, maxDepth: 10, maxNodes: 100, maxValueBytes: 512, maxRecordBytes: 1024, maxAddressBytes: 512, maxRetainedBytes: 8192, maxPendingRequests: 5, maxConcurrentRequests: 2, maxRevision: 100 };
    function session(storage: StateStorage) { return createStateSession({ instanceId: storage.owner, storage, limits: sessionLimits, now: () => 1 }); }
    it('two real sessions cannot use an initial value to overwrite another owner, and a later owner restores the saved file', async () => {
        const f = await setup(), s = session(f.storage), first = s.bind(address(), 1, { hydrate: true });if (first.status !== 'bound') throw Error('bind');const r = await first.binding.recovery;first.binding.confirmInitialization(r, { status: 'ready' });
        const opened = await f.backend.open({ owner: 'other', rootDirectory: f.root });if (opened.status !== 'opened') throw Error('open');const other = session(opened.storage), second = other.bind(address(), 2, { hydrate: true });if (second.status !== 'bound') throw Error('bind');const blocked = await second.binding.recovery;expect(blocked).toMatchObject({ status: 'blocked', issue: { code: 'NAMESPACE_BUSY' } });second.binding.confirmInitialization(blocked, { status: 'failed' });expect((await other.flush()).ok).toBe(false);
        expect((await s.flush()).ok).toBe(true);await other.dispose();await s.dispose();const next = await f.backend.open({ owner: 'next', rootDirectory: f.root });if (next.status !== 'opened') throw Error('open');const after = session(next.storage), third = after.bind(address(), 0, { hydrate: true });if (third.status !== 'bound') throw Error('bind');const restored = await third.binding.recovery;expect(restored).toMatchObject({ status: 'found', value: 1 });third.binding.confirmInitialization(restored, { status: 'ready', value: 1 });expect((await after.flush()).entries[0]?.status).toBe('unchanged');await after.dispose();expectEmpty(f.backend);
    });
    it('persists missing, shared flush, new revisions, clear suppression, remount normalization and real handoff', async () => {
        const f = await setup(), s = session(f.storage), bind = s.bind(address(), 1, { hydrate: true });if (bind.status !== 'bound') throw Error('bind');const b = bind.binding, r = await b.recovery;b.confirmInitialization(r, { status: 'ready' });
        const entered = deferred(), gate = deferred();control.handlers.rename = async (...args) => { entered.resolve();await gate.promise;return (real.rename as any)(...args); };
        const saving = s.flush();expect(s.flush()).toBe(saving);await entered.promise;b.update(2);gate.resolve();expect((await saving).entries[0]?.revision).toBe(1);expect(s.getStats().dirtyKeys).toBe(1);delete control.handlers.rename;await s.flush();expect(JSON.parse(await real.readFile(f.file(), 'utf8')).value).toBe(2);
        await b.clear();await s.flush();expect(await real.stat(f.file()).then(() => true, () => false)).toBe(false);b.update(7);b.release();const next = s.bind(address(), 0, { hydrate: true });if (next.status !== 'bound') throw Error('bind');const recovery = await next.binding.recovery;expect(recovery).toMatchObject({ status: 'found', source: 'session', value: 7 });next.binding.confirmInitialization(recovery, { status: 'ready', value: 70 });s.seal();expect((await s.flush()).ok).toBe(true);expect((await s.dispose()).release.status).toBe('released');expectEmpty(f.backend);
        const opened = await f.backend.open({ owner: 'next', rootDirectory: f.root });if (opened.status !== 'opened') throw Error('open');const restored = session(opened.storage), binding = restored.bind(address(), 0, { hydrate: true });if (binding.status !== 'bound') throw Error('bind');const old = await binding.binding.recovery;expect(old).toMatchObject({ status: 'found', source: 'v1', value: 70 });binding.binding.confirmInitialization(old, { status: 'ready', value: 70 });expect((await restored.flush()).entries[0]?.status).toBe('unchanged');await restored.dispose();expectEmpty(f.backend);
    });
    it.each(['{BROKEN', '{"version":2,"updatedAt":1,"value":0}'])('does not overwrite corrupt/future file %s', async text => {
        const f = await setup(), target = await seed(f.root, text), s = session(f.storage), result = s.bind(address(), 1, { hydrate: true });if (result.status !== 'bound') throw Error('bind');const r = await result.binding.recovery;expect(r.status).toBe('blocked');result.binding.confirmInitialization(r, { status: 'failed' });expect((await s.flush()).ok).toBe(false);expect(await real.readFile(target, 'utf8')).toBe(text);await s.dispose();expectEmpty(f.backend);
    });
});
