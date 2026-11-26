import { describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';
import { render, fireEvent, within } from '@testing-library/react';
import { SettingsPanel } from './SettingsPanel.js';

const themes = fc.constantFrom('dark' as const, 'light' as const);
const tabs = fc.constantFrom('agent' as const, 'model' as const, 'theme' as const);
const renderPanel = (theme: 'dark' | 'light', initialTab: 'agent' | 'model' | 'theme', isOpen = true) => {
    const onClose = vi.fn();
    const panel = render(<SettingsPanel isOpen={isOpen} onClose={onClose} theme={theme} onThemeChange={vi.fn()} initialTab={initialTab} />);
    return { ...panel, onClose, queries: within(panel.container) };
};

describe('SettingsPanel closure across themes and tabs', () => {
    it('closes when clicking the backdrop', () => {
        fc.assert(fc.property(themes, tabs, (theme, tab) => {
            const panel = renderPanel(theme, tab);
            try {
                fireEvent.click(panel.queries.getByRole('dialog'));
                expect(panel.onClose).toHaveBeenCalledOnce();
            } finally { panel.unmount(); }
        }));
    });

    it('closes when pressing Escape', () => {
        fc.assert(fc.property(themes, tabs, (theme, tab) => {
            const panel = renderPanel(theme, tab);
            try {
                fireEvent.keyDown(panel.queries.getByRole('dialog'), { key: 'Escape' });
                expect(panel.onClose).toHaveBeenCalledOnce();
            } finally { panel.unmount(); }
        }));
    });

    it('keeps the dialog open when clicking the content', () => {
        fc.assert(fc.property(themes, tabs, (theme, tab) => {
            const panel = renderPanel(theme, tab);
            try {
                fireEvent.click(panel.queries.getByRole('tabpanel'));
                expect(panel.onClose).not.toHaveBeenCalled();
            } finally { panel.unmount(); }
        }));
    });

    it('closes when clicking the named exit button', () => {
        fc.assert(fc.property(themes, tabs, (theme, tab) => {
            const panel = renderPanel(theme, tab);
            try {
                fireEvent.click(panel.queries.getByRole('button', { name: 'Exit settings panel' }));
                expect(panel.onClose).toHaveBeenCalledOnce();
            } finally { panel.unmount(); }
        }));
    });

    it('does not render a dialog while closed', () => {
        fc.assert(fc.property(themes, tabs, (theme, tab) => {
            const panel = renderPanel(theme, tab, false);
            try {
                expect(panel.queries.queryByRole('dialog')).not.toBeInTheDocument();
            } finally { panel.unmount(); }
        }));
    });
});
