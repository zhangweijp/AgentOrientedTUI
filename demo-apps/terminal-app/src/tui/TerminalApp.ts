import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import pkg from '../../package.json' with { type: 'json' };
import { createApp, createView, type ToolResult, type ViewHandle } from '@aotui/sdk';
import { rootBody } from './RootView.js';
import { terminalConsoleBody } from './TerminalConsoleView.js';
import { terminalBody } from './TerminalView.js';
import { RootType, TerminalType, TerminalConsoleType, terminalViewTypes } from './TerminalTools.js';
import type { TerminalSession, CommandRecord } from '../types.js';
import { DEFAULT_TAIL_LINES, hasChainedCd, isPathWithinProject, parseCdCommand, resolveNextCwd, splitLines } from '../core/terminal-utils.js';

function planCommand(cwd: string, projectPath: string, command: string): { isCd: boolean; cwd: string } | { error: string } {
    if (hasChainedCd(command)) return { error: 'Chained cd commands are not supported.' };
    const { isCd, target } = parseCdCommand(command);
    const nextCwd = isCd ? resolveNextCwd(cwd, projectPath, target) : cwd;
    if (!isPathWithinProject(projectPath, nextCwd)) return {
        error: isCd ? 'Target path is outside projectPath.' : 'Terminal working directory is outside projectPath.',
    };
    return { isCd, cwd: nextCwd };
}

type RunningCommand = {
    child: ChildProcessWithoutNullStreams;
    closed: Promise<void>;
    stopping: boolean;
};

const separateGroup = process.platform !== 'win32';

function stopCommand(command: RunningCommand): void {
    const { child } = command;
    if (command.stopping || child.pid === undefined) return;
    try {
        if (separateGroup) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
    } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    command.stopping = true;
}

export default createApp({
    ...pkg.aotui,
    viewTypes: terminalViewTypes,
    initialize({ launchConfig, publish: commit, requestAttention, registerLifecycle, signal }) {
        const projectPath = typeof launchConfig?.projectPath === 'string' && launchConfig.projectPath || homedir();
        type OpenTerminal = { session: TerminalSession; view: ViewHandle<typeof TerminalType> };
        let terminals: OpenTerminal[] = [];
        let terminalCounter = 0;
        const processes = new Map<string, RunningCommand>();

        const root = createView(RootType, { id: 'root' });
        const consoleView = createView(TerminalConsoleType, { id: 'term_console' });
        const frames = (entries: readonly OpenTerminal[]) => [
            root.frame({ body: rootBody, name: 'Root' }),
            consoleView.frame({ name: 'TerminalConsole',
                body: terminalConsoleBody(projectPath, entries.map(({session}) => session)),
                context: { onSendCommandNewTerminal: sendCommandNewTerminal },
            }),
            ...entries.map(({view,session}) => view.frame({ name: session.id, body: terminalBody(session),
                bindingKey: session.id, context: { terminal: session, onSendCommand: sendCommand, onLoadMoreOutput: setOutputTail, onCloseTerminal: closeTerminal },
            })),
        ];
        const publish = () => commit(() => frames(terminals));

        function publishCommand(): string | undefined {
            if (signal.aborted) return;
            if (!publish().ok) return 'The command state changed. The Terminal projection could not be prepared.';
        }

        registerLifecycle({
            close: async () => {
                const running = [...processes.values()];
                for (const command of running) stopCommand(command);
                await Promise.all(running.map(command => command.closed));
            },
        });

        async function closeTerminal(id: string): Promise<boolean> {
            const terminal = terminals.find(entry => entry.session.id === id);
            if (!terminal) return false;
            const running = processes.get(id);
            if (running) stopCommand(running);
            terminals = terminals.filter(entry => entry !== terminal);
            publish();
            await running?.closed;
            return true;
        }

        function setOutputTail(id: string, lines: number): boolean {
            const terminal = terminals.find(entry => entry.session.id === id);
            if (!terminal) return false;
            terminal.session.outputTail += lines;
            publish();
            return true;
        }

        async function sendCommand(id: string, command: string): Promise<ToolResult> {
            const terminal = terminals.find(entry => entry.session.id === id)?.session;
            if (!terminal) return commandRejected('Terminal not found.');
            if (terminal.status === 'running') return commandRejected('Terminal is busy running another command.');
            const plan = planCommand(terminal.cwd, projectPath, command);
            if ('error' in plan) return commandRejected(plan.error);

            const record: CommandRecord = {
                command, status: 'running', outputLines: [],
            };
            if (plan.isCd) {
                terminal.commands.push({
                    ...record, status: 'success',
                    outputLines: ['Changed directory to ' + plan.cwd],
                });
                terminal.cwd = plan.cwd;
                const projectionWarning = publishCommand();
                return { success: true, data: { message: 'Directory changed to ' + plan.cwd + '.',
                    ...(projectionWarning ? { projectionWarning } : {}) } };
            }

            const child = spawn(command, { cwd: terminal.cwd, shell: true, env: process.env, detached: separateGroup });
            child.stdin.end();
            terminal.commands.push(record);
            terminal.status = 'running';
            const closed = new Promise<void>(resolve => child.once('close', resolve));
            const running = { child, closed, stopping: false };
            processes.set(id, running);

            function append(lines: string[]): void {
                if (running.stopping || signal.aborted || !lines.length) return;
                record.outputLines.push(...lines);
                publishCommand();
            }
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => append(splitLines(chunk)));
            child.stderr.setEncoding('utf8').on('data', (chunk: string) => append(splitLines(chunk).map(line => 'stderr: ' + line)));
            child.on('error', (error: Error) => append(['stderr: ' + error.message]));
            child.once('close', code => {
                processes.delete(id);
                if (running.stopping || signal.aborted) return;
                record.status = code === 0 ? 'success' : 'failed';
                if (code !== null) record.exitCode = code;
                terminal.status = 'idle';
                publishCommand();
                if (code !== 0) requestAttention();
            });

            const projectionWarning = publishCommand();
            const error = await new Promise<Error | undefined>(resolve => {
                child.once('spawn', () => resolve(undefined));
                child.once('error', resolve);
            });
            if (error) return commandRejected(error.message);
            return { success: true, data: { message: 'Command started in ' + id + '.',
                ...(projectionWarning ? { projectionWarning } : {}) } };
        }

        function commandRejected(message: string): ToolResult {
            return { success: false, error: { code: 'COMMAND_REJECTED', message } };
        }

        async function sendCommandNewTerminal(command: string): Promise<ToolResult> {
            const plan = planCommand(projectPath, projectPath, command);
            if ('error' in plan) return commandRejected(plan.error);
            const session: TerminalSession = {
                id: 'Session ' + (terminalCounter + 1), cwd: projectPath, status: 'idle',
                commands: [], outputTail: DEFAULT_TAIL_LINES,
            };
            const view = createView(TerminalType, { idPrefix: 'terminal' });
            const next = [...terminals, { session, view }];
            const opened = commit(() => frames(next), { mode: 'candidate' });
            if (!opened.ok) return { success: false, error: { code: opened.issue.code,
                message: 'Close a Terminal View before opening a new session.' } };
            terminals = next;
            terminalCounter++;
            const viewId = opened.viewId(view);
            if (!viewId) return { success: false, error: { code: 'TERMINAL_VIEW_MISSING', message: 'The new Terminal View was not published.' } };
            const result = await sendCommand(session.id, command);
            return result.success ? { success: true, data: { ...result.data, view_id: viewId } } : result;
        }
        publish();
    },
});
