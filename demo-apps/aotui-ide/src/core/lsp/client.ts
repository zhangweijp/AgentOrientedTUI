import { BusEvent, Bus, withTimeout, Filesystem } from './adapters.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Diagnostic as VSCodeDiagnostic } from 'vscode-languageserver-types';
import { LANGUAGE_EXTENSIONS } from './language.js';
import type { LSPServer } from './server.js';
import { boundedJSON, IDEError, requireIDE, nextVersion } from '../ide-errors.js';
import z from 'zod';
import { joinProcessGroup, signalProcessGroup } from './process-resources.js';

export namespace LSPClient {
    export type Info = Awaited<ReturnType<typeof create>>;
    export type Diagnostic = VSCodeDiagnostic;
    export const Event = { Diagnostics: BusEvent.define('lsp.client.diagnostics', z.object({ serverID: z.string(), path: z.string() })) };
    export async function create(input: { serverID: string; server: LSPServer.Handle; root: string;
        onDiagnostics?: (file: string, version: number | undefined) => void; signal?: AbortSignal }) {
        const child = input.server.process;
        let closing = false, completion: Promise<void> | undefined;
        const logs: string[] = [], documents = new Map<string, { text: string; version: number }>();
        const queues = new Map<string, Promise<unknown>>(), diagnostics = new Map<string, Diagnostic[]>();
        const diagnosticVersions = new Map<string, number | undefined>();
        const diagnosticErrors = new Set<string>();
        const waiters = new Set<(closed?: boolean) => void>();
        let documentVersion = 0;
        const receiveLog = (chunk: Buffer) => { logs.push(chunk.toString('utf8').slice(0, 2048)); if (logs.length > 8) logs.shift(); };
        child.stderr.on('data', receiveLog);
        let spawnError: Error | undefined;
        const onError = (error: Error) => { spawnError = error; };
        child.on('error', onError);
        const exited = new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once('close', () => resolve());
        });
        const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
        connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
            let file: string; try { file = Filesystem.normalizePath(fileURLToPath(params.uri)); } catch { return; }
            const doc = documents.get(file);
            if (closing || !doc || !Array.isArray(params.diagnostics) || params.version !== undefined && params.version !== doc.version) return;
            // Missing server versions remain explicitly unverified, never relabelled current.
            try { diagnostics.set(file, boundedJSON(params.diagnostics)); diagnosticErrors.delete(file); }
            catch { diagnostics.delete(file); diagnosticErrors.add(file); }
            diagnosticVersions.set(file, params.version);
            if (input.onDiagnostics) input.onDiagnostics(file, params.version);
            else Bus.publish(Event.Diagnostics, { path: file, serverID: input.serverID });
            for (const waiter of waiters) waiter();
        });
        connection.onRequest('window/workDoneProgress/create', () => null);
        connection.onRequest('workspace/configuration', (params: any) => (params.items ?? []).map((item: any) =>
            item.section ? item.section.split('.').reduce((value: any, key: string) => value?.[key], input.server.initialization) ?? null : input.server.initialization ?? null));
        connection.onRequest('client/registerCapability', () => null);
        connection.onRequest('client/unregisterCapability', () => null);
        connection.onRequest('workspace/workspaceFolders', () => [{ name: 'workspace', uri: pathToFileURL(input.root).href }]);
        connection.listen();
        let abortFailure = false, terminationSignalled = false;
        const abortInitialization = () => {
            closing = true;
            try { connection.dispose(); signalProcessGroup(input.server.processGroup, child, 'SIGTERM'); terminationSignalled = true; }
            catch { abortFailure = true; }
        };
        input.signal?.addEventListener('abort', abortInitialization, { once: true });
        if (input.signal?.aborted) abortInitialization();

        async function terminate(): Promise<void> {
            connection.dispose();
            if (!terminationSignalled && child.exitCode === null && child.signalCode === null && child.pid) { signalProcessGroup(input.server.processGroup, child, 'SIGTERM'); terminationSignalled = true; }
            try { await withTimeout(exited, 5000); }
            catch { if (child.pid) signalProcessGroup(input.server.processGroup, child, 'SIGKILL'); await withTimeout(exited, 5000); }
            child.stderr.off('data', receiveLog); child.off('error', onError);
        }
        try {
            await withTimeout(connection.sendRequest('initialize', {
                rootUri: pathToFileURL(input.root).href, processId: process.pid,
                workspaceFolders: [{ name: 'workspace', uri: pathToFileURL(input.root).href }],
                initializationOptions: input.server.initialization ?? {},
                capabilities: { window: { workDoneProgress: true }, workspace: { configuration: true },
                    textDocument: { synchronization: { didOpen: true, didChange: true, didClose: true }, publishDiagnostics: { versionSupport: true } } },
            }), 45000);
            if (spawnError) throw spawnError;
            await connection.sendNotification('initialized', {});
            if (input.server.initialization) await connection.sendNotification('workspace/didChangeConfiguration', { settings: input.server.initialization });
        } catch (error) {
            const childResults = await Promise.allSettled([terminate()]);
            const results = [...childResults, ...await Promise.allSettled([joinProcessGroup(input.server.processGroup)])];
            if (abortFailure || !input.server.processGroupVerified || results.some(result => result.status === 'rejected')) throw new IDEError('LSP_INITIALIZATION_CLEANUP_FAILED');
            // This code certifies that the failed initialization owns no live
            // child/group; the App may release its failed-start cache entry.
            throw new IDEError('LSP_INITIALIZATION_FAILED');
        } finally { input.signal?.removeEventListener('abort', abortInitialization); }

        async function open(params: { path: string; text?: string }): Promise<number> {
            requireIDE(!closing, 'LSP_CLOSED');
            const previous = queues.get(params.path) ?? Promise.resolve();
            const pending = previous.catch(() => {}).then(async () => {
                requireIDE(!closing, 'LSP_CLOSED');
                const text = params.text ?? await Filesystem.readFile(params.path);
                requireIDE(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'LSP_DOCUMENT_TOO_LARGE');
                const before = documents.get(params.path);
                if (before?.text === text) return before.version;
                requireIDE(before || documents.size < 64, 'LSP_DOCUMENT_CAPACITY');
                const version = documentVersion = nextVersion(documentVersion), uri = pathToFileURL(params.path).href;
                requireIDE(!closing, 'LSP_CLOSED');
                documents.set(params.path, { text, version }); diagnostics.delete(params.path); diagnosticVersions.delete(params.path); diagnosticErrors.delete(params.path);
                if (before) await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
                else await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, version, text,
                    languageId: /\.(mts|cts)$/.test(params.path) ? 'typescript' : LANGUAGE_EXTENSIONS[('.' + params.path.split('.').pop()) as keyof typeof LANGUAGE_EXTENSIONS] ?? 'plaintext' } });
                return version;
            });
            queues.set(params.path, pending);
            void pending.finally(() => { if (queues.get(params.path) === pending) queues.delete(params.path); }).catch(() => {});
            return pending;
        }
        async function closeFile(file: string): Promise<void> {
            const pending = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
                if (!documents.delete(file)) return;
                diagnostics.delete(file); diagnosticVersions.delete(file); diagnosticErrors.delete(file);
                await connection.sendNotification('textDocument/didClose', { textDocument: { uri: pathToFileURL(file).href } });
                for (const waiter of waiters) waiter();
            });
            queues.set(file, pending);
            void pending.finally(() => { if (queues.get(file) === pending) queues.delete(file); }).catch(() => {});
            return pending;
        }
        async function waitForDiagnostics(params: { path: string; version?: number }): Promise<void> {
            const version = params.version ?? documents.get(params.path)?.version;
            requireIDE(version !== undefined, 'LSP_DOCUMENT_NOT_OPEN');
            let listener: ((closed?: boolean) => void) | undefined;
            try {
                await withTimeout(new Promise<void>((resolve, reject) => {
                    listener = closed => {
                        if (closed || closing || !documents.has(params.path)) reject(new IDEError('LSP_CLOSED'));
                        else if (documents.get(params.path)?.version !== version) reject(new IDEError('LSP_DOCUMENT_CHANGED'));
                        else if (diagnosticVersions.get(params.path) === version && diagnosticErrors.has(params.path)) reject(new IDEError('IDE_RESULT_TOO_LARGE'));
                        else if (diagnosticVersions.get(params.path) === version && diagnostics.has(params.path)) resolve();
                    };
                    waiters.add(listener); listener();
                }), 30000);
            } finally { if (listener) waiters.delete(listener); }
        }
        function shutdown(): Promise<void> {
            if (completion) return completion;
            closing = true; for (const waiter of waiters) waiter(true);
            completion = (async () => {
                let failure: unknown, phase = 'documents';
                const failureCode = (error: any) => typeof error?.code === 'number' ? error.code :
                    typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
                try {
                    await Promise.allSettled([...queues.values()]);
                    await Promise.all([...documents.keys()].map(closeFile));
                    phase = 'shutdown';
                    await withTimeout(connection.sendRequest('shutdown'), 5000);
                    phase = 'exit';
                    await connection.sendNotification('exit');
                    phase = 'child-close';
                    await withTimeout(exited, 5000);
                } catch (error) {
                    failure = error;
                    console.error('LSP_CLOSE_FAILURE', JSON.stringify({ phase, code: failureCode(error) }));
                }
                finally {
                    const childResults = await Promise.allSettled([terminate()]);
                    const resources = [...childResults, ...await Promise.allSettled([joinProcessGroup(input.server.processGroup)])];
                    documents.clear(); diagnostics.clear(); diagnosticVersions.clear(); diagnosticErrors.clear(); waiters.clear();
                    if (!input.server.processGroupVerified || resources.some(result => result.status === 'rejected')) {
                        failure = new IDEError('LSP_RESOURCE_CLEANUP_FAILED');
                        console.error('LSP_CLOSE_FAILURE', JSON.stringify({ phase: 'resources', verifiedProfile: input.server.processGroupVerified === true,
                            issues: resources.flatMap((result, index) => result.status === 'rejected' ? [{ resource: index === 0 ? 'child' : 'group', code: failureCode(result.reason) }] : []) }));
                    }
                }
                if (failure) throw new IDEError('LSP_SHUTDOWN_FAILED');
            })();
            void completion.catch(() => {}); return completion;
        }
        return { root: input.root, serverID: input.serverID, connection, process: child, notify: { open, close: closeFile },
            waitForDiagnostics, diagnostics, diagnosticVersions, shutdown, versionFor: (file: string) => documents.get(file)?.version,
            inspect: () => ({ closed: closing, documentCount: documents.size, pendingDocuments: queues.size, diagnosticWaiters: waiters.size, logs: [...logs], pid: child.pid }) };
    }
}
