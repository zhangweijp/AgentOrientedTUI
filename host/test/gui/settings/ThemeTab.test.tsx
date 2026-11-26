/**
 * ThemeTab Component - Unit Tests
 * 
 * Tests for ThemeTab component rendering and theme selection
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeTab } from '../../../src/gui/components/settings/ThemeTab.js';

describe('ThemeTab', () => {
    describe('theme card rendering', () => {
        it('should render both dark and light theme cards', () => {
            render(<ThemeTab currentTheme="dark" onThemeChange={() => {}} />);
            
            expect(screen.getByText('Dark')).toBeTruthy();
            expect(screen.getByText('Light')).toBeTruthy();
        });

        it('should render header with title', () => {
            render(<ThemeTab currentTheme="dark" onThemeChange={() => {}} />);
            
            expect(screen.getByText('Appearance')).toBeTruthy();
        });

        it('should render header with description', () => {
            render(<ThemeTab currentTheme="dark" onThemeChange={() => {}} />);
            
            expect(screen.getByText('Choose your preferred interface theme')).toBeTruthy();
        });

        it('should mark dark theme as active when currentTheme is dark', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            // Find the dark theme card (first card)
            const cards = container.querySelectorAll('[role="radio"]');
            const darkCard = cards[0] as HTMLElement;
            
            expect(darkCard.getAttribute('aria-checked')).toBe('true');
        });

        it('should mark light theme as active when currentTheme is light', () => {
            const { container } = render(
                <ThemeTab currentTheme="light" onThemeChange={() => {}} />
            );
            
            // Find the light theme card (second card)
            const cards = container.querySelectorAll('[role="radio"]');
            const lightCard = cards[1] as HTMLElement;
            
            expect(lightCard.getAttribute('aria-checked')).toBe('true');
        });

        it('should render cards in a grid layout', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            const grid = container.querySelector('.grid');
            expect(grid).toBeTruthy();
            expect(grid?.className).toContain('sm:grid-cols-2');
        });

        it('should have radiogroup role for accessibility', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            const radiogroup = container.querySelector('[role="radiogroup"]');
            expect(radiogroup).toBeTruthy();
            expect(radiogroup?.getAttribute('aria-label')).toBe('Theme selection');
        });
    });

    describe('theme selection', () => {
        it('should call onThemeChange with "dark" when dark card is clicked', () => {
            const onThemeChange = vi.fn();
            const { container } = render(
                <ThemeTab currentTheme="light" onThemeChange={onThemeChange} />
            );
            
            // Find and click the dark theme card (first card)
            const cards = container.querySelectorAll('[role="radio"]');
            const darkCard = cards[0] as HTMLElement;
            darkCard.click();
            
            expect(onThemeChange).toHaveBeenCalledWith('dark');
            expect(onThemeChange).toHaveBeenCalledTimes(1);
        });

        it('should call onThemeChange with "light" when light card is clicked', () => {
            const onThemeChange = vi.fn();
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );
            
            // Find and click the light theme card (second card)
            const cards = container.querySelectorAll('[role="radio"]');
            const lightCard = cards[1] as HTMLElement;
            lightCard.click();
            
            expect(onThemeChange).toHaveBeenCalledWith('light');
            expect(onThemeChange).toHaveBeenCalledTimes(1);
        });

        it('should allow clicking the already active theme', () => {
            const onThemeChange = vi.fn();
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );
            
            // Click the already active dark theme card
            const cards = container.querySelectorAll('[role="radio"]');
            const darkCard = cards[0] as HTMLElement;
            darkCard.click();
            
            expect(onThemeChange).toHaveBeenCalledWith('dark');
            expect(onThemeChange).toHaveBeenCalledTimes(1);
        });

        it('should handle multiple theme changes', () => {
            const onThemeChange = vi.fn();
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );
            
            const cards = container.querySelectorAll('[role="radio"]');
            const darkCard = cards[0] as HTMLElement;
            const lightCard = cards[1] as HTMLElement;
            
            // Click light theme
            lightCard.click();
            expect(onThemeChange).toHaveBeenCalledWith('light');
            
            // Click dark theme
            darkCard.click();
            expect(onThemeChange).toHaveBeenCalledWith('dark');
            
            expect(onThemeChange).toHaveBeenCalledTimes(2);
        });
    });

    describe('styling and transitions', () => {
        it('should apply transition classes to the theme cards', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            for (const card of screen.getAllByRole('radio')) {
                expect(card).toHaveClass('transition-all', 'duration-200', 'ease-[var(--ease-spring)]');
            }
        });

        it('should apply proper spacing between cards', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            const grid = container.querySelector('.grid');
            expect(grid?.className).toContain('gap-4');
        });

        it('should apply proper padding to the container', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            const mainContainer = container.querySelector('.flex.flex-col.h-full');
            expect(mainContainer?.className).toContain('p-2');
        });
    });

    describe('Requirements validation', () => {
        it('should satisfy Requirement 11.1: Display theme selection cards', () => {
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={() => {}} />
            );
            
            const cards = container.querySelectorAll('[role="radio"]');
            expect(cards.length).toBe(2);
        });

        it('should satisfy Requirement 11.2: Show preview cards for Dark and Light themes', () => {
            render(<ThemeTab currentTheme="dark" onThemeChange={() => {}} />);
            
            expect(screen.getByText('Dark')).toBeTruthy();
            expect(screen.getByText('Light')).toBeTruthy();
        });

        it('should satisfy Requirement 11.3: Apply selected theme immediately', () => {
            const onThemeChange = vi.fn();
            const { container } = render(
                <ThemeTab currentTheme="dark" onThemeChange={onThemeChange} />
            );
            
            const cards = container.querySelectorAll('[role="radio"]');
            const lightCard = cards[1] as HTMLElement;
            lightCard.click();
            
            // Verify callback is called immediately (synchronously)
            expect(onThemeChange).toHaveBeenCalledWith('light');
        });
    });
});
