/**
 * ThemeTab Component - Unit Tests
 * 
 * Tests for theme card rendering and theme selection
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeTab } from './ThemeTab.js';

describe('ThemeTab', () => {
    describe('theme card rendering', () => {
        it('should render both dark and light theme cards', () => {
            const onThemeChange = vi.fn();
            render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );

            // Check that both theme names are present
            expect(screen.getByText('Dark')).toBeInTheDocument();
            expect(screen.getByText('Light')).toBeInTheDocument();
        });

        it('should render header with title and description', () => {
            const onThemeChange = vi.fn();
            render(<ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />);

            expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
            expect(screen.getByText('Choose your preferred interface theme')).toBeInTheDocument();
        });

        it('should mark dark theme as active when currentTheme is dark', () => {
            const onThemeChange = vi.fn();
            render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );

            const card = screen.getByRole('radio', { name: 'Dark theme', checked: true });
            expect(card).toHaveClass('border-[var(--color-accent)]');
        });

        it('should mark light theme as active when currentTheme is light', () => {
            const onThemeChange = vi.fn();
            render(
                <ThemeTab currentTheme="light" onThemeChange={onThemeChange} />
            );

            const card = screen.getByRole('radio', { name: 'Light theme', checked: true });
            expect(card).toHaveClass('border-[var(--color-accent)]');
        });
    });

    describe('theme selection', () => {
        it('should call onThemeChange with "dark" when dark theme card is clicked', () => {
            const onThemeChange = vi.fn();
            render(<ThemeTab currentTheme="light" onThemeChange={onThemeChange} />);

            // Click the dark theme card
            const darkCard = screen.getByRole('radio', { name: 'Dark theme' });
            fireEvent.click(darkCard);

            expect(onThemeChange).toHaveBeenCalledWith('dark');
            expect(onThemeChange).toHaveBeenCalledTimes(1);
        });

        it('should call onThemeChange with "light" when light theme card is clicked', () => {
            const onThemeChange = vi.fn();
            render(<ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />);

            // Click the light theme card
            const lightCard = screen.getByRole('radio', { name: 'Light theme' });
            fireEvent.click(lightCard);

            expect(onThemeChange).toHaveBeenCalledWith('light');
            expect(onThemeChange).toHaveBeenCalledTimes(1);
        });

        it('should allow clicking the currently active theme', () => {
            const onThemeChange = vi.fn();
            render(<ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />);

            // Click the already active dark theme card
            const darkCard = screen.getByRole('radio', { name: 'Dark theme' });
            fireEvent.click(darkCard);

            // Should still call the handler (even though it's already active)
            expect(onThemeChange).toHaveBeenCalledWith('dark');
            expect(onThemeChange).toHaveBeenCalledTimes(1);
        });
    });

    describe('layout and styling', () => {
        it('should render cards in a grid layout', () => {
            const onThemeChange = vi.fn();
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );

            // Check for grid layout
            const grid = container.querySelector('.grid');
            expect(grid).toBeInTheDocument();
            expect(grid).toHaveClass('grid-cols-1', 'sm:grid-cols-2');
        });

        it('should apply transition animation classes', () => {
            const onThemeChange = vi.fn();
            render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );

            expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveClass('transition-all', 'duration-200');
        });
    });
});
