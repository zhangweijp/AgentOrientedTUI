/**
 * Settings Panel - ModelTab Integration Tests (V2)
 * 
 * Integration tests for ModelTab component
 * Tests provider selection, search filtering, and CRUD actions
 * 
 * Requirements: 2.1-2.6, 3.1-3.7, 4.1-4.4, 5.1-5.11, 6.1-6.11, 8.1-8.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ModelTab } from '../../../src/gui/components/settings/ModelTab.js';
import type { ProviderConfig } from '../../../src/gui/hooks/useProviderConfigs.js';
import type { ModelsDevModel } from '../../../src/services/model-registry.js';

// Mock data
const mockProviders: ProviderConfig[] = [
    {
        id: 1,
        providerId: 'openai',
        customName: 'My OpenAI',
        apiKey: 'sk-test123',
        isActive: true,
        model: 'gpt-4',
        temperature: 0.7,

        createdAt: Date.now(),
        updatedAt: Date.now(),
    },
    {
        id: 2,
        providerId: 'anthropic',
        customName: 'My Anthropic',
        apiKey: 'sk-ant-test456',
        isActive: false,
        model: 'claude-3',
        temperature: 0.7,

        createdAt: Date.now(),
        updatedAt: Date.now(),
    },
];

const mockModels: ModelsDevModel[] = [
    {
        id: 'openai/gpt-4',
        name: 'GPT-4',
        family: 'GPT-4 Family',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.03, output: 0.06 },
        limit: { context: 128000, output: 4096 },
    },
    {
        id: 'openai/gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        family: 'GPT-3.5 Family',
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.001, output: 0.002 },
        limit: { context: 16000, output: 4096 },
    },
];

// Mock hooks
const mockUseProviderConfigs = {
    providers: mockProviders,
    isLoading: false,
    error: null,
    addProvider: vi.fn().mockResolvedValue(undefined),
    updateProvider: vi.fn().mockResolvedValue(undefined),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    setActiveProvider: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
};

const mockUseModels = {
    models: mockModels,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
};

vi.mock('../../../src/gui/hooks/useProviderConfigs.js', () => ({
    useProviderConfigs: () => mockUseProviderConfigs,
    sortProviders: (providers: ProviderConfig[]) => 
        [...providers].sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return 0;
        }),
}));

vi.mock('../../../src/gui/hooks/useModels.js', () => ({
    useModels: () => mockUseModels,
    sortModels: (models: ModelsDevModel[], activeModelId: string | null) => {
        if (!activeModelId) return models;
        return [...models].sort((a, b) => {
            if (a.id === activeModelId && b.id !== activeModelId) return -1;
            if (a.id !== activeModelId && b.id === activeModelId) return 1;
            return 0;
        });
    },
}));

vi.mock('../../../src/gui/ChatBridge.js', () => {
    const bridge = {
        listCustomProviders: async () => [],
        getTrpcClient: () => ({ modelRegistry: {
            getProviders: { query: async () => [
                { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', modelCount: 2 },
            ] },
            getModels: { query: async () => mockModels },
        } }),
    };
    return { useChatBridge: () => bridge };
});

describe('ModelTab - Integration Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset mock data
        mockUseProviderConfigs.providers = mockProviders;
        mockUseProviderConfigs.isLoading = false;
        mockUseProviderConfigs.error = null;
        mockUseModels.models = mockModels;
        mockUseModels.isLoading = false;
        mockUseModels.error = null;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('Component rendering', () => {
        it('should render ModelTab with all sections', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                // Sections
                expect(screen.getByRole('list', { name: 'Provider list' })).toBeInTheDocument();
                expect(screen.getByText(/Models Of/i)).toBeInTheDocument();
                
                // Add Provider button
                expect(screen.getByRole('button', { name: /add new provider/i })).toBeInTheDocument();
            });
        });

        it('should render provider cards', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
                expect(screen.getByText('My Anthropic')).toBeInTheDocument();
            });
        });

        it('should render model cards', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('GPT-4')).toBeInTheDocument();
                expect(screen.getByText('GPT-3.5 Turbo')).toBeInTheDocument();
            });
        });

        it('should show loading state while loading providers', async () => {
            mockUseProviderConfigs.isLoading = true;

            render(<ModelTab />);

            expect(screen.getByText('Loading providers...')).toBeInTheDocument();
        });

        it('should show error state when provider loading fails', async () => {
            mockUseProviderConfigs.error = new Error('Network error');

            render(<ModelTab />);

            expect(screen.getByText(/failed to load providers/i)).toBeInTheDocument();
            expect(screen.getByText('Network error')).toBeInTheDocument();
        });
    });

    describe('Provider selection updates model list', () => {
        it('should select active provider by default', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                // Active provider should be selected (has primary border)
                const activeCard = screen.getByText('My OpenAI').closest('[role="listitem"]');
                expect(activeCard).toBeInTheDocument();
            });
        });

        it('should update model list when provider is selected', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My Anthropic')).toBeInTheDocument();
            });

            // Click on Anthropic provider
            const anthropicCard = screen.getByText('My Anthropic').closest('[role="listitem"]')?.querySelector('[role="radio"]');
            fireEvent.click(anthropicCard!);

            // Model search should be cleared
            await waitFor(() => {
                const modelSearchInput = screen.getByPlaceholderText(/search models/i) as HTMLInputElement;
                expect(modelSearchInput.value).toBe('');
            });
        });

        it('should clear model search when provider changes', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Type in model search
            const modelSearchInput = screen.getByPlaceholderText(/search models/i) as HTMLInputElement;
            fireEvent.change(modelSearchInput, { target: { value: 'GPT-4' } });

            // Wait for debounce to complete
            await new Promise(resolve => setTimeout(resolve, 350));

            // Wait for local state to update
            await waitFor(() => {
                expect(modelSearchInput.value).toBe('GPT-4');
            });

            // Select different provider
            const anthropicCard = screen.getByText('My Anthropic').closest('[role="listitem"]')?.querySelector('[role="radio"]');
            fireEvent.click(anthropicCard!);

            // Model search should be cleared - the prop changes immediately, useEffect syncs the local state
            await waitFor(() => {
                expect(modelSearchInput.value).toBe('');
            });
        });
    });

    describe('Search filtering', () => {
        it('should filter providers by search query', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
                expect(screen.getByText('My Anthropic')).toBeInTheDocument();
            });

            // Type in provider search
            const providerSearchInput = screen.getByPlaceholderText(/search providers/i) as HTMLInputElement;
            fireEvent.change(providerSearchInput, { target: { value: 'OpenAI' } });

            // Wait for debounce (300ms)
            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
                expect(screen.queryByText('My Anthropic')).not.toBeInTheDocument();
            }, { timeout: 500 });
        });

        it('should filter models by search query', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('GPT-4')).toBeInTheDocument();
                expect(screen.getByText('GPT-3.5 Turbo')).toBeInTheDocument();
            });

            // Type in model search
            const modelSearchInput = screen.getByPlaceholderText(/search models/i) as HTMLInputElement;
            fireEvent.change(modelSearchInput, { target: { value: 'GPT-4' } });

            // Wait for debounce (300ms)
            await waitFor(() => {
                expect(screen.getByText('GPT-4')).toBeInTheDocument();
                expect(screen.queryByText('GPT-3.5 Turbo')).not.toBeInTheDocument();
            }, { timeout: 500 });
        });

        it('should show empty state when provider search returns no results', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Type in provider search with no matches
            const providerSearchInput = screen.getByPlaceholderText(/search providers/i) as HTMLInputElement;
            fireEvent.change(providerSearchInput, { target: { value: 'NonExistent' } });

            // Wait for debounce
            await waitFor(() => {
                expect(screen.queryByText('My OpenAI')).not.toBeInTheDocument();
                expect(screen.queryByText('My Anthropic')).not.toBeInTheDocument();
            }, { timeout: 500 });
        });

        it('should be case-insensitive when filtering', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Type in lowercase
            const providerSearchInput = screen.getByPlaceholderText(/search providers/i) as HTMLInputElement;
            fireEvent.change(providerSearchInput, { target: { value: 'openai' } });

            // Should still find the provider
            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            }, { timeout: 500 });
        });
    });

    describe('Add provider flow', () => {
        it('opens the named add provider dialog', async () => {
            render(<ModelTab />);
            fireEvent.click(await screen.findByRole('button', { name: /add new provider/i }));

            expect(await screen.findByRole('dialog', { name: 'Add Provider' })).toBeInTheDocument();
        });

        it('closes the add provider dialog when canceled', async () => {
            render(<ModelTab />);
            fireEvent.click(await screen.findByRole('button', { name: /add new provider/i }));

            const dialog = await screen.findByRole('dialog', { name: 'Add Provider' });
            fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
            expect(screen.queryByRole('dialog', { name: 'Add Provider' })).not.toBeInTheDocument();
        });

        it('saves the selected template provider and model', async () => {
            render(<ModelTab />);
            fireEvent.click(await screen.findByRole('button', { name: /add new provider/i }));

            const dialog = within(await screen.findByRole('dialog', { name: 'Add Provider' }));
            const provider = dialog.getByRole('button', { name: 'Provider *' });
            await waitFor(() => expect(provider).toBeEnabled());
            fireEvent.click(provider);
            fireEvent.click(dialog.getByRole('option', { name: /openai/i }));

            fireEvent.change(dialog.getByLabelText('API Key *'), { target: { value: 'sk-fixture-key' } });
            const submit = dialog.getByRole('button', { name: 'Add Provider' });
            await waitFor(() => expect(submit).toBeEnabled());
            fireEvent.click(submit);

            await waitFor(() => expect(mockUseProviderConfigs.addProvider).toHaveBeenCalledExactlyOnceWith({
                providerId: 'openai', customName: 'OpenAI', apiKey: 'sk-fixture-key', model: 'openai/gpt-4',
            }));
        });
    });

    describe('Edit provider flow', () => {
        it('should open edit modal when edit button is clicked', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Hover over provider card to show edit button
            const providerCard = screen.getByText('My OpenAI').closest('[role="listitem"]');
            if (providerCard) {
                fireEvent.mouseEnter(providerCard);
            }

            // Click edit button (aria-label includes provider name)
            await waitFor(() => {
                const editButton = screen.getByLabelText(/edit my openai provider/i);
                fireEvent.click(editButton);
            });

            // Modal should open
            await waitFor(() => {
                expect(screen.getByText('Edit Provider')).toBeInTheDocument();
            });
        });

        it('should call updateProvider when save is clicked', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Hover and click edit
            const providerCard = screen.getByText('My OpenAI').closest('[role="listitem"]');
            if (providerCard) {
                fireEvent.mouseEnter(providerCard);
            }

            await waitFor(() => {
                const editButton = screen.getByLabelText(/edit my openai provider/i);
                fireEvent.click(editButton);
            });

            await waitFor(() => {
                expect(screen.getByText('Edit Provider')).toBeInTheDocument();
            });

            // Update custom name
            const customNameInput = screen.getByLabelText('Custom Name *') as HTMLInputElement;
            fireEvent.change(customNameInput, { target: { value: 'Updated OpenAI' } });

            // Click save
            const saveButton = screen.getByRole('button', { name: /save/i });
            fireEvent.click(saveButton);

            // updateProvider should be called
            await waitFor(() => {
                expect(mockUseProviderConfigs.updateProvider).toHaveBeenCalled();
            });
        });
    });

    describe('Delete provider flow', () => {
        it('should open delete confirmation when delete button is clicked', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Hover over provider card to show delete button
            const providerCard = screen.getByText('My OpenAI').closest('[role="listitem"]');
            if (providerCard) {
                fireEvent.mouseEnter(providerCard);
            }

            // Click delete button (aria-label includes provider name)
            await waitFor(() => {
                const deleteButton = screen.getByLabelText(/delete my openai provider/i);
                fireEvent.click(deleteButton);
            });

            // Confirmation dialog should open - check for dialog title specifically
            await waitFor(() => {
                const dialog = screen.getByRole('dialog', { name: 'Delete Provider' });
                expect(dialog).toHaveAttribute('aria-modal', 'true');
                expect(dialog).toHaveAccessibleDescription(/My OpenAI/i);
            });
        });

        it('should call deleteProvider when deletion is confirmed', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My Anthropic')).toBeInTheDocument();
            });

            // Hover and click delete on non-active provider
            const providerCard = screen.getByText('My Anthropic').closest('[role="listitem"]');
            if (providerCard) {
                fireEvent.mouseEnter(providerCard);
            }

            await waitFor(() => {
                const deleteButton = screen.getByLabelText(/delete my anthropic provider/i);
                fireEvent.click(deleteButton);
            });

            await waitFor(() => {
                expect(screen.getByRole('heading', { name: 'Delete Provider' })).toBeInTheDocument();
            });

            // Confirm deletion - get all buttons and find the one with "Delete Provider" text
            const confirmButton = screen.getByRole('button', { name: /delete provider/i });
            fireEvent.click(confirmButton);

            // deleteProvider should be called
            await waitFor(() => {
                expect(mockUseProviderConfigs.deleteProvider).toHaveBeenCalled();
            });
        });

        it('should show warning when deleting active provider', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Hover and click delete on active provider
            const providerCard = screen.getByText('My OpenAI').closest('[role="listitem"]');
            if (providerCard) {
                fireEvent.mouseEnter(providerCard);
            }

            await waitFor(() => {
                const deleteButton = screen.getByLabelText(/delete my openai provider/i);
                fireEvent.click(deleteButton);
            });

            // Should show active provider warning
            await waitFor(() => {
                expect(screen.getByText(/this is your active provider/i)).toBeInTheDocument();
            });
        });

        it('should clear selection when deleting selected provider', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('My OpenAI')).toBeInTheDocument();
            });

            // Select OpenAI provider
            const openaiCard = screen.getByText('My OpenAI').closest('[role="listitem"]')?.querySelector('[role="radio"]');
            fireEvent.click(openaiCard!);

            // Delete OpenAI provider
            const providerCard = screen.getByText('My OpenAI').closest('[role="listitem"]');
            if (providerCard) {
                fireEvent.mouseEnter(providerCard);
            }

            await waitFor(() => {
                const deleteButton = screen.getByLabelText(/delete my openai provider/i);
                fireEvent.click(deleteButton);
            });

            await waitFor(() => {
                const confirmButton = screen.getByRole('button', { name: /delete provider/i });
                fireEvent.click(confirmButton);
            });

            // Selection should be cleared (tested by checking if model search is disabled)
            await waitFor(() => {
                const modelSearchInput = screen.getByPlaceholderText(/select a provider/i);
                expect(modelSearchInput).toBeDisabled();
            });
        });
    });

    describe('Model selection', () => {
        it('should call updateProvider and setActiveProvider when model is selected', async () => {
            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText('GPT-3.5 Turbo')).toBeInTheDocument();
            });

            // Click on GPT-3.5 Turbo model's Activate button
            const modelCard = screen.getByText('GPT-3.5 Turbo').closest('[role="listitem"]');
            const activateButton = modelCard?.querySelector('button');
            fireEvent.click(activateButton!);

            // Should update provider with new model and set as active
            await waitFor(() => {
                expect(mockUseProviderConfigs.updateProvider).toHaveBeenCalled();
                expect(mockUseProviderConfigs.setActiveProvider).toHaveBeenCalled();
            });
        });

        it('should not select model when no provider is selected', async () => {
            // Start with no selected provider
            mockUseModels.models = [];

            render(<ModelTab />);

            await waitFor(() => {
                expect(screen.getByText(/no models available/i)).toBeInTheDocument();
            });

            // updateProvider should not be called
            expect(mockUseProviderConfigs.updateProvider).not.toHaveBeenCalled();
        });
    });
});
