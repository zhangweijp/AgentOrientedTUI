import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { IDESession, filePage } from '../dist/core/ide-session.js';
import { IDEHistory, pathList } from '../dist/core/ide-history.js';
import { ScopedSearch } from '../dist/core/scoped-search.js';
import { directoryIdentity } from '../dist/core/versioned-file-write.js';
import { createFileWithParents } from '../dist/core/observed-file-actions.js';
import { boundedJSON } from '../dist/core/ide-errors.js';
import { createMemoryStateStorage } from '../../../runtime/dist/adapters/storage/memory-state-storage.js';
import { createAppStatePersistence } from '../../../runtime/dist/worker-runtime/state-persistence.js';
const working = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-capacity-')));
const facts = { working, cases: [], passed: false }, owners = [], searches = []; let sequence = 0;
const code = expected => error => { assert.equal(error.code ?? error.message.split(':')[0], expected); return true; };
async function root(name) { const value = path.join(working, name); await fs.mkdir(value); return value; }
async function run(name, action) { const started = performance.now(); const details = await action(); facts.cases.push({ name, passed: true, elapsedMs: performance.now() - started, details }); console.log('PASS', name); }
async function session(projectPath) {
    const id = 'capacity' + ++sequence;
    const backend = createMemoryStateStorage({ maxStoredKeys: 128, maxStoredBytes: 8 * 1024 * 1024, maxRecordBytes: 262272, maxAddressBytes: 1024, maxActiveOwners: 8, maxClaimedNamespaces: 64 });
    const storage = backend.open(id); assert.equal(storage.status, 'opened');
    const managed = createAppStatePersistence({ instanceId: id, desktopId: 'test', appKey: id, storage: storage.storage });
    const owner = new IDESession(managed.port, { sessionKey: id, historyPath: path.join(working, id + '-history.json'), projectPath }, () => {});
    const x = { owner, managed, call: (name, args, view = 'workspace') => owner.invoke(name, args, view),
        async close() { owner.stop(); return managed.close(() => owner.close()); } }; owners.push(x); await owner.start(); return x;
}
function succeeds(reply) { assert.equal(reply?.success, true, JSON.stringify(reply)); return reply; }
function fails(reply, expected) { assert.equal(reply?.error?.code, expected, JSON.stringify(reply)); assert.equal(reply.effects, 'none'); }
async function makeFiles(directory, from, to, body = '') { for (let offset = from; offset < to; offset += 64) await Promise.all(Array.from({ length: Math.min(64, to - offset) }, (_, i) => fs.writeFile(path.join(directory, 'f' + (offset + i)), body))); }
async function searchSource(directory) { const identity = await directoryIdentity(directory); return { path: directory, identity, workspace: directory, workspaceIdentity: identity }; }
try {
    await run('DTO nodes/depth, page limit and UTF8 path boundaries are exact', async () => {
        for (const n of [4999, 5000]) assert.equal(boundedJSON(Array(n - 1).fill(null)).length, n - 1);
        assert.throws(() => boundedJSON(Array(5000).fill(null)), code('IDE_RESULT_TOO_LARGE'));
        for (const depth of [23, 24, 25]) { let value = null; for (let i = 0; i < depth; i++) value = { next: value };
            if (depth <= 24) boundedJSON(value); else assert.throws(() => boundedJSON(value), code('IDE_RESULT_TOO_LARGE')); }
        for (const length of [4095, 4096, 4097]) { const text = '/' + '你'.repeat(Math.floor((length - 1) / 3)) + 'x'.repeat((length - 1) % 3);
            assert.equal(Buffer.byteLength(text), length); if (length <= 4096) assert.deepEqual(pathList([text], 1), [text]); else assert.throws(() => pathList([text], 1), code('PERSIST_PATHS_INVALID')); }
        const lines = Array.from({ length: 2001 }, (_, i) => 'line' + i).join('\n');
        assert.match(filePage(lines, 0, 2000), /02000\| line1999/); assert.doesNotMatch(filePage(lines, 0, 2000), /02001/);
        assert.throws(() => filePage(lines, 0, 2001), code('IDE_RANGE_INVALID'));
        return { nodes: [4999, 5000, 5001], depths: [23, 24, 25], pathBytes: [4095, 4096, 4097], limit: [2000, 2001] };
    });
    await run('actual roots 15/16/17, input arrays 63/64/65, files 63/64/65 and expanded directories 511/512/513', async () => {
        const directory = await root('owner'), x = await session(directory);
        for (let i = 1; i < 16; i++) { succeeds(await x.call('add_folder_to_workspace', { folderPath: await root('root' + i) })); if (i === 14) assert.equal(x.owner.roots.length, 15); }
        assert.equal(x.owner.roots.length, 16); let version = x.owner.workspaceVersion;
        assert.deepEqual(succeeds(await x.call('add_folder_to_workspace', { folderPath: directory })).data, { added: 0, unchanged: 1 });
        assert.equal(x.owner.workspaceVersion, version); assert.equal(x.owner.roots.length, 16);
        fails(await x.call('add_folder_to_workspace', { folderPath: await root('root17') }), 'IDE_ROOT_CAPACITY'); assert.equal(x.owner.workspaceVersion, version);
        for (const n of [63, 64]) succeeds(await x.call('multi_close_file', { filePaths: Array(n).fill(path.join(directory, 'absent')) }));
        version = x.owner.workspaceVersion; fails(await x.call('multi_close_file', { filePaths: Array(65).fill(path.join(directory, 'absent')) }), 'IDE_INPUT_CAPACITY'); assert.equal(x.owner.workspaceVersion, version);
        for (const n of [4095, 4096]) succeeds(await x.call('multi_close_file', { filePaths: ['/' + 'x'.repeat(n - 1)] }));
        fails(await x.call('multi_close_file', { filePaths: ['/' + 'x'.repeat(4096)] }), 'IDE_PATH_INVALID');
        await makeFiles(directory, 0, 65, 'x'); const files = Array.from({ length: 65 }, (_, i) => path.join(directory, 'f' + i));
        succeeds(await x.call('multi_open_file', { filePaths: files.slice(0, 63) })); assert.equal(x.owner.files.size, 63);
        succeeds(await x.call('multi_open_file', { filePaths: [files[63]] })); assert.equal(x.owner.files.size, 64);
        version = x.owner.workspaceVersion; fails(await x.call('multi_open_file', { filePaths: [files[64]] }), 'IDE_FILE_CAPACITY'); assert.equal(x.owner.workspaceVersion, version); assert.equal(x.owner.files.size, 64);
        const directories = []; for (let i = 0; i < 497; i++) { const dir = path.join(directory, 'd' + i); await fs.mkdir(dir); directories.push(dir); }
        for (let i = 0; i < 495; i += 64) succeeds(await x.call('multi_open_dirs', { dirPaths: directories.slice(i, Math.min(i + 64, 495)) }));
        assert.equal(x.owner.expanded.length, 511); succeeds(await x.call('multi_open_dirs', { dirPaths: [directories[495]] })); assert.equal(x.owner.expanded.length, 512);
        const before = x.owner.trees; version = x.owner.workspaceVersion;
        fails(await x.call('multi_open_dirs', { dirPaths: [directories[496]] }), 'IDE_DIRECTORY_CAPACITY'); assert.equal(x.owner.trees, before); assert.equal(x.owner.workspaceVersion, version);
        assert.equal((await x.close()).ok, true);
    });
    await run('actual tree entry and byte limits reject before replacing the published tree', async () => {
        const directory = await root('tree-entries'); await makeFiles(directory, 0, 9998); const x = await session(directory);
        assert.equal(x.owner.trees.get(directory).split('\n').length, 9999); await makeFiles(directory, 9998, 9999); succeeds(await x.call('refresh_workspace', {})); assert.equal(x.owner.trees.get(directory).split('\n').length, 10000);
        const before = x.owner.trees, version = x.owner.workspaceVersion; await makeFiles(directory, 9999, 10000); fails(await x.call('refresh_workspace', {}), 'IDE_TREE_CAPACITY'); assert.equal(x.owner.trees, before); assert.equal(x.owner.workspaceVersion, version); await x.close();
        const sized = await root('tree-bytes'), limit = 200 * 1024, rootBytes = Buffer.byteLength(sized) + Buffer.byteLength('.\n'), entryOverhead = Buffer.byteLength('├── \n');
        let count = Math.floor((limit - 1 - rootBytes) / (200 + entryOverhead)), rest = limit - 1 - rootBytes - count * (200 + entryOverhead); if (rest < entryOverhead + 4) { count--; rest += 200 + entryOverhead; }
        for (let offset = 0; offset < count; offset += 64) await Promise.all(Array.from({ length: Math.min(64, count - offset) }, (_, i) => { const prefix = 'f' + String(offset + i).padStart(5, '0'); return fs.writeFile(path.join(sized, prefix + 'x'.repeat(200 - prefix.length)), ''); }));
        let tail = path.join(sized, 'tail' + 'x'.repeat(rest - entryOverhead - 4)); await fs.writeFile(tail, ''); const y = await session(sized); assert.equal(Buffer.byteLength(sized) + Buffer.byteLength(y.owner.trees.get(sized)) + 1, limit - 1);
        await fs.rename(tail, tail + 'x'); tail += 'x'; succeeds(await y.call('refresh_workspace', {})); assert.equal(Buffer.byteLength(sized) + Buffer.byteLength(y.owner.trees.get(sized)) + 1, limit);
        const prior = y.owner.trees; await fs.rename(tail, tail + 'x'); fails(await y.call('refresh_workspace', {}), 'IDE_TREE_CAPACITY'); assert.equal(y.owner.trees, prior); await y.close();
        return { entryCountIncludesRoot: true, entries: [9999, 10000, 10001], bytesIncludingFinalLineAccounting: [limit - 1, limit, limit + 1] };
    });
    await run('parent depth 31/32/33 and history LRU/roots/256KiB source limits preserve disk facts', async () => {
        for (const depth of [31, 32, 33]) { const directory = await root('parents' + depth), file = path.join(directory, ...Array(depth).fill('d'), 'file');
            if (depth < 33) { await createFileWithParents(directory, await directoryIdentity(directory), file, 'created', () => {}); assert.equal(await fs.readFile(file, 'utf8'), 'created'); }
            else { await assert.rejects(createFileWithParents(directory, await directoryIdentity(directory), file, 'x', () => {}), code('RESOURCE_PARENT_DEPTH')); assert.deepEqual(await fs.readdir(directory), []); } }
        const directory = await root('history'), file = path.join(directory, 'history.json'), history = new IDEHistory(file);
        for (let i = 0; i < 11; i++) { await history.add(directory, path.join(directory, 'f' + i)); if (i >= 8) assert.equal((await history.read()).workspaces[directory].length, Math.min(i + 1, 10)); }
        assert.equal((await history.read()).workspaces[directory].some(item => item.path.endsWith('/f0')), false);
        for (let i = 1; i < 16; i++) await history.add(path.join(directory, 'r' + i), path.join(directory, 'r' + i, 'file'));
        const before = await fs.readFile(file); await assert.rejects(history.add(path.join(directory, 'r16'), path.join(directory, 'r16/file')), code('HISTORY_CAPACITY')); assert.deepEqual(await fs.readFile(file), before); await history.close();
        const plain = JSON.stringify({ version: 1, workspaces: {} });
        for (const length of [262143, 262144, 262145]) {
            const bytes = plain + ' '.repeat(length - Buffer.byteLength(plain)); await fs.writeFile(file, bytes); const next = new IDEHistory(file);
            if (length <= 262144) { await next.read(); await next.add(directory, path.join(directory, 'accepted')); }
            else { await assert.rejects(next.read(), code('PERSIST_SOURCE_UNSUPPORTED')); await assert.rejects(next.add(directory, path.join(directory, 'rejected'))); assert.equal(await fs.readFile(file, 'utf8'), bytes); }
            await next.close();
        }
    });
    await run('complete FileDetail composition and batch unknown remain bounded and atomic', async () => {
        const directory = await root('view'), file = path.join(directory, 'file.ts'); await fs.writeFile(file, 'x'.repeat(260000)); const x = await session(directory); succeeds(await x.call('multi_open_file', { filePaths: [file] }));
        const record = x.owner.files.get(file), empty = { documentVersion: 1, value: '' };
        const overhead = Buffer.byteLength(JSON.stringify({ hover: empty }, null, 2)) + Buffer.byteLength(record.page) + Buffer.byteLength(file) + 32768;
        for (const delta of [-1, 0, 1]) {
            const result = { ...empty, value: 'x'.repeat(512 * 1024 - overhead + delta) }; boundedJSON(result); x.owner.lsp.query = async () => result;
            const before = JSON.stringify(record);
            const reply = await x.call('lsp_hover', { file_path: file, line: 1, character: 1 }, record.viewId);
            if (delta <= 0) succeeds(reply); else { fails(reply, 'IDE_VIEW_TOO_LARGE'); assert.equal(JSON.stringify(record), before); }
        }
        await x.close();
        const batchRoot = await root('unknown-batch'), a = path.join(batchRoot, 'a'), b = path.join(batchRoot, 'b'); await fs.writeFile(a, 'one'); await fs.writeFile(b, 'one');
        const y = await session(batchRoot); succeeds(await y.call('multi_open_file', { filePaths: [a, b] })); const rename = fs.rename; let attempts = 0;
        fs.rename = async (from, to) => { if (to === b) { attempts++; throw Object.assign(Error(), { code: 'EIO', syscall: 'rename' }); } return rename(from, to); };
        let reply; try { reply = await y.call('batch_edit', { edits: [{ filePath: a, oldString: 'one', newString: 'two' }, { filePath: b, oldString: 'one', newString: 'two' }, { filePath: a, oldString: 'two', newString: 'three' }] }); } finally { fs.rename = rename; }
        assert.equal(reply.success, false); assert.equal(reply.effects, undefined); assert.equal(attempts, 1); assert.deepEqual(y.owner.lastBatch.map(item => item.status), ['succeeded', 'unknown', 'not-run']); assert.equal(await fs.readFile(a, 'utf8'), 'two'); assert.equal(await fs.readFile(b, 'utf8'), 'one'); await y.close();
    });
    await run('search pattern limits, single actual Worker, 10000 scans and 64MiB actual bytes', async () => {
        const directory = await root('search-empty'), source = await searchSource(directory), search = new ScopedSearch(); searches.push(search);
        for (const size of [4095, 4096]) { assert.deepEqual((await search.run({ roots: [source], kind: 'content', pattern: 'a'.repeat(size) })).paths, []); assert.deepEqual((await search.run({ roots: [source], kind: 'content', pattern: 'x', include: '?'.repeat(size) })).paths, []); }
        for (const field of ['pattern', 'include']) assert.throws(() => search.run({ roots: [source], kind: 'content', pattern: 'x', [field]: 'x'.repeat(4097) }), code('SEARCH_PATTERN_TOO_LARGE'));
        const pending = search.run({ roots: [source], kind: 'pattern', pattern: '*' }); assert.throws(() => search.run({ roots: [source], kind: 'pattern', pattern: '*' }), code('SEARCH_BUSY')); await pending; assert.equal(search.inspect().workers, 0);
        const scanned = await root('search-scan'); await makeFiles(scanned, 0, 9999); const scanSource = await searchSource(scanned);
        for (const size of [9999, 10000]) { if (size === 10000) await makeFiles(scanned, 9999, 10000); const result = await search.run({ roots: [scanSource], kind: 'pattern', pattern: '*.none' }); assert.equal(result.scanned, size); assert.deepEqual(result.paths, []); }
        await makeFiles(scanned, 10000, 10001); await assert.rejects(search.run({ roots: [scanSource], kind: 'pattern', pattern: '*.none' }), code('SEARCH_SCAN_CAPACITY'));
        const bytesRoot = await root('search-bytes'), bytesSource = await searchSource(bytesRoot), block = 'x'.repeat(4 * 1024 * 1024);
        for (let i = 0; i < 16; i++) await fs.writeFile(path.join(bytesRoot, 'f' + i), i === 15 ? block.slice(1) : block);
        assert.equal((await search.run({ roots: [bytesSource], kind: 'content', pattern: 'no-match' })).bytes, 64 * 1024 * 1024 - 1);
        await fs.appendFile(path.join(bytesRoot, 'f15'), 'x'); assert.equal((await search.run({ roots: [bytesSource], kind: 'content', pattern: 'no-match' })).bytes, 64 * 1024 * 1024);
        await fs.writeFile(path.join(bytesRoot, 'overflow'), 'x'); await assert.rejects(search.run({ roots: [bytesSource], kind: 'content', pattern: 'no-match' }), code('SEARCH_BYTE_CAPACITY')); await search.close();
    });
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { for (const x of owners) await x.close().catch(() => {}); for (const search of searches) await search.close().catch(() => {});
    facts.finishedAt = new Date().toISOString(); await fs.writeFile(process.argv[2], JSON.stringify(facts, null, 2)); console.log('CAPACITY_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length, working })); }
