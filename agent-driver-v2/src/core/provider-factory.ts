import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { loadOptionalSetting, type FetchFunction } from '@ai-sdk/provider-utils';
import { createParser } from 'eventsource-parser';
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
    const tools = config.provider.openaiResponsesTools;
    if (tools !== undefined) {
        const { baseURL } = resolveProviderEndpoint(id, config.provider.baseURL);
        if (id !== 'openai' || (baseURL && !isOpenAIResponsesEndpoint(baseURL))) {
            throw new Error('openaiResponsesTools requires the OpenAI Responses endpoint.');
        }
        if (tools?.search !== 'hosted' && tools?.search !== 'client') {
            throw new Error('openaiResponsesTools.search must be hosted or client.');
        }
        for (const names of [tools.additionalTools, tools.deferredTools]) {
            if (names !== undefined && (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim()))) {
                throw new Error('OpenAI Responses tool selections must be arrays of tool names.');
            }
        }
        if (tools.additionalTools?.some(name => tools.deferredTools?.includes(name))) {
            throw new Error('An OpenAI Responses tool cannot be both additional and deferred.');
        }
    }
}

export function createLanguageModel(config: LLMConfig): Extract<LanguageModel, { specificationVersion: 'v3' }> {
    return createLanguageModelWithChatFetch(config);
}

/** The Driver can observe the two Chat adapters whose parsers discard [DONE]. */
export function createLanguageModelWithChatFetch(config: LLMConfig, chatFetch?: FetchFunction,
    requestFetch?: FetchFunction): Extract<LanguageModel, { specificationVersion: 'v3' }> {
    validateModelConfig(config);
    const { id: providerId, baseURL, headers } = config.provider;
    const apiKey = config.apiKey || getApiKeyFromEnv(providerId);
    if (!apiKey) {
        throw new Error(
            `API key not found for provider: ${providerId}. ` +
            `Please set ${getEnvKeyName(providerId)} or provide apiKey in config.`
        );
    }

    return buildProvider(providerId, apiKey, baseURL, headers, chatFetch ?? requestFetch, requestFetch).languageModel(config.model);
}

export function observeChatStreamEnd() {
    let latestAttempt: { done: boolean } | undefined;
    const fetch: FetchFunction = async (...args) => {
        const attempt = { done: false };
        latestAttempt = attempt;
        const response = await globalThis.fetch(...args);
        if (!response.ok || !response.body) return response;

        const decoder = new TextDecoder();
        let endsWithCR = false;
        const parser = createParser({ onEvent: ({ data }) => {
            if (data === '[DONE]') attempt.done = true;
        } });
        // Read alongside the provider on its only body stream, with the same backpressure and cancellation.
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                if (chunk.length > 0) endsWithCR = chunk[chunk.length - 1] === 0x0d;
                parser.feed(decoder.decode(chunk, { stream: true }));
                controller.enqueue(chunk);
            },
            flush() {
                // Resolve a pending CR at EOF without adding another SSE line.
                parser.feed(decoder.decode() + (endsWithCR ? '\n' : ''));
            },
        }));
        return new Response(body, response);
    };
    return { fetch, missingDone: () => latestAttempt?.done === false };
}

function buildProvider(
    providerId: string,
    apiKey: string,
    customBaseURL: string | undefined,
    headers: Record<string, string> | undefined,
    chatFetch?: FetchFunction,
    requestFetch?: FetchFunction,
) {
    const { baseURL } = resolveProviderEndpoint(providerId, customBaseURL);
    switch (providerId) {
        case 'anthropic':
            return createAnthropic({ apiKey, baseURL, headers, fetch: requestFetch });
        case 'google':
            return createGoogleGenerativeAI({ apiKey, baseURL, headers, fetch: requestFetch });
        case 'deepseek':
            return createDeepSeek({ apiKey, baseURL, headers, fetch: chatFetch });
        case 'xai':
            return createOpenAI({ apiKey, baseURL, headers, fetch: requestFetch });
        case 'openai':
            if (baseURL && !isOpenAIResponsesEndpoint(baseURL)) {
                return createOpenAICompatible({
                    name: 'openai-compatible',
                    apiKey,
                    baseURL,
                    headers,
                    fetch: chatFetch,
                });
            }
            return createOpenAI({ apiKey, baseURL, headers, fetch: requestFetch });
        case 'openrouter':
            return createOpenRouter({
                apiKey,
                baseURL,
                headers,
                compatibility: 'strict',
                fetch: requestFetch,
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
                fetch: chatFetch,
            });
        }
    }
}

export function isOpenAIResponsesEndpoint(baseURL: string): boolean {
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
