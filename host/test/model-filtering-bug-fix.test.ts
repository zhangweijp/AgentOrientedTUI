/**
 * Bug Fix Verification: Provider Model Filtering
 * 
 * This test verifies the fix for the bug where selecting a provider
 * would incorrectly show models from other providers if their model
 * names contained the provider ID.
 * 
 * Example Bug:
 * - Selecting "deepseek" provider
 * - Expected: Only show deepseek/deepseek-chat and deepseek/deepseek-reasoner
 * - Bug: Also showed other-provider/deepseek-model (incorrect!)
 * 
 * Root Cause:
 * - Old code used: models.filter(m => m.id.startsWith(`${providerId}/`))
 * - This would match ANY model ID starting with the provider name
 * - Including models from other providers with similar names
 * 
 * Fix:
 * - New code directly accesses: modelsDevData[providerId].models
 * - Only returns models that actually belong to the specified provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelRegistry } from '../src/services/model-registry.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// Mock fs module
vi.mock('fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('File not found')),
}));

describe('Bug Fix: Provider Model Filtering', () => {
    let registry: ModelRegistry;

    // Mock data that demonstrates the bug
    const mockModelsDevData = {
        deepseek: {
            id: 'deepseek',
            name: 'DeepSeek',
            env: ['DEEPSEEK_API_KEY'],
            api: 'https://api.deepseek.com/v1',
            models: {
                'deepseek-chat': {
                    id: 'deepseek/deepseek-chat',
                    name: 'DeepSeek Chat',
                    family: 'deepseek',
                    tool_call: true,
                },
                'deepseek-reasoner': {
                    id: 'deepseek/deepseek-reasoner',
                    name: 'DeepSeek Reasoner',
                    family: 'deepseek',
                    reasoning: true,
                },
            },
        },
        openai: {
            id: 'openai',
            name: 'OpenAI',
            env: ['OPENAI_API_KEY'],
            api: 'https://api.openai.com/v1',
            models: {
                'gpt-4o': {
                    id: 'openai/gpt-4o',
                    name: 'GPT-4o',
                    family: 'gpt-4',
                    tool_call: true,
                },
                // This model name contains "deepseek" but belongs to OpenAI
                'deepseek-compatible': {
                    id: 'openai/deepseek-compatible',
                    name: 'OpenAI DeepSeek Compatible',
                    family: 'gpt-4',
                    tool_call: true,
                },
            },
        },
        anthropic: {
            id: 'anthropic',
            name: 'Anthropic',
            env: ['ANTHROPIC_API_KEY'],
            api: 'https://api.anthropic.com/v1',
            models: {
                'claude-3-5-sonnet': {
                    id: 'anthropic/claude-3-5-sonnet',
                    name: 'Claude 3.5 Sonnet',
                    family: 'claude-3.5',
                    tool_call: true,
                },
            },
        },
    };

    beforeEach(() => {
        registry = new ModelRegistry();
        vi.clearAllMocks();

        // Mock successful API response
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => mockModelsDevData,
        });
    });

    it('should only return models from the specified provider (deepseek)', async () => {
        // Get models for deepseek provider
        const deepseekModels = await registry.getModels({ providerId: 'deepseek' });

        // Should only return 2 models from deepseek
        expect(deepseekModels).toHaveLength(2);

        // Verify specific models
        expect(deepseekModels.map(m => m.id)).toEqual([
            'deepseek-chat',
            'deepseek-reasoner',
        ]);

        // CRITICAL: Should NOT include openai/deepseek-compatible
        expect(deepseekModels.some(m => m.id === 'deepseek-compatible')).toBe(false);
    });

    it('should only return models from the specified provider (openai)', async () => {
        // Get models for openai provider
        const openaiModels = await registry.getModels({ providerId: 'openai' });

        // Should return 2 models from openai
        expect(openaiModels).toHaveLength(2);

        expect(openaiModels.map(m => m.id).sort()).toEqual(['deepseek-compatible', 'gpt-4o']);
    });

    it('should not leak models between providers', async () => {
        // Get models for each provider
        const deepseekModels = await registry.getModels({ providerId: 'deepseek' });
        const openaiModels = await registry.getModels({ providerId: 'openai' });
        const anthropicModels = await registry.getModels({ providerId: 'anthropic' });

        // Verify no overlap between provider models
        const deepseekIds = new Set(deepseekModels.map(m => m.id));
        const openaiIds = new Set(openaiModels.map(m => m.id));
        const anthropicIds = new Set(anthropicModels.map(m => m.id));

        // No deepseek model should appear in openai or anthropic
        openaiModels.forEach(m => {
            expect(deepseekIds.has(m.id)).toBe(false);
        });
        anthropicModels.forEach(m => {
            expect(deepseekIds.has(m.id)).toBe(false);
        });

        // No openai model should appear in deepseek or anthropic
        deepseekModels.forEach(m => {
            expect(openaiIds.has(m.id)).toBe(false);
        });
        anthropicModels.forEach(m => {
            expect(openaiIds.has(m.id)).toBe(false);
        });

        // No anthropic model should appear in deepseek or openai
        deepseekModels.forEach(m => {
            expect(anthropicIds.has(m.id)).toBe(false);
        });
        openaiModels.forEach(m => {
            expect(anthropicIds.has(m.id)).toBe(false);
        });
    });

    it('should return empty array for non-existent provider', async () => {
        const models = await registry.getModels({ providerId: 'nonexistent' });

        expect(models).toHaveLength(0);
    });

    it('should return all models when no provider filter is specified', async () => {
        const allModels = await registry.getModels();

        // Should return all 5 models (2 deepseek + 2 openai + 1 anthropic)
        expect(allModels).toHaveLength(5);

        const catalogKeys = Object.values(mockModelsDevData).flatMap(provider => Object.keys(provider.models));
        expect(allModels.map(m => m.id).sort()).toEqual(catalogKeys.sort());
    });

    it('should correctly filter by provider even with similar model names', async () => {
        const deepseekModels = await registry.getModels({ providerId: 'deepseek' });
        const openaiModels = await registry.getModels({ providerId: 'openai' });
        expect(openaiModels.map(m => m.id)).toContain('deepseek-compatible');
        expect(deepseekModels.map(m => m.id)).not.toContain('deepseek-compatible');
    });
});
