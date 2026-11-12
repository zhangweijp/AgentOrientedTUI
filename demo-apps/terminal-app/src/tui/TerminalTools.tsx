import { defineViewTypeTool, defineToolSet, type ArgsOf, type ToolBinding } from '@aotui/sdk';
import Type from 'typebox';
import type { TerminalSession } from '../types.js';

export interface TerminalActions {
    onCloseTerminal: (terminalId: string) => boolean;
    onSendCommand: (terminalId: string, command: string) => Promise<{ success: boolean; message: string }>;
    onSendCommandNewTerminal: (command: string) => Promise<{ success: boolean; terminalId?: string; message: string }>;
    onLoadMoreOutput: (terminalId: string, tailLines: number) => boolean;
}

const newTerminalInput = Type.Object({
    command: Type.String({ description: 'Shell command' }),
}, { additionalProperties: false });

const terminalId = Type.String({ description: 'Terminal ID shown in the current Terminal Views.' });

const sendCommandInput = Type.Object({
    terminal_id: terminalId,
    command: Type.String({ description: 'Shell command' }),
}, { additionalProperties: false });

const loadMoreOutputInput = Type.Object({
    terminal_id: terminalId,
    tail_lines: Type.Number({ description: 'Positive number of additional lines' }),
}, { additionalProperties: false });

const closeTerminalInput = Type.Object({
    terminal_id: terminalId,
}, { additionalProperties: false });

export function createNewTerminalBinding(onSendCommandNewTerminal: TerminalActions['onSendCommandNewTerminal']) {
    return ({ execute: async ({ command }: ArgsOf<typeof terminalTools.newTerminal>) => {
            const result = await onSendCommandNewTerminal(command);
            return result.success && result.terminalId
                ? { success: true, data: { message: result.message, terminal_id: result.terminalId } }
                : { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
        } } satisfies ToolBinding<typeof terminalTools.newTerminal>);
}

export function createSendCommandBinding(terminals: TerminalSession[], onSendCommand: TerminalActions['onSendCommand']) {
    return ({ execute: async ({ terminal_id, command }: ArgsOf<typeof terminalTools.sendCommand>) => {
            const terminal = terminals.find(item => item.id === terminal_id);
            if (!terminal) {
                return { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is closed or was not shown. Observe the current Terminal Views and try again.' } };
            }
            if (terminal.status === 'running') {
                return { success: false, error: { code: 'COMMAND_REJECTED', message: 'Terminal is busy running another command.' } };
            }
            const result = await onSendCommand(terminal.id, command);
            return result.success
                ? { success: true, data: { message: result.message } }
                : { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
        } } satisfies ToolBinding<typeof terminalTools.sendCommand>);
}

export function createLoadMoreOutputBinding(onLoadMoreOutput: TerminalActions['onLoadMoreOutput']) {
    return ({ execute: async ({ terminal_id, tail_lines }: ArgsOf<typeof terminalTools.loadMoreOutput>) => {
            if (!Number.isSafeInteger(tail_lines) || tail_lines <= 0) {
                return { success: false, error: { code: 'INVALID_TAIL_LINES', message: 'tail_lines must be a positive integer.' } };
            }
            return onLoadMoreOutput(terminal_id, tail_lines)
                ? { success: true, data: { message: 'Visible output expanded.' } }
                : { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is closed.' } };
        } } satisfies ToolBinding<typeof terminalTools.loadMoreOutput>);
}

export function createCloseTerminalBinding(onCloseTerminal: TerminalActions['onCloseTerminal']) {
    return ({ execute: async ({ terminal_id }: ArgsOf<typeof terminalTools.closeTerminal>) => {
            return onCloseTerminal(terminal_id)
                ? { success: true, data: { message: 'Terminal closed; its current View and tools are removed.' } }
                : { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is already closed.' } };
        } } satisfies ToolBinding<typeof terminalTools.closeTerminal>);
}

export const terminalTools = defineToolSet({
newTerminal: defineViewTypeTool({
        viewType: 'TerminalConsole',
        name: 'new_terminal_and_send_command',
        description: 'Create a terminal and start a shell command. Inspect the new Terminal View for output and completion.',
        inputSchema: newTerminalInput,
    }),
sendCommand: defineViewTypeTool({
        viewType: 'Terminal',
        name: 'send_command_to_exist_terminal',
        description: 'Start a shell command in the Terminal selected by terminal_id. Read that Terminal View for output and completion.',
        inputSchema: sendCommandInput,
    }),
loadMoreOutput: defineViewTypeTool({
        viewType: 'Terminal',
        name: 'load_more_output',
        description: 'Show more lines of output in the Terminal selected by terminal_id.',
        inputSchema: loadMoreOutputInput,
    }),
closeTerminal: defineViewTypeTool({
        viewType: 'Terminal',
        name: 'close_terminal',
        description: 'Close the Terminal selected by terminal_id and request termination of its active command.',
        inputSchema: closeTerminalInput,
    })
});
