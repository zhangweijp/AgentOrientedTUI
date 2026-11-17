/**
 * Settings Panel - Validation Utilities Property-Based Tests
 * 
 * Property-based tests for provider configuration validation using fast-check
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { validateProviderConfig } from './validation.js';
import type { ProviderConfig, NewProviderConfig } from './types.js';

/**
 * Arbitrary generator for ProviderConfig
 */
const arbitraryProviderConfig = (): fc.Arbitrary<ProviderConfig> => {
    return fc.record({
        id: fc.integer({ min: 1, max: 10000 }),
        providerId: fc.constantFrom('openai', 'anthropic', 'google', 'cohere', 'mistral'),
        customName: fc.string({ minLength: 3, maxLength: 30 }),
        apiKey: fc.string({ minLength: 10, maxLength: 50 }),
        isActive: fc.boolean(),
        model: fc.string({ minLength: 3, maxLength: 30 }),
        temperature: fc.float({ min: 0, max: 2 }),
        maxSteps: fc.integer({ min: 1, max: 100 }),
        createdAt: fc.integer({ min: 1600000000000, max: 1700000000000 }),
        updatedAt: fc.integer({ min: 1600000000000, max: 1700000000000 }),
    });
};

/**
 * Arbitrary generator for NewProviderConfig
 */
const arbitraryNewProviderConfig = (): fc.Arbitrary<NewProviderConfig> => {
    return fc.record({
        providerId: fc.constantFrom('openai', 'anthropic', 'google', 'cohere', 'mistral'),
        customName: fc.string({ minLength: 3, maxLength: 30 }).filter(s => s.trim().length >= 3),
        apiKey: fc.string({ minLength: 10, maxLength: 50 }).filter(s => s.trim().length >= 10),
    });
};

describe('Validation Utilities - Property-Based Tests', () => {
    /**
     * Property: Valid provider configs pass validation
     * 
     * Verifies that valid provider configurations pass validation.
     */
    it('valid provider configs pass validation', () => {
        fc.assert(
            fc.property(
                arbitraryNewProviderConfig(),
                (config) => {
                    const result = validateProviderConfig(config, []);
                    return result.isValid === true && Object.keys(result.errors).length === 0;
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Empty provider ID fails validation
     * 
     * Verifies that empty or whitespace provider IDs are rejected.
     */
    it('empty provider ID fails validation', () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 3, maxLength: 30 }),
                fc.string({ minLength: 10, maxLength: 50 }),
                (customName, apiKey) => {
                    const config: NewProviderConfig = {
                        providerId: '',
                        customName,
                        apiKey,
                    };

                    const result = validateProviderConfig(config, []);
                    return result.isValid === false && result.errors.providerId !== undefined;
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Empty custom name fails validation
     * 
     * Verifies that empty or whitespace custom names are rejected.
     */
    it('empty custom name fails validation', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('openai', 'anthropic', 'google'),
                fc.string({ minLength: 10, maxLength: 50 }),
                (providerId, apiKey) => {
                    const config: NewProviderConfig = {
                        providerId,
                        customName: '',
                        apiKey,
                    };

                    const result = validateProviderConfig(config, []);
                    return result.isValid === false && result.errors.customName !== undefined;
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Short custom name fails validation
     * 
     * Verifies that custom names shorter than 3 characters are rejected.
     */
    it('short custom name fails validation', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('openai', 'anthropic', 'google'),
                fc.string({ minLength: 1, maxLength: 2 }),
                fc.string({ minLength: 10, maxLength: 50 }),
                (providerId, customName, apiKey) => {
                    const config: NewProviderConfig = {
                        providerId,
                        customName,
                        apiKey,
                    };

                    const result = validateProviderConfig(config, []);
                    return result.isValid === false && result.errors.customName !== undefined;
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Empty API key fails validation
     * 
     * Verifies that empty or whitespace API keys are rejected.
     */
    it('empty API key fails validation', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('openai', 'anthropic', 'google'),
                fc.string({ minLength: 3, maxLength: 30 }),
                (providerId, customName) => {
                    const config: NewProviderConfig = {
                        providerId,
                        customName,
                        apiKey: '',
                    };

                    const result = validateProviderConfig(config, []);
                    return result.isValid === false && result.errors.apiKey !== undefined;
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Short API key fails validation
     * 
     * Verifies that API keys shorter than 10 characters are rejected.
     */
    it('short API key fails validation', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('openai', 'anthropic', 'google'),
                fc.string({ minLength: 3, maxLength: 30 }),
                fc.string({ minLength: 1, maxLength: 9 }),
                (providerId, customName, apiKey) => {
                    const config: NewProviderConfig = {
                        providerId,
                        customName,
                        apiKey,
                    };

                    const result = validateProviderConfig(config, []);
                    return result.isValid === false && result.errors.apiKey !== undefined;
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Duplicate name detection is case-insensitive
     * 
     * Verifies that duplicate name detection works regardless of case.
     */
    it('duplicate name detection is case-insensitive', () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 3, maxLength: 30 }).filter(name => name.trim().length >= 3),
                (customName) => {
                    const existingProvider: ProviderConfig = {
                        id: 1,
                        providerId: 'openai',
                        customName: customName.toLowerCase(),
                        apiKey: 'test-api-key-123',
                        isActive: false,
                        model: 'gpt-4',
                        temperature: 0.7,
                        maxSteps: 10,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    };

                    // Try to add a provider with the same name in different case
                    const { providerId, apiKey } = existingProvider;
                    const upperCaseResult = validateProviderConfig(
                        { providerId, apiKey, customName: customName.toUpperCase() },
                        [existingProvider]
                    );

                    const mixedCaseResult = validateProviderConfig(
                        { providerId, apiKey, customName },
                        [existingProvider]
                    );

                    // Both should fail validation
                    return (
                        upperCaseResult.errors.customName === 'This name is already in use' &&
                        mixedCaseResult.errors.customName === 'This name is already in use'
                    );
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Validation with existing providers detects duplicates
     * 
     * Verifies that validation correctly detects duplicate names when
     * existing providers are provided.
     */
    it('validation with existing providers detects duplicates', () => {
        fc.assert(
            fc.property(
                fc.array(arbitraryProviderConfig(), { minLength: 1, maxLength: 10 }),
                (existingProviders) => {
                    // Pick a random existing provider's name
                    const existingName = existingProviders[0].customName;

                    // Try to create a new provider with the same name
                    const config: NewProviderConfig = {
                        providerId: 'openai',
                        customName: existingName,
                        apiKey: 'test-api-key-123',
                    };

                    const result = validateProviderConfig(config, existingProviders);

                    // Should fail validation due to duplicate name
                    return result.isValid === false && result.errors.customName !== undefined;
                }
            ),
            { numRuns: 100 }
        );
    });
});
