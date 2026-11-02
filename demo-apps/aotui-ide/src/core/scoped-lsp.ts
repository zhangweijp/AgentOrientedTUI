import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LSPClient } from './lsp/client.js';
import { LSPServer, spawnLSPServer } from './lsp/server.js';
import { withTimeout } from './lsp/adapters.js';
import { checkedPath, directoryIdentity, inside } from './versioned-file-write.js';
import { IDEError, boundedJSON, nextVersion, requireIDE } from './ide-errors.js';
import { readBoundedText } from './ide-history.js';
import { loadedDiagnostic } from '../tui/loaded-diagnostics.js';

export type LSPQuery = 'hover' | 'definition' | 'references' | 'diagnostics' | 'symbols' | 'incoming' | 'outgoing';
/** Per-App ownership; the old module singleton is never used by this route. */
export class ScopedLSP {
    private live = true;
    private roots: string[] = [];
    private rootIdentities = new Map<string, string>();
    private clients = new Map<string, Promise<LSPClient.Info>>();
    private starts = new Map<string, AbortController>();
    private rootEpoch = new Map<string, number>();
    private rootSequence = 0;
    private actual = new Set<Promise<unknown>>();
    private generations = new Map<string, number>();
    private querySequence = 0;
    private completion?: Promise<void>;
    setRoots(sources: readonly Readonly<{ path: string; identity: string }>[]): void {
        requireIDE(this.live, 'LSP_CLOSED');
        const roots = sources.map(source => source.path);
        for (const source of sources) {
            requireIDE(!this.rootIdentities.has(source.path) || this.rootIdentities.get(source.path) === source.identity, 'LSP_ROOT_REMOVAL_REQUIRES_CLEANUP');
            this.rootIdentities.set(source.path, source.identity);
        }
        for (const root of roots) if (!this.rootEpoch.has(root)) this.rootEpoch.set(root, this.rootSequence = nextVersion(this.rootSequence));
        for (const root of this.roots) requireIDE(roots.includes(root), 'LSP_ROOT_REMOVAL_REQUIRES_CLEANUP');
        this.roots = [...roots];
    }
    stop(): void { this.live = false; for (const start of this.starts.values()) start.abort(); }
    private rootFor(file: string): string {
        const root = this.roots.filter(root => inside(root, file)).sort((a, b) => b.length - a.length)[0];
        requireIDE(root, 'LSP_OUTSIDE_WORKSPACE'); return root;
    }
    private client(root: string, file: string): Promise<LSPClient.Info> {
        const extension = path.extname(file), builtin = Object.values(LSPServer).find(server => server.extensions.includes(extension));
        const epoch = this.rootEpoch.get(root), identity = this.rootIdentities.get(root), id = builtin?.id ?? extension, key = root + '\0' + epoch + '\0' + id;
        const existing = this.clients.get(key); if (existing) return existing;
        requireIDE(this.clients.size < 8, 'LSP_CLIENT_CAPACITY');
        const start = new AbortController(); this.starts.set(key, start);
        let acquired = false;
        const pending = (async () => {
            let config: any = {};
            const currentRoot = async () => requireIDE(this.live && this.rootEpoch.get(root) === epoch && await directoryIdentity(root) === identity, 'LSP_ROOT_CHANGED');
            await currentRoot();
            try {
                await checkedPath(root, path.join(root, '.aotui-ide/lsp-config.json'));
                config = JSON.parse(await readBoundedText(path.join(root, '.aotui-ide/lsp-config.json'), 65536));
            } catch (error: any) { if (error instanceof SyntaxError) throw new IDEError('LSP_CONFIG_INVALID'); if (error.code !== 'ENOENT') throw error; }
            requireIDE(config.lsp !== false, 'LSP_DISABLED');
            const custom = config.lsp?.[id] ?? Object.values(config.lsp ?? {}).find((item: any) => item?.extensions?.includes(extension)) as any;
            requireIDE(!custom?.disabled, 'LSP_DISABLED'); requireIDE(this.live && this.roots.includes(root), 'LSP_CLOSED');
            let server: LSPServer.Handle | undefined;
            await currentRoot();
            if (custom?.command) {
                requireIDE(Array.isArray(custom.command) && custom.command.length > 0 && custom.command.length <= 32 && custom.command.every((x: unknown) => typeof x === 'string'), 'LSP_CONFIG_INVALID');
                server = await spawnLSPServer(root, custom.command[0], custom.command.slice(1), custom.env);
                server.initialization = custom.initialization;
            } else { requireIDE(builtin, 'LSP_UNAVAILABLE'); server = await builtin.spawn(root); }
            requireIDE(server, 'LSP_UNAVAILABLE');
            acquired = true;
            let client: LSPClient.Info;
            try { client = await LSPClient.create({ serverID: id, server, root, signal: start.signal, onDiagnostics() {} }); }
            catch (error: any) { if (error.code === 'LSP_INITIALIZATION_FAILED') acquired = false; throw error; }
            if (!this.live || this.rootEpoch.get(root) !== epoch) { await client.shutdown(); acquired = false; throw new IDEError('LSP_CLOSED'); }
            return client;
        })();
        this.clients.set(key, pending);
        void pending.finally(() => this.starts.delete(key)).catch(() => {});
        void pending.catch(error => {
            if (!acquired && !/CLEANUP|CLOSE_UNCERTAIN/.test(error?.code ?? '') && this.clients.get(key) === pending) this.clients.delete(key);
        }); // Only failures whose actual resource release is uncertain remain owned.
        return pending;
    }
    async query(kind: LSPQuery, file: string, text: string, line = 1, character = 1): Promise<any> {
        requireIDE(this.live, 'LSP_CLOSED'); requireIDE(this.actual.size < 4, 'LSP_QUERY_CAPACITY');
        requireIDE(Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(character) && character > 0, 'LSP_POSITION_INVALID');
        const root = this.rootFor(file), rootEpoch = this.rootEpoch.get(root), rootIdentity = this.rootIdentities.get(root), key = file + '\0' + kind;
        const generation = this.querySequence = nextVersion(this.querySequence);
        this.generations.set(key, generation);
        const actual = (async () => {
            requireIDE(await directoryIdentity(root) === rootIdentity && this.rootEpoch.get(root) === rootEpoch, 'LSP_ROOT_CHANGED');
            const client = await this.client(root, file);
            requireIDE(this.live && this.rootEpoch.get(root) === rootEpoch && await directoryIdentity(root) === rootIdentity, 'LSP_ROOT_CHANGED');
            const version = await client.notify.open({ path: file, text }), uri = pathToFileURL(file).href;
            const params = { textDocument: { uri }, position: { line: line - 1, character: character - 1 } };
            let raw: any;
            if (kind === 'diagnostics' && client.serverID === 'typescript') {
                const diagnostics: any[] = [];
                for (const command of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync', 'suggestionDiagnosticsSync']) {
                    const response: any = await client.connection.sendRequest('workspace/executeCommand', {
                        command: 'typescript.tsserverRequest', arguments: [command, { file: uri, includeLinePosition: true }, { executionTarget: 0, expectsResult: true, isAsync: false }],
                    });
                    requireIDE(response?.type === 'response' && response.success === true && Array.isArray(response.body), 'LSP_DIAGNOSTICS_UNAVAILABLE');
                    boundedJSON(response.body);
                    diagnostics.push(...response.body.map((item: any) => {
                        requireIDE(item.startLocation && item.endLocation && typeof item.message === 'string', 'LSP_DIAGNOSTICS_INVALID');
                        return { range: { start: { line: item.startLocation.line - 1, character: item.startLocation.offset - 1 },
                            end: { line: item.endLocation.line - 1, character: item.endLocation.offset - 1 } },
                            message: item.message, severity: item.category === 'error' ? 1 : item.category === 'warning' ? 2 : 3, code: item.code, source: 'typescript' };
                    }));
                }
                raw = diagnostics;
            } else if (kind === 'diagnostics') { await client.waitForDiagnostics({ path: file, version }); raw = client.diagnostics.get(file) ?? []; }
            else if (kind === 'incoming' || kind === 'outgoing') {
                const items: any = boundedJSON(await client.connection.sendRequest('textDocument/prepareCallHierarchy', params));
                raw = items?.[0] ? await client.connection.sendRequest(kind === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item: items[0] }) : [];
            } else {
                const method = { hover: 'textDocument/hover', definition: 'textDocument/definition', references: 'textDocument/references', symbols: 'textDocument/documentSymbol' }[kind];
                raw = await client.connection.sendRequest(method, { ...params, ...(kind === 'references' ? { context: { includeDeclaration: true } } : {}) });
            }
            requireIDE(this.live && this.rootEpoch.get(root) === rootEpoch && await directoryIdentity(root) === rootIdentity && client.versionFor(file) === version && this.generations.get(key) === generation, 'LSP_RESULT_STALE');
            if (kind === 'diagnostics') {
                try {
                    boundedJSON(raw); requireIDE(Array.isArray(raw), 'LSP_DIAGNOSTICS_INVALID');
                    raw = raw.map(item => { requireIDE(item.severity === undefined || [1, 2, 3, 4].includes(item.severity), 'LSP_DIAGNOSTICS_INVALID'); return loadedDiagnostic({ ...item, severity: item.severity ?? 1 }); });
                } catch { throw new IDEError('LSP_DIAGNOSTICS_INVALID'); }
            }
            return boundedJSON({ documentVersion: version, value: normalizeResult(boundedJSON(raw ?? (kind === 'hover' ? null : []))) });
        })();
        this.actual.add(actual); void actual.finally(() => {
            this.actual.delete(actual); if (this.generations.get(key) === generation) this.generations.delete(key);
        }).catch(() => {});
        // Deadline does not release the actual request's capacity or ownership.
        return withTimeout(actual, 30000).catch(error => { throw error instanceof IDEError ? error : new IDEError('LSP_QUERY_FAILED'); });
    }
    async closeDocument(file: string): Promise<void> {
        for (const key of this.generations.keys()) if (key.startsWith(file + '\0')) this.generations.delete(key);
        await Promise.all([...this.clients.values()].map(async pending => { const client = await pending; await client.notify.close(file); }));
    }
    async removeRoot(root: string): Promise<void> {
        this.roots = this.roots.filter(value => value !== root);
        this.rootEpoch.delete(root);
        this.rootIdentities.delete(root);
        const entries = [...this.clients].filter(([key]) => key.startsWith(root + '\0'));
        for (const [key] of entries) this.starts.get(key)?.abort();
        const results = await Promise.allSettled(entries.map(async ([key, pending]) => {
            let client: LSPClient.Info;
            try { client = await pending; } catch (error) { if (this.clients.get(key) === pending) throw error; return; }
            await client.shutdown(); if (this.clients.get(key) === pending) this.clients.delete(key);
        }));
        if (results.some(result => result.status === 'rejected')) throw new IDEError('LSP_ROOT_CLEANUP_FAILED');
    }
    close(): Promise<void> {
        if (this.completion) return this.completion; this.stop();
        this.completion = (async () => {
            const results = await Promise.allSettled([...this.clients].map(async ([key, pending]) => {
                let client: LSPClient.Info;
                try { client = await pending; } catch (error) { if (this.clients.get(key) === pending) throw error; return; }
                await client.shutdown();
            }));
            await Promise.allSettled([...this.actual]);
            this.clients.clear(); this.generations.clear(); this.rootEpoch.clear(); this.rootIdentities.clear();
            if (results.some(result => result.status === 'rejected')) throw new IDEError('LSP_CLEANUP_FAILED');
        })();
        void this.completion.catch(() => {}); return this.completion;
    }
    inspect() { return { live: this.live, clients: this.clients.size, actualQueries: this.actual.size, currentQueries: this.generations.size, startingClients: this.starts.size, roots: this.rootEpoch.size }; }
}
function normalizeResult(value: any): any {
    if (Array.isArray(value)) return value.map(normalizeResult);
    if (!value || typeof value !== 'object') return value;
    if (Number.isSafeInteger(value.line) && Number.isSafeInteger(value.character) && Object.keys(value).length === 2)
        return { line: value.line + 1, character: value.character + 1 };
    const result: Record<string, any> = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeResult(item)]));
    if (typeof value.uri === 'string' && value.uri.startsWith('file:')) result.filePath = fileURLToPath(value.uri);
    if (typeof value.targetUri === 'string' && value.targetUri.startsWith('file:')) result.filePath = fileURLToPath(value.targetUri);
    return result;
}
