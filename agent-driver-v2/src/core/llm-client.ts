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
import { APICallError, streamText, wrapLanguageModel, type Tool, type ModelMessage } from 'ai';
import type { LLMConfig, LLMResponse, ModelInputLimits } from './interfaces.js';
import { Logger } from '../utils/logger.js';
import { createLanguageModel, validateModelConfig } from './provider-factory.js';

export class ModelInputError extends Error {
    constructor(readonly code: 'MODEL_INPUT_BUDGET_EXCEEDED' | 'MODEL_INPUT_LIMITS_UNAVAILABLE' | 'MODEL_INPUT_UNMEASURABLE', message: string, readonly details?: Readonly<Record<string, number | string>>) {
        super(message);
    }
}

function checkInputBudget(limits: ModelInputLimits, request: string, messages: number, tools: number): void {
    const available = Math.min(limits.maxInputTokens ?? Infinity, limits.contextWindow - limits.maxOutputTokens);
    const bytes = Buffer.byteLength(request, 'utf8');
    const safety = Math.max(256, Math.ceil(bytes * 0.05)) + 8 * (messages + tools);
    if (bytes + safety > available) {
        throw new ModelInputError('MODEL_INPUT_BUDGET_EXCEEDED',
            `Estimated model input requires ${bytes + safety} tokens (including margin); ${available} are available. Open fewer Views, reduce history, or select a larger model.`,
            { method: 'utf8-bytes', inputBytes: bytes, safety, inputLimit: available, outputReserved: limits.maxOutputTokens });
    }
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

    constructor(config: LLMConfig) {
        validateModelConfig(config);
        this.config = { ...config, provider: { ...config.provider } };
        this.logger = new Logger('LLMClient');
    }

    private createProvider() {
        return createLanguageModel(this.config);
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
        }
    ): Promise<LLMResponse> {
        let requestFailure: unknown;
        try {
            const budget = await this.inputLimits();
            const capabilities = budget?.capabilities ?? this.config.modelCapabilities;
            messages = this.applyInputCapabilityGuard(messages, capabilities);
            const shouldDisableTools =
                capabilities?.toolCall === false &&
                Object.keys(tools).length > 0;
            // Driver owns Source execution; the model SDK only receives the definition.
            const effectiveTools = shouldDisableTools ? {} : Object.fromEntries(
                Object.entries(tools).map(([name, { execute: _execute, ...definition }]) => [name, definition])
            );

            if (shouldDisableTools) {
                this.logger.warn('Tool calls disabled by model capability metadata', {
                    model: this.config.model,
                    providerId: this.config.provider.id,
                    reason: 'models.dev.tool_call=false',
                });
            }

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
            
            if (budget && messages.some(message => Array.isArray(message.content) &&
                message.content.some(part => part.type === 'file' || part.type === 'image'))) {
                throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'This Host cannot count media inputs. Remove the attachment to continue.');
            }
            const provider = this.createProvider();
            const retryWithoutTools = this.config.provider.id === 'openrouter' && Object.keys(effectiveTools).length > 0;
            let admitted: Promise<void> | undefined;
            const model = budget || callbacks?.beforeRequest || retryWithoutTools ? wrapLanguageModel({ model: provider, middleware: {
                specificationVersion: 'v3',
                wrapStream: async ({ params, doStream }) => {
                    try {
                        if (budget) {
                            if (params.tools?.some(tool => tool.type !== 'function') || params.maxOutputTokens !== budget.maxOutputTokens) {
                                throw new ModelInputError('MODEL_INPUT_UNMEASURABLE', 'The model request uses unsupported tools or output settings.');
                            }
                            const hasMedia = params.prompt.some(message => typeof message.content !== 'string' &&
                                message.content.some(part => part.type === 'file' || (part.type === 'tool-result' &&
                                    part.output.type === 'content' && part.output.value.some(item => item.type !== 'text'))));
                            if (hasMedia) throw new ModelInputError('MODEL_INPUT_UNMEASURABLE',
                                'This Host cannot count media inputs, including media in tool history.');
                        }
                        const input = JSON.stringify({ messages: params.prompt, tools: params.tools ?? [], toolChoice: params.toolChoice });
                        if (budget) checkInputBudget(budget, input, params.prompt.length, params.tools?.length ?? 0);
                        if (callbacks?.beforeRequest) {
                            const signature = createHash('sha256')
                                .update(JSON.stringify([this.config.provider.id, this.config.model])).update(input)
                                .update(String(params.maxOutputTokens)).digest('hex');
                            admitted ??= Promise.resolve().then(() => callbacks.beforeRequest!(signature));
                            await admitted;
                        }
                    } catch (error) {
                        requestFailure = error;
                        throw error;
                    }
                    try {
                        return await doStream();
                    } catch (error) {
                        if (!retryWithoutTools || !params.tools?.length || !this.isToolCompatibilityError(error)) {
                            throw error;
                        }
                        this.logger.warn('OpenRouter tool-call compatibility issue detected, retrying without tools', {
                            model: this.config.model,
                        });
                        return provider.doStream({ ...params, tools: undefined, toolChoice: undefined });
                    }
                },
            } }) : provider;

            const result = streamText({
                model,
                messages,
                tools: effectiveTools,
                maxOutputTokens: budget?.maxOutputTokens,
                temperature: this.config.temperature ?? 0.7,
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
            const usage = await result.usage;

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
                usage: usage
                    ? {
                        // AI SDK v6 usage 字段
                        promptTokens: (usage as any).promptTokens ?? 0,
                        completionTokens: (usage as any).completionTokens ?? 0,
                        totalTokens: (usage as any).totalTokens ?? 0,
                    }
                    : undefined,
                assistantMessage,
            };

            this.logger.info('LLM call completed', {
                textLength: text.length,
                toolCallCount: toolCalls.length,
                finishReason: response.finishReason,
                usage: response.usage,
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

    private isToolCompatibilityError(error: unknown): boolean {
        if (!APICallError.isInstance(error)) return false;
        const message = error.message.trim();
        if (error.statusCode === 404) {
            return /^No endpoints found that support tool use\b/i.test(message);
        }
        if (error.statusCode !== 400) return false;
        return /\b(?:does not|doesn't) support (?:tools|tool use|(?:tool|function) calling)(?=$|[.!](?:\s|$))/i.test(message)
            || /\b(?:tool|function) calling is not supported(?: for this model)?(?=$|[.!](?:\s|$))/i.test(message);
    }
}
