/**
 * @aotui/agent-driver-v2 - Core Interfaces
 * 
 * 定义 Agent Driver V2 的核心接口：
 * - ContextDrivenSource: 本轮上下文驱动源接口
 * - MessageWithTimestamp: 带时间戳的消息
 * - ToolResult: 工具执行结果
 * - AgentDriverV2Config: 配置接口
 * 
 * 基于 Vercel AI SDK v6
 */

import type { ModelMessage, Tool } from 'ai';

/**
 * AgentState - AgentDriver 状态
 * 
 * - **idle**: 空闲，等待信号
 * - **thinking**: 收到信号，正在整合消息并调用 LLM
 * - **executing**: LLM 返回 ToolCalls，正在执行工具
 */
export type AgentState = 'idle' | 'thinking' | 'executing';
export type ContextRegion = 'static' | 'session' | 'dynamic';

/**
 * MessageWithTimestamp - 带时间戳的消息
 * 
 * 扩展 ModelMessage，添加时间戳用于排序
 * 
 * @example
 * const message: MessageWithTimestamp = {
 *   role: 'user',
 *   content: [{ type: 'text', text: 'Hello' }],
 *   timestamp: Date.now()
 * };
 */
export interface MessageWithTimestamp {
    /** ModelMessage 的所有字段 */
    role: ModelMessage['role'];
    content: ModelMessage['content'];
    /** Unix timestamp (ms) */
    timestamp: number;
    /** Context layering hint for region-first assembly */
    region?: ContextRegion;
}

/**
 * ToolResult - 工具执行结果
 */
export type ToolOutcomeStatus = 'succeeded' | 'rejected' | 'failed' | 'accepted' | 'unknown';

export interface ToolResult {
    /** Tool Call ID，用于匹配 ToolCall */
    toolCallId: string;
    /** 工具名称 */
    toolName: string;
    /** Internal execution classification for metrics; never a model-facing result envelope. */
    outcomeStatus?: ToolOutcomeStatus;
    /** Tool output or recovery details. Core receipts belong to the source. */
    result?: unknown;
    /** 受控错误信息；配合 outcomeStatus 区分拒绝、失败和未知。 */
    error?: {
        code: string;
        message: string;
    };
}

/** One source's messages, tools and invocation route captured for one model turn. */
export interface DrivenSourceContext {
    messages: MessageWithTimestamp[];
    tools: Record<string, Tool>;
    /** Adopt this prepared context for a model turn; diagnostic reads do not call it. */
    adopt?: () => void | Promise<void>;
    /** Request admission must preserve the tools supplied by this context. */
    preserveTools?: boolean;
    /** Uses the bindings captured with this context, rather than a later source read. */
    executeTool?: (
        toolName: string,
        args: unknown,
        toolCallId: string
    ) => Promise<ToolResult | undefined>;
    /** Releases this turn's retained observation after model and tool execution finish. */
    release?: () => void | Promise<void>;
}

/**
 * Atomic source contract. A model turn owns one captured set of messages, tools,
 * and tool bindings, so callers do not need to implement split-read methods.
 */
export interface ContextDrivenSource {
    readonly name: string;
    getContext(): Promise<DrivenSourceContext>;
    onUpdate(callback: () => void): () => void;
}

/** One captured context per source and model turn. */
export type DrivenSource = ContextDrivenSource;

/**
 * AgentDriverV2Config - 配置接口
 */
export interface AgentDriverV2Config {
    /** Driven Sources 列表 */
    sources: DrivenSource[];

    /** 
     * LLM 配置
     * 
     * 支持多种配置格式，详见 LLMConfig 接口文档
     */
    llm: LLMConfig;

    /** 工作循环配置 */
    workLoop?: {
        /** 信号防抖时间 (ms)，默认 300 */
        debounceMs?: number;
        /** ToolCall 超时时间 (ms)，默认 30000 */
        toolCallTimeoutMs?: number;
    };

    /** 
     * Assistant Message 事件监听器
     * 
     * 当 LLM 返回 assistant message 时触发
     * 
     * @param message - Assistant Message (可能包含 text 或 toolcall)
     * 
     * @example
     * onAssistantMessage: (message) => {
     *   console.log('LLM returned:', message);
     *   messageService.addMessage(topicId, message);
     * }
     */
    onAssistantMessage?: (message: ModelMessage) => void;

    /** 
     * ToolResult Message 事件监听器
     * 
     * 当 ToolCall 执行完成，生成 toolresult message 时触发
     * 
     * @param message - Tool Message (包含一个或多个 tool-result)
     * 
     * @example
     * onToolResult: (message) => {
     *   console.log('Tool executed:', message);
     *   messageService.addMessage(topicId, message);
     * }
     */
    onToolResult?: (message: ModelMessage) => void;

    /**
     * LLM Usage 事件监听器
     *
     * 当 LLM 返回 token 使用情况时触发
     */
    onLLMUsage?: (usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    }) => void;

    /** 状态变化监听器 (可选，用于调试) */
    onStateChange?: (oldState: AgentState, newState: AgentState) => void;

    /**
     * Text Delta 事件监听器 (流式输出)
     *
     * 当 LLM 逐 token 输出文本时触发，用于实现流式渲染。
     * 每次回调包含一个增量文本片段 (delta)。
     * 完整的 assistant message 仍通过 onAssistantMessage 在流结束后触发。
     *
     * @param delta - 增量文本片段
     */
    onTextDelta?: (delta: string) => void;

    /**
     * Reasoning Delta 事件监听器 (流式推理输出)
     *
     * 当 LLM 逐 token 输出推理/思考过程时触发（如 Claude extended thinking）。
     * 每次回调包含一个增量推理文本片段 (delta)。
     *
     * @param delta - 增量推理文本片段
     */
    onReasoningDelta?: (delta: string) => void;

    /**
     * 工作循环错误监听器
     *
     * 当 AgentDriver 在 run loop 中遇到异常（如 LLM 调用失败、网络异常等）时触发。
     */
    onRunError?: (error: Error) => void;
}


/**
 * ProviderConfig - LLM Provider 配置
 * 
 * 用于自定义 Provider 行为，支持：
 * - 自定义 baseURL (兼容 OpenRouter, models.dev 等)
 * - 自定义 headers
 * - Provider-specific 配置
 * 
 * @example
 * // 使用 OpenRouter
 * const config: ProviderConfig = {
 *   id: 'openrouter',
 *   baseURL: 'https://openrouter.ai/api/v1',
 *   headers: { 'HTTP-Referer': 'https://my-app.com' }
 * };
 * 
 * // 使用 Alibaba Qwen
 * const config: ProviderConfig = {
 *   id: 'alibaba',
 *   baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
 * };
 */
export interface ProviderConfig {
    /** The selected Provider identifier. */
    id: string;

    /** 
     * 自定义 Base URL
     * 
     * 用于 OpenAI 兼容的 API 端点，例如:
     * - OpenRouter: 'https://openrouter.ai/api/v1'
     * - Alibaba: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
     * - Moonshot: 'https://api.moonshot.cn/v1'
     */
    baseURL?: string;

    /** 自定义 HTTP Headers */
    headers?: Record<string, string>;
}

export interface ModelInputLimits {
    readonly contextWindow: number;
    readonly maxInputTokens?: number;
    readonly maxOutputTokens: number;
    readonly capabilities?: LLMConfig['modelCapabilities'];
}

export interface LLMConfig {
    /** Nonempty model ID sent to the selected Provider verbatim. */
    model: string;

    /** The Provider and its optional endpoint and headers. */
    provider: ProviderConfig;

    /** Defaults to the API key environment variable for the selected Provider. */
    apiKey?: string;

    /** 
     * 最大步数 (默认 5)
     * 
     * ReAct 循环的最大迭代次数
     */
    maxSteps?: number;

    /** 
     * 温度 (默认 0.7)
     * 
     * 控制生成的随机性，范围 0-2
     */
    temperature?: number;

    /** Trusted Host limit lookup for the actual provider and model used for this request. */
    inputBudget?: (target: Readonly<{ providerId: string; modelId: string }>) =>
        ModelInputLimits | undefined | Promise<ModelInputLimits | undefined>;

    /**
     * 模型能力（来自 models.dev 等上游元数据）
     */
    modelCapabilities?: {
        /** 是否支持 tool calls */
        toolCall?: boolean;
        /** 输入模态能力 */
        input?: {
            image?: boolean;
            pdf?: boolean;
        };
    };
}


/**
 * LLMResponse - LLM 响应
 */
export interface LLMResponse {
    /** 生成的文本 */
    text: string;
    /** ToolCalls */
    toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        args: unknown;
    }>;
    /** 结束原因 */
    finishReason: string;
    /** Token 使用情况 */
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    /** Assistant Message (用于构建消息历史) */
    assistantMessage?: ModelMessage;
}
