import { defineParams, useViewTypeTool } from '@aotui/sdk';
import type { TerminalSession } from '../types.js';

export interface TerminalActions {
    onCloseTerminal: (terminalId: string) => boolean;
    onSendCommand: (terminalId: string, command: string) => Promise<{ success: boolean; message: string }>;
    onSendCommandNewTerminal: (command: string) => Promise<{ success: boolean; terminalId?: string; message: string }>;
    onLoadMoreOutput: (terminalId: string, tailLines: number) => boolean;
}

export function TerminalConsoleTools({ onSendCommandNewTerminal }: Pick<TerminalActions, 'onSendCommandNewTerminal'>) {
    useViewTypeTool('new_terminal_and_send_command', {
        description: 'Create a terminal and start a shell command. Inspect the new Terminal View for output and completion.',
        params: defineParams({ command: { type: 'string', required: true, desc: 'Shell command' } }),
        isMutating: true,
    }, async ({ command }) => {
        const result = await onSendCommandNewTerminal(command);
        return result.success && result.terminalId
            ? { success: true, data: { message: result.message, terminal_id: result.terminalId } }
            : { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
    });
    return null;
}

export function TerminalTools({ terminal, onSendCommand, onCloseTerminal, onLoadMoreOutput }:
    { terminal: TerminalSession } & Omit<TerminalActions, 'onSendCommandNewTerminal'>) {
    const target = { param: 'terminal_id', value: terminal.id };
    const terminalParam = { terminal_id: { type: 'string' as const, required: true, desc: 'Terminal ID from the current Terminal View' } };
    useViewTypeTool('send_command_to_exist_terminal', {
        target,
        description: 'Start a shell command in this Terminal. Read this View for output and completion.',
        params: defineParams({ ...terminalParam, command: { type: 'string', required: true, desc: 'Shell command' } }),
        isMutating: true,
    }, async ({ command }) => {
        const result = await onSendCommand(terminal.id, command);
        return result.success
            ? { success: true, data: { message: result.message } }
            : { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
    }, { enabled: terminal.status !== 'running' });
    useViewTypeTool('load_more_output', {
        target,
        description: 'Show more lines of the current command output in this Terminal View.',
        params: defineParams({ ...terminalParam, tail_lines: { type: 'number', required: true, desc: 'Positive number of additional lines' } }),
        isMutating: true,
    }, async ({ tail_lines }) => {
        if (!Number.isSafeInteger(tail_lines) || tail_lines <= 0) {
            return { success: false, error: { code: 'INVALID_TAIL_LINES', message: 'tail_lines must be a positive integer.' } };
        }
        return onLoadMoreOutput(terminal.id, tail_lines)
            ? { success: true, data: { message: 'Visible output expanded.' } }
            : { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is closed.' } };
    });
    useViewTypeTool('close_terminal', {
        target,
        description: 'Close this Terminal and request termination of its active command.',
        params: defineParams(terminalParam), isMutating: true,
    }, async () => onCloseTerminal(terminal.id)
        ? { success: true, data: { message: 'Terminal closed; its current View and tools are removed.' } }
        : { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is already closed.' } });
    return null;
}
