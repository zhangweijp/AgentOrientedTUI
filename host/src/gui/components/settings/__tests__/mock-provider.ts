import type { ProviderConfig } from '../types.js';

export function createMockProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        id: 1,
        providerId: 'openai',
        customName: 'My OpenAI',
        apiKey: 'sk-test-key-1234567890',
        isActive: false,
        model: 'gpt-4',
        temperature: 0.7,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
    };
}
