import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { loadOptionalSetting } from '@ai-sdk/provider-utils';
import type { LanguageModel } from 'ai';
import type { LLMConfig } from './interfaces.js';

const PROVIDER_BASE_URLS = new Map([
    ['openai', 'https://api.openai.com/v1'],
    ['anthropic', 'https://api.anthropic.com/v1'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta'],
    ['deepseek', 'https://api.deepseek.com'],
    ['xai', 'https://api.x.ai/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
]);

export function resolveProviderEndpoint(providerId: string, configuredBaseURL?: string) {
    const defaultBaseURL = PROVIDER_BASE_URLS.get(providerId);
    const configured = providerId === 'openai' || providerId === 'anthropic'
        ? loadOptionalSetting({ settingValue: configuredBaseURL, environmentVariableName: providerId.toUpperCase() + '_BASE_URL' })
        : configuredBaseURL;
    return { baseURL: (providerId === 'xai' ? configured || defaultBaseURL : configured ?? defaultBaseURL), defaultBaseURL };
}

export function validateModelConfig(config: LLMConfig): void {
    const id = config?.provider?.id;
    if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
        throw new Error('An explicit provider.id is required.');
    }
    if (typeof config.model !== 'string' || !config.model.trim()) {
        throw new Error('A nonempty model ID is required.');
    }
}

export function createLanguageModel(config: LLMConfig): Extract<LanguageModel, { specificationVersion: 'v3' }> {
    validateModelConfig(config);
    const { id: providerId, baseURL, headers } = config.provider;
    const apiKey = config.apiKey || getApiKeyFromEnv(providerId);
    if (!apiKey) {
        throw new Error(
            `API key not found for provider: ${providerId}. ` +
            `Please set ${getEnvKeyName(providerId)} or provide apiKey in config.`
        );
    }

    return buildProvider(providerId, apiKey, baseURL, headers).languageModel(config.model);
}

function buildProvider(
    providerId: string,
    apiKey: string,
    customBaseURL: string | undefined,
    headers: Record<string, string> | undefined
) {
    const { baseURL } = resolveProviderEndpoint(providerId, customBaseURL);
    switch (providerId) {
        case 'anthropic':
            return createAnthropic({ apiKey, baseURL, headers });
        case 'google':
            return createGoogleGenerativeAI({ apiKey, baseURL, headers });
        case 'deepseek':
            return createDeepSeek({ apiKey, baseURL, headers });
        case 'xai':
            return createOpenAI({ apiKey, baseURL, headers });
        case 'openai':
            if (baseURL && !isOpenAIResponsesEndpoint(baseURL)) {
                return createOpenAICompatible({
                    name: 'openai-compatible',
                    apiKey,
                    baseURL,
                    headers,
                });
            }
            return createOpenAI({ apiKey, baseURL, headers });
        case 'openrouter':
            return createOpenRouter({
                apiKey,
                baseURL,
                headers,
                compatibility: 'strict',
            });
        default: {
            if (!baseURL) {
                throw new Error(
                    `Provider "${providerId}" requires a baseURL. ` +
                    `Please configure the baseURL in your LLM config (typically from ModelRegistry).`
                );
            }

            return createOpenAICompatible({
                name: providerId,
                apiKey,
                baseURL,
                headers,
            });
        }
    }
}

function isOpenAIResponsesEndpoint(baseURL: string): boolean {
    try {
        const { hostname } = new URL(baseURL);
        return hostname === 'api.openai.com';
    } catch {
        return false;
    }
}

function getApiKeyFromEnv(providerId: string): string | undefined {
    return process.env[getEnvKeyName(providerId)] ||
        (providerId === 'google' ? process.env.GOOGLE_GENERATIVE_AI_API_KEY : undefined);
}

function getEnvKeyName(providerId: string): string {
    return `${providerId.toUpperCase()}_API_KEY`;
}
