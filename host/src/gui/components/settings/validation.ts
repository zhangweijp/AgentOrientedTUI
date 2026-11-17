/**
 * Settings Panel - Form Validation Utilities
 * 
 * Validation functions for configuration form inputs
 */

import type { ValidationErrors, ValidationResult, ProviderConfig, NewProviderConfig } from './types.js';

/**
 * Validates a provider configuration (V2)
 * 
 * Validates provider ID, custom name, and API key according to requirements:
 * - Provider ID: Required, not empty
 * - Custom Name: Required, not empty, min 3 chars, unique
 * - API Key: Required, not empty, min 10 chars
 * 
 * @param config - The provider configuration to validate
 * @param existingProviders - Array of existing provider configurations (for uniqueness check)
 * @returns Validation result with errors
 * 
 * Requirements: 5.6, 5.7, 5.8
 */
export function validateProviderConfig(
    config: NewProviderConfig,
    existingProviders: ProviderConfig[] = []
): ValidationResult {
    const errors: ValidationErrors = {};

    // Validate provider ID (required, not empty)
    if (!config.providerId || config.providerId.trim().length === 0) {
        errors.providerId = 'Provider is required';
    }

    // Validate custom name (required, not empty, min 3 chars, unique)
    const trimmedCustomName = config.customName?.trim() || '';
    if (!config.customName || trimmedCustomName.length === 0) {
        errors.customName = 'Custom name is required';
    } else if (trimmedCustomName.length < 3) {
        errors.customName = 'Custom name must be at least 3 characters';
    } else {
        // Check uniqueness (case-insensitive)
        const normalizedName = trimmedCustomName.toLowerCase();
        const isDuplicate = existingProviders.some(
            provider => provider.customName.trim().toLowerCase() === normalizedName
        );
        if (isDuplicate) {
            errors.customName = 'This name is already in use';
        }
    }

    // Validate API key (required, not empty, min 10 chars)
    const trimmedApiKey = config.apiKey?.trim() || '';
    if (!config.apiKey || trimmedApiKey.length === 0) {
        errors.apiKey = 'API key is required';
    } else if (trimmedApiKey.length < 10) {
        errors.apiKey = 'API key must be at least 10 characters';
    }

    return {
        isValid: Object.keys(errors).length === 0,
        errors,
    };
}
