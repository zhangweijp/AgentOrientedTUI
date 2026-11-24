import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AddProviderModal } from '../../../src/gui/components/settings/AddProviderModal.js';
import { SettingsPanel } from '../../../src/gui/components/settings/SettingsPanel.js';
import { SettingsSidebar } from '../../../src/gui/components/settings/SettingsSidebar.js';
import { ThemeTab } from '../../../src/gui/components/settings/ThemeTab.js';

vi.mock('../../../src/gui/ChatBridge.js', () => {
    const bridge = { getTrpcClient: () => ({ modelRegistry: {
        getProviders: { query: async () => [
            { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', modelCount: 1 },
        ] },
        getModels: { query: async () => [{ id: 'gpt-4o' }] },
    } }) };
    return { useChatBridge: () => bridge };
});

describe('Settings accessibility', () => {
    it('names the settings dialog and closes it with Escape', () => {
        const onClose = vi.fn();
        render(<SettingsPanel isOpen initialTab="theme" onClose={onClose} theme="dark" onThemeChange={vi.fn()} />);

        const dialog = screen.getByRole('dialog', { name: 'Settings Panel' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(within(dialog).getByRole('button', { name: 'Exit settings panel' })).toBeInTheDocument();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('focuses the first tab on open and keeps Tab and Shift+Tab within the dialog', async () => {
        const panel = (isOpen: boolean) => (
            <SettingsPanel isOpen={isOpen} initialTab="theme" onClose={vi.fn()} theme="dark" onThemeChange={vi.fn()} />
        );
        const { rerender } = render(panel(false));
        rerender(panel(true));

        const first = screen.getAllByRole('tab')[0];
        const last = screen.getByRole('radio', { name: 'Light theme' });
        await waitFor(() => expect(first).toHaveFocus());
        fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
        expect(last).toHaveFocus();
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(first).toHaveFocus();
    });

    it('names the navigation tabs and identifies the selected tab and its panel', () => {
        render(<SettingsSidebar activeTab="model" onTabChange={vi.fn()} />);

        const tabs = screen.getByRole('tablist', { name: 'Settings navigation' });
        const model = within(tabs).getByRole('tab', { name: /model/i, selected: true });
        const theme = within(tabs).getByRole('tab', { name: /theme/i, selected: false });
        expect(model).toHaveAttribute('aria-controls', 'model-tab-panel');
        expect(theme).toHaveAttribute('aria-controls', 'theme-tab-panel');
    });

    it.each(['Enter', ' '])('selects a named theme with %j', key => {
        const onThemeChange = vi.fn();
        render(<ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />);

        const group = screen.getByRole('radiogroup', { name: 'Theme selection' });
        expect(within(group).getByRole('radio', { name: 'Dark theme', checked: true })).toBeInTheDocument();
        const light = within(group).getByRole('radio', { name: 'Light theme', checked: false });
        fireEvent.keyDown(light, { key });
        expect(onThemeChange).toHaveBeenCalledExactlyOnceWith('light');
    });

    it('announces when settings open and close', () => {
        const panel = (isOpen: boolean) => (
            <SettingsPanel isOpen={isOpen} initialTab="theme" onClose={vi.fn()} theme="dark" onThemeChange={vi.fn()} />
        );
        const { rerender } = render(panel(true));
        expect(screen.getByText('Settings panel opened')).toHaveAttribute('aria-live', 'polite');
        rerender(panel(false));
        expect(screen.getByText('Settings panel closed')).toHaveAttribute('aria-live', 'polite');
    });

    it('names the provider modal and its template controls', async () => {
        const onClose = vi.fn();
        render(<AddProviderModal isOpen onClose={onClose} onSave={vi.fn()} />);

        const dialog = screen.getByRole('dialog', { name: 'Add Provider' });
        const provider = within(dialog).getByRole('button', { name: 'Provider *' });
        await waitFor(() => expect(provider).toBeEnabled());
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(provider).toHaveAttribute('aria-haspopup', 'listbox');
        expect(within(dialog).getByRole('textbox', { name: 'Display Name *' })).toBeInTheDocument();
        expect(within(dialog).getByLabelText('API Key *')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Close modal' })).toBeInTheDocument();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('announces validation errors from the current provider form', async () => {
        const onSave = vi.fn();
        render(<AddProviderModal isOpen onClose={vi.fn()} onSave={onSave} />);

        const provider = screen.getByRole('button', { name: 'Provider *' });
        await waitFor(() => expect(provider).toBeEnabled());
        fireEvent.click(provider);
        fireEvent.click(screen.getByRole('option', { name: /openai/i }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Display Name *' }), { target: { value: 'ab' } });
        fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'sk-fixture-key' } });
        const submit = screen.getByRole('button', { name: 'Add Provider' });
        await waitFor(() => expect(submit).toBeEnabled());
        fireEvent.click(submit);

        expect(screen.getByRole('alert')).toHaveTextContent('Custom name must be at least 3 characters');
        expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'assertive');
        expect(screen.getByRole('status')).toHaveTextContent('Custom name must be at least 3 characters');
        expect(onSave).not.toHaveBeenCalled();
    });
});
