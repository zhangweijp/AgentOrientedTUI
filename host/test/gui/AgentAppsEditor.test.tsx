import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentAppsEditor } from '../../src/gui/components/settings/agent/AgentAppsEditor.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../src/gui/ChatBridge.js', () => {
    const bridge = { getTrpcClient: () => ({ apps: { getConfig: { query } } }) };
    return { useChatBridge: () => bridge };
});
vi.mock('../../src/gui/components/settings/agent/AgentEditorModal.js', () => ({
    AgentEditorModal: ({ children, footer }: any) => <div>{children}{footer}</div>,
}));
afterEach(cleanup);

describe('Agent application selection identity', () => {
    it('displays a label but persists the registry key, retaining other references', async () => {
        query.mockResolvedValue({ system_ide: { name: 'Friendly IDE', source: 'local:/apps/ide' } });
        const save = vi.fn();
        render(<AgentAppsEditor isOpen onClose={() => {}} value={['uninstalled-app']} onSave={save} />);
        await waitFor(() => expect(screen.getByText('Friendly IDE')).toBeInTheDocument());
        expect(screen.getByRole('status')).toHaveTextContent('Unavailable app references: uninstalled-app');
        fireEvent.click(screen.getAllByRole('switch')[1]);
        fireEvent.click(screen.getByText('Save'));
        expect(save).toHaveBeenCalledWith(['uninstalled-app', 'system_ide']);
    });
});
