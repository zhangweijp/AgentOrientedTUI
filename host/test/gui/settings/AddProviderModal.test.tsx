/**
 * Settings Panel - AddProviderModal Unit Tests (V2)
 * 
 * Unit tests for AddProviderModal component
 * Requirements: 5.1-5.11
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AddProviderModal } from '../../../src/gui/components/settings/AddProviderModal.js';

const catalog = vi.hoisted(() => {
    const providers = vi.fn();
    const models = vi.fn();
    const bridge = { getTrpcClient: () => ({ modelRegistry: {
        getProviders: { query: providers },
        getModels: { query: models },
    } }) };
    return { bridge, providers, models };
});
vi.mock('../../../src/gui/ChatBridge.js', () => ({ useChatBridge: () => catalog.bridge }));

const rawModel = 'openai/team:fast';

describe('AddProviderModal', () => {
    const mockHandlers = {
        onClose: vi.fn(),
        onSave: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        catalog.providers.mockReset().mockResolvedValue([
            { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', modelCount: 10 },
            { id: 'anthropic', name: 'Anthropic', baseURL: 'https://api.anthropic.com', modelCount: 5 },
            { id: 'google', name: 'Google', baseURL: 'https://generativelanguage.googleapis.com/v1beta', modelCount: 8 },
        ]);
        catalog.models.mockReset().mockResolvedValue([{ id: rawModel, catalogId: 'openai/' + rawModel }]);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('Modal rendering', () => {
        it('should not render when isOpen is false', () => {
            render(
                <AddProviderModal
                    isOpen={false}
                    {...mockHandlers}
                />
            );

            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        });

        it('should render when isOpen is true', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByRole('dialog')).toBeInTheDocument();
            });
        });

        it('should display modal title', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByRole('heading', { name: 'Add Provider' })).toBeInTheDocument();
            });
        });

        it('should have aria-modal attribute', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                const dialog = screen.getByRole('dialog');
                expect(dialog).toHaveAttribute('aria-modal', 'true');
            });
        });

        it('should have aria-labelledby attribute', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                const dialog = screen.getByRole('dialog');
                expect(dialog).toHaveAttribute('aria-labelledby', 'add-provider-modal-title');
            });
        });

        it('should display close button', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByLabelText('Close modal')).toBeInTheDocument();
            });
        });
    });

    describe('Provider dropdown', () => {
        it('should display provider dropdown', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText('Provider *')).toBeInTheDocument();
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });
        });

        it('should show loading state while fetching providers', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            // Initially should show loading
            const button = screen.getByText(/loading providers/i);
            expect(button).toBeInTheDocument();
        });

        it('should display available providers after loading', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            // Wait for providers to load
            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Click to open dropdown
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);

            // Check for providers
            await waitFor(() => {
                expect(screen.getByText('OpenAI')).toBeInTheDocument();
                expect(screen.getByText('Anthropic')).toBeInTheDocument();
                expect(screen.getByText('Google')).toBeInTheDocument();
            });
        });

        it('should display model count for each provider', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);

            await waitFor(() => {
                expect(screen.getByText('10 models')).toBeInTheDocument();
                expect(screen.getByText('5 models')).toBeInTheDocument();
                expect(screen.getByText('8 models')).toBeInTheDocument();
            });
        });

        it('should select provider when clicked', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Open dropdown
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);

            // Select OpenAI
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            // Dropdown should close and show selected provider
            await waitFor(() => {
                expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
            });
        });

        it('should auto-fill custom name when provider is selected', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Open dropdown
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);

            // Select OpenAI
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            // Custom name should be auto-filled
            await waitFor(() => {
                const customNameInput = screen.getByLabelText('Display Name *') as HTMLInputElement;
                expect(customNameInput.value).toBe('OpenAI');
            });
        });

        it('should display provider logo in dropdown', async () => {
            const { container } = render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Open dropdown
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);

            // Check for logo images or fallback
            await waitFor(() => {
                const logos = container.querySelectorAll('img[alt*="logo"], [title*="OpenAI"]');
                expect(logos.length).toBeGreaterThan(0);
            });
        });
    });

    describe('Input validation', () => {
        it('disables submission without a Provider', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Try to save without selecting provider
            const saveButton = screen.getByRole('button', { name: 'Add Provider' });
            expect(saveButton).toBeDisabled();
        });

        it('disables submission without a display name', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            // Clear custom name
            const customNameInput = screen.getByLabelText('Display Name *') as HTMLInputElement;
            fireEvent.change(customNameInput, { target: { value: '' } });

            // Save button should be disabled
            const saveButton = screen.getByRole('button', { name: 'Add Provider' });
            expect(saveButton).toBeDisabled();
        });

        it('disables submission without an API key', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            // Custom name is auto-filled, but API key is empty
            const saveButton = screen.getByRole('button', { name: 'Add Provider' });
            expect(saveButton).toBeDisabled();
        });

        it('should enable save button when all fields are valid', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            // Fill API key
            const apiKeyInput = screen.getByLabelText('API Key *') as HTMLInputElement;
            fireEvent.change(apiKeyInput, { target: { value: 'sk-test1234567890' } });

            // Save button should be enabled
            await waitFor(() => {
                const saveButton = screen.getByRole('button', { name: 'Add Provider' });
                expect(saveButton).not.toBeDisabled();
            });
        });

        it('should clear validation errors when input changes', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            const customNameInput = screen.getByLabelText('Display Name *');
            fireEvent.change(customNameInput, { target: { value: 'X' } });
            fireEvent.change(screen.getByLabelText('API Key *'), { target: { value: 'fixture-secret' } });
            fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
            expect(screen.getByRole('alert')).toHaveTextContent('Custom name must be at least 3 characters');

            fireEvent.change(customNameInput, { target: { value: 'My Provider' } });
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        });
    });

    describe('Save/Cancel handlers', () => {
        it('uses the new Provider model and clears the previous Key while changing Providers', async () => {
            let finishOldRequest!: (models: Array<{ id: string }>) => void;
            catalog.models
                .mockImplementationOnce(() => new Promise(resolve => { finishOldRequest = resolve; }))
                .mockResolvedValueOnce([{ id: 'anthropic/team:v2' }]);
            render(<AddProviderModal isOpen={true} {...mockHandlers} />);
            await screen.findByText('Select a provider');
            const provider = screen.getByLabelText('Provider *');
            fireEvent.click(provider);
            fireEvent.click(screen.getByRole('option', { name: /openai/i }));
            await waitFor(() => expect(catalog.models).toHaveBeenCalledWith({ providerId: 'openai' }));
            const apiKey = screen.getByLabelText('API Key *');
            fireEvent.change(apiKey, { target: { value: 'fixture-openai' } });
            const save = screen.getByRole('button', { name: 'Add Provider' });
            expect(save).toBeDisabled();

            fireEvent.click(provider);
            fireEvent.click(screen.getByRole('option', { name: /anthropic/i }));
            await screen.findByText('anthropic/team:v2');
            await act(async () => finishOldRequest([{ id: rawModel }]));
            expect(apiKey).toHaveValue('');
            expect(screen.getByLabelText('Default Model *')).toHaveTextContent('anthropic/team:v2');
            expect(save).toBeDisabled();

            fireEvent.change(apiKey, { target: { value: 'fixture-anthropic' } });
            fireEvent.click(save);
            await waitFor(() => expect(mockHandlers.onSave).toHaveBeenCalledWith(expect.objectContaining({
                providerId: 'anthropic', model: 'anthropic/team:v2', apiKey: 'fixture-anthropic',
            })));
        });

        it('should call onSave with correct data when save button is clicked', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            // Fill custom name
            const customNameInput = screen.getByLabelText('Display Name *') as HTMLInputElement;
            fireEvent.change(customNameInput, { target: { value: 'My OpenAI Account' } });

            // Fill API key
            const apiKeyInput = screen.getByLabelText('API Key *') as HTMLInputElement;
            fireEvent.change(apiKeyInput, { target: { value: 'sk-test1234567890abcdef' } });

            // Click save
            const saveButton = screen.getByRole('button', { name: 'Add Provider' });
            fireEvent.click(saveButton);

            await waitFor(() => {
                expect(mockHandlers.onSave).toHaveBeenCalledWith({
                    providerId: 'openai',
                    customName: 'My OpenAI Account',
                    apiKey: 'sk-test1234567890abcdef',
                    model: rawModel,
                });
            });
        });

        it('should call onClose after successful save', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider and fill fields
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            const apiKeyInput = screen.getByLabelText('API Key *') as HTMLInputElement;
            fireEvent.change(apiKeyInput, { target: { value: 'sk-test1234567890abcdef' } });

            // Click save
            const saveButton = screen.getByRole('button', { name: 'Add Provider' });
            fireEvent.click(saveButton);

            await waitFor(() => {
                expect(mockHandlers.onClose).toHaveBeenCalled();
            });
        });

        it('should call onClose when cancel button is clicked', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByRole('dialog')).toBeInTheDocument();
            });

            const cancelButton = screen.getByRole('button', { name: /cancel/i });
            fireEvent.click(cancelButton);

            expect(mockHandlers.onClose).toHaveBeenCalled();
        });

        it('should call onClose when close button is clicked', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByRole('dialog')).toBeInTheDocument();
            });

            const closeButton = screen.getByLabelText('Close modal');
            fireEvent.click(closeButton);

            expect(mockHandlers.onClose).toHaveBeenCalled();
        });

        it('should call onClose when backdrop is clicked', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByRole('dialog')).toBeInTheDocument();
            });

            const backdrop = screen.getByRole('dialog');
            fireEvent.click(backdrop);

            expect(mockHandlers.onClose).toHaveBeenCalled();
        });

        it('should call onClose when Escape key is pressed', async () => {
            render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByRole('dialog')).toBeInTheDocument();
            });

            fireEvent.keyDown(document, { key: 'Escape' });

            expect(mockHandlers.onClose).toHaveBeenCalled();
        });

        it('should disable buttons while saving', async () => {
            const slowSave = vi.fn(() => new Promise(resolve => setTimeout(resolve, 1000)));
            
            render(
                <AddProviderModal
                    isOpen={true}
                    onClose={mockHandlers.onClose}
                    onSave={slowSave}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Select provider and fill fields
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            const apiKeyInput = screen.getByLabelText('API Key *') as HTMLInputElement;
            fireEvent.change(apiKeyInput, { target: { value: 'sk-test1234567890abcdef' } });

            // Click save
            const saveButton = screen.getByRole('button', { name: 'Add Provider' });
            fireEvent.click(saveButton);

            // Buttons should be disabled while saving
            await waitFor(() => {
                expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
                expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
            });
        });

        it('should reset form when modal closes', async () => {
            const { rerender } = render(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });

            // Fill form
            const dropdownButton = screen.getByLabelText('Provider *');
            fireEvent.click(dropdownButton);
            
            await waitFor(() => {
                const openaiOption = screen.getByRole('option', { name: /openai/i });
                fireEvent.click(openaiOption);
            });

            const apiKeyInput = screen.getByLabelText('API Key *') as HTMLInputElement;
            fireEvent.change(apiKeyInput, { target: { value: 'sk-test1234567890abcdef' } });

            // Close modal
            rerender(
                <AddProviderModal
                    isOpen={false}
                    {...mockHandlers}
                />
            );

            // Reopen modal
            rerender(
                <AddProviderModal
                    isOpen={true}
                    {...mockHandlers}
                />
            );

            // Form should be reset
            await waitFor(() => {
                expect(screen.getByText(/select a provider/i)).toBeInTheDocument();
            });
        });
    });
});
