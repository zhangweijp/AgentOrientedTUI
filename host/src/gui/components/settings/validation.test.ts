/**
 * Settings Panel - Validation Utilities Unit Tests
 * 
 * Unit tests for provider configuration validation functions
 */

import { describe, it, expect } from 'vitest';
import { validateProviderConfig } from './validation.js';
import type { ProviderConfig, NewProviderConfig } from './types.js';
import { createMockProvider } from './__tests__/mock-provider.js';

describe('validateProviderConfig', () => {
    const mockExistingProviders: ProviderConfig[] = [
        createMockProvider({
            id: 1,
            providerId: 'openai',
            customName: 'OpenAI Production',
            isActive: true,
        }),
        createMockProvider({
            id: 2,
            providerId: 'anthropic',
            customName: 'Anthropic Dev',
            isActive: false,
        }),
    ];

    describe('valid configurations', () => {
        it('should pass validation for valid config', () => {
            const config: NewProviderConfig = {
                providerId: 'google',
                customName: 'Google Testing',
                apiKey: 'sk-test-key-valid',
            };

            const result = validateProviderConfig(config, mockExistingProviders);

            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors)).toHaveLength(0);
        });

        it('should pass validation with minimum valid lengths', () => {
            const config: NewProviderConfig = {
                providerId: 'x',
                customName: 'abc', // Exactly 3 chars
                apiKey: '1234567890', // Exactly 10 chars
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors)).toHaveLength(0);
        });

        it('should pass validation with long values', () => {
            const config: NewProviderConfig = {
                providerId: 'very-long-provider-id-that-is-still-valid',
                customName: 'A very long custom name that should still be valid',
                apiKey: 'sk-very-long-api-key-that-is-definitely-more-than-10-characters',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors)).toHaveLength(0);
        });
    });

    describe('provider ID validation', () => {
        it('should fail when provider ID is empty', () => {
            const config: NewProviderConfig = {
                providerId: '',
                customName: 'Valid Name',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.providerId).toBe('Provider is required');
        });

        it('should fail when provider ID is whitespace only', () => {
            const config: NewProviderConfig = {
                providerId: '   ',
                customName: 'Valid Name',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.providerId).toBe('Provider is required');
        });
    });

    describe('custom name validation', () => {
        it('should fail when custom name is empty', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: '',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('Custom name is required');
        });

        it('should fail when custom name is whitespace only', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: '   ',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('Custom name is required');
        });

        it('should fail when custom name is less than 3 characters', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'ab',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('Custom name must be at least 3 characters');
        });

        it('should fail when custom name is 1 character', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'a',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('Custom name must be at least 3 characters');
        });

        it('should fail when custom name is duplicate (exact match)', () => {
            const config: NewProviderConfig = {
                providerId: 'google',
                customName: 'OpenAI Production',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, mockExistingProviders);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('This name is already in use');
        });

        it('should fail when custom name is duplicate (case-insensitive)', () => {
            const config: NewProviderConfig = {
                providerId: 'google',
                customName: 'openai production',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, mockExistingProviders);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('This name is already in use');
        });

        it('should fail when custom name is duplicate (uppercase)', () => {
            const config: NewProviderConfig = {
                providerId: 'google',
                customName: 'ANTHROPIC DEV',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, mockExistingProviders);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('This name is already in use');
        });

        it('should fail when custom name is duplicate with extra whitespace', () => {
            const config: NewProviderConfig = {
                providerId: 'google',
                customName: '  OpenAI Production  ',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, mockExistingProviders);

            expect(result.isValid).toBe(false);
            expect(result.errors.customName).toBe('This name is already in use');
        });
    });

    describe('API key validation', () => {
        it('should fail when API key is empty', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'Valid Name',
                apiKey: '',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.apiKey).toBe('API key is required');
        });

        it('should fail when API key is whitespace only', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'Valid Name',
                apiKey: '   ',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.apiKey).toBe('API key is required');
        });

        it('should fail when API key is less than 10 characters', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'Valid Name',
                apiKey: 'short',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.apiKey).toBe('API key must be at least 10 characters');
        });

        it('should fail when API key is exactly 9 characters', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'Valid Name',
                apiKey: '123456789',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.apiKey).toBe('API key must be at least 10 characters');
        });
    });

    describe('multiple validation errors', () => {
        it('should return all validation errors when multiple fields are invalid', () => {
            const config: NewProviderConfig = {
                providerId: '',
                customName: 'ab',
                apiKey: 'short',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(false);
            expect(result.errors.providerId).toBe('Provider is required');
            expect(result.errors.customName).toBe('Custom name must be at least 3 characters');
            expect(result.errors.apiKey).toBe('API key must be at least 10 characters');
            expect(Object.keys(result.errors)).toHaveLength(3);
        });

        it('should return all errors including duplicate name', () => {
            const config: NewProviderConfig = {
                providerId: '',
                customName: 'OpenAI Production',
                apiKey: 'short',
            };

            const result = validateProviderConfig(config, mockExistingProviders);

            expect(result.isValid).toBe(false);
            expect(result.errors.providerId).toBe('Provider is required');
            expect(result.errors.customName).toBe('This name is already in use');
            expect(result.errors.apiKey).toBe('API key must be at least 10 characters');
            expect(Object.keys(result.errors)).toHaveLength(3);
        });
    });

    describe('edge cases', () => {
        it('should handle empty existing providers array', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'Valid Name',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors)).toHaveLength(0);
        });

        it('should handle special characters in custom name', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'My-Provider_123!',
                apiKey: 'valid-api-key',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors)).toHaveLength(0);
        });

        it('should handle special characters in API key', () => {
            const config: NewProviderConfig = {
                providerId: 'openai',
                customName: 'Valid Name',
                apiKey: 'sk-test_key-123!@#',
            };

            const result = validateProviderConfig(config, []);

            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors)).toHaveLength(0);
        });
    });
});
