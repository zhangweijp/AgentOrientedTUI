/**
 * Settings Panel - Responsive Behavior Tests
 * 
 * Tests for responsive layout, viewport sizes, scrolling, and mobile behavior
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 * 
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPanel } from './SettingsPanel.js';
import { SettingsSidebar } from './SettingsSidebar.js';
import { ModelTab } from './ModelTab.js';
import { ThemeTab } from './ThemeTab.js';
import { AddProviderModal } from './AddProviderModal.js';

vi.mock('../../hooks/useProviderConfigs.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../hooks/useProviderConfigs.js')>(),
    useProviderConfigs: () => ({ providers: [], isLoading: false, error: null }),
}));
vi.mock('../../hooks/useCustomProviders.js', () => ({
    useCustomProviders: () => ({ customProviders: [], isLoading: false }),
}));
vi.mock('../../hooks/useModels.js', () => ({
    useModels: () => ({ models: [], isLoading: false }),
}));
vi.mock('../../ChatBridge.js', () => ({
    useChatBridge: () => ({ getTrpcClient: () => ({ modelRegistry: { getProviders: { query: async () => [] } } }) }),
}));

describe('Responsive Behavior', () => {
    const defaultProps = {
        isOpen: true,
        onClose: vi.fn(),
        theme: 'dark' as const,
        onThemeChange: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Panel at different viewport sizes', () => {
        it('should have minimum width constraint', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel?.className).toContain('min-w-[320px]');
        });

        it('should have maximum width constraint', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel?.className).toContain('max-w-[1100px]');
        });

        it('should have responsive margins', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel?.className).toContain('mx-4');
            expect(panel?.className).toContain('sm:mx-6');
        });

        it('should have full width', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel?.className).toContain('w-full');
        });

        it('should use flex-col on mobile and flex-row on desktop', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel?.className).toContain('flex-col');
            expect(panel?.className).toContain('md:flex-row');
        });
    });

    describe('Sidebar responsive behavior', () => {
        it('should stack horizontally on mobile', () => {
            const { container } = render(
                <SettingsSidebar activeTab="model" onTabChange={vi.fn()} />
            );

            const sidebar = container.querySelector('nav');
            expect(sidebar?.className).toContain('flex-row');
        });

        it('should stack vertically on desktop', () => {
            const { container } = render(
                <SettingsSidebar activeTab="model" onTabChange={vi.fn()} />
            );

            const sidebar = container.querySelector('nav');
            expect(sidebar?.className).toContain('md:flex-col');
        });

        it('should have full width on mobile', () => {
            const { container } = render(
                <SettingsSidebar activeTab="model" onTabChange={vi.fn()} />
            );

            const sidebar = container.querySelector('nav');
            expect(sidebar?.className).toContain('w-full');
        });

        it('should have fixed width on desktop', () => {
            const { container } = render(
                <SettingsSidebar activeTab="model" onTabChange={vi.fn()} />
            );

            const sidebar = container.querySelector('nav');
            expect(sidebar?.className).toContain('md:w-[160px]');
        });

        it('should have responsive padding', () => {
            const { container } = render(
                <SettingsSidebar activeTab="model" onTabChange={vi.fn()} />
            );

            const sidebar = container.querySelector('nav');
            expect(sidebar?.className).toContain('p-2');
            expect(screen.getByRole('tab', { name: 'Model' })).toHaveClass('px-3', 'md:px-4');
        });

        it('should have responsive button layout', () => {
            const { container } = render(<SettingsSidebar activeTab="model" onTabChange={vi.fn()} />);

            const modelButton = container.querySelector('button');
            // Should be flex-1 on mobile (equal width), flex-none on desktop
            expect(modelButton?.className).toContain('flex-1');
            expect(modelButton?.className).toContain('md:flex-none');
        });

        it('should center content on mobile, left-align on desktop', () => {
            const { container } = render(<SettingsSidebar activeTab="model" onTabChange={vi.fn()} />);

            const modelButton = container.querySelector('button');
            expect(modelButton?.className).toContain('justify-center');
            expect(modelButton?.className).toContain('md:justify-start');
        });

        it('should use readable text sizing on mobile and desktop', () => {
            const { container } = render(<SettingsSidebar activeTab="model" onTabChange={vi.fn()} />);

            const modelText = container.querySelector('span');
            expect(modelText).toHaveClass('text-[13px]');
        });

        it('should have border on bottom for mobile, right for desktop', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const sidebarContainer = container.querySelector('.flex-shrink-0');
            expect(sidebarContainer?.className).toContain('border-b');
            expect(sidebarContainer?.className).toContain('md:border-b-0');
            expect(sidebarContainer?.className).toContain('md:border-r');
        });
    });

    describe('Content area scrolling', () => {
        it('should have scrollable content area', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const contentArea = container.querySelector('.overflow-y-auto');
            expect(contentArea).toBeTruthy();
            expect(contentArea?.className).toContain('overflow-y-auto');
        });

        it('should have responsive padding in content area', () => {
            render(<SettingsPanel {...defaultProps} />);
            expect(screen.getByRole('tabpanel').parentElement).toHaveClass('p-5', 'sm:p-6');
        });

        it('should allow content to scroll when it exceeds viewport', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const contentArea = container.querySelector('.overflow-y-auto');
            expect(contentArea?.className).toContain('overflow-y-auto');
            
            // Content area should be scrollable
            expect(contentArea).toBeTruthy();
        });

        it('should keep sidebar fixed while content scrolls', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const sidebar = container.querySelector('.flex-shrink-0');
            expect(sidebar?.className).toContain('flex-shrink-0');
        });
    });

    describe('ModelTab responsive layout', () => {
        it('puts the provider search below its heading on mobile and beside it on larger screens', () => {
            render(<ModelTab />);
            const heading = screen.getByRole('heading', { name: 'Providers' });
            expect(heading).toHaveClass('text-[11px]', 'sm:text-[13px]');
            expect(heading.parentElement).toHaveClass('flex-col', 'sm:grid', 'sm:grid-cols-[1fr_auto]');
            expect(within(heading.parentElement!).getByRole('textbox', { name: 'Search providers' })).toBeInTheDocument();
        });

        it('increases the spacing between sections for larger viewports', () => {
            const { container } = render(<ModelTab />);
            expect(container.firstElementChild).toHaveClass('gap-4', 'sm:gap-5', 'md:gap-6');
        });

        it('shows model search below its heading when no provider is selected', () => {
            render(<ModelTab />);
            const heading = screen.getByRole('heading', { name: 'Models Of Provider' });
            expect(heading).toHaveClass('text-[11px]', 'sm:text-[13px]');
            expect(heading.parentElement).toHaveClass('flex-col', 'sm:grid', 'sm:grid-cols-[1fr_auto]');
            expect(within(heading.parentElement!).getByRole('textbox', { name: 'Search models' })).toBeDisabled();
        });
    });

    describe('ThemeTab responsive layout', () => {
        it('should have responsive heading size', () => {
            const { container } = render(<ThemeTab currentTheme="dark" onThemeChange={vi.fn()} />);

            const heading = container.querySelector('h2');
            expect(heading).toHaveClass('text-[22px]');
            expect(heading?.parentElement).toHaveClass('text-center', 'sm:text-left');
        });

        it('should have responsive padding', () => {
            const { container } = render(<ThemeTab currentTheme="dark" onThemeChange={vi.fn()} />);

            const mainContainer = container.querySelector('.flex-col');
            expect(mainContainer).toHaveClass('p-2', 'max-w-[800px]', 'mx-auto');
        });

        it('should use single column on mobile', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={vi.fn()} />
            );

            const grid = container.querySelector('[class*="grid-cols"]');
            expect(grid?.className).toContain('grid-cols-1');
        });

        it('should use two columns on small screens and up', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={vi.fn()} />
            );

            const grid = container.querySelector('[class*="grid-cols"]');
            expect(grid?.className).toContain('sm:grid-cols-2');
        });

        it('should have responsive gap', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={vi.fn()} />
            );

            const grid = container.querySelector('[class*="grid-cols"]');
            expect(grid).toHaveClass('gap-4');
        });

        it('should have responsive margin bottom on header', () => {
            const { container } = render(<ThemeTab currentTheme="dark" onThemeChange={vi.fn()} />);

            const header = container.querySelector('.mb-6');
            expect(header).toContainElement(screen.getByRole('heading', { name: 'Appearance' }));
        });
    });

    describe('Responsive form elements', () => {
        it('lets users open Add Provider from the normal Model settings flow', () => {
            render(<ModelTab />);
            const trigger = screen.getByRole('button', { name: 'Add new provider' });
            fireEvent.click(trigger);
            expect(screen.getByRole('dialog', { name: 'Add Provider' })).toBeInTheDocument();
        });

        it('keeps form actions aligned and reachable on narrow screens', () => {
            render(<ModelTab />);
            fireEvent.click(screen.getByRole('button', { name: 'Add new provider' }));
            const dialog = screen.getByRole('dialog', { name: 'Add Provider' });
            const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
            const submit = within(dialog).getByRole('button', { name: 'Add Provider' });
            expect(cancel.parentElement).toHaveClass('flex', 'justify-end', 'gap-3');
            expect(submit.parentElement).toBe(cancel.parentElement);
        });

        it('validates and saves through the native form submit path', async () => {
            const onSaveCustom = vi.fn(async () => {});
            const onClose = vi.fn();
            render(<AddProviderModal isOpen onClose={onClose} onSave={vi.fn(async () => {})} onSaveCustom={onSaveCustom} />);
            fireEvent.click(screen.getByRole('button', { name: 'Customize' }));

            const url = screen.getByRole('textbox', { name: /base url/i });
            const submit = screen.getByRole('button', { name: 'Create Provider' });
            fireEvent.change(screen.getByRole('textbox', { name: /provider name/i }), { target: { value: 'Local provider' } });
            fireEvent.change(url, { target: { value: 'ftp://localhost' } });
            expect(submit).toHaveAttribute('type', 'submit');
            const form = url.closest('form')!;
            expect(form).toContainElement(submit);
            fireEvent.submit(form);

            expect(onSaveCustom).not.toHaveBeenCalled();
            expect(url).toHaveAttribute('aria-invalid', 'true');
            expect(url).toHaveAccessibleDescription('Base URL must start with http:// or https://');

            fireEvent.change(url, { target: { value: 'https://localhost/v1' } });
            expect(url).not.toHaveAttribute('aria-invalid');
            fireEvent.submit(form);
            await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
            expect(onSaveCustom).toHaveBeenCalledExactlyOnceWith({
                name: 'Local provider', baseUrl: 'https://localhost/v1', protocol: 'openai', apiKey: undefined,
            });
        });
    });

    describe('Scrollable areas responsive behavior', () => {
        it('keeps the provider row horizontally scrollable and vertically constrained', () => {
            const { container } = render(<ModelTab />);
            const row = container.querySelector('.provider-row-scroll');
            expect(row).toHaveStyle({ overflowX: 'auto', overflowY: 'hidden' });
        });

        it('scales provider card gaps with the viewport', () => {
            const { container } = render(<ModelTab />);
            const row = container.querySelector('.provider-row-scroll') as HTMLElement;
            expect(row.style.gap).toBe('clamp(12px, 2vw, 16px)');
        });
    });

    describe('Layout structure', () => {
        it('should render panel with proper structure', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel).toBeTruthy();
        });

        it('should have sidebar and content area', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const sidebar = container.querySelector('nav');
            const contentArea = container.querySelector('.overflow-y-auto');

            expect(sidebar).toBeTruthy();
            expect(contentArea).toBeTruthy();
        });

        it('should maintain proper flex layout', () => {
            const { container } = render(<SettingsPanel {...defaultProps} />);

            const panel = container.querySelector('[role="dialog"] > div');
            expect(panel?.className).toContain('flex');
        });
    });
});
