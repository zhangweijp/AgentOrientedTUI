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
import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible';
import { asSchema, streamText, wrapLanguageModel, type LanguageModelUsage, type Tool, type ModelMessage } from 'ai';
import type { LLMConfig, LLMResponse, ModelInputLimits, ModelInputMeasurement } from './interfaces.js';
import { Logger } from '../utils/logger.js';
import { createLanguageModelWithChatFetch, observeChatStreamEnd, validateModelConfig } from './provider-factory.js';
import { createProviderToolSchemaPolicy, ProviderToolSchemaError, type ProviderToolSchemaPolicy } from './provider-tool-schema.js';

export class ModelInputError extends Error {
    constructor(readonly code: 'MODEL_INPUT_BUDGET_EXCEEDED' | 'MODEL_INPUT_LIMITS_UNAVAILABLE' | 'MODEL_INPUT_UNMEASURABLE', message: string, readonly details?: Readonly<Record<string, number | string>>) {
        super(message);
    }
}

type StreamParams = Parameters<ReturnType<typeof createLanguageModelWithChatFetch>['doStream']>[0];

function verifyMeasurable(params: StreamParams, limits: ModelInputLimits): void {
    if (params.tools?.some(tool => tool.type !== 'function') || params.maxOutputTokens !== limits.maxOutputTokens) {
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The model request uses unsupported tools or output settings.');
    }
    if (params.prompt.some(message => typeof message.content !== 'string' &&
        message.content.some(part => part.type === 'file' || (part.type === 'tool-result' &&
            part.output.type === 'content' && part.output.value.some(item => item.type !== 'text'))))) {
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'This Host cannot count media inputs, including media in tool history.');
    }
}

async function encodedInput(input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<string> {
    const body = options?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== 'string') throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not encode a measurable JSON request.');
    return body;
}

function measureInput(limits: ModelInputLimits, request: string, params: StreamParams): ModelInputMeasurement {
    const inputBytes = Buffer.byteLength(request, 'utf8');
    let encoded: Record<string, unknown>;
    try { encoded = JSON.parse(request); }
    catch { throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not send JSON model input.'); }
    if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded))
        throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The Provider did not send a JSON model request.');
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

    private async prepareInput(messages: ModelMessage[], tools: Record<string, Tool>, budget: ModelInputLimits | undefined, preserveTools: boolean) {
        const capabilities = budget?.capabilities ?? this.config.modelCapabilities;
        messages = this.applyInputCapabilityGuard(messages, capabilities);
        if (budget && messages.some(message => Array.isArray(message.content) &&
            message.content.some(part => part.type === 'file' || part.type === 'image'))) {
            throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'This Host cannot count media inputs. Remove the attachment to continue.');
        }
        if (capabilities?.toolCall === false && Object.keys(tools).length > 0) {
            if (preserveTools) throw new ProviderToolSchemaError((await this.toolSchemaPolicy()).label,
                'required tools', '$', 'The selected model does not support the tools required by this context.');
            return { messages, tools: {} };
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
        return { messages, tools: Object.fromEntries(definitions) };
    }

    /** Run the real Provider encoder with a local fetch that cannot send. */
    async createInputMeasurement() {
        const budget = await this.inputLimits();
        if (!budget) return;
        return async (messages: ModelMessage[], tools: Record<string, Tool>, preserveTools: boolean): Promise<ModelInputMeasurement> => {
            const input = await this.prepareInput(messages, tools, budget, preserveTools);
            let params: StreamParams | undefined;
            let measurement: ModelInputMeasurement | undefined;
            let failure: unknown;
            const capture: typeof fetch = async (url, init) => {
                try {
                    if (!params) throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'No Provider input to count.');
                    measurement = measureInput(budget, await encodedInput(url, init), params);
                } catch (error) { failure = error; }
                throw new Error('Local model input measurement completed');
            };
            const model = wrapLanguageModel({ model: this.createProvider(capture, capture), middleware: {
                specificationVersion: 'v3',
                wrapStream: ({ params: value, doStream }) => {
                    verifyMeasurable(value, budget);
                    params = value;
                    return doStream();
                },
            } });
            const trial = streamText({ model, ...input, maxOutputTokens: budget.maxOutputTokens,
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
            beforeRequest?: (signature: string) => void | Promise<void>;
            preserveTools?: boolean;
        }
    ): Promise<LLMResponse> {
        let requestFailure: unknown;
        try {
            const budget = await this.inputLimits();
            const input = await this.prepareInput(messages, tools, budget, !!callbacks?.preserveTools);
            messages = input.messages;
            const effectiveTools = input.tools;

            this.logger.info('Calling LLM', {
                model: this.config.model,
                providerId: this.config.provider.id,
                messageCount: messages.length,
                toolCount: Object.keys(effectiveTools).length,
            });

            console.log('\n=== LLM Messages ===');
            console.log(JSON.stringify(messages, null, 2));
            // 打印所有工具的名称
            console.log('Tools:', Object.keys(effectiveTools));
            console.log('====================\n');
            
            const hasTools = Object.keys(effectiveTools).length > 0;
            const streamEnd = hasTools ? observeChatStreamEnd() : undefined;
            let admitted: Promise<void> | undefined;
            let paramsForFetch: StreamParams | undefined;
            const admit = (input: string, output: number | undefined) => {
                if (!callbacks?.beforeRequest) return;
                const signature = createHash('sha256')
                    .update(JSON.stringify([this.config.provider.id, this.config.model])).update(input)
                    .update(String(output)).digest('hex');
                return admitted ??= Promise.resolve().then(() => callbacks.beforeRequest!(signature));
            };
            const guard = (send: typeof fetch): typeof fetch => async (url, init) => {
                try {
                    if (!budget || !paramsForFetch) throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'No Provider input to count.');
                    const body = await encodedInput(url, init);
                    const cost = measureInput(budget, body, paramsForFetch);
                    if (cost.estimated > cost.inputLimit) throw inputBudgetExceeded(cost);
                    await admit(body, paramsForFetch.maxOutputTokens);
                } catch (error) { requestFailure = error; throw error; }
                return send(url, init);
            };
            const provider = this.createProvider(budget ? guard(streamEnd?.fetch ?? globalThis.fetch) : streamEnd?.fetch,
                budget ? guard(globalThis.fetch) : undefined);
            const model = budget || callbacks?.beforeRequest ? wrapLanguageModel({ model: provider, middleware: {
                specificationVersion: 'v3',
                wrapStream: async ({ params, doStream }) => {
                    try {
                        if (budget) {
                            verifyMeasurable(params, budget);
                            paramsForFetch = params;
                        } else if (callbacks?.beforeRequest) await admit(
                            JSON.stringify({ messages: params.prompt, tools: params.tools ?? [], toolChoice: params.toolChoice }), params.maxOutputTokens);
                    } catch (error) {
                        requestFailure = error;
                        throw error;
                    }
                    return doStream();
                },
            } }) : provider;

            let streamRaw: RawUsage | undefined;
            // Select the actual adapter: OpenAI with a compatible URL uses Chat, while xAI uses Responses.
            const usageFormat: UsageFrameFormat | undefined = provider instanceof OpenAICompatibleChatLanguageModel ? 'chat'
                : provider.provider === 'openai.responses' ? 'responses'
                : provider.provider === 'google.generative-ai' ? 'generate-content'
                : undefined;
            const result = streamText({
                model,
                messages,
                tools: effectiveTools,
                maxOutputTokens: budget?.maxOutputTokens,
                temperature: this.config.temperature ?? 0.7,
                includeRawChunks: usageFormat !== undefined,
                onError: ({ error }) => { requestFailure ??= error; },
                onChunk: usageFormat ? ({ chunk }) => {
                    if (chunk.type === 'raw') streamRaw = readUsageFrame(chunk.rawValue, usageFormat) ?? streamRaw;
                } : undefined,
            });

            let text: string;
            let reasoningParts: Array<{ type: 'reasoning'; text: string }> = [];

            const isStreaming = !!(callbacks?.onTextDelta || callbacks?.onReasoningDelta);

            if (isStreaming) {
                // ═══════════════════════════════════════════════
                //  流式模式: 通过 fullStream 实时消费所有部分
                //
                //  关键: 不能在消费 textStream 之前 await result.reasoning,
                //  因为 AI SDK 的 Promise 属性会先内部消费整个 stream 再 resolve,
                //  导致 textStream 被提前耗尽，streaming delta 永远不会触发。
                //  使用 fullStream 同时获取 reasoning + text delta，一次完成。
                // ═══════════════════════════════════════════════
                text = '';
                let reasoningAccum = '';
                for await (const part of result.fullStream) {
                    switch (part.type) {
                        case 'error': throw part.error;
                        case 'text-delta':
                            text += (part as any).text ?? '';
                            if ((part as any).text) callbacks.onTextDelta?.((part as any).text);
                            break;
                        case 'reasoning-delta':
                            reasoningAccum += (part as any).text ?? '';
                            if ((part as any).text) callbacks.onReasoningDelta?.((part as any).text);
                            break;
                        // tool-call, finish 等由 await result.toolCalls 后续处理
                    }
                }
                if (reasoningAccum) {
                    reasoningParts = [{ type: 'reasoning', text: reasoningAccum }];
                }
            } else {
                // ═══════════════════════════════════════════════
                //  非流式模式: 先提取 reasoning，再等待完整文本
                // ═══════════════════════════════════════════════
                let reasoningText: string | undefined;
                try {
                    const reasoningValue = (result as any).reasoning;
                    if (reasoningValue) {
                        const resolvedReasoning = typeof reasoningValue === 'string'
                            ? reasoningValue
                            : await reasoningValue;
                        if (Array.isArray(resolvedReasoning)) {
                            reasoningParts = resolvedReasoning
                                .filter((part: any) => part && typeof part === 'object' && part.type === 'reasoning')
                                .map((part: any) => ({ type: 'reasoning' as const, text: String(part.text ?? '') }));
                        } else {
                            reasoningText = String(resolvedReasoning);
                        }
                    }
                } catch (error) {
                    this.logger.debug('Failed to read reasoning from LLM result', { error });
                }
                if (reasoningParts.length === 0 && reasoningText && reasoningText.trim().length > 0) {
                    reasoningParts = [{ type: 'reasoning', text: reasoningText }];
                }
                text = await result.text;
            }

            if (requestFailure !== undefined) throw requestFailure;
            const reasoningString = reasoningParts.length > 0
                ? reasoningParts.map((part) => part.text).join('\n')
                : '';

            if (reasoningString.trim().length > 0) {
                console.log('\n=== LLM REASONING ===');
                console.log(reasoningString.slice(0, 400) + (reasoningString.length > 400 ? '...' : ''));
                console.log('=====================\n');
            }

            // stream 已被完整消费，以下 Promise 均已 resolve
            const toolCalls = (await result.toolCalls).map((tc) => ({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: (tc as any).args ?? (tc as any).input,
            }));
            const finishReason = await result.finishReason;
            if (toolCalls.length > 0 && streamEnd?.missingDone() &&
                finishReason === 'other' && (await result.rawFinishReason) === undefined) {
                throw new Error('The model stream ended without a termination signal. Tool calls require a complete response.');
            }
            const usage = reportedUsage(await result.usage, streamRaw);

            const hasText = typeof text === 'string' && text.trim().length > 0;
            const hasToolCalls = toolCalls.length > 0;
            let assistantMessage: ModelMessage | undefined;

            if (hasToolCalls || hasText) {
                const reasoningPart = reasoningParts;

                if (hasToolCalls) {
                    const contentParts = [
                        ...reasoningPart,
                        ...(hasText ? [{ type: 'text', text }] : []),
                        ...toolCalls.map((tc) => ({
                            type: 'tool-call' as const,
                            toolCallId: tc.toolCallId,
                            toolName: tc.toolName,
                            input: tc.args,
                        })),
                    ];

                    assistantMessage = {
                        role: 'assistant',
                        content: contentParts,
                    } as ModelMessage;
                } else if (reasoningPart.length > 0) {
                    assistantMessage = {
                        role: 'assistant',
                        content: [
                            ...reasoningPart,
                            ...(hasText ? [{ type: 'text', text }] : []),
                        ],
                    } as ModelMessage;
                } else {
                    assistantMessage = {
                        role: 'assistant',
                        content: text,
                    } as ModelMessage;
                }
            }

            const response: LLMResponse = {
                text,
                toolCalls,
                finishReason: finishReason || 'unknown',
                ...(usage && { usage }),
                assistantMessage,
            };

            this.logger.info('LLM call completed', {
                textLength: text.length,
                toolCallCount: toolCalls.length,
                finishReason: response.finishReason,
                usage: usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
            });
            
            // 🔍 打印 LLM 响应
            console.log('\n=== LLM RESPONSE ===');
            console.log('Text:', text.slice(0, 200) + (text.length > 200 ? '...' : ''));
            console.log('Tool Calls:', toolCalls.map(tc => ({ name: tc.toolName, args: tc.args })));
            console.log('Finish Reason:', response.finishReason);
            console.log('====================\n');

            return response;
        } catch (error) {
            if (requestFailure !== undefined) throw requestFailure;
            this.logger.error('LLM call failed', { error });
            
            // 🔍 打印 API 请求中的 tools (从错误对象获取)
            if ((error as any).requestBodyValues?.tools) {
                console.log('\n=== Request Tools (from API error) ===');
                const requestTools = (error as any).requestBodyValues.tools;
                console.log('Total tools in request:', requestTools.length);
                
                // 打印前3个工具的完整结构
                for (let i = 0; i < Math.min(3, requestTools.length); i++) {
                    console.log(`\n[Tool ${i + 1}] ${requestTools[i].type || 'function'}:`, requestTools[i].function?.name);
                    console.log('  Parameters schema:');
                    console.log(JSON.stringify(requestTools[i].function?.parameters, null, 2));
                }
                console.log('=====================================\n');
            }
            
            throw error;
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
