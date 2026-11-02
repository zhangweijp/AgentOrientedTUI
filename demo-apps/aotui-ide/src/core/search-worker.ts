import { parentPort, workerData } from 'node:worker_threads';
import { globIterate } from 'glob';
import fs from 'node:fs/promises';
import * as nativeFS from 'node:fs';
import path from 'node:path';
import { checkedPath, directoryIdentity, inside, readObservedFile } from './versioned-file-write.js';
import { boundedJSON, closeDirectory, requireIDE } from './ide-errors.js';
import type { SearchRoot } from './scoped-search.js';

const input = workerData as { roots: SearchRoot[]; kind: 'pattern' | 'content'; pattern: string; include?: string };
let candidates = 0, bytes = 0, scanned = 0;
const results = new Set<string>(), errors: Array<{ path: string; code: string }> = [];
let traversalFailure: unknown;
async function readdir(directory: any, options: any = {}) {
    try {
        const entries: nativeFS.Dirent[] = [], handle = await fs.opendir(directory);
        try { for (let entry; (entry = await handle.read()) !== null;) {
            requireIDE(++scanned <= 10000, 'SEARCH_SCAN_CAPACITY'); entries.push(entry);
        } } finally { await closeDirectory(handle); }
        return options.withFileTypes ? entries : entries.map(entry => entry.name);
    } catch (error: any) {
        traversalFailure ??= error;
        if (errors.length < 8) errors.push({ path: String(directory).slice(0, 4096), code: error.code ?? 'SEARCH_READ_FAILED' });
        throw error;
    }
}
const trackedFS = { ...nativeFS, promises: { ...fs, readdir }, readdir(directory: any, options: any, callback: any) {
    if (typeof options === 'function') { callback = options; options = {}; }
    readdir(directory, options).then(entries => callback(null, entries), error => callback(error));
} };
async function search() {
    const regex = input.kind === 'content' ? new RegExp(input.pattern) : undefined;
    const seen = new Set<string>();
    for (const source of input.roots) {
        const root = source.path;
        const current = async () => {
            await checkedPath(source.workspace, path.join(root, '__search_probe__'));
            requireIDE(await directoryIdentity(source.workspace) === source.workspaceIdentity && await directoryIdentity(root) === source.identity, 'SEARCH_ROOT_CHANGED');
        };
        await current();
        // Strictly probe directory access; glob's permissive unreadable-root behavior is insufficient.
        const directory = await fs.opendir(root); await closeDirectory(directory);
        for await (const file of globIterate(input.kind === 'pattern' ? input.pattern : input.include ?? '**/*', {
            cwd: root, absolute: true, nodir: true, follow: false, fs: trackedFS as any,
            ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.git/**', '**/.next/**', '**/.turbo/**', '**/out/**'],
        })) {
            if (traversalFailure) throw traversalFailure;
            await current();
            requireIDE(inside(root, file), 'SEARCH_OUTSIDE_WORKSPACE');
            await checkedPath(root, file);
            if (seen.has(file)) continue; seen.add(file);
            requireIDE(++candidates <= 10000, 'SEARCH_CANDIDATE_CAPACITY');
            const stat = await fs.lstat(file);
            requireIDE(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'SEARCH_FILE_UNSUPPORTED');
            requireIDE(stat.size <= 4 * 1024 * 1024, 'SEARCH_FILE_TOO_LARGE');
            requireIDE(bytes + stat.size <= 64 * 1024 * 1024, 'SEARCH_BYTE_CAPACITY');
            const observed = regex ? await readObservedFile(root, file, 64 * 1024 * 1024 - bytes) : undefined;
            bytes += observed ? Buffer.byteLength(observed.content) : stat.size;
            requireIDE(bytes <= 64 * 1024 * 1024, 'SEARCH_BYTE_CAPACITY');
            if (!regex || regex.test(observed!.content)) {
                results.add(file); requireIDE(results.size <= 500, 'SEARCH_RESULT_CAPACITY');
            }
        }
        await current();
    }
    if (traversalFailure) throw traversalFailure;
    return boundedJSON({ complete: true, paths: [...results].sort(), candidates, scanned, bytes });
}
void search().then(result => parentPort!.postMessage({ ok: true, result }), (error: any) => {
    parentPort!.postMessage({ ok: false, code: typeof error?.code === 'string' ? error.code : error instanceof SyntaxError ? 'SEARCH_PATTERN_INVALID' : 'SEARCH_FAILED',
        details: { complete: false, pathsSample: [...results].slice(0, 8).map(file => Buffer.from(file).subarray(0, 512).toString('utf8')),
            resultCount: results.size, candidates, scanned, bytes, errors: errors.map(error => ({ path: Buffer.from(error.path).subarray(0, 512).toString('utf8'), code: error.code.slice(0, 128) })) } });
});
