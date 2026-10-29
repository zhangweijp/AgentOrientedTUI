import fs from 'node:fs/promises';
import path from 'node:path';
import type { OperationResult, useAppRuntimeContext } from '@aotui/sdk';
import { readObservedFile, directoryIdentity, checkedPath, inside, type ObservedFile } from './versioned-file-write.js';
import { createFileWithParents, replaceObservedFile, deleteObservedFile, renameObservedFile } from './observed-file-operations.js';
import { applyEditReplacement } from './file-system-service.js';
import { createWorkspaceFileCreator, type WorkspaceFileCreator } from './conditional-file-create.js';
import { IDEHistory, pathList, readLegacyIDE } from './ide-history.js';
import { ScopedLSP, type LSPQuery } from './scoped-lsp.js';
import { ScopedSearch } from './scoped-search.js';
import { boundedJSON, closeDirectory, IDEError, nextVersion, requireIDE } from './ide-errors.js';
import { initialLoadedDiagnostics, transitionLoadedDiagnostics, type LoadedDiagnosticsState } from '../tui/loaded-diagnostics.js';
import { mergeWorkspaceFolders } from '../tui/workspace-folders.js';

type Persistence = NonNullable<ReturnType<typeof useAppRuntimeContext>['persistence']>;
type Binding = Extract<ReturnType<Persistence['bind']>, { status: 'bound' }>['binding'];
export interface IDEFile { viewId: string; observed: ObservedFile; offset: number; limit: number; page: string;
    diagnostics: LoadedDiagnosticsState; panels: Record<string, unknown> }
type Root = { path: string; identity: string; creator: WorkspaceFileCreator };
export interface IDEOptions { sessionKey: string; historyPath: string; projectPath?: string; legacyImportPath?: string }
const sessionKeys = ['workspaceFolders', 'activeFiles', 'expandedDirs'] as const;
const fail = (error: IDEError): OperationResult => ({
    success: false, error: { code: error.code, message: error.code },
    ...(error.details ? { data: error.details as Record<string, unknown> } : {}),
    ...(error.effects === 'unknown' ? {} : { effects: error.effects }),
});
const success = (data: Record<string, unknown> = {}): OperationResult => ({ success: true, data });
const textPath = (input: unknown): string => {
    requireIDE(typeof input === 'string' && input.length > 0 && !input.includes('\0') && Buffer.byteLength(input) <= 4096 && path.isAbsolute(input), 'IDE_PATH_INVALID');
    return path.resolve(input);
};
function list(input: unknown): string[] {
    requireIDE(Array.isArray(input) && input.length <= 64, 'IDE_INPUT_CAPACITY'); return input.map(textPath);
}
export function filePage(content: string, offset = 0, limit = 2000): string {
    requireIDE(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 2000, 'IDE_RANGE_INVALID');
    const lines = content.split('\n'), end = Math.min(offset + limit, lines.length);
    const body = lines.slice(offset, end).map((line, index) => `${String(offset + index + 1).padStart(5, '0')}| ${line}`).join('\n');
    const page = `${body}\n\n${end > offset ? `Showing lines ${offset + 1}-${end}` : 'No lines in requested range'} of ${lines.length}`;
    requireIDE(Buffer.byteLength(page) <= 256 * 1024, 'IDE_PAGE_TOO_LARGE'); return page;
}

/** Single business owner per App. SDK StateBindings remain the persistence authority. */
export class IDESession {
    live = true;
    ready = false;
    error: string | null = null;
    workspaceVersion = 1;
    roots: Root[] = [];
    unavailableRoots: string[] = [];
    files = new Map<string, IDEFile>();
    expanded: string[] = [];
    tree = '';
    search: { incarnation: number; query: string; paths: string[] } | null = null;
    lastBatch: unknown = null;
    warnings: string[] = [];
    readonly lsp = new ScopedLSP();
    readonly searchWorker = new ScopedSearch();
    readonly history: IDEHistory;
    private sequence = 0;
    private searchSequence = 0;
    private bindings = new Map<string, Binding>();
    private pending = new Set<Promise<unknown>>();
    private startup?: Promise<void>;
    private completion?: Promise<void>;
    private cleanupFailed = false;
    constructor(private persistence: Persistence, readonly options: IDEOptions, private changed: () => void) {
        requireIDE(!!persistence && /^[a-zA-Z0-9_.-]{1,128}$/.test(options.sessionKey), 'IDE_SESSION_KEY_REQUIRED');
        this.history = new IDEHistory(options.historyPath);
    }
    private current(): void { requireIDE(this.live, 'IDE_STOPPED'); }
    private track<T>(promise: Promise<T>): Promise<T> {
        this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise;
    }
    private warn(code: string): void { if (!this.warnings.includes(code)) { this.warnings.push(code); if (this.warnings.length > 8) this.warnings.shift(); } }
    private publish(): void { if (this.live) this.changed(); }
    private workspaceFolders(): string[] { return [...new Set([...this.roots.map(root => root.path), ...this.unavailableRoots])]; }
    private setUnavailableRoots(roots: string[]): void {
        this.unavailableRoots = roots;
        if (roots.length) this.warn('RESTORED_WORKSPACE_UNAVAILABLE');
        else this.warnings = this.warnings.filter(warning => warning !== 'RESTORED_WORKSPACE_UNAVAILABLE');
    }
    private persist(): void {
        const values = { workspaceFolders: this.workspaceFolders(), activeFiles: [...this.files.keys()], expandedDirs: this.expanded };
        for (const key of sessionKeys) {
            const result = this.bindings.get(key)?.update(values[key]);
            if (result?.status !== 'accepted') this.warn('SESSION_UPDATE_FAILED');
        }
    }
    private commitWorkspace(): void { this.current(); this.workspaceVersion = nextVersion(this.workspaceVersion); this.persist(); this.publish(); }
    private async root(input: string): Promise<Root> {
        const candidate = textPath(input), canonical = await fs.realpath(candidate); this.current();
        const identity = await directoryIdentity(canonical); this.current();
        const handle = await fs.opendir(canonical); await closeDirectory(handle); this.current();
        let record: Root;
        const guard = () => { this.current(); requireIDE(this.roots.includes(record), 'WORKSPACE_REMOVED'); };
        const creator = await createWorkspaceFileCreator(canonical, guard); this.current();
        requireIDE(await directoryIdentity(canonical) === identity, 'WORKSPACE_ROOT_CHANGED'); this.current();
        record = { path: canonical, identity, creator: input => this.track((async () => {
            try { guard(); } catch { return { status: 'failed' as const, effects: 'none' as const, code: 'RESOURCE_SOURCE_STALE', message: 'Workspace source is no longer current' }; }
            const result = await creator(input);
            if (result.status === 'unknown') this.cleanupFailed = true;
            return result;
        })()) };
        return record;
    }
    private rootFor(file: string): Root {
        const root = this.roots.filter(root => inside(root.path, file)).sort((a, b) => b.path.length - a.path.length)[0];
        requireIDE(root, 'IDE_OUTSIDE_WORKSPACE'); return root;
    }
    private async observe(file: string, guard: () => void): Promise<ObservedFile> {
        const root = this.rootFor(file), result = await readObservedFile(root.path, file); guard();
        requireIDE(result.rootIdentity === root.identity, 'WORKSPACE_ROOT_CHANGED'); return result;
    }
    private record(observed: ObservedFile, offset: number, limit: number, previous?: IDEFile): IDEFile {
        const page = filePage(observed.content, offset, limit);
        return { viewId: previous?.viewId ?? 'fd_' + (this.sequence = nextVersion(this.sequence)),
            observed, offset, limit, page, diagnostics: previous ? transitionLoadedDiagnostics(previous.diagnostics, observed.path, 'idle') : initialLoadedDiagnostics(observed.path), panels: {} };
    }
    private async readTree(roots: readonly Root[], expanded: readonly string[], guard: () => void): Promise<string> {
        const lines: string[] = []; let count = 0, bytes = 0;
        const add = (line: string) => { requireIDE(++count <= 10000 && (bytes += Buffer.byteLength(line) + 1) <= 200 * 1024, 'IDE_TREE_CAPACITY'); lines.push(line); };
        const walk = async (root: Root, directory: string, depth: number): Promise<void> => {
            requireIDE(await directoryIdentity(root.path) === root.identity, 'WORKSPACE_ROOT_CHANGED'); guard();
            if (directory !== root.path) await checkedPath(root.path, path.join(directory, '__tree_probe__'));
            const handle = await fs.opendir(directory);
            try {
                guard();
                for (let entry; (entry = await handle.read()) !== null;) {
                    guard(); const full = path.join(directory, entry.name);
                    if (['node_modules', '.git', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
                    add(`${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? ' [symlink]' : ''}`);
                    if (entry.isDirectory() && expanded.includes(full)) await walk(root, full, depth + 1);
                }
            } finally { await closeDirectory(handle); }
        };
        for (const root of roots) { requireIDE(await directoryIdentity(root.path) === root.identity, 'WORKSPACE_ROOT_CHANGED'); guard(); add(root.path + '/'); if (expanded.includes(root.path)) await walk(root, root.path, 1); }
        guard(); return lines.join('\n');
    }
    start(): Promise<void> {
        if (this.startup) return this.startup;
        this.startup = this.track((async () => {
            this.current();
            for (const key of sessionKeys) {
                const result = this.persistence.bind(key, [], { hydrate: true, storageKey: this.options.sessionKey });
                requireIDE(result.status === 'bound', 'IDE_PERSISTENCE_UNAVAILABLE'); this.bindings.set(key, result.binding);
            }
            const recovered = await Promise.all(sessionKeys.map(key => this.bindings.get(key)!.recovery));
            const values = new Map<string, string[]>();
            let blocked = false;
            recovered.forEach((recovery, index) => {
                const key = sessionKeys[index]!, binding = this.bindings.get(key)!;
                try {
                    requireIDE(recovery.status !== 'blocked', 'IDE_RECOVERY_FAILED');
                    const value = recovery.status === 'found' ? pathList(recovery.value, key === 'workspaceFolders' ? 16 : key === 'activeFiles' ? 64 : 512) : [];
                    values.set(key, value);
                } catch { binding.confirmInitialization(recovery, { status: 'failed' }); blocked = true; }
            });
            requireIDE(!blocked, 'IDE_RECOVERY_FAILED'); this.current();
            let imported: Awaited<ReturnType<typeof readLegacyIDE>> | undefined;
            if (this.options.legacyImportPath) {
                imported = await readLegacyIDE(this.options.legacyImportPath); this.current();
                await this.history.importHistory(imported); this.current();
                if (recovered[0]?.status === 'missing') values.set('workspaceFolders', imported.workspaceFolders);
            }
            const projectPath = this.options.projectPath ? textPath(this.options.projectPath) : undefined;
            const folders = [...new Set(mergeWorkspaceFolders(values.get('workspaceFolders')!, projectPath).map(textPath))];
            const roots: Root[] = [], unavailable: string[] = [];
            for (const folder of folders) {
                try {
                    const root = await this.root(folder); this.current();
                    if (!roots.some(existing => existing.path === root.path)) roots.push(root);
                } catch (error: any) {
                    this.current();
                    // A missing restored folder remains a session record. Explicit
                    // launch paths, permission failures and uncertain cleanup still fail.
                    if (folder === projectPath || !['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
                    unavailable.push(folder);
                }
            }
            requireIDE(new Set([...roots.map(root => root.path), ...unavailable]).size <= 16, 'IDE_ROOT_CAPACITY');
            this.roots = roots; this.setUnavailableRoots(unavailable);
            this.lsp.setRoots(this.roots);
            this.expanded = recovered[2]?.status === 'missing' ? this.roots.map(root => root.path) : values.get('expandedDirs')!.filter(directory => this.roots.some(root => inside(root.path, directory)));
            for (const file of values.get('activeFiles')!) {
                this.current();
                try { const observed = await this.observe(file, () => this.current()); this.files.set(file, this.record(observed, 0, 2000)); }
                catch (error: any) { this.current(); if (/CLEANUP|CLOSE_UNCERTAIN/.test(error?.code ?? '')) throw error; this.warn('RESTORED_FILE_UNAVAILABLE'); }
            }
            this.tree = await this.readTree(this.roots, this.expanded, () => this.current()); this.current();
            const initial = { workspaceFolders: this.workspaceFolders(), activeFiles: [...this.files.keys()], expandedDirs: this.expanded };
            recovered.forEach((recovery, index) => {
                const key = sessionKeys[index]!, binding = this.bindings.get(key)!;
                // Missing values are prepared before the first initialization
                // acknowledgment. A stopped/failed import cannot persist [].
                if (recovery.status === 'missing') requireIDE(binding.update(initial[key]).status === 'accepted', 'IDE_RECOVERY_FAILED');
                const confirmed = binding.confirmInitialization(recovery, recovery.status === 'found' ? { status: 'ready', value: values.get(key)! } : { status: 'ready' });
                const status = binding.inspect();
                requireIDE(confirmed.status === 'accepted' && !status.issue, 'IDE_RECOVERY_FAILED');
            });
            this.persist();
            if (imported) {
                const expected = sessionKeys.map((key, index) => ({ key, address: recovered[index]!.address,
                    revision: (this.bindings.get(key)!.inspect() as { revision: number }).revision }));
                const flushed = await this.persistence.flush(); this.current();
                requireIDE(flushed.ok && expected.every(item => flushed.entries.some(entry => entry.address.namespace === item.address.namespace &&
                    entry.address.key === item.address.key && entry.revision === item.revision && ['saved', 'unchanged'].includes(entry.status))), 'IMPORT_SESSION_SAVE_FAILED');
                await this.history.completeImport(imported.digest); this.current();
            }
            this.ready = true;
            this.publish();
        })());
        void this.startup.catch(error => {
            if (/CLEANUP|CLOSE_UNCERTAIN/.test(error?.code ?? '')) this.cleanupFailed = true;
            // Releasing a partial bind cancels its initialization wait before
            // Runtime's flush. App cleanup is deliberately later than flush.
            for (const binding of this.bindings.values()) { const status = binding.inspect(); if (status.phase !== 'released' && !status.initialized) binding.release(); }
            if (this.live) {
                this.error = error instanceof IDEError ? error.code
                    : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ELOOP'].includes(error?.code)
                        ? 'IDE_IO_' + error.code : 'IDE_INITIALIZATION_FAILED';
                this.ready = false; this.publish();
            }
        });
        return this.startup;
    }
    private workspaceGuard(): () => void {
        const version = this.workspaceVersion;
        const guard = () => { this.current(); requireIDE(this.ready && version < Number.MAX_SAFE_INTEGER && this.workspaceVersion === version, 'IDE_WORKSPACE_STALE'); };
        guard(); return guard;
    }
    private fileGuard(file: string): { record: IDEFile; guard: () => void } {
        const record = this.files.get(file); requireIDE(record, 'IDE_FILE_NOT_LOADED');
        const guard = () => { this.current(); requireIDE(this.files.get(file) === record, 'IDE_FILE_STALE'); };
        guard(); return { record, guard };
    }
    invoke(name: string, args: Readonly<Record<string, any>>, viewId = 'workspace'): Promise<OperationResult> {
        if (!this.live || !this.ready) return Promise.resolve(fail(new IDEError('IDE_NOT_READY')));
        return this.track(this.execute(name, args, viewId).catch(error => {
            if (/CLEANUP|CLOSE_UNCERTAIN/.test(error?.code ?? '')) this.cleanupFailed = true;
            return fail(error instanceof IDEError ? error : ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'].includes(error?.code)
                ? new IDEError('IDE_IO_' + error.code) : /^(RESOURCE_UNSUPPORTED|RESOURCE_SCOPE_DENIED|RESOURCE_SCOPE_CHANGED|RESOURCE_PARENT_INVALID|RESOURCE_CHANGED_DURING_READ)(:|$)/.test(error?.message ?? '')
                    ? new IDEError(error.message.split(':')[0]) : new IDEError('IDE_OPERATION_UNKNOWN', 'unknown'));
        }));
    }
    private async finishDisk(record: IDEFile | undefined, file: string, expected: string | undefined, guard: () => void, action: string, effect: { cleanupWarning?: string }) {
        const warnings: string[] = effect.cleanupWarning ? [effect.cleanupWarning] : [];
        let committedWorkspaceVersion: number | undefined;
        if (effect.cleanupWarning) this.cleanupFailed = true;
        try {
            guard();
            if (action === 'delete') {
                this.files.delete(file); this.commitWorkspace(); committedWorkspaceVersion = this.workspaceVersion;
                await this.lsp.closeDocument(file);
            } else {
                const observed = await this.observe(file, guard);
                requireIDE(expected === undefined || observed.content === expected, 'RESOURCE_CHANGED_AFTER_WRITE');
                const next = this.record(observed, record?.offset ?? 0, record?.limit ?? 2000, record);
                guard();
                if (record && record.observed.path !== file) this.files.delete(record.observed.path);
                if (record || this.files.size < 64) this.files.set(file, next); else warnings.push('File written; active file capacity prevented opening');
                this.commitWorkspace(); committedWorkspaceVersion = this.workspaceVersion;
                if (record) await this.lsp.closeDocument(record.observed.path);
                if (this.live) {
                    try { await this.history.add(observed.root, observed.path); }
                    catch { warnings.push('HISTORY_UPDATE_FAILED'); }
                }
            }
        } catch (error: any) {
            if (/CLEANUP|CLOSE_UNCERTAIN/.test(error?.code ?? '')) this.cleanupFailed = true;
            warnings.push('Disk effect completed; view synchronization did not complete');
        }
        return { result: success({ action, filePath: file, diskCommitted: true, warnings }), committedWorkspaceVersion };
    }
    private async execute(name: string, args: Readonly<Record<string, any>>, viewId: string): Promise<OperationResult> {
        if (viewId !== 'workspace') return this.executeView(name, args, viewId);
        if (['edit_file', 'delete_file', 'rename_file'].includes(name) || name === 'write_file' && this.files.has(textPath(args.filePath))) {
            const file = textPath(name === 'rename_file' ? args.oldPath : args.filePath), { record, guard } = this.fileGuard(file);
            if (name === 'delete_file') return (await this.finishDisk(record, file, undefined, guard, 'delete', await deleteObservedFile(record.observed, guard))).result;
            if (name === 'rename_file') {
                const destination = textPath(args.newPath), root = this.rootFor(destination);
                const current = () => { guard(); requireIDE(this.roots.includes(root), 'WORKSPACE_REMOVED'); };
                const effect = await renameObservedFile(record.observed, destination, current, root.path, root.identity);
                return (await this.finishDisk(record, destination, record.observed.content, current, 'rename', effect)).result;
            }
            let next: string;
            try { next = name === 'edit_file' ? applyEditReplacement(record.observed.content, args.oldString, args.newString, args.replaceAll ?? false) : args.content; }
            catch { throw new IDEError('IDE_EDIT_NOT_MATCHED'); }
            requireIDE(typeof next === 'string', 'IDE_CONTENT_INVALID');
            const effect = await replaceObservedFile(record.observed, next, guard);
            return (await this.finishDisk(record, file, next, guard, 'write', effect)).result;
        }
        const guard = this.workspaceGuard();
        if (name === 'create_file' || name === 'write_file') {
            const file = textPath(args.filePath), root = this.rootFor(file);
            requireIDE(typeof args.content === 'string', 'IDE_CONTENT_INVALID');
            const effect = await createFileWithParents(root.path, root.identity, file, args.content, guard);
            return (await this.finishDisk(undefined, file, args.content, guard, 'create', effect)).result;
        }
        if (name === 'multi_open_file') {
            const files = list(args.filePaths), offset = args.offset ?? 0, limit = args.limit ?? 2000;
            filePage('', offset, limit);
            requireIDE(new Set([...this.files.keys(), ...files]).size <= 64, 'IDE_FILE_CAPACITY');
            const records: IDEFile[] = [];
            for (const file of [...new Set(files)]) { const observed = await this.observe(file, guard); records.push(this.record(observed, offset, limit, this.files.get(file))); }
            guard(); const opened = records.filter(record => !this.files.has(record.observed.path)).length;
            for (const record of records) this.files.set(record.observed.path, record);
            this.commitWorkspace();
            for (const record of records) {
                try { await this.history.add(record.observed.root, record.observed.path); }
                catch { this.warn('HISTORY_UPDATE_FAILED'); }
            }
            this.publish(); return success({ opened, reloaded: records.length - opened, duplicateInputs: files.length - records.length, warnings: [...this.warnings] });
        }
        if (name === 'multi_close_file') {
            const files = list(args.filePaths), closing = [...new Set(files)].filter(file => this.files.has(file)); guard();
            for (const file of closing) this.files.delete(file); this.commitWorkspace();
            const cleanup = await Promise.allSettled(closing.map(file => this.lsp.closeDocument(file)));
            return success({ closed: closing.length, unchanged: files.length - closing.length, warnings: cleanup.some(result => result.status === 'rejected') ? ['LSP_DOCUMENT_CLOSE_FAILED'] : [] });
        }
        if (name.startsWith('search_files_by_')) {
            requireIDE(typeof args.pattern === 'string' && args.pattern.length > 0 && (!('include' in args) || typeof args.include === 'string' && args.include.length > 0), 'SEARCH_PATTERN_INVALID');
            const directories = args.cwd === undefined ? this.roots.map(root => root.path) : [textPath(args.cwd)];
            const roots = [];
            for (const directory of directories) {
                const workspace = this.rootFor(directory); await checkedPath(workspace.path, path.join(directory, '__search_probe__')); guard();
                requireIDE(await directoryIdentity(workspace.path) === workspace.identity, 'WORKSPACE_ROOT_CHANGED'); guard();
                roots.push({ path: directory, identity: await directoryIdentity(directory), workspace: workspace.path, workspaceIdentity: workspace.identity }); guard();
            }
            const result = await this.searchWorker.run({ roots, kind: name === 'search_files_by_pattern' ? 'pattern' : 'content', pattern: args.pattern, include: args.include }); guard();
            for (const root of roots) {
                requireIDE(await directoryIdentity(root.workspace) === root.workspaceIdentity && await directoryIdentity(root.path) === root.identity, 'WORKSPACE_ROOT_CHANGED'); guard();
            }
            this.search = { incarnation: this.searchSequence = nextVersion(this.searchSequence), query: args.pattern, paths: result.paths };
            this.commitWorkspace(); return success(result);
        }
        if (name === 'batch_edit') return this.batch(args.edits, guard);
        if (name === 'add_folder_to_workspace') {
            const requested = textPath(args.folderPath), root = await this.root(requested); guard();
            const existing = this.roots.some(item => item.path === root.path);
            const unavailable = this.unavailableRoots.filter(folder => folder !== requested && folder !== root.path);
            const restored = this.unavailableRoots.length - unavailable.length;
            if (existing && !restored) return success({ added: 0, unchanged: 1 });
            const roots = existing ? this.roots : [...this.roots, root];
            requireIDE(new Set([...roots.map(item => item.path), ...unavailable]).size <= 16, 'IDE_ROOT_CAPACITY');
            const expanded = existing ? this.expanded : [...new Set([...this.expanded, root.path])];
            requireIDE(expanded.length <= 512, 'IDE_DIRECTORY_CAPACITY');
            const tree = await this.readTree(roots, expanded, guard); guard();
            this.roots = roots; this.setUnavailableRoots(unavailable); this.expanded = expanded; this.tree = tree;
            this.lsp.setRoots(roots); this.commitWorkspace(); return success({ added: existing ? 0 : 1, ...(restored ? { restored } : {}) });
        }
        if (name === 'remove_folder_from_workspace') {
            const folder = textPath(args.folderPath), root = this.roots.find(root => root.path === folder);
            if (!root && !this.unavailableRoots.includes(folder)) return success({ removed: 0, unchanged: 1 });
            guard(); this.setUnavailableRoots(this.unavailableRoots.filter(item => item !== folder));
            if (!root) { this.commitWorkspace(); return success({ removed: 1, closedFiles: 0, warnings: [...this.warnings] }); }
            this.roots = this.roots.filter(item => item !== root);
            this.expanded = this.expanded.filter(directory => !inside(folder, directory));
            const closed = [...this.files.keys()].filter(file => inside(folder, file) && !this.roots.some(item => inside(item.path, file)));
            for (const file of closed) this.files.delete(file);
            const retiring = this.lsp.removeRoot(folder); this.commitWorkspace();
            try { await retiring; } catch { this.warn('LSP_ROOT_CLEANUP_FAILED'); }
            if (!this.live) return success({ removed: 1, closedFiles: closed.length, warnings: ['IDE_STOPPED_AFTER_COMMIT'] });
            try {
                const version = this.workspaceVersion, tree = await this.readTree(this.roots, this.expanded, () => { this.current(); requireIDE(this.workspaceVersion === version, 'IDE_WORKSPACE_STALE'); });
                this.tree = tree; this.publish();
            } catch (error: any) { if (/CLEANUP|CLOSE_UNCERTAIN/.test(error?.code ?? '')) this.cleanupFailed = true; this.warn('WORKSPACE_TREE_REFRESH_FAILED'); }
            return success({ removed: 1, closedFiles: closed.length, warnings: [...this.warnings] });
        }
        if (['multi_open_dirs', 'multi_close_dirs', 'refresh_workspace'].includes(name)) {
            const directories = name === 'refresh_workspace' ? this.roots.map(root => root.path) : list(args.dirPaths);
            for (const directory of directories) {
                const root = this.rootFor(directory); await checkedPath(root.path, path.join(directory, '__directory_probe__')); guard();
                const handle = await fs.opendir(directory); await closeDirectory(handle); guard();
            }
            const expanded = name === 'refresh_workspace' ? directories : name === 'multi_open_dirs' ? [...new Set([...this.expanded, ...directories])] : this.expanded.filter(directory => !directories.includes(directory));
            requireIDE(expanded.length <= 512, 'IDE_DIRECTORY_CAPACITY');
            const tree = await this.readTree(this.roots, expanded, guard); guard();
            const changed = new Set([...this.expanded.filter(value => !expanded.includes(value)), ...expanded.filter(value => !this.expanded.includes(value))]).size;
            this.expanded = expanded; this.tree = tree; this.commitWorkspace(); return success({ changed, unchanged: Math.max(0, directories.length - changed) });
        }
        throw new IDEError('IDE_TOOL_UNKNOWN');
    }
    private async batch(input: unknown, initialGuard: () => void): Promise<OperationResult> {
        requireIDE(Array.isArray(input) && input.length <= 64, 'IDE_BATCH_INVALID');
        const edits = input.map(item => {
            requireIDE(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 3 && ['filePath', 'oldString', 'newString'].every(key => typeof item[key] === 'string'), 'IDE_BATCH_INVALID');
            const file = textPath(item.filePath), record = this.files.get(file); requireIDE(record, 'IDE_FILE_NOT_LOADED');
            return { file, oldString: item.oldString, newString: item.newString, record };
        });
        initialGuard();
        const known = new Map(edits.map(edit => [edit.file, edit.record])), results: any[] = [];
        let workspaceVersion = this.workspaceVersion;
        for (const [index, edit] of edits.entries()) {
            const record = known.get(edit.file)!;
            const guard = () => { this.current(); requireIDE(this.workspaceVersion === workspaceVersion && this.files.get(edit.file) === record, 'IDE_BATCH_STALE'); };
            try {
                guard(); const content = applyEditReplacement(record.observed.content, edit.oldString, edit.newString, false);
                const effect = await replaceObservedFile(record.observed, content, guard);
                const update = await this.finishDisk(record, edit.file, content, guard, 'write', effect);
                results.push({ index, status: 'succeeded', ...update.result.data as object });
                const next = this.files.get(edit.file); requireIDE(next && next !== record && next.observed.content === content && update.committedWorkspaceVersion !== undefined, 'IDE_BATCH_REFRESH_FAILED');
                known.set(edit.file, next); workspaceVersion = update.committedWorkspaceVersion;
            } catch (error) {
                const issue = error instanceof IDEError ? error : new IDEError('IDE_EDIT_NOT_MATCHED');
                if (results[results.length - 1]?.index === index) results[results.length - 1].followupError = issue.code;
                else results.push({ index, status: issue.effects === 'unknown' ? 'unknown' : 'failed', code: issue.code });
                for (let rest = index + 1; rest < edits.length; rest++) results.push({ index: rest, status: 'not-run' });
                if (this.live) { this.lastBatch = boundedJSON(results); this.publish(); }
                if (issue.effects === 'unknown') return fail(new IDEError(issue.code, 'unknown', { results }));
                return fail(new IDEError(issue.code, results.some(item => item.status === 'succeeded') || issue.effects === 'partial' ? 'partial' : 'none', { results }));
            }
        }
        this.lastBatch = boundedJSON(results); this.publish(); return success({ results });
    }
    private async executeView(name: string, args: Readonly<Record<string, any>>, viewId: string): Promise<OperationResult> {
        if (viewId === 'search') {
            const current = this.search; requireIDE(current && name === 'close_search_view' && args.view_id === viewId, 'IDE_SEARCH_STALE');
            this.current(); this.search = null; this.commitWorkspace(); return success({ closed: 1 });
        }
        const record = [...this.files.values()].find(file => file.viewId === viewId); requireIDE(record, 'IDE_FILE_VIEW_CLOSED');
        const guard = () => { this.current(); requireIDE(this.files.get(record.observed.path) === record, 'IDE_FILE_VIEW_STALE'); };
        guard();
        if (['write_file', 'edit_file', 'delete_file', 'rename_file'].includes(name)) {
            // The target comes from the mounted FileDetail, never from a model-supplied path.
            return this.execute(name, { ...args, filePath: record.observed.path, oldPath: record.observed.path }, 'workspace');
        }
        if (name === 'close_file_detail') {
            requireIDE(args.view_id === viewId, 'IDE_WRONG_VIEW'); this.files.delete(record.observed.path); this.commitWorkspace();
            try { await this.lsp.closeDocument(record.observed.path); return success({ closed: 1 }); }
            catch { return success({ closed: 1, warnings: ['LSP_DOCUMENT_CLOSE_FAILED'] }); }
        }
        requireIDE(textPath(args.file_path) === record.observed.path, 'IDE_WRONG_FILE');
        const kind = ({ lsp_hover: 'hover', lsp_goto_definition: 'definition', lsp_find_references: 'references', lsp_get_diagnostics: 'diagnostics', lsp_document_symbol: 'symbols', lsp_incoming_calls: 'incoming', lsp_outgoing_calls: 'outgoing' } as Record<string, LSPQuery>)[name];
        requireIDE(kind, 'IDE_TOOL_UNKNOWN');
        let result: any;
        try { result = await this.lsp.query(kind, record.observed.path, record.observed.content, args.line, args.character); }
        catch (error) { throw error instanceof IDEError ? error : new IDEError('LSP_QUERY_FAILED'); }
        guard();
        const panels = { ...record.panels, [kind]: result };
        requireIDE(Buffer.byteLength(JSON.stringify(panels, null, 2)) + Buffer.byteLength(record.page) + Buffer.byteLength(record.observed.path) + 32768 <= 512 * 1024, 'IDE_VIEW_TOO_LARGE');
        let diagnostics = record.diagnostics;
        if (kind === 'diagnostics') {
            try { diagnostics = transitionLoadedDiagnostics(record.diagnostics, record.observed.path, 'success', result.value); }
            catch { throw new IDEError('LSP_DIAGNOSTICS_INVALID'); }
        }
        record.panels = panels; record.diagnostics = diagnostics;
        this.publish(); return success(result);
    }
    stop(): void { this.live = false; this.lsp.stop(); this.searchWorker.stop(); this.history.stop(); }
    close(): Promise<void> {
        if (this.completion) return this.completion; this.stop();
        this.completion = (async () => {
            const resources = await Promise.allSettled([this.lsp.close(), this.searchWorker.close(), this.history.close()]);
            await Promise.allSettled([...this.pending]);
            for (const binding of this.bindings.values()) binding.release(); this.bindings.clear();
            if (this.cleanupFailed || resources.some(result => result.status === 'rejected')) console.error('IDE_CLOSE_FAILURE', JSON.stringify({
                priorCleanupFailure: this.cleanupFailed,
                resources: resources.map((result, index) => ({ resource: ['lsp', 'search', 'history'][index], status: result.status,
                    ...(result.status === 'rejected' ? { code: result.reason instanceof IDEError ? result.reason.code : 'UNKNOWN' } : {}) })),
            }));
            requireIDE(!this.cleanupFailed && resources.every(result => result.status === 'fulfilled'), 'IDE_RESOURCE_CLEANUP_FAILED');
        })();
        void this.completion.catch(() => {}); return this.completion;
    }
    inspect() { return { live: this.live, ready: this.ready, pending: this.pending.size, lsp: this.lsp.inspect(), search: this.searchWorker.inspect() }; }
}
