/**
 * @aotui/host - tRPC ModelRegistry Router Tests
 * 
 * 测试 modelRegistry tRPC 路由的功能、参数验证、错误处理和类型安全
 * 
 * Requirements: 8.2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import type { ModelRegistry } from '../src/services/model-registry.js';
import type { HostManagerV2 } from '../src/core/host-manager-v2.js';
import type { LLMConfigService } from '../src/core/llm-config-service.js';

describe('tRPC ModelRegistry Router', () => {
    let mockModelRegistry: ModelRegistry;
    let mockHostManager: HostManagerV2;
    let mockLLMConfigService: LLMConfigService;
    let caller: ReturnType<typeof appRouter.createCaller>;

    beforeEach(() => {
        // Mock ModelRegistry
        mockModelRegistry = {
            getProviders: vi.fn(),
            getModels: vi.fn(),
        } as any;

        // Mock HostManager (minimal mock)
        mockHostManager = {} as any;

        // Mock LLMConfigService (minimal mock)
        mockLLMConfigService = {} as any;

        // Create tRPC caller with mocked context
        caller = appRouter.createCaller({
            hostManager: mockHostManager,
            llmConfigService: mockLLMConfigService,
            modelRegistry: mockModelRegistry,
        });
    });

    describe('getProviders', () => {
        it('should return list of providers', async () => {
            const mockProviders = [
                {
                    id: 'openai',
                    name: 'OpenAI',
                    baseURL: 'https://api.openai.com/v1',
                    modelCount: 5,
                },
                {
                    id: 'anthropic',
                    name: 'Anthropic',
                    baseURL: 'https://api.anthropic.com/v1',
                    modelCount: 3,
                },
            ];

            vi.mocked(mockModelRegistry.getProviders).mockResolvedValue(mockProviders);

            const result = await caller.modelRegistry.getProviders();

            expect(result).toEqual(mockProviders);
            expect(mockModelRegistry.getProviders).toHaveBeenCalledTimes(1);
        });

        it('should handle empty provider list', async () => {
            vi.mocked(mockModelRegistry.getProviders).mockResolvedValue([]);

            const result = await caller.modelRegistry.getProviders();

            expect(result).toEqual([]);
        });

        it('should propagate errors from ModelRegistry', async () => {
            const error = new Error('Failed to fetch providers');
            vi.mocked(mockModelRegistry.getProviders).mockRejectedValue(error);

            await expect(caller.modelRegistry.getProviders()).rejects.toThrow(
                'Failed to fetch providers'
            );
        });
    });

    describe('getModels', () => {
        it('should return all models without filter', async () => {
            const mockModels = [
                {
                    id: 'openai/gpt-4',
                    name: 'GPT-4',
                    tool_call: true,
                    reasoning: false,
                    cost: { input: 30, output: 60 },
                },
                {
                    id: 'anthropic/claude-3-5-sonnet',
                    name: 'Claude 3.5 Sonnet',
                    tool_call: true,
                    reasoning: false,
                    cost: { input: 3, output: 15 },
                },
            ];

            vi.mocked(mockModelRegistry.getModels).mockResolvedValue(mockModels);

            const result = await caller.modelRegistry.getModels({});

            expect(result).toEqual(mockModels);
            expect(mockModelRegistry.getModels).toHaveBeenCalledWith({});
        });

        it('should filter by providerId', async () => {
            const mockModels = [
                {
                    id: 'openai/gpt-4',
                    name: 'GPT-4',
                    tool_call: true,
                },
            ];

            vi.mocked(mockModelRegistry.getModels).mockResolvedValue(mockModels);

            const result = await caller.modelRegistry.getModels({
                providerId: 'openai',
            });

            expect(result).toEqual(mockModels);
            expect(mockModelRegistry.getModels).toHaveBeenCalledWith({
                providerId: 'openai',
            });
        });

        it('should filter by capability', async () => {
            const mockModels = [
                {
                    id: 'openai/gpt-4',
                    name: 'GPT-4',
                    tool_call: true,
                    reasoning: false,
                },
            ];

            vi.mocked(mockModelRegistry.getModels).mockResolvedValue(mockModels);

            const result = await caller.modelRegistry.getModels({
                capability: 'tool_call',
            });

            expect(result).toEqual(mockModels);
            expect(mockModelRegistry.getModels).toHaveBeenCalledWith({
                capability: 'tool_call',
            });
        });

        it('should filter by maxInputCost', async () => {
            const mockModels = [
                {
                    id: 'anthropic/claude-3-5-haiku',
                    name: 'Claude 3.5 Haiku',
                    cost: { input: 1, output: 5 },
                },
            ];

            vi.mocked(mockModelRegistry.getModels).mockResolvedValue(mockModels);

            const result = await caller.modelRegistry.getModels({
                maxInputCost: 5,
            });

            expect(result).toEqual(mockModels);
            expect(mockModelRegistry.getModels).toHaveBeenCalledWith({
                maxInputCost: 5,
            });
        });

        it('should support multiple filters', async () => {
            const mockModels = [
                {
                    id: 'openai/gpt-4o-mini',
                    name: 'GPT-4o Mini',
                    tool_call: true,
                    cost: { input: 0.15, output: 0.6 },
                },
            ];

            vi.mocked(mockModelRegistry.getModels).mockResolvedValue(mockModels);

            const result = await caller.modelRegistry.getModels({
                providerId: 'openai',
                capability: 'tool_call',
                maxInputCost: 1,
            });

            expect(result).toEqual(mockModels);
            expect(mockModelRegistry.getModels).toHaveBeenCalledWith({
                providerId: 'openai',
                capability: 'tool_call',
                maxInputCost: 1,
            });
        });

        it('should validate capability enum', async () => {
            // Test with invalid capability
            await expect(
                caller.modelRegistry.getModels({ capability: 'invalid' } as any)
            ).rejects.toThrow();
        });

        it('should validate maxInputCost type', async () => {
            // Test with invalid type
            await expect(
                caller.modelRegistry.getModels({ maxInputCost: 'not-a-number' } as any)
            ).rejects.toThrow();
        });

        it('should handle empty result', async () => {
            vi.mocked(mockModelRegistry.getModels).mockResolvedValue([]);

            const result = await caller.modelRegistry.getModels({
                providerId: 'nonexistent',
            });

            expect(result).toEqual([]);
        });
    });

    describe('Type Safety', () => {
        it('should enforce correct input types for getModels', async () => {
            vi.mocked(mockModelRegistry.getModels).mockResolvedValue([]);

            // This should compile without errors
            const result = await caller.modelRegistry.getModels({
                providerId: 'openai',
                capability: 'reasoning',
                maxInputCost: 10,
            });

            expect(Array.isArray(result)).toBe(true);
        });

        it('should return correctly typed responses', async () => {
            const mockProviders = [
                {
                    id: 'openai',
                    name: 'OpenAI',
                    baseURL: 'https://api.openai.com/v1',
                    modelCount: 5,
                },
            ];

            vi.mocked(mockModelRegistry.getProviders).mockResolvedValue(mockProviders);

            const result = await caller.modelRegistry.getProviders();

            // TypeScript should infer the correct type
            expect(result[0].id).toBe('openai');
            expect(result[0].modelCount).toBe(5);
        });
    });

    describe('Error Handling', () => {
        it('should handle network errors gracefully', async () => {
            const networkError = new Error('Network request failed');
            vi.mocked(mockModelRegistry.getProviders).mockRejectedValue(networkError);

            await expect(caller.modelRegistry.getProviders()).rejects.toThrow(
                'Network request failed'
            );
        });

        it('should handle validation errors with clear messages', async () => {
            // Invalid capability value
            await expect(
                caller.modelRegistry.getModels({ capability: 'invalid_capability' } as any)
            ).rejects.toThrow();
        });

        it('should handle ModelRegistry internal errors', async () => {
            const internalError = new Error('Internal ModelRegistry error');
            vi.mocked(mockModelRegistry.getModels).mockRejectedValue(internalError);

            await expect(
                caller.modelRegistry.getModels({})
            ).rejects.toThrow('Internal ModelRegistry error');
        });
    });

    describe('Integration with Context', () => {
        it('should access ModelRegistry from context', async () => {
            vi.mocked(mockModelRegistry.getProviders).mockResolvedValue([]);

            await caller.modelRegistry.getProviders();

            // Verify that the mock was called, proving context injection works
            expect(mockModelRegistry.getProviders).toHaveBeenCalled();
        });

        it('should not interfere with other routers', async () => {
            // Ensure modelRegistry router doesn't affect other routers
            expect(caller.db).toBeDefined();
            expect(caller.chat).toBeDefined();
            expect(caller.session).toBeDefined();
            expect(caller.project).toBeDefined();
            expect(caller.llmConfig).toBeDefined();
        });
    });
});
