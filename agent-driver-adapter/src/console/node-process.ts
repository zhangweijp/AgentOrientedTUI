import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ConsoleInputs, InteractionIssue } from '@aotui/runtime';
import type { ToolResult } from '@aotui/agent-driver-v2';
import { clipText, frame, MAX_CALLS, MAX_LOGS, OUTPUT_BYTES, readFrames, record, VERSION, writeFrame } from './program-wire.js';

export interface ConsoleProgram {
    readonly code: string;
    readonly reset?: true;
    readonly names: readonly string[];
    readonly inputs: Extract<ConsoleInputs, { status: 'ready' }>;
    readonly signal: AbortSignal;
    recheck(): InteractionIssue | undefined | Promise<InteractionIssue | undefined>;
    invoke(name: string, input: Record<string, unknown>, slot: number, signal: AbortSignal): Promise<ToolResult>;
}

export interface ConsoleProcessResult {
    readonly output: readonly string[];
    readonly truncated?: true;
    readonly error?: InteractionIssue;
    readonly scope?: 'retained' | 'reset' | 'lost';
    readonly environmentPid?: number;
    readonly process?: { readonly pid: number | undefined; readonly code: number | null; readonly signal: NodeJS.Signals | null };
}

export interface NodeConsoleOptions {
    readonly nodePath?: string;
    readonly timeoutMs?: number;
}

export type ConsoleExecutor = ((program: ConsoleProgram) => Promise<ConsoleProcessResult>) & {
    readonly mode?: 'scoped';
    readonly settlesOnAbort?: true;
    dispose?(): Promise<void>;
};
export type ScopedConsoleExecutor = ConsoleExecutor & { readonly mode: 'scoped'; dispose(): Promise<void> };

const environmentIssue = {
    code: 'CONSOLE_ENVIRONMENT_UNAVAILABLE',
    message: 'Console requires macOS Seatbelt and Node 24. For the Electron Host set AOTUI_CONSOLE_NODE to the absolute path of a trusted Node binary.',
};
const protocolIssue = { code: 'CONSOLE_PROTOCOL_INVALID', message: 'The isolated program process did not follow the Console protocol.' };
const cancelled = { code: 'CONSOLE_CANCELLED', message: 'Console execution was cancelled.' };
const literal = (path: string) => '(literal ' + JSON.stringify(path) + ')';

// Kept internal to the package. A trusted bootstrap can exercise the same OS policy in isolation tests.
export function launchIsolatedNode(options: NodeConsoleOptions, entry = new URL('./program-child.mjs', import.meta.url),
    mode: 'once' | 'scoped' = 'once') {
    if (process.platform !== 'darwin') throw new Error(environmentIssue.message);
    const nodePath = options.nodePath ?? (process.versions.electron ? process.env.AOTUI_CONSOLE_NODE : process.execPath);
    if (!nodePath || !isAbsolute(nodePath)) throw new Error(environmentIssue.message);
    const binary = realpathSync(nodePath);
    const physicalPath = (url: URL) => realpathSync(fileURLToPath(url).replace(/\.asar\//, '.asar.unpacked/'));
    const bootstrap = physicalPath(entry);
    const read = [binary, bootstrap, '/', '/dev/null'].map(literal).join(' ');
    const ancestors: string[] = [];
    for (let path = dirname(bootstrap); path !== '/'; path = dirname(path)) ancestors.push(literal(path));
    // The allowlist covers only the installed execution machinery and OS libraries.
    // No project directories, inheritable Host environment, network or child processes.
    const profile = [
        '(version 1)', '(deny default)',
        '(allow process-exec ' + literal(binary) + ')',
        '(allow file-read* ' + read + ' (subpath "/System/Library") (subpath "/usr/lib"))',
        '(allow file-read-metadata ' + ancestors.join(' ') + ')',
        '(allow sysctl-read)',
    ].join('\n');
    return spawn('/usr/bin/sandbox-exec', ['-p', profile, binary,
        '--no-addons', '--no-global-search-paths', '--permission', '--max-old-space-size=64',
        '--preserve-symlinks', '--preserve-symlinks-main', '--allow-fs-read=' + bootstrap,
        bootstrap, mode], {
        cwd: '/', env: {}, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
}

const processExited = { code: 'CONSOLE_PROCESS_EXITED', message: 'The isolated program process exited before completing the run.' };
const timedOut = { code: 'CONSOLE_TIMEOUT', message: 'Console reached its time limit.' };
const lost = { code: 'CONSOLE_STATE_LOST', message: 'The scoped Console process exited between runs.' };

function timeoutOf(options: NodeConsoleOptions): number {
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new TypeError('Invalid Console timeout.');
    return timeout;
}

function completion<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

function openProgramProcess(options: NodeConsoleOptions, mode: 'once' | 'scoped') {
    const child = launchIsolatedNode(options, undefined, mode);
    const input = child.stdio[3] as Duplex, output = child.stdio[4] as Duplex;
    const closeEvent = completion<NonNullable<ConsoleProcessResult['process']>>();
    let exit: NonNullable<ConsoleProcessResult['process']> | undefined, sequence = 0;
    let ready = false, terminating = false;
    let receiver: { prepare(): void; message(message: Record<string, unknown>): void; fail(issue: InteractionIssue): void } | undefined;
    const kill = () => {
        if (terminating || exit) return;
        terminating = true;
        child.kill('SIGKILL');
    };
    const fail = (issue: InteractionIssue) => { receiver?.fail(issue);kill(); };
    child.once('error', () => fail(environmentIssue));
    child.once('close', (code, signal) => {
        exit = { pid: child.pid, code, signal };
        receiver?.fail(ready ? processExited : environmentIssue);
        closeEvent.resolve(exit);
    });
    input.on('error', () => fail(protocolIssue));
    readFrames(output, message => {
        if (!ready) {
            if (message.type !== 'ready' || message.version !== VERSION || message.mode !== mode) { fail(environmentIssue);return; }
            ready = true;
            receiver?.prepare();
            return;
        }
        if (message.run === sequence && receiver) receiver.message(message);
        else if (typeof message.run !== 'number' || message.run > sequence) fail(protocolIssue);
    }, () => fail(protocolIssue));

    return {
        get exit() { return exit; },
        get pid() { return child.pid; },
        async close() { kill();return closeEvent.promise; },
        async run(program: ConsoleProgram, timeout: number, onBegin?: () => void): Promise<ConsoleProcessResult> {
            if (program.signal.aborted) return { output: [], error: cancelled };
            if (exit || terminating) return { output: [], error: processExited };
            const run = sequence + 1;
            const finished = completion<void>();
            const controller = new AbortController(), logs: string[] = [], names = new Set(program.names);
            const life: { stage: 'ready' | 'initialize' | 'checking' | 'running' | 'finished' } = { stage: 'ready' };
            let bytes = 0, received = 0, truncated = false;
            let error: InteractionIssue | undefined;
            let tail = Promise.resolve();
            const finish = (issue?: InteractionIssue) => {
                if (life.stage === 'finished') return;
                life.stage = 'finished';
                error = issue;
                controller.abort();
                finished.resolve();
            };
            const failed = (issue: InteractionIssue) => {
                if (life.stage === 'finished') return;
                finish(issue);
                kill();
            };
            const skip = (issue: InteractionIssue) => {
                if (life.stage === 'initialize' || life.stage === 'checking') writeFrame(input, { type: 'skip', run });
                finish(issue);
                if (mode === 'once') kill();
            };
            const cancel = () => life.stage === 'running' ? failed(cancelled) : skip(cancelled);
            const deadline = setTimeout(() => {
                if (mode === 'once' && life.stage === 'finished' && !exit) {
                    error ??= timedOut;
                    kill();
                } else failed(ready ? timedOut : environmentIssue);
            }, timeout);
            try {
                receiver = {
                    fail: failed,
                    prepare() {
                        if (life.stage !== 'ready') return;
                        const payload = { type: 'run', version: VERSION, run, code: program.code, names: program.names,
                            refs: program.inputs.refs, paths: program.inputs.paths.map(path => [path.appId, path.viewId, path.refId, ...path.path.map(String)]) };
                        let data: string;
                        try { data = frame(payload); }
                        catch {
                            skip({ code: 'CONSOLE_INPUT_CAPACITY', message: 'Console inputs exceed the transport limit. Use less code or a smaller imports list.' });
                            return;
                        }
                        sequence = run;
                        life.stage = 'initialize';
                        input.write(data);
                    },
                    message(message) {
                        if (life.stage === 'finished') return;
                        if (life.stage === 'initialize') {
                            if (message.type !== 'initialized') { failed(protocolIssue);return; }
                            life.stage = 'checking';
                            void Promise.resolve().then(() => program.recheck()).then(issue => {
                                if (life.stage !== 'checking') return;
                                if (issue) { skip(issue);return; }
                                onBegin?.();
                                life.stage = 'running';
                                writeFrame(input, { type: 'begin', run });
                            }).catch(() => failed(protocolIssue));
                            return;
                        }
                        if (life.stage === 'running' && message.type === 'log' && typeof message.text === 'string' && logs.length < MAX_LOGS) {
                            const text = clipText(message.text, OUTPUT_BYTES - bytes);
                            if (text.length < message.text.length) truncated = true;
                            bytes += Buffer.byteLength(text);
                            logs.push(text);
                            return;
                        }
                        if (life.stage === 'running' && message.type === 'invoke' && received < MAX_CALLS && message.id === received + 1 &&
                            typeof message.name === 'string' && names.has(message.name) && record(message.input)) {
                            const id = ++received;
                            const { name, input: args } = message;
                            tail = tail.then(async () => {
                                const result = await program.invoke(name, args, id, controller.signal);
                                if (controller.signal.aborted) return;
                                const response = result.error
                                    ? { type: 'result', run, id, error: result.error }
                                    : { type: 'result', run, id, value: result.result ?? null };
                                let data: string;
                                try { data = frame(response); }
                                catch { data = frame({ type: 'result', run, id, error: { code: 'CONSOLE_TOOL_RESULT_CAPACITY',
                                    message: 'The Tool result exceeds the Console limit. Check the original receipt.' } }); }
                                input.write(data);
                            }).catch(() => failed(protocolIssue));
                            return;
                        }
                        if (life.stage === 'running' && message.type === 'done' && (message.error === undefined ||
                            (record(message.error) && typeof message.error.message === 'string' && message.error.code === 'CONSOLE_PROGRAM_FAILED'))) {
                            truncated ||= message.truncated === true;
                            finish(message.error ? { code: 'CONSOLE_PROGRAM_FAILED', message: clipText(message.error.message as string, 512) } : undefined);
                            if (mode === 'once') input.end();
                            return;
                        }
                        failed(protocolIssue);
                    },
                };
                program.signal.addEventListener('abort', cancel, { once: true });
                if (program.signal.aborted) cancel();
                else if (ready) receiver.prepare();
                await finished.promise;
                const exited = mode === 'once' || terminating || exit ? await closeEvent.promise : undefined;
                await tail;
                if (exited && exited.code !== 0 && !error) error = processExited;
                return { output: logs, ...(truncated ? { truncated: true } : {}), ...(error ? { error } : {}),
                    ...(exited ? { process: exited } : {}) };
            } finally {
                clearTimeout(deadline);
                program.signal.removeEventListener('abort', cancel);
                receiver = undefined;
            }
        },
    };
}

/** Execute one program in a fresh, OS-confined process and wait for its exit. */
export function createNodeConsoleExecutor(options: NodeConsoleOptions = {}): ConsoleExecutor {
    const timeout = timeoutOf(options), config = { ...options };
    const execute: ConsoleExecutor = async program => {
        if (program.signal.aborted) return { output: [], error: cancelled };
        let process: ReturnType<typeof openProgramProcess>;
        try { process = openProgramProcess(config, 'once'); }
        catch { return { output: [], error: environmentIssue }; }
        try { return await process.run(program, timeout); }
        finally { await process.close(); }
    };
    return Object.assign(execute, { settlesOnAbort: true as const });
}

/** One lazy process for one live session. Dispose the executor with that session. */
export function createNodeScopedConsoleExecutor(options: NodeConsoleOptions = {}): ScopedConsoleExecutor {
    const timeout = timeoutOf(options), config = { ...options };
    type Environment = ReturnType<typeof openProgramProcess>;
    let current: Environment | undefined;
    let active: Promise<ConsoleProcessResult> | undefined;
    let disposing: Promise<void> | undefined;
    const lifetime = new AbortController();
    const execute: ConsoleExecutor = program => {
        if (lifetime.signal.aborted || program.signal.aborted) return Promise.resolve({ output: [], error: cancelled });
        if (active) return Promise.resolve({ output: [], error: { code: 'CONSOLE_BUSY', message: 'Wait for the current Console run to finish.' } });
        if (current?.exit && !program.reset) {
            const process = current.exit;
            current = undefined;
            return Promise.resolve({ output: [], error: lost, scope: 'lost', process });
        }
        const run = async (): Promise<ConsoleProcessResult> => {
            const prior = current;
            let chosen = prior;
            if (!chosen || program.reset) {
                try { chosen = openProgramProcess(config, 'scoped'); }
                catch { return { output: [], error: environmentIssue }; }
            }
            let retiring: Promise<unknown> | undefined;
            let result: ConsoleProcessResult;
            try {
                result = await chosen.run({ ...program, signal: AbortSignal.any([program.signal, lifetime.signal]) }, timeout, () => {
                    current = chosen;
                    if (prior && prior !== chosen) retiring = prior.close();
                });
            } catch (error) {
                if (chosen !== current) await chosen.close();
                throw error;
            } finally { await retiring; }
            // A candidate that could not prepare its inputs never takes ownership from the prior scope.
            if (chosen !== current) result = { ...result, process: await chosen.close() };
            if (current?.exit) {
                current = undefined;
                return { ...result, scope: 'lost' };
            }
            if (current === chosen) return { ...result, scope: program.reset ? 'reset' : 'retained', environmentPid: chosen.pid };
            return result;
        };
        active = run().finally(() => { active = undefined; });
        return active;
    };
    return Object.assign(execute, {
        mode: 'scoped' as const,
        settlesOnAbort: true as const,
        dispose() {
            if (disposing) return disposing;
            lifetime.abort();
            const pending = active;
            const environment = current;
            disposing = Promise.allSettled([pending, environment?.close()]).then(() => { current = undefined; });
            return disposing;
        },
    });
}
