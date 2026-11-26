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
        + 'Send JSON lines with op: views, observe, adopt, invoke, release, or exit.\n'
        + 'Commands run with the local operator\'s permissions. Structured replies start with AOTUI_IDE.');
} else {
    if (!values.project || !values.data) throw new Error('--project and --data are required');
    const project = await fs.realpath(path.resolve(values.project));
    if (!(await fs.stat(project)).isDirectory()) throw new Error('--project must be a directory');
    const data = path.resolve(values.data);
    await fs.mkdir(data, { recursive: true });
    const session = values.session ?? createHash('sha256').update(project).digest('hex').slice(0, 24);
    const emit = (event, detail = {}) => console.log('AOTUI_IDE ' + JSON.stringify({ event, ...detail }));
    const runtime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    const lines = input[Symbol.asyncIterator]();
    let closing, startup, initializing = true, queued = 0;
    const fail = error => { process.exitCode = 1; emit('error', { message: String(error) }); };
    function shutdown(reason) {
        if (!closing) {
            const acceptedStartup = startup;
            closing = (async () => {
                await acceptedStartup?.catch(() => {});
                const report = await runtime.beginClose().completion;
                if (!report.ok || !report.resourcesReleased) process.exitCode = 1;
                emit('closed', { report });
                return report;
            })();
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
        const desktop = await (startup = runtime.createDesktop('local-scoped-ide'));
        startup = undefined;
        if (!closing) {
            const client = await (startup = desktop.installDynamicWorkerApp(import.meta.resolve('@agentina/aotui-ide'), {
                installationId: 'local-ide', name: 'system_ide',
                config: { projectPath: project, ideSessionKey: session,
                    ideHistoryPath: path.join(data, 'history.json'), AOTUI_DATA_DIR: path.join(data, 'state'),
                    enableDiagnosticsRead: true, enableWorkspaceCreate: true },
            }));
            startup = undefined;
            if (!closing) {
                const candidates = new Map();
                let active;
                async function observe() {
                    const prepared = await client.observe();
                    if (prepared.status === 'rejected') return prepared;
                    const { observation } = prepared.candidate;
                    candidates.set(observation.observationId, prepared.candidate);
                    return { status: 'observed', observation };
                }
                function release(observationId) {
                    if (active?.observationId === observationId) {
                        active.turn.release();
                        active = undefined;
                    }
                    candidates.get(observationId)?.discard();
                    candidates.delete(observationId);
                }
                const deadline = Date.now() + 15000;
                let ready;
                while (!closing) {
                    ready = await observe();
                    if (ready.status === 'observed') {
                        // This marker belongs to this packaged IDE's Root View.
                        // Workspace contents can contain arbitrary file names/text.
                        const root = ready.observation.views.find(view => view.id === 'root');
                        const failed = /^Initialization failed: ([A-Z][A-Z0-9_]{0,127})\r?$/m.exec(root?.content?.value ?? '');
                        if (failed) {
                            release(ready.observation.observationId);
                            throw new Error('Initialization failed: ' + failed[1]);
                        }
                        if (ready.observation.tools.some(tool => tool.name === 'multi_open_file')) break;
                        release(ready.observation.observationId);
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
                            case 'views': {
                                const preview = await client.preview();
                                if (preview.status !== 'previewed') throw new Error('Could not preview Views: ' + preview.issue.code);
                                value = preview.views.map(({ id, type, name }) => ({ viewId: id, viewType: type, viewName: name }));
                                break;
                            }
                            case 'observe': value = await observe(); break;
                            case 'adopt': {
                                const { observationId } = command;
                                if (active?.observationId === observationId && active.turn.isCurrent) {
                                    value = { status: 'adopted' };
                                    break;
                                }
                                const result = desktop.adoptTurn({ apps: [{ candidate: candidates.get(observationId) }] });
                                if (result.status === 'adopted') {
                                    if (active && active.observationId !== observationId) candidates.delete(active.observationId);
                                    active = { observationId, turn: result.turn };
                                    value = { status: 'adopted' };
                                } else value = result;
                                break;
                            }
                            case 'invoke': {
                                if (!active) throw new Error('Adopt an observation before invoking a Tool.');
                                value = await active.turn.invoke(client.appId, { invocationId: command.invocationId ?? randomUUID(),
                                    observationId: command.observationId, toolId: command.toolId,
                                    ...(command.viewId === undefined ? {} : { viewId: command.viewId }), input: command.input });
                                break;
                            }
                            case 'release': release(command.observationId); value = { released: true }; break;
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
