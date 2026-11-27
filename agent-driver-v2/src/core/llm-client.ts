/**
 * @aotui/agent-driver-v2 - LLM Client
 * 
 * 基于 Vercel AI SDK 的 LLM 客户端
 * 
 * 设计原则:
 * - 使用 @ai-sdk/openai，支持自定义 baseURL (兼容 models.dev, OpenRouter 等)
 * - 支持用户自定义 LLM Provider 和 Model
 * - 类型安全的 ToolCall 处理
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRequestToolCheck } from './provider-request-tools.js';
import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible';
import { asSchema, streamText, wrapLanguageModel, type LanguageModelUsage, type Tool, type ModelMessage } from 'ai';
import type { LLMConfig, LLMResponse, ModelInputLimits, ModelInputMeasurement } from './interfaces.js';
import { Logger } from '../utils/logger.js';
import { createLanguageModelWithChatFetch, observeChatStreamEnd, validateModelConfig } from './provider-factory.js';
import { createProviderToolSchemaPolicy, ProviderToolSchemaError, type ProviderToolSchemaPolicy } from './provider-tool-schema.js';
import { captureAnthropicSearchError, includeAnthropicHistoryTools, isAnthropicSearchTool,
    prepareAnthropicSearchErrorReplay, recordAnthropicSearchTools, withoutAnthropicSearchHistory,
    type AnthropicSearchError } from './anthropic-tool-history.js';
import { getToolResultIds } from './context-regions.js';
import { prepareOpenAIResponsesInput, recordOpenAIResponsesToolLoad } from './openai-responses-tools.js';

export class ModelInputError extends Error {
    constructor(readonly code: 'MODEL_INPUT_BUDGET_EXCEEDED' | 'MODEL_INPUT_LIMITS_UNAVAILABLE' | 'MODEL_INPUT_UNMEASURABLE', message: string, readonly details?: Readonly<Record<string, number | string>>) {
        super(message);
    }
}

type StreamParams = Parameters<ReturnType<typeof createLanguageModelWithChatFetch>['doStream']>[0];

function hasUnmeasurableParts(messages: ModelMessage[] | StreamParams['prompt']): boolean {
    return messages.some(message => typeof message.content !== 'string' &&
        message.content.some(part => part.type === 'file' || part.type === 'image' || (part.type === 'tool-result' &&
            part.output.type === 'content' && part.output.value.some(item => item.type !== 'text'))));
}

function verifyMeasurable(params: StreamParams, limits: ModelInputLimits): void {
    if (params.maxOutputTokens !== limits.maxOutputTokens) {
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The model request uses unsupported output settings.');
    }
    if (hasUnmeasurableParts(params.prompt)) {
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'This Host cannot count media inputs, including media in tool history.');
    }
}

async function encodedInput(input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<string> {
    const body = options?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== 'string') throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not encode a measurable JSON request.');
    return body;
}

function parseEncodedRequest(request: string): Record<string, unknown> {
    let encoded: unknown;
    try { encoded = JSON.parse(request); }
    catch { throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not encode JSON model input.'); }
    if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded))
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not encode a JSON model request.');
    return encoded as Record<string, unknown>;
}

function measureInput(limits: ModelInputLimits, request: string, params: StreamParams, encoded = parseEncodedRequest(request)): ModelInputMeasurement {
    const inputBytes = Buffer.byteLength(request, 'utf8');
    const generation = decodedObject(encoded.generationConfig);
    const outputLimits = [encoded.max_tokens, encoded.max_completion_tokens, encoded.max_output_tokens, generation?.maxOutputTokens]
        .filter(value => value !== undefined);
    if (outputLimits.length !== 1 || outputLimits[0] !== limits.maxOutputTokens)
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The actual encoded request does not preserve the reserved output limit.');
    const messages = encoded.messages ?? encoded.input ?? encoded.contents;
    const messageCount = Array.isArray(messages) ? messages.length : params.prompt.length;
    const toolCount = Array.isArray(encoded.tools) ? encoded.tools.length : params.tools?.length ?? 0;
    const safety = Math.max(256, Math.ceil(inputBytes * 0.05)) + 8 * (messageCount + toolCount);
    return { method: 'utf8-bytes', inputBytes, safety, estimated: inputBytes + safety,
        inputLimit: Math.min(limits.maxInputTokens ?? Infinity, limits.contextWindow - limits.maxOutputTokens),
        outputReserved: limits.maxOutputTokens };
}

export function inputBudgetExceeded(cost: ModelInputMeasurement): ModelInputError {
    return new ModelInputError('MODEL_INPUT_BUDGET_EXCEEDED',
        `Estimated model input requires ${cost.estimated} tokens including margin and ${cost.inputLimit} are available. Reduce window or history costs, or select a larger model.`,
        { ...cost });
}

type RawUsage = NonNullable<LanguageModelUsage['raw']>;
type UsageFrameFormat = 'chat' | 'responses' | 'generate-content';

function decodedObject(value: unknown): RawUsage | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as RawUsage;
}

function readUsageFrame(frame: unknown, format: UsageFrameFormat): RawUsage | undefined {
    const value = decodedObject(frame);
    if (!value) return;
    if (format === 'chat') return decodedObject(value.usage);
    if (format === 'generate-content') return decodedObject(value.usageMetadata);
    if (value.type === 'response.completed' || value.type === 'response.incomplete') {
        return decodedObject(decodedObject(value.response)?.usage);
    }
}

function reportedUsage(usage: LanguageModelUsage, streamRaw?: RawUsage): LanguageModelUsage | undefined {
    const { raw, ...counts } = usage;
    const reportedRaw = streamRaw ?? raw;
    if (reportedRaw) return { ...counts, raw: reportedRaw };
    const { inputTokens, outputTokens, totalTokens, inputTokenDetails, outputTokenDetails } = counts;
    if ([inputTokens, outputTokens, totalTokens, ...Object.values(inputTokenDetails), ...Object.values(outputTokenDetails)]
        .some(count => typeof count === 'number')) return counts;
}

/**
 * LLMClient - LLM 客户端
 * 
 * 设计原则:
 * - 直接使用 LLMConfig 中的完整配置
 * - 不依赖 ModelRegistry
 * - 支持主流 Provider (OpenAI, Anthropic, Google, xAI)
 * - 支持自定义 baseURL (兼容 OpenRouter 等)
 */
export class LLMClient {
    private logger: Logger;
    private readonly config: LLMConfig;
    private providerToolPolicy?: Promise<ProviderToolSchemaPolicy>;

    constructor(config: LLMConfig) {
        validateModelConfig(config);
        this.config = { ...config, provider: { ...config.provider } };
        this.logger = new Logger('LLMClient');
    }

    private createProvider(chatFetch?: typeof globalThis.fetch, httpFetch?: typeof globalThis.fetch) {
        return createLanguageModelWithChatFetch(this.config, chatFetch, httpFetch);
    }

    toolSchemaPolicy(): Promise<ProviderToolSchemaPolicy> {
        return this.providerToolPolicy ??= createProviderToolSchemaPolicy(this.config);
    }

    private async prepareInput(messages: ModelMessage[], tools: Record<string, Tool>, budget: ModelInputLimits | undefined,
        preserveTools: boolean): Promise<Awaited<ReturnType<typeof prepareOpenAIResponsesInput>> & { sourceTools: ReadonlySet<string> }> {
        const sourceTools = new Set(Object.keys(tools));
        const capabilities = budget?.capabilities ?? this.config.modelCapabilities;
        messages = this.applyInputCapabilityGuard(messages, capabilities);
        if (budget && hasUnmeasurableParts(messages)) {
            throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'This Host cannot count media inputs, including media in tool history.');
        }
        const anthropic = this.config.provider.id === 'anthropic';
        if (anthropic) tools = includeAnthropicHistoryTools(messages, tools);
        else messages = withoutAnthropicSearchHistory(messages);
        if (capabilities?.toolCall === false && Object.keys(tools).length > 0) {
            if (preserveTools) throw new ProviderToolSchemaError((await this.toolSchemaPolicy()).label,
                'required tools', '$', 'The selected model does not support the tools required by this context.');
            return { messages: anthropic ? withoutAnthropicSearchHistory(messages) : messages, tools: {}, sourceTools: new Set() };
        }
        const policy = await this.toolSchemaPolicy();
        const definitions: [string, Tool][] = [];
        for (const [name, { execute: _execute, ...definition }] of Object.entries(tools)) {
            if (definition.type === 'provider') {
                definitions.push([name, definition]);
                continue;
            }
            const issue = policy.check ? policy.check(await asSchema(definition.inputSchema).jsonSchema) : undefined;
            if (issue) throw new ProviderToolSchemaError(policy.label, name, issue.path, issue.reason);
            definitions.push([name, { ...definition, ...(policy.strict === undefined ? {} : { strict: policy.strict }) }]);
        }
        const input = await prepareOpenAIResponsesInput(this.config, messages, Object.fromEntries(definitions));
        const replay = anthropic ? prepareAnthropicSearchErrorReplay(input.messages) : undefined;
        return { ...input, ...replay, sourceTools };
    }

    /** Run the real Provider encoder with a local fetch that cannot send. */
    async createInputMeasurement() {
        const budget = await this.inputLimits();
        if (!budget) return;
        return async (messages: ModelMessage[], tools: Record<string, Tool>, preserveTools: boolean): Promise<ModelInputMeasurement> => {
            const input = await this.prepareInput(messages, tools, budget, preserveTools);
            let params: StreamParams | undefined;
            let checkTools: Awaited<ReturnType<typeof createRequestToolCheck>>;
            let measurement: ModelInputMeasurement | undefined;
            let failure: unknown;
            const capture: typeof fetch = async (url, init) => {
                try {
                    if (!params) throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'No Provider input to count.');
                    const encoded = await encodedInput(url, init);
                    const body = input.rewriteRequestBody?.(encoded) ?? encoded;
                    const logical = parseEncodedRequest(body);
                    checkTools(logical);
                    measurement = measureInput(budget, body, params, logical);
                } catch (error) { failure = error; }
                throw new Error('Local model input measurement completed');
            };
            const provider = this.createProvider(capture, capture);
            checkTools = await createRequestToolCheck(input, provider.provider, this.config.model, (await this.toolSchemaPolicy()).label);
            const model = wrapLanguageModel({ model: provider, middleware: {
                specificationVersion: 'v3',
                wrapStream: ({ params: value, doStream }) => {
                    verifyMeasurable(value, budget);
                    params = value;
                    return doStream();
                },
            } });
            const trial = streamText({ model, messages: input.messages, tools: input.tools, providerOptions: input.providerOptions,
                maxOutputTokens: budget.maxOutputTokens,
                temperature: this.config.temperature ?? 0.7, maxRetries: 0, onError: () => {} });
            try {
                for await (const part of trial.fullStream) if (part.type === 'error') throw part.error;
            } catch (error) { if (!measurement) throw failure ?? error; }
            if (!measurement) throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not supply the encoded input.');
            return measurement;
        };
    }

    /**
     * 调用 LLM
     *
     * @param messages - 消息列表
     * @param tools - 工具定义
     * @param callbacks - 流式回调 (可选)
     * @param callbacks.onTextDelta - 当 LLM 逐 token 输出文本时触发
     * @param callbacks.onReasoningDelta - 当 LLM 逐 token 输出推理时触发
     */
    async call(
        messages: ModelMessage[],
        tools: Record<string, Tool>,
        callbacks?: {
            onTextDelta?: (delta: string) => void;
            onReasoningDelta?: (delta: string) => void;
            beforeRequest?: (signature: string, sourceTools?: ReadonlySet<string>) => void | Promise<void>;
            preserveTools?: boolean;
            signal?: AbortSignal;
        }
    ): Promise<LLMResponse> {
        let requestFailure: unknown;
        let admitted: Promise<void> | undefined;
        const signal = callbacks?.signal;
        try {
            signal?.throwIfAborted();
            const budget = await this.inputLimits();
            signal?.throwIfAborted();
            const input = await this.prepareInput(messages, tools, budget, !!callbacks?.preserveTools);
            signal?.throwIfAborted();
            messages = input.messages;
            const effectiveTools = input.tools;

            this.logger.info('Calling LLM', {
                model: this.config.model,
                providerId: this.config.provider.id,
                messageCount: messages.length,
                toolCount: Object.keys(effectiveTools).length,
            });

            const hasTools = Object.keys(effectiveTools).length > 0;
            const streamEnd = hasTools ? observeChatStreamEnd() : undefined;
            const recordSearchHistory = this.config.provider.id === 'anthropic' && Object.values(effectiveTools).some(isAnthropicSearchTool);
            let paramsForFetch: StreamParams | undefined;
            let checkTools: Awaited<ReturnType<typeof createRequestToolCheck>>;
            let firstRequest: { url: string; body: string; logical: unknown } | undefined;
            let requestTools: StreamParams['tools'];
            const admit = (body: string, output: number | undefined) => {
                if (!callbacks?.beforeRequest) return;
                const signature = createHash('sha256')
                    .update(JSON.stringify([this.config.provider.id, this.config.model])).update(body)
                    .update(String(output)).digest('hex');
                // One adoption belongs to this call, not to each SDK transport attempt.
                return admitted ??= Promise.resolve().then(() => {
                    signal?.throwIfAborted();
                    return callbacks.beforeRequest!(signature, input.sourceTools);
                });
            };
            const guard = (send: typeof fetch): typeof fetch => async (url, init) => {
                let body: string;
                try {
                    signal?.throwIfAborted();
                    if (!paramsForFetch) throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'No encoded Provider input to adopt.');
                    const encoded = await encodedInput(url, init);
                    body = input.rewriteRequestBody?.(encoded) ?? encoded;
                    const logical = parseEncodedRequest(body);
                    checkTools(logical);
                    const endpoint = url instanceof Request ? url.url : String(url);
                    if (firstRequest) {
                        if (firstRequest.url !== endpoint || !isDeepStrictEqual(firstRequest.logical, logical))
                            throw new ProviderToolSchemaError((await this.toolSchemaPolicy()).label, 'request', '$',
                                'The actual model request changed during a transport retry.');
                        // Preserve the first verified bytes, including across harmless key-order changes.
                        body = firstRequest.body;
                    }
                    if (budget) {
                        const cost = measureInput(budget, body, paramsForFetch, logical);
                        if (cost.estimated > cost.inputLimit) throw inputBudgetExceeded(cost);
                    }
                    firstRequest ??= { url: endpoint, body, logical };
                    await admit(body, paramsForFetch.maxOutputTokens);
                    signal?.throwIfAborted();
                } catch (error) { requestFailure ??= error; throw error; }
                // The checked string is the one actually sent, not a mutable pre-adoption body.
                return send(url, { ...init, body });
            };
            const provider = this.createProvider(guard(streamEnd?.fetch ?? globalThis.fetch), guard(globalThis.fetch));
            checkTools = await createRequestToolCheck(input, provider.provider, this.config.model, (await this.toolSchemaPolicy()).label);
            signal?.throwIfAborted();
            const model = wrapLanguageModel({ model: provider, middleware: {
                specificationVersion: 'v3',
                wrapStream: ({ params, doStream }) => {
                    try {
                        signal?.throwIfAborted();
                        if (recordSearchHistory) requestTools = params.tools;
                        if (budget) verifyMeasurable(params, budget);
                        paramsForFetch = params;
                    } catch (error) {
                        requestFailure ??= error;
                        throw error;
                    }
                    return doStream();
                },
            } });

            let streamRaw: RawUsage | undefined;
            const searchErrors = new Map<string, AnthropicSearchError>();
            // Select the actual adapter: OpenAI with a compatible URL uses Chat, while xAI uses Responses.
            const usageFormat: UsageFrameFormat | undefined = provider instanceof OpenAICompatibleChatLanguageModel ? 'chat'
                : provider.provider === 'openai.responses' ? 'responses'
                : provider.provider === 'google.generative-ai' ? 'generate-content'
                : undefined;
            const result = streamText({
                model,
                messages,
                tools: effectiveTools,
                abortSignal: signal,
                providerOptions: input.providerOptions,
                maxOutputTokens: budget?.maxOutputTokens,
                temperature: this.config.temperature ?? 0.7,
                includeRawChunks: recordSearchHistory || usageFormat !== undefined,
                onError: ({ error }) => { requestFailure ??= error; },
                onChunk: recordSearchHistory || usageFormat ? ({ chunk }) => {
                    if (chunk.type !== 'raw') return;
                    if (recordSearchHistory) captureAnthropicSearchError(chunk.rawValue, searchErrors);
                    if (usageFormat) streamRaw = readUsageFrame(chunk.rawValue, usageFormat) ?? streamRaw;
                } : undefined,
            });

            if (callbacks?.onTextDelta || callbacks?.onReasoningDelta) {
                for await (const part of result.fullStream) {
                    signal?.throwIfAborted();
                    switch (part.type) {
                        case 'error': throw part.error;
                        case 'text-delta':
                            if (part.text) callbacks.onTextDelta?.(part.text);
                            break;
                        case 'reasoning-delta':
                            if (part.text) callbacks.onReasoningDelta?.(part.text);
                            break;
                    }
                }
            }

            const { messages: history } = await result.response;
            if (requestFailure !== undefined) throw requestFailure;
            signal?.throwIfAborted();

            const toolMessages = history.filter(message => message.role === 'tool');
            const completed = new Set(toolMessages.flatMap(getToolResultIds));
            const toolCalls = (await result.toolCalls).filter(call => call.providerExecuted !== true && !completed.has(call.toolCallId))
                .map(call => ({ toolCallId: call.toolCallId, toolName: call.toolName, args: call.input }));
            if (toolCalls.length > 0 && streamEnd?.missingDone() &&
                (await result.finishReason) === 'other' && (await result.rawFinishReason) === undefined) {
                throw new Error('The model stream ended without a termination signal. Tool calls require a complete response.');
            }
            const usage = reportedUsage(await result.usage, streamRaw);
            signal?.throwIfAborted();

            let assistantMessage = history.find(message => message.role === 'assistant');
            if (assistantMessage && requestTools) assistantMessage = recordAnthropicSearchTools(assistantMessage, requestTools, searchErrors);
            assistantMessage = recordOpenAIResponsesToolLoad(assistantMessage, input.openaiToolLoad);
            if (assistantMessage && Array.isArray(assistantMessage.content) && assistantMessage.content.length === 1) {
                const [onlyPart] = assistantMessage.content;
                if (onlyPart?.type === 'text' && !onlyPart.providerOptions)
                    assistantMessage = onlyPart.text.trim() ? { ...assistantMessage, content: onlyPart.text } : undefined;
            }

            return {
                toolCalls,
                ...(usage && { usage }),
                assistantMessage,
                ...(toolMessages.length && { toolMessages }),
            };

        } catch (error) {
            if (requestFailure !== undefined) throw requestFailure;
            this.logger.error('LLM call failed', { model: this.config.model, providerId: this.config.provider.id,
                message: error instanceof Error ? error.message : String(error) });
            throw error;
        } finally {
            // A transport abort cannot settle an already-started Source adoption.
            // The run still owns its contexts until that callback has finished.
            await admitted?.catch(() => {});
        }
    }

    private async inputLimits(): Promise<ModelInputLimits | undefined> {
        if (!this.config.inputBudget) return;
        const { provider, model } = this.config;
        let budget: ModelInputLimits | undefined;
        try { budget = await this.config.inputBudget({ providerId: provider.id, modelId: model }); }
        catch { /* Missing or inaccessible metadata prevents sending this request. */ }
        if (!budget || ![budget.contextWindow, budget.maxOutputTokens, budget.maxInputTokens ?? 1]
            .every(value => Number.isSafeInteger(value) && value > 0) || budget.maxOutputTokens >= budget.contextWindow) {
            throw new ModelInputError('MODEL_INPUT_LIMITS_UNAVAILABLE',
                `No valid input window and output limit for ${provider.id}:${model}. Set model limits in the Host or choose a model with known limits.`);
        }
        return budget;
    }

    private applyInputCapabilityGuard(messages: ModelMessage[], capabilities: LLMConfig['modelCapabilities']): ModelMessage[] {
        const supportsImage = capabilities?.input?.image !== false;
        const supportsPdf = capabilities?.input?.pdf !== false;

        const resolvePartModality = (part: any): 'image' | 'pdf' | null => {
            if (!part || typeof part !== 'object') {
                return null;
            }

            if (part.type === 'image') {
                return 'image';
            }

            if (part.type === 'file' && typeof part.mediaType === 'string') {
                if (part.mediaType.startsWith('image/')) {
                    return 'image';
                }
                if (part.mediaType === 'application/pdf') {
                    return 'pdf';
                }
            }

            return null;
        };

        const hasEmptyDataUrlPayload = (part: any): boolean => {
            if (!part || typeof part !== 'object') {
                return false;
            }

            const candidate = part.type === 'image'
                ? part.image
                : part.type === 'file'
                    ? part.data
                    : undefined;

            if (typeof candidate !== 'string' || !candidate.startsWith('data:')) {
                return false;
            }

            const match = candidate.match(/^data:[^;]+;base64,(.*)$/);
            return !!match && (!match[1] || match[1].length === 0);
        };

        return messages.map((message) => {
            if (message.role !== 'user' || !Array.isArray(message.content)) {
                return message;
            }

            const nextContent = (message.content as any[]).map((part: any) => {
                if (!part || typeof part !== 'object') {
                    return part;
                }

                const modality = resolvePartModality(part);
                if (!modality) {
                    return part;
                }

                if (hasEmptyDataUrlPayload(part)) {
                    return {
                        type: 'text' as const,
                        text: 'ERROR: Attachment is empty or corrupted. Please provide a valid file.',
                    };
                }

                const supported = modality === 'image' ? supportsImage : supportsPdf;
                if (supported) {
                    return part;
                }

                const filename = typeof part.filename === 'string' && part.filename.trim().length > 0
                    ? `"${part.filename}"`
                    : (modality === 'pdf' ? 'this PDF' : 'this image');
                return {
                    type: 'text' as const,
                    text: `ERROR: Cannot read ${filename} (current model does not support ${modality} input). Inform the user.`,
                };
            });

            return {
                ...message,
                content: nextContent,
            };
        });
    }

}
