import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AgentMcpEditor } from '../../../src/gui/components/settings/agent/AgentMcpEditor.js';

const mockRef = vi.hoisted(() => ({
    bridge: null as any,
}));

vi.mock('../../../src/gui/ChatBridge.js', () => ({
    useChatBridge: () => mockRef.bridge,
}));

function createBridgeWithMcpData() {
    return {
        getTrpcClient: vi.fn().mockReturnValue({
            mcp: {
                getRuntime: {
                    query: vi.fn().mockResolvedValue({
                        'server-a': {
                            status: 'connected',
                            tools: [{ name: 'search', description: 'search a', enabled: true }],
                        },
                        'server-b': {
                            status: 'connected',
                            tools: [{ name: 'search', description: 'search b', enabled: true }],
                        },
                    }),
                },
            },
        }),
    };
}

describe('AgentMcpEditor tool-key persistence', () => {
    beforeEach(() => {
        mockRef.bridge = createBridgeWithMcpData();
    });

    it('saves disabled tool with server-scoped key when duplicate tool names exist', async () => {
        const onSave = vi.fn();
        const onClose = vi.fn();

        render(
            <AgentMcpEditor
                isOpen={true}
                onClose={onClose}
                value={['server-a', 'server-b']}
                disabledTools={[]}
                onSave={onSave}
            />,
        );

        await waitFor(() => expect(screen.queryByText('Loading MCP servers...')).not.toBeInTheDocument());

        const serverADetails = screen.getByText('server-a').closest('details');
        expect(serverADetails).toBeTruthy();
        const serverARegion = within(serverADetails as HTMLElement);

        const searchLabelInServerA = serverARegion.getByText('search').closest('label');
        expect(searchLabelInServerA).toBeTruthy();
        const searchSwitchInServerA = within(searchLabelInServerA as HTMLElement).getByRole('switch');

        fireEvent.click(searchSwitchInServerA);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onSave).toHaveBeenCalledTimes(1);
        const [enabledMCPs, disabledMcpTools] = onSave.mock.calls[0];
        expect(enabledMCPs).toEqual(expect.arrayContaining(['server-a', 'server-b']));
        expect(disabledMcpTools).toContain('mcp-server-a-search');
        expect(disabledMcpTools).not.toContain('mcp-server-b-search');
        expect(disabledMcpTools).not.toContain('search');
    });

    it('keeps MCP off when saving an Agent with ambiguous tool permissions', async () => {
        const onSave = vi.fn();

        render(
            <AgentMcpEditor
                isOpen={true}
                onClose={vi.fn()}
                value={['server-a', 'server-b']}
                disabledTools={['search']}
                onSave={onSave}
            />,
        );

        await waitFor(() => expect(screen.queryByText('Loading MCP servers...')).not.toBeInTheDocument());
        expect(screen.getByRole('alert')).toHaveTextContent('Select servers and tools again and save.');
        for (const label of ['server-a', 'server-b']) {
            const server = screen.getByText(label).closest('summary') as HTMLElement;
            expect(within(server).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
        }
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledExactlyOnceWith([], []);
    });
});
