import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { IDESession, filePage } from '../dist/core/ide-session.js';
import { IDEHistory, readLegacyIDE } from '../dist/core/ide-history.js';
import { ScopedSearch } from '../dist/core/scoped-search.js';
import { ScopedLSP } from '../dist/core/scoped-lsp.js';
import { readObservedFile, directoryIdentity } from '../dist/core/versioned-file-write.js';
import { createFileWithParents, replaceObservedFile, renameObservedFile, deleteObservedFile } from '../dist/core/observed-file-operations.js';
import { boundedJSON, closeDirectory, IDEError } from '../dist/core/ide-errors.js';
import { createMemoryStateStorage } from '../../../runtime/dist/adapters/storage/memory-state-storage.js';
import { createAppStatePersistence } from '../../../runtime/dist/worker-runtime/state-persistence.js';

const working = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-ide-edges-')));
const facts = { startedAt: new Date().toISOString(), working, cases: [], passed: false };
let sequence = 0;
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(value).digest('hex');
async function run(name, action) { const time = performance.now(); await action(); facts.cases.push({ name, ms: performance.now() - time, passed: true }); console.log('PASS', name); }
async function workspace(name) { const root = path.join(working, name); await fs.mkdir(root, { recursive: true }); return root; }
const code = expected => error => { assert.equal(error.code ?? error.message.split(':')[0], expected); return true; };
const rootSource = async root => ({ path: root, identity: await directoryIdentity(root), workspace: root, workspaceIdentity: await directoryIdentity(root) });
async function session(root, options = {}) {
    const id = 'edge' + ++sequence, namespace = JSON.stringify(['test', options.sessionKey ?? id]);
    const backend = options.backend ?? createMemoryStateStorage({ maxStoredKeys: 128, maxStoredBytes: 8 * 1024 * 1024, maxRecordBytes: 262272, maxAddressBytes: 1024, maxActiveOwners: 8, maxClaimedNamespaces: 64 }, options.initial ?? []);
    const opened = backend.open(id); assert.equal(opened.status, 'opened');
    const managed = createAppStatePersistence({ instanceId: id, desktopId: 'test', appKey: id, storage: options.storage ? options.storage(opened.storage) : opened.storage });
    const owner = new IDESession(options.port ? options.port(managed.port) : managed.port, { sessionKey: options.sessionKey ?? id,
        historyPath: options.historyPath ?? path.join(working, id + '-history.json'), projectPath: root, legacyImportPath: options.legacy }, () => {});
    const call = (name, args, view = 'workspace') => owner.invoke(name, args, view);
    const close = async () => { owner.stop(); return managed.close(() => owner.close()); };
    return { owner, managed, backend, storage: opened.storage, namespace, call, close };
}
const sessionRecords = (sessionKey, values) => Object.entries(values).map(([key, value]) => ({
    address: { namespace: JSON.stringify(['test', sessionKey]), key }, text: JSON.stringify(value),
}));
async function savedValue(x, key) {
    const receipt = await x.storage.read({ namespace: x.namespace, key }); assert.equal(receipt.status, 'found');
    const parsed = JSON.parse(receipt.text); return Array.isArray(parsed) ? parsed : parsed.value;
}

try {
    await run('file/page/DTO boundaries reject whole values without truncation', async () => {
        assert.match(filePage('a\nb\nc', 1, 1), /00002\| b/); assert.doesNotMatch(filePage('a\nb\nc', 1, 1), /00001/);
        for (const range of [[-1, 1], [0, 0], [0, 2001], [0.5, 2]]) assert.throws(() => filePage('a', ...range), code('IDE_RANGE_INVALID'));
        const pageSuffix = Buffer.byteLength(filePage('', 0, 1));
        for (const delta of [-1, 0]) assert.equal(Buffer.byteLength(filePage('x'.repeat(262144 - pageSuffix + delta), 0, 1)), 262144 + delta);
        assert.throws(() => filePage('x'.repeat(262145 - pageSuffix), 0, 1), code('IDE_PAGE_TOO_LARGE'));
        for (const delta of [-1, 0]) assert.equal(boundedJSON('x'.repeat(262144 - 2 + delta)).length, 262144 - 2 + delta);
        assert.throws(() => boundedJSON('x'.repeat(262143)), code('IDE_RESULT_TOO_LARGE'));
        let deep = null; for (let i = 0; i < 26; i++) deep = { deep }; assert.throws(() => boundedJSON(deep), code('IDE_RESULT_TOO_LARGE'));
        const root = await workspace('size'), file = path.join(root, 'file');
        for (const delta of [-1, 0]) { await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024 + delta)); assert.equal((await readObservedFile(root, file)).content.length, 4 * 1024 * 1024 + delta); }
        await fs.appendFile(file, 'x'); await assert.rejects(readObservedFile(root, file), /RESOURCE_UNSUPPORTED/);
        await assert.rejects(closeDirectory({ async close() { throw Object.assign(Error(), { code: 'EIO' }); } }), code('IDE_DIRECTORY_CLOSE_UNCERTAIN'));
    });
    await run('staging close rejection cannot certify App or history resource release', async () => {
        for (const physicallyClosed of [false, true]) {
            const root = await workspace('staging-' + physicallyClosed), file = path.join(root, 'file'); await fs.writeFile(file, 'before');
            const x = await session(root); await x.owner.start(); await x.call('multi_open_file', { filePaths: [file] });
            const open = fs.open, acquired = [];
            fs.open = async (name, flags, ...args) => {
                const handle = await open(name, flags, ...args);
                if (flags === 'wx' && String(name).startsWith(path.join(root, '.file.aotui-'))) {
                    const close = handle.close.bind(handle); acquired.push({ handle, close });
                    handle.close = async () => { if (physicallyClosed) await close(); throw Object.assign(Error('fixture staging close failure'), { code: 'EIO' }); };
                }
                return handle;
            };
            try {
                const outcome = await x.call('write_file', { filePath: file, content: 'after' });
                assert.equal(acquired.length, 1); assert.equal(acquired[0].handle.fd === -1, physicallyClosed);
                facts.stagingClose ??= []; facts.stagingClose.push({ physicallyClosed, outcome, descriptorOpen: acquired[0].handle.fd !== -1 });
                assert.equal(outcome.success, false); assert.equal(outcome.effects, undefined); assert.equal(outcome.error.code, 'RESOURCE_CLOSE_UNCERTAIN'); assert.equal(await fs.readFile(file, 'utf8'), 'before');
                await assert.rejects(x.owner.close(), code('IDE_RESOURCE_CLEANUP_FAILED'));
            } finally {
                fs.open = open;
                for (const item of acquired) { await item.close(); assert.equal(item.handle.fd, -1); }
                await x.close();
            }
        }
        const root = await workspace('staging-history'), file = path.join(root, 'history.json'), history = new IDEHistory(file);
        await history.add(root, path.join(root, 'first')); const before = await fs.readFile(file), open = fs.open, acquired = [];
        fs.open = async (name, flags, ...args) => {
            const handle = await open(name, flags, ...args);
            if (flags === 'wx' && String(name).startsWith(path.join(root, '.history.json.aotui-'))) {
                const close = handle.close.bind(handle); acquired.push({ handle, close });
                handle.close = async () => { throw Object.assign(Error('fixture history staging close failure'), { code: 'EIO' }); };
            }
            return handle;
        };
        try {
            await assert.rejects(history.add(root, path.join(root, 'second')), error => error.code === 'RESOURCE_CLOSE_UNCERTAIN' && error.effects === 'unknown');
            assert.equal(acquired.length, 1); assert.ok(acquired[0].handle.fd >= 0); assert.deepEqual(await fs.readFile(file), before);
            assert.throws(() => history.add(root, path.join(root, 'third')), code('HISTORY_OUTCOME_UNKNOWN'));
            await assert.rejects(history.close(), code('HISTORY_CLEANUP_FAILED'));
        } finally { fs.open = open; for (const item of acquired) await item.close(); await history.close().catch(() => {}); }
    });
    await run('parent/root identity, aliases, hardlinks and no-overwrite checks precede disk effects', async () => {
        const root = await workspace('identity'), parent = path.join(root, 'parent'); await fs.mkdir(parent);
        const file = path.join(parent, 'file'); await fs.writeFile(file, 'before'); const observed = await readObservedFile(root, file);
        await fs.rename(parent, parent + '-old'); await fs.mkdir(parent); await fs.writeFile(file, 'replacement');
        await assert.rejects(replaceObservedFile(observed, 'bad', () => {})); assert.equal(await fs.readFile(file, 'utf8'), 'replacement');
        assert.equal((await fs.readdir(parent)).some(name => name.endsWith('.aotui-lock')), false);
        const outside = await workspace('outside'); await fs.symlink(outside, path.join(root, 'alias'));
        await assert.rejects(createFileWithParents(root, await directoryIdentity(root), path.join(root, 'alias/bad'), 'bad', () => {})); assert.deepEqual(await fs.readdir(outside), []);
        await fs.link(file, path.join(parent, 'hardlink')); await assert.rejects(readObservedFile(root, file), /RESOURCE_UNSUPPORTED/); await fs.unlink(path.join(parent, 'hardlink'));
        const fresh = await readObservedFile(root, file), target = path.join(root, 'target'); await fs.writeFile(target, 'keep');
        await assert.rejects(renameObservedFile(fresh, target, () => {}), code('RESOURCE_ALREADY_EXISTS'));
        assert.equal(await fs.readFile(file, 'utf8'), 'replacement'); assert.equal(await fs.readFile(target, 'utf8'), 'keep');
        await fs.writeFile(file, 'external'); await assert.rejects(deleteObservedFile(fresh, () => {}), code('RESOURCE_CONFLICT')); assert.equal(await fs.readFile(file, 'utf8'), 'external');
    });
    await run('auto-parent partial and native wx unknown retain exact disk facts', async () => {
        const root = await workspace('partial'), identity = await directoryIdentity(root), mkdir = fs.mkdir;
        fs.mkdir = async (file, ...args) => { if (String(file) === path.join(root, 'a/b')) throw Object.assign(Error(), { code: 'EACCES' }); return mkdir(file, ...args); };
        try { await assert.rejects(createFileWithParents(root, identity, path.join(root, 'a/b/file'), 'x', () => {}), error => error.effects === 'partial'); }
        finally { fs.mkdir = mkdir; }
        assert.ok((await fs.stat(path.join(root, 'a'))).isDirectory()); await assert.rejects(fs.stat(path.join(root, 'a/b/file')), { code: 'ENOENT' });
        const open = fs.open; let attempts = 0;
        fs.open = async (file, flags, ...args) => { if (String(file) === path.join(root, 'unknown') && flags === 'wx') { attempts++; throw Object.assign(Error(), { code: 'EIO', syscall: 'open', path: file }); } return open(file, flags, ...args); };
        try { await assert.rejects(createFileWithParents(root, identity, path.join(root, 'unknown'), 'x', () => {}), error => error.effects === 'unknown'); } finally { fs.open = open; }
        assert.equal(attempts, 1);
    });
    await run('batch prevalidation, partial stop and concurrent workspace commit are exact', async () => {
        const root = await workspace('batch'), file = path.join(root, 'a.ts'); await fs.writeFile(file, 'one');
        const x = await session(root); await x.owner.start(); await x.call('multi_open_file', { filePaths: [file] });
        const invalid = await x.call('batch_edit', { edits: [{ filePath: file, oldString: 'one', newString: 'two' }, { filePath: file, oldString: 1, newString: 'bad' }] });
        assert.equal(invalid.effects, 'none'); assert.equal(await fs.readFile(file, 'utf8'), 'one');
        const partial = await x.call('batch_edit', { edits: [{ filePath: file, oldString: 'one', newString: 'two' }, { filePath: file, oldString: 'missing', newString: 'bad' }, { filePath: file, oldString: 'two', newString: 'three' }] });
        assert.equal(partial.effects, 'partial'); assert.equal(await fs.readFile(file, 'utf8'), 'two'); assert.deepEqual(x.owner.lastBatch.map(item => item.status), ['succeeded', 'failed', 'not-run']);
        const entered = gate(), release = gate(), add = x.owner.history.add.bind(x.owner.history);
        x.owner.history.add = async (...args) => { entered.resolve(); await release.promise; return add(...args); };
        const pending = x.call('batch_edit', { edits: [{ filePath: file, oldString: 'two', newString: 'three' }, { filePath: file, oldString: 'three', newString: 'four' }] });
        await entered.promise; const extra = await workspace('batch-other'); assert.equal((await x.call('add_folder_to_workspace', { folderPath: extra })).success, true);
        release.resolve(); const concurrent = await pending; assert.equal(concurrent.effects, 'partial'); assert.equal(await fs.readFile(file, 'utf8'), 'three');
        assert.equal((await x.close()).ok, true);
    });
    await run('conditional slice close failure stays unknown and prevents clean App release', async () => {
        const root = await workspace('slice-close'), x = await session(root); await x.owner.start();
        const open = fs.open, target = path.join(root, 'file'); let closeCalls = 0;
        fs.open = async (file, flags, ...args) => {
            const handle = await open(file, flags, ...args);
            if (String(file) === target && flags === 'wx') { const close = handle.close.bind(handle); handle.close = async () => { closeCalls++; await close(); throw Error('fixture close rejection after actual close'); }; }
            return handle;
        };
        let result; try { result = await x.owner.roots[0].creator({ relativePath: 'file', content: 'created' }); } finally { fs.open = open; }
        assert.equal(result.status, 'unknown'); assert.equal(closeCalls, 1); assert.equal(await fs.readFile(target, 'utf8'), 'created');
        await assert.rejects(x.owner.close(), code('IDE_RESOURCE_CLEANUP_FAILED')); await x.managed.close(() => x.owner.close());
    });
    await run('independent language panels coexist while a replaced file rejects a late response', async () => {
        const root = await workspace('language-panels'), file = path.join(root, 'a.ts'); await fs.writeFile(file, 'const x = 1;');
        const x = await session(root); await x.owner.start(); await x.call('multi_open_file', { filePaths: [file] });
        const record = x.owner.files.get(file), entered = gate(), release = gate();
        try {
            x.owner.lsp.query = async kind => {
                if (kind === 'hover') { entered.resolve(); await release.promise; }
                return { documentVersion: 1, value: kind };
            };
            const hover = x.call('lsp_hover', { file_path: file, line: 1, character: 1 }, record.viewId);
            await entered.promise;
            assert.equal((await x.call('lsp_goto_definition', { file_path: file, line: 1, character: 1 }, record.viewId)).success, true);
            release.resolve(); assert.equal((await hover).success, true);
            assert.deepEqual(Object.keys(record.panels).sort(), ['definition', 'hover']);

            const lateEntered = gate(), lateRelease = gate();
            try {
                x.owner.lsp.query = async () => { lateEntered.resolve(); await lateRelease.promise; return { documentVersion: 1, value: 'obsolete' }; };
                const late = x.call('lsp_hover', { file_path: file, line: 1, character: 1 }, record.viewId);
                await lateEntered.promise;
                await fs.writeFile(file, 'const x = 2;');
                assert.equal((await x.call('multi_open_file', { filePaths: [file] })).success, true);
                const current = x.owner.files.get(file); assert.notEqual(current, record); assert.equal(current.viewId, record.viewId);
                lateRelease.resolve(); const rejected = await late;
                assert.equal(rejected.error.code, 'IDE_FILE_VIEW_STALE'); assert.equal(rejected.effects, 'none'); assert.deepEqual(current.panels, {});
                x.owner.lsp.query = async (_kind, _file, content) => ({ documentVersion: 2, value: content });
                const fresh = await x.call('lsp_hover', { file_path: file, line: 1, character: 1 }, current.viewId);
                assert.equal(fresh.success, true); assert.equal(fresh.data.value, 'const x = 2;');
            } finally { lateRelease.resolve(); }
        } finally { release.resolve(); await x.close(); }
    });
    await run('invalid diagnostic DTO never changes the loaded file or panels', async () => {
        const root = await workspace('diagnostic-atomic'), file = path.join(root, 'a.ts'); await fs.writeFile(file, 'const x = 1;');
        const x = await session(root); await x.owner.start(); await x.call('multi_open_file', { filePaths: [file] });
        const record = x.owner.files.get(file), before = JSON.stringify(record);
        x.owner.lsp.query = async () => ({ documentVersion: 1, value: [{ range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } }, message: 'bad' }] });
        const result = await x.call('lsp_get_diagnostics', { file_path: file }, record.viewId);
        assert.equal(result.error.code, 'LSP_DIAGNOSTICS_INVALID'); assert.equal(result.effects, 'none'); assert.equal(JSON.stringify(record), before); await x.close();
    });
    await run('queued history cancellation has no disk effect and is a healthy close', async () => {
        const root = await workspace('cancel-history'), file = path.join(root, 'history.json'), history = new IDEHistory(file);
        const adding = history.add(root, path.join(root, 'file')), reading = history.read();
        history.stop();
        const settled = await Promise.allSettled([adding, reading]);
        assert.deepEqual(settled.map(result => result.status === 'rejected' && result.reason.code), ['HISTORY_CLOSED', 'HISTORY_CLOSED']);
        await history.close(); assert.deepEqual(await fs.readdir(root), []);
    });
    await run('multi-open prepares every file before one business commit', async () => {
        const root = await workspace('open-atomic'), file = path.join(root, 'file'), second = path.join(root, 'second');
        await fs.writeFile(file, 'existing'); await fs.writeFile(second, 'second');
        const x = await session(root); await x.owner.start(); await x.call('multi_open_file', { filePaths: [file] });
        const before = x.owner.files.get(file), version = x.owner.workspaceVersion;
        const outcome = await x.call('multi_open_file', { filePaths: [second, file, path.join(root, 'missing')] });
        assert.equal(outcome.success, false); assert.equal(outcome.effects, 'none');
        assert.equal(x.owner.workspaceVersion, version); assert.equal(x.owner.files.get(file), before); assert.equal(x.owner.files.size, 1);
        assert.equal((await x.close()).ok, true);
    });
    await run('history concurrent CAS, corruption and unknown never overwrite or retry', async () => {
        const root = await workspace('history'), file = path.join(root, 'history.json'), a = new IDEHistory(file), b = new IDEHistory(file);
        await a.add(root, path.join(root, 'initial'));
        const reads = fs.open, arrived = gate(), released = gate(); let probes = 0;
        fs.open = async (p, flags, ...args) => { const handle = await reads(p, flags, ...args); if (String(p) === file && typeof flags === 'number' && ++probes <= 2) { if (probes === 2) arrived.resolve(); await released.promise; } return handle; };
        const first = a.add(root, path.join(root, 'a')), second = b.add(root, path.join(root, 'b'));
        try { await arrived.promise; released.resolve(); const replies = await Promise.allSettled([first, second]); assert.equal(replies.filter(item => item.status === 'fulfilled').length, 1); }
        finally { released.resolve(); fs.open = reads; }
        assert.equal((await a.read()).workspaces[root].length, 2); await a.close(); await b.close();
        await fs.writeFile(file, JSON.stringify({ version: 1, workspaces: {}, migration: false })); const invalidMarker = new IDEHistory(file); await assert.rejects(invalidMarker.add(root, path.join(root, 'x')), code('HISTORY_INVALID')); await invalidMarker.close();
        await fs.writeFile(file, '{broken'); const corrupt = new IDEHistory(file); await assert.rejects(corrupt.add(root, path.join(root, 'c'))); assert.equal(await fs.readFile(file, 'utf8'), '{broken'); await corrupt.close();
        await fs.unlink(file); const unknown = new IDEHistory(file), nativeOpen = fs.open; let attempts = 0;
        fs.open = async (p, flags, ...args) => { if (String(p) === file && flags === 'wx') { attempts++; throw Object.assign(Error(), { code: 'EIO', syscall: 'open', path: p }); } return nativeOpen(p, flags, ...args); };
        try { await assert.rejects(unknown.add(root, path.join(root, 'a'))); await assert.rejects(async () => unknown.add(root, path.join(root, 'b')), code('HISTORY_OUTCOME_UNKNOWN')); } finally { fs.open = nativeOpen; }
        assert.equal(attempts, 1); await assert.rejects(unknown.close(), code('HISTORY_CLEANUP_FAILED'));
    });
    await run('missing restored roots remain saved across restarts while valid files and expansions recover', async () => {
        const root = await workspace('recovery-main'), extra = await workspace('recovery-extra'), nested = path.join(root, 'src');
        await fs.mkdir(nested); const file = path.join(nested, 'a.txt'), other = path.join(extra, 'b.txt');
        await fs.writeFile(file, 'before'); await fs.writeFile(other, 'other');
        const sessionKey = 'recovery-preserved', owners = [];
        try {
            const first = await session(root, { sessionKey }); owners.push(first); await first.owner.start();
            assert.equal((await first.call('add_folder_to_workspace', { folderPath: extra })).success, true);
            assert.equal((await first.call('multi_open_file', { filePaths: [file, other] })).success, true);
            assert.equal((await first.call('multi_open_dirs', { dirPaths: [nested] })).success, true); await first.close();
            await fs.rename(extra, extra + '-moved');

            const restored = await session(root, { backend: first.backend, sessionKey }); owners.push(restored); await restored.owner.start();
            assert.equal(restored.owner.ready, true); assert.deepEqual(restored.owner.roots.map(item => item.path), [root]);
            assert.deepEqual(restored.owner.unavailableRoots, [extra]); assert.equal(restored.owner.lsp.inspect().roots, 1);
            assert.ok(restored.owner.warnings.includes('RESTORED_WORKSPACE_UNAVAILABLE')); assert.ok(restored.owner.warnings.includes('RESTORED_FILE_UNAVAILABLE'));
            assert.deepEqual([...restored.owner.files.keys()], [file]); assert.ok(restored.owner.expanded.includes(nested)); assert.ok(!restored.owner.expanded.includes(extra));
            assert.equal((await restored.call('write_file', { filePath: file, content: 'after' })).success, true);
            assert.equal(await fs.readFile(file, 'utf8'), 'after'); assert.equal((await restored.managed.port.flush()).ok, true);
            assert.deepEqual(await savedValue(restored, 'workspaceFolders'), [root, extra]); await restored.close();

            const again = await session(root, { backend: first.backend, sessionKey }); owners.push(again); await again.owner.start();
            assert.deepEqual(again.owner.unavailableRoots, [extra]); await assert.rejects(fs.stat(extra), { code: 'ENOENT' });
            await fs.rename(extra + '-moved', extra);
            assert.deepEqual(again.owner.unavailableRoots, [extra]); // Disk restoration alone does not admit it into this running App.
            const reconnected = await again.call('add_folder_to_workspace', { folderPath: extra + '/.' });
            assert.deepEqual(reconnected.data, { added: 1, restored: 1 }); assert.deepEqual(again.owner.unavailableRoots, []);
            assert.equal(again.owner.lsp.inspect().roots, 2); assert.equal(again.owner.files.has(other), false);
            assert.ok(!again.owner.warnings.includes('RESTORED_WORKSPACE_UNAVAILABLE')); await again.close();
            const final = await session(root, { backend: first.backend, sessionKey }); owners.push(final); await final.owner.start();
            assert.deepEqual(final.owner.roots.map(item => item.path), [root, extra]); assert.deepEqual(final.owner.unavailableRoots, []);
        } finally { for (const owner of owners) await owner.close(); }
    });
    await run('ENOENT and ENOTDIR restored entries can be explicitly removed without creating folders', async () => {
        const missing = path.join(working, 'unavailable-only'), parent = path.join(working, 'not-a-directory'); await fs.writeFile(parent, 'keep');
        const invalidParent = path.join(parent, 'child'), sessionKey = 'recovery-remove';
        const x = await session(undefined, { sessionKey, initial: sessionRecords(sessionKey, { workspaceFolders: [missing + '/.', invalidParent] }) });
        try {
            await x.owner.start(); assert.equal(x.owner.ready, true); assert.deepEqual(x.owner.roots, []);
            assert.deepEqual(x.owner.unavailableRoots, [missing, invalidParent]); assert.equal(x.owner.lsp.inspect().roots, 0);
            assert.equal((await x.call('create_file', { filePath: path.join(missing, 'file'), content: 'no' })).error.code, 'IDE_OUTSIDE_WORKSPACE');
            assert.equal((await x.call('add_folder_to_workspace', { folderPath: missing })).error.code, 'IDE_IO_ENOENT');
            assert.deepEqual(x.owner.unavailableRoots, [missing, invalidParent]); await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
            for (const folderPath of [missing + '/.', invalidParent]) assert.equal((await x.call('remove_folder_from_workspace', { folderPath })).data.removed, 1);
            assert.deepEqual(x.owner.unavailableRoots, []); assert.ok(!x.owner.warnings.includes('RESTORED_WORKSPACE_UNAVAILABLE'));
            assert.equal(await fs.readFile(parent, 'utf8'), 'keep'); await x.close();
            const restarted = await session(undefined, { backend: x.backend, sessionKey });
            try { await restarted.owner.start(); assert.deepEqual(restarted.owner.roots, []); assert.deepEqual(restarted.owner.unavailableRoots, []); }
            finally { await restarted.close(); }
        } finally { await x.close(); }
    });
    await run('the 16 saved-root limit includes missing roots and permits reconnection or canonical deduplication', async () => {
        const root = await workspace('recovery-capacity'), alias = path.join(working, 'recovery-main-alias'); await fs.symlink(root, alias);
        const missing = Array.from({ length: 15 }, (_, index) => path.join(working, 'recovery-missing-' + index));
        const sessionKey = 'recovery-capacity', initial = sessionRecords(sessionKey, { workspaceFolders: [root, ...missing] });
        // The explicit alias is a seventeenth spelling, but not a seventeenth root.
        const x = await session(alias, { sessionKey, initial });
        try {
            await x.owner.start(); assert.equal(x.owner.roots.length + x.owner.unavailableRoots.length, 16);
            const extra = await workspace('recovery-seventeenth'), version = x.owner.workspaceVersion;
            assert.equal((await x.call('add_folder_to_workspace', { folderPath: extra })).error.code, 'IDE_ROOT_CAPACITY');
            assert.equal(x.owner.workspaceVersion, version); assert.deepEqual(x.owner.unavailableRoots, missing);
            await fs.mkdir(missing[0]); assert.deepEqual((await x.call('add_folder_to_workspace', { folderPath: missing[0] })).data, { added: 1, restored: 1 });
            assert.equal(x.owner.roots.length + x.owner.unavailableRoots.length, 16);
            await fs.symlink(root, missing[1]); assert.deepEqual((await x.call('add_folder_to_workspace', { folderPath: missing[1] })).data, { added: 0, restored: 1 });
            assert.equal(x.owner.roots.length + x.owner.unavailableRoots.length, 15);
            assert.equal((await x.call('add_folder_to_workspace', { folderPath: extra })).success, true);
            assert.equal((await x.managed.port.flush()).ok, true);
            const saved = await savedValue(x, 'workspaceFolders'); assert.equal(saved.length, 16); assert.ok(!saved.includes(alias)); assert.ok(!saved.includes(missing[1]));
        } finally { await x.close(); }
    });
    await run('explicit missing roots, permission failures and uncertain root cleanup remain startup failures', async () => {
        const root = await workspace('recovery-strict-main'), extra = await workspace('recovery-strict-extra');
        const missing = path.join(working, 'explicit-missing'), nonDirectory = path.join(root, 'not-a-directory'); await fs.writeFile(nonDirectory, 'keep');
        for (const [project, errno] of [[missing, 'ENOENT'], [path.join(nonDirectory, 'child'), 'ENOTDIR']]) {
            const explicit = await session(project);
            try {
                await assert.rejects(explicit.owner.start(), code(errno)); assert.equal(explicit.owner.ready, false);
                assert.equal(explicit.owner.error, 'IDE_IO_' + errno); assert.deepEqual(explicit.owner.unavailableRoots, []);
            } finally { await explicit.close(); }
        }
        for (const fault of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'UNRECOGNIZED', 'cleanup']) {
            const sessionKey = 'recovery-strict-' + fault, initial = sessionRecords(sessionKey, { workspaceFolders: [root, extra] });
            const x = await session(root, { sessionKey, initial }), opendir = fs.opendir; let closed = 0;
            fs.opendir = async (directory, ...args) => {
                if (String(directory) !== extra) return opendir(directory, ...args);
                if (fault !== 'cleanup') throw Object.assign(Error('controlled root open failure'), { code: fault });
                const handle = await opendir(directory, ...args), close = handle.close.bind(handle);
                handle.close = async () => { await close(); closed++; throw Object.assign(Error('controlled close failure'), { code: 'EIO' }); };
                return handle;
            };
            try {
                await assert.rejects(x.owner.start(), code(fault === 'cleanup' ? 'IDE_DIRECTORY_CLOSE_UNCERTAIN' : fault));
                assert.equal(x.owner.ready, false); assert.deepEqual(x.owner.unavailableRoots, []);
                assert.equal(x.owner.error, fault === 'cleanup' ? 'IDE_DIRECTORY_CLOSE_UNCERTAIN'
                    : fault === 'UNRECOGNIZED' ? 'IDE_INITIALIZATION_FAILED' : 'IDE_IO_' + fault);
                const saved = await x.storage.read({ namespace: x.namespace, key: 'workspaceFolders' }); assert.equal(saved.text, initial[0].text);
                if (fault === 'cleanup') { assert.equal(closed, 1); await assert.rejects(x.owner.close(), code('IDE_RESOURCE_CLEANUP_FAILED')); }
            } finally { fs.opendir = opendir; await x.close(); }
        }
    });
    await run('invalid saved paths and corrupt JSON are not replaced with unavailable-root defaults', async () => {
        const root = await workspace('recovery-invalid-main'), missing = path.join(working, 'recovery-invalid-missing');
        for (const fault of ['workspaceFolders', 'activeFiles', 'expandedDirs', 'json']) {
            const sessionKey = 'recovery-invalid-' + fault, values = { workspaceFolders: [root, missing], activeFiles: [], expandedDirs: [] };
            if (fault !== 'json') values[fault] = ['relative/path'];
            const initial = sessionRecords(sessionKey, values); if (fault === 'json') initial[0].text = '{broken';
            const x = await session(root, { sessionKey, initial });
            try {
                await assert.rejects(x.owner.start(), code('IDE_RECOVERY_FAILED')); assert.equal(x.owner.ready, false); assert.deepEqual(x.owner.unavailableRoots, []);
                assert.equal(x.owner.error, 'IDE_RECOVERY_FAILED');
                for (const record of initial) assert.equal((await x.storage.read(record.address)).text, record.text);
            } finally { await x.close(); }
        }
    });
    await run('actual Workspace keeps add/remove available when only unavailable roots remain', async () => {
        const h = await import('./ide-test-harness.mjs'), root = await workspace('recovery-ui-main'), extra = await workspace('recovery-ui-extra');
        const sessionKey = 'recovery-ui';
        try {
            const first = await h.start(root, 'recovery-ui-first', { sessionKey, slices: false });
            await h.invoke(first, 'add_folder_to_workspace', { folderPath: extra }); await h.close(first); await fs.rename(extra, extra + '-moved');
            const second = await h.start(root, 'recovery-ui-second', { data: first.data, sessionKey, slices: false });
            assert.ok(h.viewText(second, 'workspace').includes(extra)); assert.match(h.viewText(second, 'workspace'), /Unavailable folders/);
            await h.invoke(second, 'remove_folder_from_workspace', { folderPath: root });
            await h.eventually(() => !h.toolNames(second).includes('multi_open_file'), 'unavailable-only tool availability');
            const names = h.toolNames(second); assert.ok(names.includes('add_folder_to_workspace')); assert.ok(names.includes('remove_folder_from_workspace'));
            assert.ok(!names.includes('search_files_by_pattern')); assert.ok(!names.includes('create_file'));
            await h.invoke(second, 'remove_folder_from_workspace', { folderPath: extra });
            await h.eventually(() => !h.toolNames(second).includes('remove_folder_from_workspace'), 'removed last saved root');
            assert.doesNotMatch(h.viewText(second, 'workspace'), /Unavailable folders/);
            await h.invoke(second, 'add_folder_to_workspace', { folderPath: root }); await h.close(second);
            facts.recoveryUI = { unavailableOnlyTools: names, cleanup: h.facts.cleanup };
        } finally {
            for (const app of h.apps) if (!app.closed) { app.host.terminate(); await app.worker.terminate(); await app.host.waitForResourceRelease(); app.closed = true; }
        }
    });
    await run('legacy import phases are reentrant, existing target wins and source bytes stay unchanged', async () => {
        const root = await workspace('import-root'), other = await workspace('import-target'), source = path.join(working, 'legacy.json'), historyPath = path.join(working, 'import-history.json');
        const bytes = JSON.stringify({ workspaceFolders: [root], workspaces: { [root]: { openFiles: [{ path: path.join(root, 'old'), lastOpened: 1 }] } } }); await fs.writeFile(source, bytes);
        const history = new IDEHistory(historyPath); await history.add(root, path.join(root, 'new')); await history.close();
        let fail = true; const sessionKey = 'import';
        const x = await session(undefined, { sessionKey, legacy: source, historyPath, storage: base => ({ ...base, replace: async (...args) => fail ? { status: 'failed', effects: 'none', issue: { code: 'IO_FAILED', message: 'fixture' } } : base.replace(...args) }) });
        await assert.rejects(x.owner.start(), code('IMPORT_SESSION_SAVE_FAILED'));
        assert.equal(JSON.parse(await fs.readFile(historyPath, 'utf8')).migration.phase, 'history'); assert.equal(x.owner.ready, false); await x.close();
        fail = false;
        const y = await session(undefined, { backend: x.backend, sessionKey, legacy: source, historyPath }); await y.owner.start(); assert.equal(y.owner.ready, true); assert.equal(y.owner.roots[0].path, root); await y.close();
        const imported = JSON.parse(await fs.readFile(historyPath, 'utf8')); assert.equal(imported.migration.phase, 'completed'); assert.equal(imported.workspaces[root][0].path, path.join(root, 'new'));
        const prior = hash(await fs.readFile(historyPath)); const z = await session(undefined, { backend: x.backend, sessionKey, legacy: source, historyPath }); await z.owner.start(); await z.close(); assert.equal(hash(await fs.readFile(historyPath)), prior);
        assert.equal(hash(await fs.readFile(source)), hash(bytes));
        const existingKey = 'existing', initial = [{ address: { namespace: JSON.stringify(['test', existingKey]), key: 'workspaceFolders' }, text: JSON.stringify([other]) }];
        const existing = await session(undefined, { initial, sessionKey: existingKey, legacy: source, historyPath }); await existing.owner.start(); assert.deepEqual(existing.owner.roots.map(item => item.path), [other]); await existing.close();
        await fs.appendFile(source, ' '); const changed = new IDEHistory(historyPath); await assert.rejects(changed.importHistory(await readLegacyIDE(source)), code('IMPORT_SOURCE_CONFLICT')); await changed.close();
    });
    await run('partial binding failure and stop during initialization cannot deadlock managed flush', async () => {
        const root = await workspace('init'), x = await session(root, { port: port => ({ ...port, bind(key, ...args) { return key === 'activeFiles' ? { status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } } : port.bind(key, ...args); } }) });
        await assert.rejects(x.owner.start(), code('IDE_PERSISTENCE_UNAVAILABLE')); const closed = await x.close(); assert.equal(closed.unmount, 'completed');
        const entered = gate(), release = gate(), y = await session(root, { storage: base => ({ ...base, async read(address) { entered.resolve(); await release.promise; return base.read(address); } }) });
        const starting = y.owner.start(); void starting.catch(() => {}); await entered.promise;
        assert.equal(y.owner.ready, false); assert.equal(y.owner.error, null);
        y.owner.stop(); const closing = y.managed.close(() => y.owner.close()); release.resolve(); await assert.rejects(starting, code('IDE_STOPPED'));
        assert.equal((await closing).unmount, 'completed'); assert.equal(y.managed.getStats().pendingInitializations, 0);
    });
    await run('search zero/error/root identity/result capacity and actual regex Worker deadline', async () => {
        const root = await workspace('search'), search = new ScopedSearch(), source = await rootSource(root);
        await fs.writeFile(path.join(root, 'a.txt'), 'abc'); assert.deepEqual((await search.run({ roots: [source], kind: 'content', pattern: 'nothing' })).paths, []);
        await assert.rejects(search.run({ roots: [source], kind: 'content', pattern: '[' }), code('SEARCH_PATTERN_INVALID'));
        for (let i = 0; i < 501; i++) await fs.writeFile(path.join(root, `file-${i}.ts`), 'x');
        await assert.rejects(search.run({ roots: [source], kind: 'pattern', pattern: '*.ts' }), error => { assert.equal(error.code, 'SEARCH_RESULT_CAPACITY'); assert.equal(error.details.complete, false); assert.ok(error.details.pathsSample.length <= 8); return true; });
        await fs.unlink(path.join(root, 'file-500.ts')); assert.equal((await search.run({ roots: [source], kind: 'pattern', pattern: '*.ts' })).paths.length, 500);
        await fs.unlink(path.join(root, 'file-499.ts')); assert.equal((await search.run({ roots: [source], kind: 'pattern', pattern: '*.ts' })).paths.length, 499);
        const outside = await workspace('search-outside'); await fs.writeFile(path.join(outside, 'escape.ts'), 'x'); await fs.symlink(outside, path.join(root, 'link'));
        const alias = await search.run({ roots: [source], kind: 'pattern', pattern: 'link/*.ts' }).then(value => ({ value }), error => ({ error }));
        assert.ok(alias.error || alias.value.paths.length === 0); await fs.unlink(path.join(root, 'link'));
        const large = path.join(root, 'evil.txt'); await fs.writeFile(large, 'a'.repeat(50000) + '!'); const time = performance.now();
        await assert.rejects(search.run({ roots: [source], kind: 'content', pattern: '(a+)+$', include: 'evil.txt' }), code('SEARCH_DEADLINE'));
        assert.ok(performance.now() - time < 6500); assert.equal(search.inspect().workers, 0);
        await fs.rename(root, root + '-old'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'replacement'), 'x');
        await assert.rejects(search.run({ roots: [source], kind: 'pattern', pattern: '*' }), code('SEARCH_ROOT_CHANGED')); await search.close();
    });
    await run('search cleanup error survives message-stop-exit and rejected termination after actual exit', async () => {
        const root = await workspace('search-cleanup'), source = await rootSource(root);
        await fs.writeFile(path.join(root, 'evil.txt'), 'a'.repeat(50000) + '!');
        const first = new ScopedSearch(), pending = first.run({ roots: [source], kind: 'content', pattern: '(a+)+$', include: 'evil.txt' });
        // Inject a cleanup protocol fault while retaining an actual Node Worker.
        first.worker.emit('message', { ok: false, code: 'IDE_DIRECTORY_CLOSE_UNCERTAIN' });
        first.stop(); await assert.rejects(pending, code('SEARCH_CLOSED'));
        await assert.rejects(first.close(), code('SEARCH_CLEANUP_FAILED')); assert.equal(first.inspect().workers, 0);
        const second = new ScopedSearch(), actual = second.run({ roots: [source], kind: 'content', pattern: '(a+)+$', include: 'evil.txt' });
        const terminate = second.worker.terminate.bind(second.worker);
        second.worker.terminate = async () => { await terminate(); throw Error('Controlled API rejection after real exit'); };
        const closing = second.close(); await assert.rejects(actual, code('SEARCH_CLOSED'));
        await assert.rejects(closing, code('SEARCH_CLEANUP_FAILED')); assert.equal(second.inspect().workers, 0);
    });
    await run('LSP unsupported starts release slots and same-path root replacement cannot start new config', async () => {
        const root = await workspace('lsp-invalid'), lsp = new ScopedLSP(); lsp.setRoots([await rootSource(root)]);
        for (let i = 0; i < 12; i++) await assert.rejects(lsp.query('hover', path.join(root, 'file.unsupported' + i), 'x'), code('LSP_UNAVAILABLE'));
        assert.deepEqual(lsp.inspect(), { live: true, clients: 0, actualQueries: 0, currentQueries: 0, startingClients: 0, roots: 1 });
        await fs.rename(root, root + '-old'); await fs.mkdir(root); await assert.rejects(lsp.query('hover', path.join(root, 'file.ts'), 'x'), code('LSP_ROOT_CHANGED'));
        assert.equal(lsp.inspect().clients, 0); await lsp.close();
    });
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { facts.finishedAt = new Date().toISOString(); if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(facts, null, 2)); console.log('EDGE_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length, working })); }
