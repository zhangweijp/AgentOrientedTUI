import { describe, expect, it, vi } from 'vitest';
import { createCloseTerminalBinding, createSendCommandBinding } from '../src/tui/TerminalTools.js';
import { TerminalView } from '../src/tui/TerminalView.js';
import type { TerminalSession } from '../src/types.js';

const terminal = (id: string, status: TerminalSession['status'] = 'idle'): TerminalSession => ({
    id,
    cwd: '/project',
    status,
    createdAt: '2026-11-02T00:00:00.000Z',
    commands: [],
    outputTail: 20,
});

describe('Terminal View type tools', () => {
    it('shows the terminal_id value required by the shared type-level tools', () => {
        const selected = terminal('terminal_9');
        expect(JSON.stringify(TerminalView({ terminal: selected }))).toContain(selected.id);
    });

    it('routes one shared command definition to the terminal_id selected by the Agent', async () => {
        const terminals = Array.from({ length: 10 }, (_, index) => terminal(`terminal_${index}`));
        const onSendCommand = vi.fn(async (terminalId: string) => ({ success: true, message: `started in ${terminalId}` }));
        const tool = createSendCommandBinding(terminals, onSendCommand);

        const receipt = await tool.execute({ terminal_id: 'terminal_9', command: 'pwd' });

        expect(onSendCommand).toHaveBeenCalledTimes(1);
        expect(onSendCommand).toHaveBeenCalledWith('terminal_9', 'pwd');
        expect(receipt).toMatchObject({ success: true, data: { message: 'started in terminal_9' } });
    });

    it('rejects a terminal that is busy or no longer open without dispatching the command', async () => {
        const onSendCommand = vi.fn(async (terminalId: string) => ({ success: true, message: terminalId }));
        const tool = createSendCommandBinding([terminal('terminal_busy', 'running')], onSendCommand);

        const busyReceipt = await tool.execute({ terminal_id: 'terminal_busy', command: 'pwd' });
        const closedReceipt = await tool.execute({ terminal_id: 'terminal_closed', command: 'pwd' });

        expect(onSendCommand).not.toHaveBeenCalled();
        expect(busyReceipt).toMatchObject({ success: false, error: { code: 'COMMAND_REJECTED' } });
        expect(closedReceipt).toMatchObject({ success: false, error: { code: 'TERMINAL_NOT_FOUND' } });
    });

    it('reports a closed terminal from the application callback', async () => {
        const liveTerminals = new Set(['terminal_open']);
        const onCloseTerminal = vi.fn((terminalId: string) => {
            if (!liveTerminals.delete(terminalId)) return false;
            return true;
        });
        const tool = createCloseTerminalBinding(onCloseTerminal);

        const first = await tool.execute({ terminal_id: 'terminal_open' });
        const second = await tool.execute({ terminal_id: 'terminal_open' });

        expect(first).toMatchObject({ success: true });
        expect(second).toMatchObject({ success: false, error: { code: 'TERMINAL_NOT_FOUND' } });
        expect(onCloseTerminal).toHaveBeenCalledTimes(2);
    });
});
