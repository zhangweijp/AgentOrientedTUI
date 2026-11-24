import pkg from '../../package.json' with { type: 'json' };
import { createTUIApp, useCallback, useMemo, useRef, useState, useAppRuntimeContext, type ToolResult } from '@aotui/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import { RootView } from './RootView.js';
import { TerminalConsoleView } from './TerminalConsoleView.js';
import { TerminalView } from './TerminalView.js';
import {
    RootType, TerminalType, TerminalConsoleType, terminalViewTypes,
} from './TerminalTools.js';
import type { TerminalSession, CommandRecord, CommandStatus } from '../types.js';
import {
    DEFAULT_TAIL_LINES,
    hasChainedCd,
    isPathWithinProject,
    parseCdCommand,
    resolveNextCwd,
    splitLines
} from '../core/terminal-utils.js';

function createCommand(commandId: string, command: string): CommandRecord {
    return {
        id: commandId,
        command,
        status: 'running',
        startedAt: new Date().toISOString(),
        outputLines: []
    };
}

function planCommand(cwd: string, projectPath: string, command: string): { isCd: boolean; cwd: string } | { error: string } {
    if (hasChainedCd(command)) return { error: 'Chained cd commands are not supported.' };
    const { isCd, target } = parseCdCommand(command);
    const nextCwd = isCd ? resolveNextCwd(cwd, projectPath, target) : cwd;
    if (!isPathWithinProject(projectPath, nextCwd)) return {
        error: isCd ? 'Target path is outside projectPath.' : 'Terminal working directory is outside projectPath.',
    };
    return { isCd, cwd: nextCwd };
}

function TerminalRoot() {
    const { launchConfig, prepareOpeningProjection, readPreparedViewId, requestAttention } = useAppRuntimeContext();
    const envProjectPath = launchConfig?.projectPath as string | undefined;
    const projectPath = useMemo(() => envProjectPath || os.homedir(), [envProjectPath]);
    const terminalsRef = useRef<TerminalSession[]>([]);
    const [terminals, renderTerminals] = useState(terminalsRef.current);
    const terminalCounter = useRef(0);
    const commandCounter = useRef(0);
    const processMap = useRef(new Map<string, ChildProcessWithoutNullStreams>());

    const setTerminals = useCallback((next: TerminalSession[]) => {
        terminalsRef.current = next;
        renderTerminals(next);
    }, []);

    const updateTerminal = useCallback((terminalId: string, updater: (terminal: TerminalSession) => TerminalSession) => {
        setTerminals(terminalsRef.current.map(terminal => terminal.id === terminalId ? updater(terminal) : terminal));
    }, [setTerminals]);

    const closeTerminal = useCallback((terminalId: string) => {
        const target = terminalsRef.current.find((terminal: TerminalSession) => terminal.id === terminalId);
        if (!target) {
            return false;
        }
        if (target.activeCommandId) {
            const proc = processMap.current.get(target.activeCommandId);
            if (proc) {
                proc.kill();
                processMap.current.delete(target.activeCommandId);
            }
        }
        setTerminals(terminalsRef.current.filter(terminal => terminal.id !== terminalId));
        return true;
    }, [setTerminals]);

    const setOutputTail = useCallback((terminalId: string, tailLines: number) => {
        const normalized = Number.isFinite(tailLines) ? Math.max(1, Math.floor(tailLines)) : DEFAULT_TAIL_LINES;
        const target = terminalsRef.current.find((terminal: TerminalSession) => terminal.id === terminalId);
        if (!target) {
            return false;
        }
        updateTerminal(terminalId, (terminal: TerminalSession) => ({ ...terminal, outputTail: terminal.outputTail + normalized }));
        return true;
    }, [updateTerminal]);

    const updateCommandOutput = useCallback((terminalId: string, commandId: string, lines: string[]) => {
        if (lines.length === 0) {
            return;
        }
        updateTerminal(terminalId, (terminal: TerminalSession) => {
            const nextCommands = terminal.commands.map((command: CommandRecord) => {
                if (command.id !== commandId) {
                    return command;
                }
                return { ...command, outputLines: [...command.outputLines, ...lines] };
            });
            return { ...terminal, commands: nextCommands };
        });
    }, [updateTerminal]);

    const sendCommand = useCallback(async (terminalId: string, command: string) => {
        const terminal = terminalsRef.current.find(item => item.id === terminalId);
        if (!terminal) {
            return { success: false, message: 'Terminal not found.' };
        }
        if (terminal.status === 'running') {
            return { success: false, message: 'Terminal is busy running another command.' };
        }
        const plan = planCommand(terminal.cwd, projectPath, command);
        if ('error' in plan) return { success: false, message: plan.error };
        if (plan.isCd) {
            const nextCwd = plan.cwd;
            const commandId = `cmd_${commandCounter.current++}`;
            updateTerminal(terminalId, (current: TerminalSession) => ({
                ...current,
                cwd: nextCwd,
                commands: [
                    ...current.commands,
                    {
                        id: commandId,
                        command,
                        status: 'success',
                        startedAt: new Date().toISOString(),
                        finishedAt: new Date().toISOString(),
                        outputLines: [`Changed directory to ${nextCwd}`]
                    }
                ],
                activeCommandId: undefined,
                status: 'idle'
            }));
            return { success: true, message: `Directory changed to ${nextCwd}.` };
        }

        const commandId = `cmd_${commandCounter.current++}`;
        updateTerminal(terminalId, (current: TerminalSession) => ({
            ...current,
            status: 'running',
            activeCommandId: commandId,
            commands: [...current.commands, createCommand(commandId, command)]
        }));

        const proc = spawn(command, {
            cwd: terminal.cwd,
            shell: true,
            env: process.env
        }) as ChildProcessWithoutNullStreams;

        processMap.current.set(commandId, proc);

        proc.stdout.on('data', (data: Buffer) => {
            updateCommandOutput(terminalId, commandId, splitLines(data.toString()));
        });
        proc.stderr.on('data', (data: Buffer) => {
            const lines = splitLines(data.toString()).map(line => `stderr: ${line}`);
            updateCommandOutput(terminalId, commandId, lines);
        });

        proc.on('close', (code: number | null) => {
            if (!processMap.current.delete(commandId)) return;
            updateTerminal(terminalId, (current: TerminalSession) => {
                const status: CommandStatus = code === 0 ? 'success' : 'failed';
                const nextCommands = current.commands.map((item: CommandRecord) => {
                    if (item.id !== commandId) {
                        return item;
                    }
                    return {
                        ...item,
                        status,
                        finishedAt: new Date().toISOString(),
                        exitCode: code ?? undefined
                    };
                });
                return {
                    ...current,
                    status: 'idle',
                    activeCommandId: undefined,
                    commands: nextCommands
                };
            });
            if (code !== 0) requestAttention();
        });

        return { success: true, message: `Command started in ${terminalId}.` };
    }, [commandCounter, projectPath, requestAttention, updateCommandOutput, updateTerminal]);

    const sendCommandNewTerminal = useCallback(async (command: string): Promise<ToolResult> => {
        const plan = planCommand(projectPath, projectPath, command);
        if ('error' in plan) return { success: false, error: { code: 'COMMAND_REJECTED', message: plan.error } };
        const terminal: TerminalSession = {
            id: `Session ${++terminalCounter.current}`, cwd: projectPath, status: 'idle',
            createdAt: new Date().toISOString(), commands: [], outputTail: DEFAULT_TAIL_LINES,
        };
        try {
            await prepareOpeningProjection(
                () => setTerminals([...terminalsRef.current, terminal]),
                () => { closeTerminal(terminal.id); },
            );
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'OBSERVATION_CAPACITY') {
                return { success: false, error: { code: error.code, message: 'Close a Terminal View before opening a new session.' } };
            }
            throw error;
        }
        const viewId = readPreparedViewId(TerminalType.name, terminal.id);
        if (!viewId) {
            closeTerminal(terminal.id);
            return { success: false, error: { code: 'TERMINAL_VIEW_MISSING', message: 'The new Terminal View was not published.' } };
        }
        const result = await sendCommand(terminal.id, command);
        if (!result.success) {
            closeTerminal(terminal.id);
            return { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
        }
        return { success: true, data: { view_id: viewId, message: result.message } };
    }, [closeTerminal, prepareOpeningProjection, projectPath, readPreparedViewId, sendCommand, setTerminals]);

    return (
        <>
            <RootType id="root" name="Root">
                <RootView />
            </RootType>
            <TerminalConsoleType id="term_console" context={{ onSendCommandNewTerminal: sendCommandNewTerminal }} name="TerminalConsole">
                <TerminalConsoleView projectPath={projectPath} terminals={terminals} />
            </TerminalConsoleType>
            {terminals.map((terminal: TerminalSession) => (
                <TerminalType key={terminal.id} idPrefix="terminal" context={{ terminal, onSendCommand: sendCommand, onLoadMoreOutput: setOutputTail, onCloseTerminal: closeTerminal }} name={terminal.id}>
                    <TerminalView terminal={terminal} />
                </TerminalType>
            ))}
        </>
    );
}

export default createTUIApp({
    ...pkg.aotui,
    component: TerminalRoot,
    viewTypes: terminalViewTypes,
});
