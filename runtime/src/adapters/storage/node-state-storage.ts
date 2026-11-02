import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats, Dir } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureStateAddress, failedMutation, failedRead, rejectState, requireStateLimits, stateFields, stateIssue, unknownMutation, validStateOwner } from '../../core/persistence/state-storage.js';
import type { StateAddress, StateIssueCode, StateMutationResult, StateReadResult, StateReleaseResult, StateStorage } from '../../core/persistence/state-storage.js';

export interface NodeStateStorageLimits {
    readonly maxActiveOwners: number;
    readonly maxRoots: number;
    readonly maxClaimedNamespaces: number;
    readonly maxPendingOperations: number;
    readonly maxRecordBytes: number;
    readonly maxAddressBytes: number;
    readonly maxPathBytes: number;
    readonly maxSegmentBytes: number;
    readonly maxDirectoryEntries: number;
    readonly maxBufferedBytes: number;
}
type Identity = { dev: bigint; ino: bigint };
type Root = { path: string; identity: Identity; owners: Set<Owner>; namespaces: Map<string, Namespace> };
type Owner = { id: string; opening: boolean; closing: boolean; root?: Root; operations: Set<Operation>; claims: Set<Namespace>; releasePromise?: Promise<StateReleaseResult>; releaseResult?: StateReleaseResult; idle: (() => void)[] };
type Namespace = { owner: Owner; desktop: string; app: string; identity: string; unknown: boolean; keys: Map<string, { key: string; operation: Operation }> };
type Operation = { owner: Owner; active: boolean; retained: boolean; namespace?: Namespace; key?: string; buffered: number; files: Set<FileHandle>; dirs: Set<Dir>; failedFiles: Set<FileHandle>; failedDirs: Set<Dir>; temp?: { path: string; identity?: Identity }; unknown: boolean; cleanupUnknown: boolean; cleanupIssue?: StateIssueCode };
type Address = { desktop: string; app: string; key: string; namespace: string; filename: string; desktopPath: string; appPath: string; target: string };
class StorageFailure extends Error { constructor(readonly code: StateIssueCode) { super(code); } }
function fail(code: StateIssueCode): never { throw new StorageFailure(code); }
function errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    try { const field = Object.getOwnPropertyDescriptor(error, 'code');return field && 'value' in field && typeof field.value === 'string' ? field.value : undefined; } catch { return undefined; }
}
function issueCode(error: unknown): StateIssueCode {
    if (error instanceof StorageFailure) return error.code;
    const code = errorCode(error);
    return code === 'EACCES' || code === 'EPERM' ? 'PERMISSION_DENIED' : ['ELOOP', 'ENOTDIR', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '') ? 'RESOURCE_UNSUPPORTED' : 'IO_FAILED';
}
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

/** One explicitly shared backend, not a process-wide singleton or a cross-process lock. */
export function createNodeStateStorage(input: NodeStateStorageLimits) {
    const limits = requireStateLimits(input, ['maxActiveOwners', 'maxRoots', 'maxClaimedNamespaces', 'maxPendingOperations', 'maxRecordBytes', 'maxAddressBytes', 'maxPathBytes', 'maxSegmentBytes', 'maxDirectoryEntries', 'maxBufferedBytes']);
    if (limits.maxSegmentBytes > 128) throw new Error('INVALID_INPUT: maxSegmentBytes must be at most 128');
    const roots = new Map<string, Root>(), owners = new Map<string, Owner>(), operations = new Set<Operation>();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let namespaceCount = 0, ioInFlight = 0, bufferedBytes = 0, peakBufferedBytes = 0;
    async function io<T>(action: () => Promise<T>): Promise<T> {
        ioInFlight++;
        try { return await action(); } finally { ioInFlight--; }
    }
    function reserve(op: Operation, count: number) {
        if (count > limits.maxBufferedBytes - bufferedBytes) fail('CAPACITY_EXCEEDED');
        op.buffered += count;bufferedBytes += count;peakBufferedBytes = Math.max(peakBufferedBytes, bufferedBytes);
    }
    function unreserve(op: Operation, count: number) { op.buffered -= count;bufferedBytes -= count; }
    function createOperation(owner: Owner): Operation {
        const op: Operation = { owner, active: true, retained: false, buffered: 0, files: new Set(), dirs: new Set(), failedFiles: new Set(), failedDirs: new Set(), unknown: false, cleanupUnknown: false };
        operations.add(op);owner.operations.add(op);return op;
    }
    function finish(op: Operation) {
        unreserve(op, op.buffered);op.active = false;
        op.retained = op.unknown || !!op.cleanupIssue || !!op.files.size || !!op.dirs.size || !!op.temp;
        if (!op.retained) {
            operations.delete(op);op.owner.operations.delete(op);
            if (op.namespace && op.key) op.namespace.keys.delete(op.key.toLowerCase());
        }
        if (![...op.owner.operations].some(p => p.active)) for (const resolve of op.owner.idle.splice(0)) resolve();
    }
    async function lstat(filename: string): Promise<BigIntStats | undefined> {
        try { return await io(() => fs.lstat(filename, { bigint: true })); }
        catch (error) { if (errorCode(error) === 'ENOENT') return undefined;throw error; }
    }
    async function directory(filename: string, identity?: Identity): Promise<BigIntStats> {
        const stat = await lstat(filename);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || identity && !sameIdentity(identity, stat)) fail('RESOURCE_UNSUPPORTED');
        return stat;
    }
    async function closeDirectory(op: Operation, handle: Dir) {
        try { await io(() => handle.close());op.dirs.delete(handle); }
        catch (error) {
            if (errorCode(error) === 'ERR_DIR_CLOSED') { op.dirs.delete(handle);return; }
            op.failedDirs.add(handle);op.cleanupIssue ??= issueCode(error);op.cleanupUnknown = true;throw error;
        }
    }
    async function closeFile(op: Operation, handle: FileHandle) {
        try { await io(() => handle.close());op.files.delete(handle); }
        catch (error) {
            if (handle.fd === -1) { op.files.delete(handle);throw error; }
            op.failedFiles.add(handle);op.cleanupIssue ??= issueCode(error);op.cleanupUnknown = true;throw error;
        }
    }
    async function lookup(op: Operation, parent: string, name: string, keep = false): Promise<boolean> {
        const handle = await io(() => fs.opendir(parent, { bufferSize: Math.min(32, limits.maxDirectoryEntries + 1) }));op.dirs.add(handle);let count = 0, found = false;
        let failed = false, failure: unknown;
        try {
            for (;;) {
                const entry = await io(() => handle.read());if (!entry) break;
                if (++count > limits.maxDirectoryEntries) fail('CAPACITY_EXCEEDED');
                if (entry.name.toLowerCase() === name.toLowerCase()) { if (entry.name !== name) fail('ADDRESS_UNSUPPORTED');found = true; }
            }
        } catch (error) { failed = true;failure = error; }
        if (!keep) { try { await closeDirectory(op, handle); } catch (error) { if (!failed) { failed = true;failure = error; } } }
        if (failed) throw failure;
        return found;
    }
    function checkPath(filename: string) { if (bytes(filename) > limits.maxPathBytes) fail('CAPACITY_EXCEEDED'); }
    function segment(value: string) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) || value.endsWith('.') || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value.split('.')[0]!)) fail('ADDRESS_UNSUPPORTED');
        if (bytes(value) > limits.maxSegmentBytes) fail('CAPACITY_EXCEEDED');
    }
    function address(owner: Owner, input: StateAddress): Address {
        const captured = captureStateAddress(input, limits.maxAddressBytes);if (captured.status === 'rejected') fail(captured.issue.code);
        let tuple: unknown;try { tuple = JSON.parse(captured.address.namespace); } catch { fail('ADDRESS_UNSUPPORTED'); }
        if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some(v => typeof v !== 'string' || !v.length) || JSON.stringify(tuple) !== captured.address.namespace) fail('ADDRESS_UNSUPPORTED');
        const [desktop, app] = tuple as [string, string], key = captured.address.key;segment(desktop);segment(app);segment(key);
        const filename = key + '.json';if (bytes(filename) > 255) fail('CAPACITY_EXCEEDED');
        const desktopPath = path.join(owner.root!.path, desktop), appPath = path.join(desktopPath, app), target = path.join(appPath, filename);
        checkPath(desktopPath);checkPath(appPath);checkPath(target);
        return { desktop, app, key, namespace: JSON.stringify([desktop.toLowerCase(), app.toLowerCase()]), filename, desktopPath, appPath, target };
    }
    function claim(owner: Owner, a: Address, write: boolean, initialBytes: number): Operation {
        if (owner.closing || owners.get(owner.id) !== owner) fail('OWNER_RELEASED');
        const root = owner.root!, ns = root.namespaces.get(a.namespace);
        if (ns && ns.owner !== owner) fail('NAMESPACE_BUSY');
        if (ns && (ns.desktop !== a.desktop || ns.app !== a.app)) fail('ADDRESS_UNSUPPORTED');
        for (const other of root.namespaces.values()) if (other.desktop.toLowerCase() === a.desktop.toLowerCase() && other.desktop !== a.desktop) fail('ADDRESS_UNSUPPORTED');
        if (write && ns?.unknown) fail('UNKNOWN_OUTCOME');
        const existing = ns?.keys.get(a.key.toLowerCase());if (existing) fail(existing.key === a.key ? 'CAPACITY_EXCEEDED' : 'ADDRESS_UNSUPPORTED');
        if (operations.size >= limits.maxPendingOperations || initialBytes > limits.maxBufferedBytes - bufferedBytes || !ns && namespaceCount >= limits.maxClaimedNamespaces) fail('CAPACITY_EXCEEDED');
        const current = ns ?? { owner, desktop: a.desktop, app: a.app, identity: a.namespace, unknown: false, keys: new Map() };
        if (!ns) { root.namespaces.set(a.namespace, current);owner.claims.add(current);namespaceCount++; }
        const op = createOperation(owner);op.namespace = current;op.key = a.key;reserve(op, initialBytes);current.keys.set(a.key.toLowerCase(), { key: a.key, operation: op });return op;
    }
    async function childDirectory(op: Operation, parent: string, name: string, create: boolean): Promise<BigIntStats | undefined> {
        const found = await lookup(op, parent, name), filename = path.join(parent, name);
        if (!found) {
            if (!create) { if (await lstat(filename)) fail('RESOURCE_UNSUPPORTED');return undefined; }
            try { await io(() => fs.mkdir(filename, { mode: 0o700 })); }
            catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
            if (!await lookup(op, parent, name)) fail('RESOURCE_UNSUPPORTED');
        }
        return directory(filename);
    }
    async function prepare(op: Operation, a: Address, create: boolean): Promise<{ target?: BigIntStats; parents: { path: string; identity: Identity }[] } | undefined> {
        const root = op.owner.root!;await directory(root.path, root.identity);
        const desktop = await childDirectory(op, root.path, a.desktop, create);if (!desktop) return undefined;
        const app = await childDirectory(op, a.desktopPath, a.app, create);if (!app) return undefined;
        const found = await lookup(op, a.appPath, a.filename, true), target = await lstat(a.target);
        if (found !== !!target) fail('RESOURCE_UNSUPPORTED');
        if (target && (!target.isFile() || target.nlink !== 1n)) fail('RESOURCE_UNSUPPORTED');
        return { target, parents: [{ path: root.path, identity: root.identity }, { path: a.desktopPath, identity: desktop }, { path: a.appPath, identity: app }] };
    }
    async function verify(prepared: NonNullable<Awaited<ReturnType<typeof prepare>>>, a: Address) {
        for (const parent of prepared.parents) await directory(parent.path, parent.identity);
        const current = await lstat(a.target);
        if (current && (!current.isFile() || current.nlink !== 1n) || !!current !== !!prepared.target || current && prepared.target && !sameIdentity(current, prepared.target)) fail('RESOURCE_UNSUPPORTED');
    }
    async function cleanup(op: Operation) {
        for (const file of [...op.files]) if (!op.failedFiles.has(file)) { try { await closeFile(op, file); } catch { /* bounded fact retained by closeFile */ } }
        if (op.temp?.identity) {
            const temp = op.temp;
            try {
                await directory(op.owner.root!.path, op.owner.root!.identity);
                const stat = await lstat(temp.path);
                if (!stat) op.temp = undefined;
                else if (!sameIdentity(stat, temp.identity!)) { op.cleanupUnknown = true;op.cleanupIssue ??= 'RESOURCE_UNSUPPORTED'; }
                else {
                    try { await io(() => fs.unlink(temp.path));op.temp = undefined; }
                    catch (error) {
                        const after = await lstat(temp.path);
                        if (!after) op.temp = undefined;
                        else { op.cleanupIssue ??= issueCode(error);if (!sameIdentity(after, temp.identity!)) op.cleanupUnknown = true; }
                    }
                }
            } catch (error) { op.cleanupIssue ??= issueCode(error);op.cleanupUnknown = true; }
        } else if (op.temp) { op.cleanupIssue ??= 'IO_FAILED';op.cleanupUnknown = true; }
        for (const dir of [...op.dirs]) if (!op.failedDirs.has(dir)) { try { await closeDirectory(op, dir); } catch { /* retained, never silently cleared */ } }
    }
    async function readText(op: Operation, a: Address, stat: BigIntStats): Promise<string> {
        if (stat.size > BigInt(limits.maxRecordBytes)) fail('CAPACITY_EXCEEDED');
        const handle = await io(() => fs.open(a.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));op.files.add(handle);
        const actual = await io(() => handle.stat({ bigint: true }));
        if (!actual.isFile() || actual.nlink !== 1n || !sameIdentity(actual, stat)) fail('RESOURCE_UNSUPPORTED');
        if (actual.size > BigInt(limits.maxRecordBytes)) fail('CAPACITY_EXCEEDED');
        const chunks: Buffer[] = [];let total = 0, allocated = 0;
        for (;;) {
            const capacity = Math.min(65536, Math.max(1, Number(actual.size) - total), Math.max(1, limits.maxRecordBytes - total));reserve(op, capacity);
            const chunk = Buffer.alloc(capacity);const read = await io(() => handle.read(chunk, 0, capacity, null));
            if (!Number.isInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > capacity) fail('IO_FAILED');
            if (!read.bytesRead) { unreserve(op, capacity);break; }
            total += read.bytesRead;if (total > limits.maxRecordBytes) fail('CAPACITY_EXCEEDED');
            chunks.push(chunk.subarray(0, read.bytesRead));allocated += capacity;
        }
        let buffer: Buffer;
        if (chunks.length === 1) buffer = chunks.pop()!;
        else { reserve(op, total);buffer = Buffer.concat(chunks, total);chunks.length = 0;unreserve(op, allocated);allocated = total; }
        reserve(op, total);let text: string;
        try { text = decoder.decode(buffer); } catch { fail('CORRUPT'); }
        buffer = Buffer.alloc(0);unreserve(op, allocated);return text!;
    }
    function textSize(text: unknown): number {
        if (typeof text !== 'string') fail('INVALID_INPUT');if (text.length > limits.maxRecordBytes) fail('CAPACITY_EXCEEDED');
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff) { const next = text.charCodeAt(++i);if (!(next >= 0xdc00 && next <= 0xdfff)) fail('INVALID_INPUT'); }
            else if (c >= 0xdc00 && c <= 0xdfff) fail('INVALID_INPUT');
        }
        const size = bytes(text);if (size > limits.maxRecordBytes) fail('CAPACITY_EXCEEDED');return size;
    }
    function run(owner: Owner, input: StateAddress, kind: 'read' | 'replace' | 'remove', text?: string): Promise<StateReadResult | StateMutationResult> {
        let a: Address, op: Operation;
        try {
            if (owner.closing || owners.get(owner.id) !== owner) fail('OWNER_RELEASED');
            a = address(owner, input);const size = kind === 'replace' ? textSize(text) : 0;
            if (kind === 'replace') { const tempName = '_s_' + '0'.repeat(32) + '.tmp';if (bytes(tempName) > 255) fail('CAPACITY_EXCEEDED');checkPath(path.join(a.appPath, tempName)); }
            op = claim(owner, a, kind !== 'read', 2 * size);
        } catch (error) { const code = issueCode(error);return Promise.resolve(kind === 'read' ? failedRead(code) : failedMutation(code)); }
        return (async () => {
            let result: StateReadResult | StateMutationResult, targetEntered = false;
            try {
                const encoded = kind === 'replace' ? Buffer.from(text!, 'utf8') : undefined;
                const prepared = await prepare(op, a, kind === 'replace');
                if (kind === 'read') result = prepared?.target ? Object.freeze({ status: 'found', text: await readText(op, a, prepared.target) }) : Object.freeze({ status: 'missing' });
                else if (kind === 'remove') {
                    if (prepared?.target) { await verify(prepared, a);targetEntered = true;try { await io(() => fs.unlink(a.target)); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; } }
                    result = Object.freeze({ status: 'applied' });
                } else {
                    const tempPath = path.join(a.appPath, '_s_' + randomUUID().replaceAll('-', '') + '.tmp');checkPath(tempPath);
                    let handle: FileHandle;
                    try { handle = await io(() => fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
                    catch (error) {
                        if (errorCode(error) !== 'EEXIST') { const possible = await lstat(tempPath);if (possible) { op.temp = { path: tempPath };op.cleanupUnknown = true;op.cleanupIssue = 'IO_FAILED'; } }
                        throw error;
                    }
                    op.files.add(handle);op.temp = { path: tempPath };
                    const stat = await io(() => handle.stat({ bigint: true }));op.temp.identity = stat;
                    if (!stat.isFile() || stat.nlink !== 1n) fail('RESOURCE_UNSUPPORTED');
                    let written = 0;
                    while (written < encoded!.length) {
                        const part = await io(() => handle.write(encoded!, written, encoded!.length - written, null));
                        if (!Number.isInteger(part.bytesWritten) || part.bytesWritten <= 0 || part.bytesWritten > encoded!.length - written) fail('IO_FAILED');written += part.bytesWritten;
                    }
                    await closeFile(op, handle);await verify(prepared!, a);targetEntered = true;await io(() => fs.rename(tempPath, a.target));op.temp = undefined;
                    result = Object.freeze({ status: 'applied' });
                }
            } catch (error) {
                if (kind !== 'read' && targetEntered) { op.unknown = true;op.namespace!.unknown = true;result = unknownMutation(); }
                else result = kind === 'read' ? failedRead(issueCode(error)) : failedMutation(issueCode(error));
            }
            await cleanup(op);
            if (op.cleanupIssue && (result.status === 'found' || result.status === 'missing')) result = failedRead(op.cleanupIssue);
            finish(op);return result;
        })();
    }
    function release(owner: Owner): Promise<StateReleaseResult> {
        if (owner.releasePromise) return owner.releasePromise;
        owner.closing = true;let resolve!: (value: StateReleaseResult) => void;
        owner.releasePromise = new Promise(done => { resolve = done; });
        void Promise.resolve().then(async () => {
            if ([...owner.operations].some(op => op.active)) await new Promise<void>(done => owner.idle.push(done));
            const retained = [...owner.operations];
            const result: StateReleaseResult = retained.some(op => op.unknown || op.cleanupUnknown) ? Object.freeze({ status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') }) : retained.length ? Object.freeze({ status: 'failed', issue: stateIssue(retained.find(op => op.cleanupIssue)?.cleanupIssue ?? 'IO_FAILED') }) : Object.freeze({ status: 'released' });
            if (result.status === 'released') {
                for (const ns of owner.claims) { owner.root!.namespaces.delete(ns.identity);namespaceCount--; }owner.claims.clear();owner.root!.owners.delete(owner);
                if (!owner.root!.owners.size && roots.get(owner.root!.path) === owner.root) roots.delete(owner.root!.path);
                if (owners.get(owner.id) === owner) owners.delete(owner.id);
            }
            owner.releaseResult = result;resolve(result);
        });
        return owner.releasePromise;
    }
    function open(input: Readonly<{ owner: string; rootDirectory: string }>): Promise<Readonly<{ status: 'opened'; storage: StateStorage }> | ReturnType<typeof rejectState>> {
        const fields = stateFields(input), id = fields?.owner?.value, configured = fields?.rootDirectory?.value;
        if (!fields || Object.keys(fields).length !== 2 || !validStateOwner(id, limits.maxAddressBytes) || typeof configured !== 'string' || !path.isAbsolute(configured) || configured.includes('\0')) return Promise.resolve(rejectState('INVALID_INPUT'));
        if (bytes(configured) > limits.maxPathBytes) return Promise.resolve(rejectState('CAPACITY_EXCEEDED'));
        if (owners.has(id)) return Promise.resolve(rejectState('OWNER_BUSY'));
        if (owners.size >= limits.maxActiveOwners || operations.size >= limits.maxPendingOperations) return Promise.resolve(rejectState('CAPACITY_EXCEEDED'));
        const owner: Owner = { id, opening: true, closing: false, claims: new Set(), operations: new Set(), idle: [] };owners.set(id, owner);const op = createOperation(owner);
        return (async () => {
            try {
                try { await io(() => fs.mkdir(configured, { recursive: true, mode: 0o700 })); } catch (error) { if (errorCode(error) === 'EEXIST') fail('RESOURCE_UNSUPPORTED');throw error; }
                const canonical = await io(() => fs.realpath(configured));checkPath(canonical);const identity = await directory(canonical);
                let root = roots.get(canonical);
                if (root && !sameIdentity(root.identity, identity)) fail('RESOURCE_UNSUPPORTED');
                if (!root) root = [...roots.values()].find(r => sameIdentity(r.identity, identity));
                if (!root) { if (roots.size >= limits.maxRoots) fail('CAPACITY_EXCEEDED');root = { path: canonical, identity, owners: new Set(), namespaces: new Map() };roots.set(canonical, root); }
                // Pin before validating across an await: an earlier owner's
                // release must not remove a root that this open is adopting.
                owner.root = root;root.owners.add(owner);await directory(root.path, root.identity);owner.opening = false;finish(op);
                const storage: StateStorage = Object.freeze({ owner: id, read: (a: StateAddress) => run(owner, a, 'read') as Promise<StateReadResult>, replace: (a: StateAddress, text: string) => run(owner, a, 'replace', text) as Promise<StateMutationResult>, remove: (a: StateAddress) => run(owner, a, 'remove') as Promise<StateMutationResult>, release: () => release(owner) });
                return Object.freeze({ status: 'opened' as const, storage });
            } catch (error) {
                if (owner.root) { owner.root.owners.delete(owner);if (!owner.root.owners.size && roots.get(owner.root.path) === owner.root) roots.delete(owner.root.path); }
                finish(op);if (owners.get(id) === owner) owners.delete(id);return rejectState(issueCode(error));
            }
        })();
    }
    return Object.freeze({ open, getStats: () => Object.freeze({ ownerSlots: owners.size, pendingOpens: [...owners.values()].filter(o => o.opening).length, activeOwners: [...owners.values()].filter(o => !o.opening && !o.closing).length, closingOwners: [...owners.values()].filter(o => o.closing && !o.releaseResult).length, retainedOwners: [...owners.values()].filter(o => o.closing && !!o.releaseResult).length, roots: roots.size, claimedNamespaces: namespaceCount, pendingOperations: operations.size, activeOperations: [...operations].filter(o => o.active).length, ioInFlight, retainedOperations: [...operations].filter(o => o.retained).length, fileHandles: [...operations].reduce((n, o) => n + o.files.size, 0), directoryHandles: [...operations].reduce((n, o) => n + o.dirs.size, 0), temporaryFiles: [...operations].filter(o => o.temp).length, unknownOperations: [...operations].filter(o => o.unknown || o.cleanupUnknown).length, cleanupFailedOperations: [...operations].filter(o => o.cleanupIssue).length, bufferedBytes, peakBufferedBytes }) });
}
