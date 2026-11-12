import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createProviderRegistry, customProvider } from 'ai';
import { loadOptionalSetting } from '@ai-sdk/provider-utils';
import type { LLMConfig } from './interfaces.js';

export interface ModelTarget {
    providerId: string;
    modelName: string;
    registryModelId: string;
}

export interface ProviderFactoryDeps {
    config: LLMConfig;
    target: ModelTarget;
    warn: (message: string) => void;
}

const ENV_KEY_MAP: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    xai: 'XAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
};

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

export function createLanguageModel(deps: ProviderFactoryDeps): ReturnType<ReturnType<typeof createProviderRegistry>['languageModel']> {
    const { config, target } = deps;
    const { providerId, modelName, registryModelId } = target;

    const apiKey = config.apiKey || getApiKeyFromEnv(providerId);
    if (!apiKey) {
        throw new Error(
            `API key not found for provider: ${providerId}. ` +
            `Please set ${getEnvKeyName(providerId)} or provide apiKey in config.`
        );
    }

    const customBaseURL = config.provider?.id === providerId
        ? config.provider.baseURL
        : undefined;
    const headers = config.provider?.id === providerId
        ? config.provider.headers
        : undefined;

    const provider = buildProvider(providerId, apiKey, customBaseURL, headers);
    const registryProvider = customProvider({
        languageModels: {},
        fallbackProvider: provider as any,
    });
    const registry = createProviderRegistry({
        [providerId]: registryProvider,
    });

    const modelId = (registryModelId || `${providerId}:${modelName}`) as `${string}:${string}`;
    return registry.languageModel(modelId);
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
            if (customBaseURL && !isOpenAIResponsesEndpoint(customBaseURL)) {
                return createOpenAICompatible({
                    name: 'openai-compatible',
                    apiKey,
                    baseURL: customBaseURL,
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
    const envKey = getEnvKeyName(providerId);
    return process.env[envKey];
}

function getEnvKeyName(providerId: string): string {
    return ENV_KEY_MAP[providerId] || `${providerId.toUpperCase()}_API_KEY`;
}
