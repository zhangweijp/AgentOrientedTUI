/**
 * ThemeCard Component - Unit Tests
 * 
 * Tests for ThemeCard component rendering and interactions
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeCard } from '../../../src/gui/components/settings/ThemeCard.js';

describe('ThemeCard', () => {
    describe('active state rendering', () => {
        it('should display checkmark icon when active', () => {
            const { container } = render(
                <ThemeCard theme="dark" isActive={true} onSelect={() => {}} />
            );
            
            // Check for checkmark SVG path
            const checkmark = container.querySelector('svg[aria-hidden="true"] polyline');
            expect(checkmark).toBeTruthy();
        });

        it('should not display checkmark icon when inactive', () => {
            const { container } = render(
                <ThemeCard theme="dark" isActive={false} onSelect={() => {}} />
            );
            
            // Check for checkmark SVG path
            const checkmark = container.querySelector('svg[aria-hidden="true"] polyline');
            expect(checkmark).toBeFalsy();
        });

        it('should apply primary border when active', () => {
            const { container } = render(
                <ThemeCard theme="dark" isActive={true} onSelect={() => {}} />
            );
            
            // Find the button wrapper (first child)
            const button = container.firstChild as HTMLElement;
            expect(button.className).toContain('shadow-[0_0_0_1px_var(--color-accent)]');
            expect(button.className).toContain('border-[var(--color-accent)]');
        });

        it('should apply default border when inactive', () => {
            const { container } = render(
                <ThemeCard theme="dark" isActive={false} onSelect={() => {}} />
            );
            
            // Find the button wrapper (first child)
            const button = container.firstChild as HTMLElement;
            expect(button.className).toContain('border');
            expect(button.className).toContain('border-[var(--mat-border)]');
            expect(button.className).not.toContain('shadow-[0_0_0_1px_var(--color-accent)]');
        });
    });

    describe('click handler', () => {
        it('should call onSelect when clicked', () => {
            const onSelect = vi.fn();
            const { container } = render(
                <ThemeCard theme="dark" isActive={false} onSelect={onSelect} />
            );
            
            const button = container.firstChild as HTMLElement;
            button.click();
            
            expect(onSelect).toHaveBeenCalledTimes(1);
        });

        it('should call onSelect when active card is clicked', () => {
            const onSelect = vi.fn();
            const { container } = render(
                <ThemeCard theme="dark" isActive={true} onSelect={onSelect} />
            );
            
            const button = container.firstChild as HTMLElement;
            button.click();
            
            expect(onSelect).toHaveBeenCalledTimes(1);
        });
    });

    describe('theme preview colors', () => {
        it('should display dark theme preview colors', () => {
            const { container } = render(
                <ThemeCard theme="dark" isActive={false} onSelect={() => {}} />
            );
            
            // Check for dark theme background color (happy-dom returns hex format)
            const preview = container.querySelector('[style*="background-color"]') as HTMLElement;
            expect(preview).toBeTruthy();
            const bgColor = preview.style.backgroundColor.toLowerCase();
            expect(bgColor === '#1c1c1e' || bgColor === 'rgb(28, 28, 30)').toBe(true);
        });

        it('should display light theme preview colors', () => {
            const { container } = render(
                <ThemeCard theme="light" isActive={false} onSelect={() => {}} />
            );
            
            // Check for light theme background color (happy-dom returns hex format)
            const preview = container.querySelector('[style*="background-color"]') as HTMLElement;
            expect(preview).toBeTruthy();
            const bgColor = preview.style.backgroundColor.toLowerCase();
            expect(bgColor === '#f5f5f7' || bgColor === 'rgb(245, 245, 247)').toBe(true);
        });

        it('should display "Dark" label for dark theme', () => {
            render(<ThemeCard theme="dark" isActive={false} onSelect={() => {}} />);
            expect(screen.getByText('Dark')).toBeTruthy();
        });

        it('should display "Light" label for light theme', () => {
            render(<ThemeCard theme="light" isActive={false} onSelect={() => {}} />);
            expect(screen.getByText('Light')).toBeTruthy();
        });

        it('keeps decorative preview content out of the accessible name', () => {
            render(<ThemeCard theme="dark" isActive={false} onSelect={() => {}} />);
            const card = screen.getByRole('radio', { name: 'Dark theme' });
            expect(card.querySelector('[aria-hidden="true"] div[style]')).toBeInTheDocument();
        });
    });

    describe('theme-specific styling', () => {
        it('should apply dark theme accent color (#0A84FF)', () => {
            const { container } = render(
                <ThemeCard theme="dark" isActive={false} onSelect={() => {}} />
            );
            
            // Find the accent color element (the colored bar in preview)
            const accentElements = Array.from(container.querySelectorAll('[style*="background-color"]')) as HTMLElement[];
            const accentElement = accentElements.find(el => {
                const bgColor = el.style.backgroundColor.toLowerCase();
                return bgColor === '#0a84ff' || bgColor === 'rgb(10, 132, 255)';
            });
            expect(accentElement).toBeTruthy();
        });

        it('should apply light theme accent color (#007AFF)', () => {
            const { container } = render(
                <ThemeCard theme="light" isActive={false} onSelect={() => {}} />
            );
            
            // Find the accent color element (the colored bar in preview)
            const accentElements = Array.from(container.querySelectorAll('[style*="background-color"]')) as HTMLElement[];
            const accentElement = accentElements.find(el => {
                const bgColor = el.style.backgroundColor.toLowerCase();
                return bgColor === '#007aff' || bgColor === 'rgb(0, 122, 255)';
            });
            expect(accentElement).toBeTruthy();
        });
    });
});
