import { defineViewType } from '@aotui/sdk';
import Type from 'typebox';
import type { TerminalSession } from '../types.js';

export interface TerminalActions {
    onCloseTerminal: (terminalId: string) => boolean;
    onSendCommand: (terminalId: string, command: string) => Promise<{ success: boolean; message: string }>;
    onSendCommandNewTerminal: (command: string) => Promise<{ success: boolean; terminalId?: string; message: string }>;
    onLoadMoreOutput: (terminalId: string, tailLines: number) => boolean;
}

type TerminalContext = Pick<TerminalActions, 'onCloseTerminal' | 'onSendCommand' | 'onLoadMoreOutput'>
    & { readonly terminal: TerminalSession };

const newTerminalInput = Type.Object({
    command: Type.String({ description: 'Shell command' }),
}, { additionalProperties: false });

const sendCommandInput = Type.Object({
    command: Type.String({ description: 'Shell command' }),
}, { additionalProperties: false });

const loadMoreOutputInput = Type.Object({
    tail_lines: Type.Number({ description: 'Positive number of additional lines' }),
}, { additionalProperties: false });

const closeTerminalInput = Type.Object({}, { additionalProperties: false });

export const RootType = defineViewType({ name: 'Root' });

export const TerminalConsoleType = defineViewType<Pick<TerminalActions, 'onSendCommandNewTerminal'>>()({ name: 'TerminalConsole', tools: {
        new_terminal_and_send_command: { description: 'Create a terminal and start a shell command. Inspect the new Terminal View for output and completion.',
            inputSchema: newTerminalInput,
            async execute({ input: { command }, context: { onSendCommandNewTerminal } }) {
                const result = await onSendCommandNewTerminal(command);
                return result.success && result.terminalId
                    ? { success: true, data: { message: result.message, terminal_id: result.terminalId } }
                    : { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
            },
        },
} });

export const TerminalType = defineViewType<TerminalContext>()({ name: 'Terminal', tools: {
        send_command_to_exist_terminal: { description: 'Start a shell command in this Terminal. Read that Terminal View for output and completion.',
            inputSchema: sendCommandInput,
            enabled: ({ terminal }) => terminal.status !== 'running',
            async execute({ input: { command }, context: { terminal, onSendCommand } }) {
                if (terminal.status === 'running') {
                    return { success: false, error: { code: 'COMMAND_REJECTED', message: 'Terminal is busy running another command.' } };
                }
                const result = await onSendCommand(terminal.id, command);
                return result.success
                    ? { success: true, data: { message: result.message } }
                    : { success: false, error: { code: 'COMMAND_REJECTED', message: result.message } };
            },
        },
        load_more_output: { description: 'Show more lines of output in this Terminal.',
            inputSchema: loadMoreOutputInput,
            async execute({ input: { tail_lines }, context: { terminal: { id: terminalId }, onLoadMoreOutput } }) {
                if (!Number.isSafeInteger(tail_lines) || tail_lines <= 0) {
                    return { success: false, error: { code: 'INVALID_TAIL_LINES', message: 'tail_lines must be a positive integer.' } };
                }
                return onLoadMoreOutput(terminalId, tail_lines)
                    ? { success: true, data: { message: 'Visible output expanded.' } }
                    : { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is closed.' } };
            },
        },
        close_terminal: { description: 'Close this Terminal and request termination of its active command.',
            inputSchema: closeTerminalInput,
            async execute({ context: { terminal: { id: terminalId }, onCloseTerminal } }) {
                return onCloseTerminal(terminalId)
                    ? { success: true, data: { message: 'Terminal closed; its current View and tools are removed.' } }
                    : { success: false, error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal is already closed.' } };
            },
        },
} });

export const terminalViewTypes = [RootType, TerminalConsoleType, TerminalType] as const;
