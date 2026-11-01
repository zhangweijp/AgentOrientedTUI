import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createRuntime } from '@aotui/runtime';

const { values } = parseArgs({ options: {
    project: { type: 'string' }, data: { type: 'string' }, session: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
    console.log('Local scoped IDE: --project <directory> --data <directory> [--session <key>]\n'
        + 'Send JSON lines with op: views, observe, invoke, receipt, release, or exit.\n'
        + 'Commands run with the local operator\'s permissions. Structured replies start with AOTUI_IDE.');
} else {
    if (!values.project || !values.data) throw new Error('--project and --data are required');
    const project = await fs.realpath(path.resolve(values.project));
    if (!(await fs.stat(project)).isDirectory()) throw new Error('--project must be a directory');
    const data = path.resolve(values.data);
    await fs.mkdir(data, { recursive: true });
    const session = values.session ?? createHash('sha256').update(project).digest('hex').slice(0, 24);
    const emit = (event, detail = {}) => console.log('AOTUI_IDE ' + JSON.stringify({ event, ...detail }));
    const runtime = createRuntime({ worker: { timeoutMs: 45000, pool: { initialSize: 0, maxSize: 1 } } });
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    const lines = input[Symbol.asyncIterator]();
    let client, closing, startup, initializing = true, queued = 0;
    const fail = error => { process.exitCode = 1; emit('error', { message: String(error) }); };
    function shutdown(reason) {
        if (!closing) {
            const acceptedStartup = startup;
            closing = (async () => {
                await acceptedStartup?.catch(() => {});
                const report = await runtime.beginShutdown(reason).completion;
                if (!report.ok || !report.resourcesReleased) process.exitCode = 1;
                emit('closed', { report });
                return report;
            })();
            client?.close();
            input.close();
            emit('stopping', { reason, waitingForStartup: !!acceptedStartup });
        }
        return closing;
    }
    const interrupt = () => { void shutdown('local signal').catch(fail); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    input.on('line', () => queued++);
    input.on('close', () => {
        if (initializing && queued === 0) void shutdown('stdin ended during startup').catch(fail);
    });
    try {
        emit('starting', { project, data, session, runtimeModule: import.meta.resolve('@aotui/runtime'),
            ideModule: import.meta.resolve('@agentina/aotui-ide') });
        const desktopId = await (startup = runtime.createDesktop('local-scoped-ide'));
        startup = undefined;
        if (!closing) {
            const appId = await (startup = runtime.installDynamicWorkerApp(desktopId, import.meta.resolve('@agentina/aotui-ide'), {
                appId: 'local-ide',
                interactionModes: ['ordinary-v2', 'snapshot-value-v2'],
                config: { projectPath: project, ideSessionKey: session,
                    ideHistoryPath: path.join(data, 'history.json'), AOTUI_DATA_DIR: path.join(data, 'state'),
                    enableDiagnosticsRead: true, enableWorkspaceCreate: true },
            }));
            startup = undefined;
            if (!closing) {
                const opened = runtime.createAppScope(desktopId, appId, {
                    project({ source, selection }) {
                        const ids = new Set(selection.viewIds), selected = source.views.filter(view => ids.has(view.id));
                        return {
                            views: selected.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                            refs: [],
                            targets: Object.values(source.tools).flatMap(tool => tool.targets.filter(target => ids.has(target.viewId))
                                .map(target => ({ toolId: tool.id, target }))),
                            content: selected.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' })),
                        };
                    },
                    authorize: () => true,
                    canReadReceipt: () => true,
                });
                if (opened.status !== 'opened') throw new Error(JSON.stringify(opened));
                client = opened.client;
                const deadline = Date.now() + 15000;
                let ready;
                while (!closing) {
                    ready = await client.observe({ viewIds: ['root', 'workspace'] });
                    if (ready.status === 'observed') {
                        // This marker belongs to this packaged IDE's Root View.
                        // Workspace contents can contain arbitrary file names/text.
                        const root = ready.observation.views.find(view => view.id === 'root');
                        const failed = /^Initialization failed: ([A-Z][A-Z0-9_]{0,127})\r?$/m.exec(root?.content?.value ?? '');
                        if (failed) {
                            client.releaseObservation(ready.observation.observationId);
                            throw new Error('Initialization failed: ' + failed[1]);
                        }
                        if (ready.observation.tools.some(tool => tool.name === 'multi_open_file')) break;
                        client.releaseObservation(ready.observation.observationId);
                    }
                    if (Date.now() >= deadline) throw new Error('Workspace not ready: ' + JSON.stringify(ready));
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                initializing = false;
                if (!closing) emit('ready', { observation: ready.observation });
                let sequence = 0;
                for await (const line of lines) {
                    if (closing) break;
                    queued--;
                    if (!line.trim()) continue;
                    const request = ++sequence;
                    try {
                        const command = JSON.parse(line);
                        if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Expected a command object');
                        if (command.op === 'exit') break;
                        let value;
                        switch (command.op) {
                            case 'views':
                                value = await client.observe({ all: true });
                                if (value.status === 'observed') value = value.observation.views
                                    .map(({ id, type, name }) => ({ viewId: id, viewType: type, viewName: name }));
                                else throw new Error('Could not observe the current Views: ' + value.issue.code);
                                break;
                            case 'observe': value = await client.observe({ viewIds: command.viewIds }); break;
                            case 'invoke': value = await client.invoke({ invocationId: command.invocationId ?? randomUUID(),
                                observationId: command.observationId, bindingId: command.bindingId, input: command.input }); break;
                            case 'receipt': value = await client.readReceipt(command.invocationId); break;
                            case 'release': client.releaseObservation(command.observationId); value = { released: true }; break;
                            default: throw new Error('Unknown op: ' + command.op);
                        }
                        emit('result', { request, op: command.op, value });
                    } catch (error) { emit('command-error', { request, message: String(error) }); }
                }
            }
        }
    } catch (error) { if (!closing || startup) fail(error); }
    finally {
        initializing = false;
        await shutdown('local input complete').catch(fail);
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
    }
}
