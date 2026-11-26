import { describe, expect, it, vi } from 'vitest';
import { captureViewBindings, captureViewTypes } from '../../../sdk/src/tools/view-type-tool.js';
import { TerminalType, type TerminalActions } from '../src/tui/TerminalTools.js';
import { terminalBody } from '../src/tui/TerminalView.js';
import type { TerminalSession } from '../src/types.js';

const terminal = (id: string, status: TerminalSession['status'] = 'idle'): TerminalSession => ({
    id,
    cwd: '/project',
    status,
    commands: [],
    outputTail: 20,
});

function terminalTool(name: keyof typeof TerminalType.tools, terminal: TerminalSession, actions: Partial<TerminalActions> = {}) {
    return captureViewBindings(captureViewTypes([TerminalType]).values().next().value!, terminal.id, {
        terminal,
        onSendCommand: () => { throw Error('Unexpected send'); },
        onCloseTerminal: () => { throw Error('Unexpected close'); },
        onLoadMoreOutput: () => { throw Error('Unexpected output expansion'); },
        ...actions,
    }).find(tool => tool.name === name)!;
}

describe('Terminal View type tools', () => {
    it('shows the selected terminal identity in its current View', () => {
        const selected = terminal('terminal_9');
        expect(terminalBody(selected)).toContain(selected.id);
    });

    it('runs the same declared command against each receiving View context', async () => {
        const onSendCommand = vi.fn(async (terminalId: string) => ({ success: true as const, data: { message: 'started in ' + terminalId } }));
        const a = terminalTool('send_command_to_exist_terminal', terminal('terminal_1'), { onSendCommand });
        const b = terminalTool('send_command_to_exist_terminal', terminal('terminal_9'), { onSendCommand });
        expect((await a.execute({ command: 'pwd' })).success).toBe(true);
        expect(await b.execute({ command: 'pwd' })).toMatchObject({ success: true, data: { message: 'started in terminal_9' } });
        expect(onSendCommand.mock.calls).toEqual([['terminal_1', 'pwd'], ['terminal_9', 'pwd']]);
    });

    it('disables a busy terminal and refuses to start another command if called', async () => {
        const onSendCommand = vi.fn(async (terminalId: string) => ({ success: true as const, data: { message: terminalId } }));
        const busy = terminalTool('send_command_to_exist_terminal', terminal('terminal_busy', 'running'), { onSendCommand });
        expect(busy.enabled).toBe(false);
        expect(await busy.execute({ command: 'pwd' })).toMatchObject({ success: false, error: { code: 'COMMAND_REJECTED' } });
        expect(onSendCommand).not.toHaveBeenCalled();
    });

    it('reports an already closed terminal from the application callback', async () => {
        const liveTerminals = new Set(['terminal_open']);
        const onCloseTerminal = vi.fn(async (terminalId: string) => liveTerminals.delete(terminalId));
        const tool = terminalTool('close_terminal', terminal('terminal_open'), { onCloseTerminal });

        expect(await tool.execute({})).toMatchObject({ success: true });
        expect(await tool.execute({})).toMatchObject({ success: false, error: { code: 'TERMINAL_NOT_FOUND' } });
        expect(onCloseTerminal.mock.calls).toEqual([['terminal_open'], ['terminal_open']]);
    });
});
