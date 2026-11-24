/**
 * Settings Panel - ModelList Unit Tests (V2)
 * 
 * Unit tests for ModelList component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ModelList } from '../../../src/gui/components/settings/ModelList.js';
import type { ModelsDevModel } from '../../../src/services/model-registry.js';

describe('ModelList', () => {
    const mockModels: ModelsDevModel[] = [
        {
            id: 'openai/gpt-4',
            name: 'GPT-4',
            family: 'GPT-4',
            tool_call: true,
            reasoning: true,
            cost: { input: 0.00003, output: 0.00006 },
            limit: { context: 128000 },
        },
        {
            id: 'openai/gpt-3.5-turbo',
            name: 'GPT-3.5 Turbo',
            family: 'GPT-3.5',
            tool_call: true,
            cost: { input: 0.000001, output: 0.000002 },
            limit: { context: 16000 },
        },
        {
            id: 'anthropic/claude-3-opus',
            name: 'Claude 3 Opus',
            family: 'Claude 3',
            reasoning: true,
            cost: { input: 0.000015, output: 0.000075 },
            limit: { context: 200000 },
        },
    ];

    const mockHandlers = {
        onSelectModel: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Model rendering', () => {
        it('should render all models', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            expect(screen.getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: 'GPT-3.5 Turbo' })).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: 'Claude 3 Opus' })).toBeInTheDocument();
        });

        it('should render models as list items', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const list = screen.getByRole('list');
            const items = within(list).getAllByRole('listitem');
            expect(items).toHaveLength(3);
        });

        it('should pass correct props to ModelCard components', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId="openai/gpt-4"
                    {...mockHandlers}
                />
            );

            // Active model should have active badge
            expect(screen.getByText('Active')).toBeInTheDocument();
        });
    });

    describe('Sorting (active first)', () => {
        it('should display active model first', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId="openai/gpt-3.5-turbo"
                    {...mockHandlers}
                />
            );

            const list = screen.getByRole('list');
            const items = within(list).getAllByRole('listitem');
            
            // First item should be the active model
            expect(within(items[0]).getByRole('heading', { name: 'GPT-3.5 Turbo' })).toBeInTheDocument();
        });

        it('should maintain order when no active model', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const list = screen.getByRole('list');
            const items = within(list).getAllByRole('listitem');
            
            // Order should match original array
            expect(within(items[0]).getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            expect(within(items[1]).getByRole('heading', { name: 'GPT-3.5 Turbo' })).toBeInTheDocument();
            expect(within(items[2]).getByRole('heading', { name: 'Claude 3 Opus' })).toBeInTheDocument();
        });

        it('should sort correctly when last model is active', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId="anthropic/claude-3-opus"
                    {...mockHandlers}
                />
            );

            const list = screen.getByRole('list');
            const items = within(list).getAllByRole('listitem');
            
            // Last model should now be first
            expect(within(items[0]).getByRole('heading', { name: 'Claude 3 Opus' })).toBeInTheDocument();
        });
    });

    describe('Vertical scrolling', () => {
        it('should apply vertical scroll styles', () => {
            const { container } = render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const scrollContainer = container.querySelector('.model-list-grid');
            expect(scrollContainer).toBeInTheDocument();
            expect(scrollContainer).toHaveStyle({ overflowY: 'auto' });
        });

    });

    describe('Loading state', () => {
        it('should display loading state when isLoading is true', () => {
            render(
                <ModelList
                    models={[]}
                    activeModelId={null}
                    isLoading={true}
                    {...mockHandlers}
                />
            );

            expect(screen.getByText('Loading models...')).toBeInTheDocument();
        });

        it('should not display models when loading', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    isLoading={true}
                    {...mockHandlers}
                />
            );

            expect(screen.queryByRole('heading', { name: 'GPT-4' })).not.toBeInTheDocument();
            expect(screen.queryByRole('heading', { name: 'GPT-3.5 Turbo' })).not.toBeInTheDocument();
        });

        it('should display models when not loading', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    isLoading={false}
                    {...mockHandlers}
                />
            );

            expect(screen.getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
        });
    });

    describe('Empty state', () => {
        it('should display empty state when no models', () => {
            render(
                <ModelList
                    models={[]}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            expect(screen.getByText('No models available. Please select a provider.')).toBeInTheDocument();
        });

        it('should not display empty state when models exist', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            expect(screen.queryByText('No models available. Please select a provider.')).not.toBeInTheDocument();
        });

        it('should display empty state with proper role', () => {
            render(
                <ModelList
                    models={[]}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const emptyState = screen.getByRole('status');
            expect(emptyState).toHaveAttribute('aria-live', 'polite');
        });

        it('should not display empty state when loading', () => {
            render(
                <ModelList
                    models={[]}
                    activeModelId={null}
                    isLoading={true}
                    {...mockHandlers}
                />
            );

            expect(screen.queryByText('No models available. Please select a provider.')).not.toBeInTheDocument();
            expect(screen.getByText('Loading models...')).toBeInTheDocument();
        });
    });

    describe('Accessibility', () => {
        it('should have role="list"', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const list = screen.getByRole('list');
            expect(list).toBeInTheDocument();
        });

        it('should have aria-label for list', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const list = screen.getByRole('list');
            expect(list).toHaveAttribute('aria-label', 'Model list');
        });

        it('should have proper ARIA attributes for empty state', () => {
            render(
                <ModelList
                    models={[]}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const emptyState = screen.getByRole('status');
            expect(emptyState).toHaveAttribute('aria-live', 'polite');
        });
    });

    describe('Edge cases', () => {
        it('should handle single model', () => {
            render(
                <ModelList
                    models={[mockModels[0]]}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            expect(screen.getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            const items = screen.getAllByRole('listitem');
            expect(items).toHaveLength(1);
        });

        it('should handle large number of models', () => {
            const manyModels = Array.from({ length: 50 }, (_, i) => ({
                id: `provider/model-${i}`,
                name: `Model ${i}`,
            }));

            render(
                <ModelList
                    models={manyModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            const items = screen.getAllByRole('listitem');
            expect(items).toHaveLength(50);
        });

        it('should handle active model not in list', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId="nonexistent/model"
                    {...mockHandlers}
                />
            );

            // Should not crash and should render all models
            expect(screen.getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            expect(screen.queryByText('Active')).not.toBeInTheDocument();
        });

        it('should handle undefined isLoading prop', () => {
            render(
                <ModelList
                    models={mockModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            // Should default to not loading
            expect(screen.getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
        });

        it('should handle models with duplicate IDs gracefully', () => {
            const duplicateModels = [
                mockModels[0],
                { ...mockModels[0], name: 'Duplicate Model' },
            ];

            render(
                <ModelList
                    models={duplicateModels}
                    activeModelId={null}
                    {...mockHandlers}
                />
            );

            // Should render both (React will warn about duplicate keys in console)
            expect(screen.getByRole('heading', { name: 'GPT-4' })).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: 'Duplicate Model' })).toBeInTheDocument();
        });
    });

    describe('Model selection', () => {
        it.each([
            ['GPT-4', 'openai/gpt-4'],
            ['Claude 3 Opus', 'anthropic/claude-3-opus'],
        ])('activates %s with its model ID', (name, modelId) => {
            render(<ModelList models={mockModels} activeModelId={null} {...mockHandlers} />);

            const card = screen.getByRole('listitem', { name: `${name} model` });
            within(card).getByRole('button', { name: 'Activate' }).click();

            expect(mockHandlers.onSelectModel).toHaveBeenCalledExactlyOnceWith(modelId);
        });

        it('labels the active model and hides its activation action', () => {
            render(<ModelList models={mockModels} activeModelId="openai/gpt-4" {...mockHandlers} />);

            const card = screen.getByRole('listitem', { name: 'GPT-4 model (active)' });
            expect(within(card).getByText('Active')).toBeInTheDocument();
            expect(within(card).queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
        });
    });
});
