import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Sidebar } from '../Sidebar.js';
import type { Topic } from '../../../types.js';

// Mock Icons to avoid SVG issues in test
vi.mock('../Icons', () => ({
    IconNewChat: () => <div data-testid="icon-new-chat" />,
    IconSun: () => <div data-testid="icon-sun" />,
    IconMoon: () => <div data-testid="icon-moon" />,
    IconFolder: () => <div data-testid="icon-folder" />,
    IconSettings: () => <div data-testid="icon-settings" />,
    IconChat: () => <div data-testid="icon-chat" />,
}));

describe('Sidebar Component', () => {
    const now = Date.now();

    const mockTopics: Topic[] = [
        { id: 'current', title: 'Current Topic', createdAt: now - 1000, updatedAt: now, status: 'hot' },
        { id: 'active-1', title: 'Active 1', createdAt: now - 5_000, updatedAt: now - 5_000, status: 'warm' },
        { id: 'active-2', title: 'Active 2', createdAt: now - 6_000, updatedAt: now - 6_000, status: 'warm' },
        { id: 'recent-1', title: 'Recent 1', createdAt: now - 1 * 24 * 60 * 60 * 1000, updatedAt: now - 1 * 24 * 60 * 60 * 1000, status: 'warm' },
        { id: 'recent-2', title: 'Recent 2', createdAt: now - 2 * 24 * 60 * 60 * 1000, updatedAt: now - 2 * 24 * 60 * 60 * 1000, status: 'warm' },
        { id: 'recent-3', title: 'Recent 3', createdAt: now - 2.5 * 24 * 60 * 60 * 1000, updatedAt: now - 2.5 * 24 * 60 * 60 * 1000, status: 'warm' },
        { id: 'recent-4', title: 'Recent 4', createdAt: now - 2.7 * 24 * 60 * 60 * 1000, updatedAt: now - 2.7 * 24 * 60 * 60 * 1000, status: 'warm' },
        { id: 'recent-5', title: 'Recent 5', createdAt: now - 2.8 * 24 * 60 * 60 * 1000, updatedAt: now - 2.8 * 24 * 60 * 60 * 1000, status: 'warm' },
        { id: 'recent-6', title: 'Recent 6', createdAt: now - 2.9 * 24 * 60 * 60 * 1000, updatedAt: now - 2.9 * 24 * 60 * 60 * 1000, status: 'warm' },
        { id: 'history-1', title: 'History 1', createdAt: now - 8 * 24 * 60 * 60 * 1000, updatedAt: now - 8 * 24 * 60 * 60 * 1000, status: 'cold' },
        { id: 'history-2', title: 'History 2', createdAt: now - 9 * 24 * 60 * 60 * 1000, updatedAt: now - 9 * 24 * 60 * 60 * 1000, status: 'cold' },
        { id: 'history-3', title: 'History 3', createdAt: now - 10 * 24 * 60 * 60 * 1000, updatedAt: now - 10 * 24 * 60 * 60 * 1000, status: 'cold' },
        { id: 'history-4', title: 'History 4', createdAt: now - 11 * 24 * 60 * 60 * 1000, updatedAt: now - 11 * 24 * 60 * 60 * 1000, status: 'cold' },
        { id: 'history-5', title: 'History 5', createdAt: now - 12 * 24 * 60 * 60 * 1000, updatedAt: now - 12 * 24 * 60 * 60 * 1000, status: 'cold' },
        { id: 'history-6', title: 'History 6', createdAt: now - 13 * 24 * 60 * 60 * 1000, updatedAt: now - 13 * 24 * 60 * 60 * 1000, status: 'cold' },
    ];

    const defaultProps = {
        sidebarOpen: true,
        topics: mockTopics,
        activeTopicId: 'current',
        activeTopicIds: ['active-1', 'active-2'],
        theme: 'dark' as const,
        onNewChat: vi.fn(),
        onSelectTopic: vi.fn(),
        toggleTheme: vi.fn(),
        onSwitchProject: vi.fn(),
        getTopicState: vi.fn(() => 'IDLE'),
        getTopicPaused: vi.fn(() => false)
    };

    it('renders correctly when open', () => {
        render(<Sidebar {...defaultProps} />);
        expect(screen.getByText('Sessions')).toBeInTheDocument();
        expect(screen.getAllByText('Current').length).toBeGreaterThan(0);
        expect(screen.getByText('Active')).toBeInTheDocument();
        expect(screen.getByText('Recent')).toBeInTheDocument();
        expect(screen.getByText('Other')).toBeInTheDocument();
        expect(screen.getByText('Current Topic')).toBeInTheDocument();
    });

    it('handles new chat click', () => {
        render(<Sidebar {...defaultProps} />);
        fireEvent.click(screen.getByText('New Session'));
        expect(defaultProps.onNewChat).toHaveBeenCalled();
    });

    it('handles topic selection', () => {
        render(<Sidebar {...defaultProps} />);
        fireEvent.click(screen.getByText('Recent 2'));
        expect(defaultProps.onSelectTopic).toHaveBeenCalledWith('recent-2');
    });

    it('shows three recent and other sessions by default and expands each group independently', () => {
        render(<Sidebar {...defaultProps} />);
        const recent = screen.getByTestId('recent-list');
        const other = screen.getByTestId('other-list');

        expect(within(recent).getAllByText(/^Recent [1-3]$/)).toHaveLength(3);
        expect(within(other).getAllByText(/^History [1-3]$/)).toHaveLength(3);
        expect(within(recent).queryByText('Recent 4')).not.toBeInTheDocument();
        expect(within(other).queryByText('History 4')).not.toBeInTheDocument();

        fireEvent.click(within(recent.parentElement!).getByRole('button', { name: 'Show 3 More' }));
        expect(within(recent).getByText('Recent 6')).toBeInTheDocument();
        expect(within(other).queryByText('History 4')).not.toBeInTheDocument();

        fireEvent.click(within(other.parentElement!).getByRole('button', { name: 'Show 3 More' }));
        expect(within(other).getByText('History 6')).toBeInTheDocument();
        expect(other).toHaveClass('max-h-[11rem]', 'overflow-y-auto');
    });

    it('moves a selected older session to Current when the active topic changes', () => {
        const { rerender } = render(<Sidebar {...defaultProps} />);
        fireEvent.click(within(screen.getByTestId('other-list')).getByText('History 2'));
        expect(defaultProps.onSelectTopic).toHaveBeenCalledWith('history-2');
        rerender(<Sidebar {...defaultProps} activeTopicId="history-2" />);
        expect(screen.getByText('History 2')).toBeInTheDocument();
        expect(within(screen.getByTestId('other-list')).queryByText('History 2')).not.toBeInTheDocument();
        expect(within(screen.getByTestId('recent-list')).getByText('Current Topic')).toBeInTheDocument();
    });

    it('groups inactive sessions on either side of the three-day threshold', () => {
        const day = 24 * 60 * 60 * 1000;
        const topics: Topic[] = [
            { id: 'current', title: 'Current Topic', createdAt: now, updatedAt: now, status: 'hot' },
            { id: 'recent', title: 'Just recent', createdAt: now - 4 * day, updatedAt: now - 3 * day + 60_000, status: 'warm' },
            { id: 'other', title: 'Just older', createdAt: now - 3 * day - 60_000, status: 'cold' },
        ];
        render(<Sidebar {...defaultProps} topics={topics} activeTopicIds={[]} />);

        expect(within(screen.getByTestId('recent-list')).getByText('Just recent')).toBeInTheDocument();
        expect(within(screen.getByTestId('other-list')).getByText('Just older')).toBeInTheDocument();
    });

    it('hides content when closed', () => {
        render(<Sidebar {...defaultProps} sidebarOpen={false} />);
        const aside = screen.getByRole('complementary'); // 'aside' role
        expect(aside).toHaveClass('opacity-0');
    });
});
