import { createTUIApp, View, useCallback, useMemo, useRef, useState, useAppRuntimeContext } from '@aotui/sdk';
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

function TerminalRoot() {
    const envProjectPath = useAppRuntimeContext().launchConfig?.projectPath as string | undefined;
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

    const addTerminal = useCallback((initialPath?: string) => {
        const terminalId = `terminal_${terminalCounter.current++}`;
        const nextCwd = resolveNextCwd(projectPath, projectPath, initialPath);
        const safeCwd = isPathWithinProject(projectPath, nextCwd) ? nextCwd : projectPath;
        const terminal: TerminalSession = {
            id: terminalId,
            cwd: safeCwd,
            status: 'idle',
            createdAt: new Date().toISOString(),
            commands: [],
            outputTail: DEFAULT_TAIL_LINES
        };
        setTerminals([...terminalsRef.current, terminal]);
        return terminal;
    }, [projectPath, setTerminals]);

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
        if (hasChainedCd(command)) {
            return { success: false, message: 'Chained cd commands are not supported.' };
        }
        const cdResult = parseCdCommand(command);
        if (cdResult.isCd) {
            const nextCwd = resolveNextCwd(terminal.cwd, projectPath, cdResult.target);
            if (!isPathWithinProject(projectPath, nextCwd)) {
                return { success: false, message: 'Target path is outside projectPath.' };
            }
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

        if (!isPathWithinProject(projectPath, terminal.cwd)) {
            return { success: false, message: 'Terminal working directory is outside projectPath.' };
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
            processMap.current.delete(commandId);
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
        });

        return { success: true, message: `Command started in ${terminalId}.` };
    }, [commandCounter, projectPath, updateCommandOutput, updateTerminal]);

    const sendCommandNewTerminal = useCallback(async (command: string) => {
        const terminal = addTerminal();
        const result = await sendCommand(terminal.id, command);
        if (!result.success) {
            closeTerminal(terminal.id);
            return { success: false, message: result.message };
        }
        return { success: true, terminalId: terminal.id, message: result.message };
    }, [addTerminal, closeTerminal, sendCommand]);

    return (
        <>
            <View kind="instruction" id="root" type={RootType} name="Root">
                <RootView />
            </View>
            <View kind="state" id="term_console" type={TerminalConsoleType} context={{ onSendCommandNewTerminal: sendCommandNewTerminal }} name="TerminalConsole">
                <TerminalConsoleView projectPath={projectPath} terminals={terminals} />
            </View>
            {terminals.map((terminal: TerminalSession) => (
                <View kind="state" key={terminal.id} id={terminal.id} type={TerminalType} context={{ terminal, onSendCommand: sendCommand, onLoadMoreOutput: setOutputTail, onCloseTerminal: closeTerminal }} name={`Terminal ${terminal.id}`}>
                    <TerminalView terminal={terminal} />
                </View>
            ))}
        </>
    );
}

export default createTUIApp({
    app_name: 'terminal',
    whatItIs: 'A multi-terminal shell application with command history, working directory tracking, and output tailing for LLM workflows.',
    whenToUse: 'Run shell commands in the project workspace, manage terminal sessions, and inspect command status and output.',
    component: TerminalRoot,
    viewTypes: terminalViewTypes,
});
