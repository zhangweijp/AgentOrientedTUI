/**
 * @aotui/agent-driver-v2 - AgentDriver V2 Core
 * 
 * 多源消息聚合器，负责：
 * 1. 聚合来自多个 ContextDrivenSource 的消息和工具
 * 2. 按时间戳排序消息
 * 3. 路由 ToolCall 到对应的 ContextDrivenSource
 * 4. 管理工作循环
 * 
 * 设计原则：
 * - **依赖反转**: 依赖 ContextDrivenSource 接口，不依赖具体实现
 * - **职责清晰**: AgentDriver 只负责聚合和路由，不负责业务逻辑
 * - **可扩展**: 易于添加新的 ContextDrivenSource
 */

import { asSchema, type ModelMessage, type Tool } from 'ai';
import type {
    ContextDrivenSource,
    DrivenSourceContext,
    MessageWithTimestamp,
    FittedModelRequest,
    ToolExecutionBudget,
    ToolResult,
    ToolOutcomeStatus,
    AgentDriverV2Config,
    AgentState,
} from './interfaces.js';
import { debounce } from '../utils/debounce.js';
import { Logger } from '../utils/logger.js';
import { LLMClient, inputBudgetExceeded } from './llm-client.js';
import { ProviderToolSchemaError } from './provider-tool-schema.js';
import { assembleContextRegions } from './context-regions.js';

const REQUEST_SKIPPED = Symbol('model request skipped');
const TOOL_TURN_CLOSED = Symbol('tool turn closed');

interface CapturedSourceContext {
    source: ContextDrivenSource;
    context: DrivenSourceContext;
}

interface ToolExecutionRoute {
    source: ContextDrivenSource;
    executeTool?: DrivenSourceContext['executeTool'];
    settlesOnAbort: boolean;
}
type InputMeasure = NonNullable<Awaited<ReturnType<LLMClient['createInputMeasurement']>>>;
type ToolBatch = { assistant: ModelMessage; results: readonly ToolResult[]; feedbackSource?: ContextDrivenSource; routes: ReadonlyMap<string, ToolExecutionRoute> };

function createToolTurn() {
    let closing = false;
    let interrupt!: (value: typeof TOOL_TURN_CLOSED) => void;
    let delivered!: () => void;
    let failed!: (error: unknown) => void;
    const interrupted = new Promise<typeof TOOL_TURN_CLOSED>(resolve => { interrupt = resolve; });
    const completion = new Promise<void>((resolve, reject) => {
        delivered = resolve;
        failed = reject;
    });
    void completion.catch(() => {});
    return {
        interrupted, completion, delivered, failed,
        get closing() { return closing; },
        close() { closing = true; interrupt(TOOL_TURN_CLOSED); },
    };
}

type ToolTurn = ReturnType<typeof createToolTurn>;

function toolIds(message: MessageWithTimestamp, type: 'tool-call' | 'tool-result'): string[] {
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap(part => part.type === type && 'toolCallId' in part ? [part.toolCallId] : []);
}

function recoveryHistory(messages: readonly MessageWithTimestamp[]): MessageWithTimestamp[] {
    const history = messages.filter(message => message.region === undefined || message.region === 'session')
        .sort((a, b) => b.timestamp - a.timestamp);
    const user = history.find(message => message.role === 'user');
    const lastResult = history.findIndex(message => message.role === 'tool');
    const result = history[lastResult];
    const ids = result ? new Set(toolIds(result, 'tool-result')) : undefined;
    const call = ids && history.find((message, index) => index > lastResult &&
        message.role === 'assistant' && toolIds(message, 'tool-call').some(id => ids.has(id)));
    return messages.filter(message => message.role === 'system' || message === user || (!!call && (message === call || message === result)));
}

/**
 * AgentDriverV2 - 核心类
 */
export class AgentDriverV2 {
    private static nextId = 1;

    private readonly driverId: number;
    private sources: ContextDrivenSource[];
    private unsubscribers: (() => void)[] = [];
    private updateDebounced: () => void;
    private logger: Logger;
    private config: AgentDriverV2Config;
    private llmClient: LLMClient;
    private sourceEnabledMap = new Map<string, boolean>();

    // 状态机
    private state: AgentState = 'idle';
    private pending = false;
    private runInFlight: Promise<void> | null = null;
    private toolTurn?: ToolTurn;
    private runningTool?: { source: string; controller: AbortController };
    private lastInputSignature: string | null = null;
    private lastModelRequestFailed = false;

    private running = false;
    private paused = false;

    constructor(config: AgentDriverV2Config) {
        this.config = config;
        this.sources = config.sources;
        this.logger = new Logger('AgentDriverV2');
        this.llmClient = new LLMClient(config.llm);
        this.driverId = AgentDriverV2.nextId++;
        this.sources.forEach((source) => this.sourceEnabledMap.set(source.name, true));

        // 创建防抖的更新处理函数
        const debounceMs = config.workLoop?.debounceMs ?? 300;
        this.updateDebounced = debounce(() => {
            // handleUpdate 现在不阻塞，可以安全调用
            this.handleUpdate().catch((error) => {
                this.logger.error('Error in debounced handleUpdate:', error);
            });
        }, debounceMs);

        try {
            this.setupUpdateListeners();
            this.start();
        } catch (error) {
            this.running = false;
            try { this.dispose(); }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], error instanceof Error ? error.message : String(error), { cause: error });
            }
            throw error;
        }
    }

    /**
     * 获取 Driver 实例 ID (用于排查多实例并发)
     */
    getId(): number {
        return this.driverId;
    }

    /**
     * 获取当前状态 (用于测试)
     */
    getState(): AgentState {
        return this.state;
    }

    /**
     * 是否有待处理的更新 (用于测试)
     */
    hasPendingUpdate(): boolean {
        return this.pending;
    }

    setSourceEnabled(sourceName: string, enabled: boolean): void {
        this.sourceEnabledMap.set(sourceName, enabled);
        if (!enabled && this.runningTool?.source === sourceName) this.runningTool.controller.abort();
        this.updateDebounced();
    }

    private getActiveSources(): ContextDrivenSource[] {
        return this.sources.filter((source) => this.sourceEnabledMap.get(source.name) !== false);
    }

    /**
     * 设置更新监听器
     * 
     * 订阅所有 ContextDrivenSource 的更新事件
     */
    private setupUpdateListeners(): void {
        this.sources.forEach((source) => {
            const unsubscribe = source.onUpdate(() => {
                this.logger.debug(`Update signal from source: ${source.name}`);
                this.updateDebounced();
            });
            this.unsubscribers.push(unsubscribe);
        });

        this.logger.info(`Listening to ${this.sources.length} driven sources`);
    }

    /**
     * 收集所有消息
     * 
     * ✅ 简化: 直接聚合，按时间戳排序
     * - 每个 source 已经保证消息去重
     * - AgentDriver 只需拼接并排序
     */
    private async collectMessages(captured: readonly CapturedSourceContext[], batch?: ToolBatch, feedback?: object): Promise<ModelMessage[]> {
        const management = captured.find(({ context }) => context.managementOnly)?.context;
        const history = captured.flatMap(({ context }) => context === management ? [] : context.messages);
        if (batch) {
            const { assistant, results, feedbackSource, routes } = batch;
            const identical = JSON.stringify(assistant.content);
            for (let index = history.length - 1; index >= 0; index--) {
                const message = history[index]!;
                if (message.role === 'assistant' && JSON.stringify(message.content) === identical) { history.splice(index, 1); break; }
            }
            const time = history.reduce((latest, message) => Math.max(latest, message.timestamp), Date.now()) + 1;
            history.push({ ...assistant, timestamp: time },
                { ...this.createToolMessage(results, feedback, result => routes.get(result.toolName)?.source === feedbackSource), timestamp: time + 1 });
        }
        const allMessages = management ? [...management.messages, ...recoveryHistory(history)] : history;

        const normalizedTimedMessages = allMessages.filter(message => message.role !== 'assistant' ||
            (typeof message.content === 'string' ? message.content.trim().length > 0 : message.content.length > 0));

        const normalized = assembleContextRegions(normalizedTimedMessages);

        const getToolCallIds = (message: ModelMessage): string[] => {
            if (message.role !== 'assistant' || !Array.isArray(message.content)) {
                return [];
            }

            return message.content
                .filter((part: any) => part?.type === 'tool-call' && typeof part.toolCallId === 'string')
                .map((part: any) => part.toolCallId as string);
        };

        const getToolResultIds = (message: ModelMessage): string[] => {
            if (message.role !== 'tool' || !Array.isArray(message.content)) {
                return [];
            }

            return message.content
                .filter((part: any) => part?.type === 'tool-result' && typeof part.toolCallId === 'string')
                .map((part: any) => part.toolCallId as string);
        };

        const toolMessages = normalized.filter((message) => message.role === 'tool');
        const nonToolMessages = normalized.filter((message) => message.role !== 'tool');
        const usedToolMessages = new Set<number>();
        const reordered: ModelMessage[] = [];

        for (const message of nonToolMessages) {
            reordered.push(message);

            const toolCallIds = getToolCallIds(message);
            if (toolCallIds.length === 0) {
                continue;
            }

            const toolIndex = toolMessages.findIndex((toolMessage, index) => {
                if (usedToolMessages.has(index)) {
                    return false;
                }
                const toolResultIds = getToolResultIds(toolMessage);
                return toolResultIds.some((id) => toolCallIds.includes(id));
            });

            if (toolIndex >= 0) {
                usedToolMessages.add(toolIndex);
                reordered.push(toolMessages[toolIndex]);
            }
        }

        for (let index = 0; index < toolMessages.length; index += 1) {
            if (!usedToolMessages.has(index)) {
                reordered.push(toolMessages[index]);
            }
        }

        const protocolSafe: ModelMessage[] = [];
        let pendingToolCallIds: Set<string> | null = null;

        for (const message of reordered) {
            if (message.role === 'assistant') {
                protocolSafe.push(message);
                const callIds = getToolCallIds(message);
                pendingToolCallIds = callIds.length > 0 ? new Set(callIds) : null;
                continue;
            }

            if (message.role === 'tool') {
                if (!Array.isArray(message.content) || message.content.length === 0) {
                    this.logger.warn('Dropping malformed tool message with empty content');
                    continue;
                }

                if (!pendingToolCallIds || pendingToolCallIds.size === 0) {
                    this.logger.warn('Dropping orphan tool message without pending assistant tool-call');
                    continue;
                }

                const pendingIds = pendingToolCallIds;

                const matchedParts = (message.content as any[]).filter((part: any) => (
                    part?.type === 'tool-result'
                    && typeof part.toolCallId === 'string'
                    && pendingIds.has(part.toolCallId)
                ));

                if (matchedParts.length === 0) {
                    this.logger.warn('Dropping tool message because no toolCallId matches pending assistant tool-calls');
                    continue;
                }

                for (const part of matchedParts as any[]) {
                    pendingToolCallIds.delete(part.toolCallId);
                }

                protocolSafe.push({
                    ...message,
                    content: matchedParts,
                } as ModelMessage);
                continue;
            }

            pendingToolCallIds = null;
            protocolSafe.push(message);
        }

        return protocolSafe;
    }

    /** Capture once per source; never silently replace a failed atomic capture. */
    private async captureContexts(retained: CapturedSourceContext[]): Promise<void> {
        for (const source of this.getActiveSources()) {
            try {
                const context = await this.captureSource(source);
                retained.push({ source, context });
            } catch (error) {
                this.logger.error(`Failed to capture context from ${source.name}:`, error);
                // An atomic source is part of the current working state. A failed
                // capture must fail the turn, not silently omit that state.
                throw error;
            }
        }
    }

    private async captureSource(source: ContextDrivenSource): Promise<DrivenSourceContext> {
        const policy = await this.llmClient.toolSchemaPolicy();
        const context = await source.getContext(policy);
        if (!policy.check) return context;
        try {
            const tools: [string, Tool][] = [];
            const omitted: string[] = [];
            for (const [name, tool] of Object.entries(context.tools)) {
                const issue = tool.type === 'provider' ? undefined : policy.check(await asSchema(tool.inputSchema).jsonSchema);
                if (!issue) { tools.push([name, tool]); continue; }
                const error = new ProviderToolSchemaError(policy.label, name, issue.path, issue.reason);
                if (context.preserveTools) throw error;
                omitted.push(error.message);
            }
            if (!omitted.length) return context;
            return {
                ...context, tools: Object.fromEntries(tools),
                messages: [...context.messages, { role: 'user', region: 'dynamic', timestamp: 0,
                    content: 'Optional tools unavailable for this request.\n' + omitted.join('\n') }],
            };
        } catch (error) {
            await context.release?.();
            throw error;
        }
    }

    private collectTools(captured: readonly CapturedSourceContext[]) {
        const management = captured.find(({ context }) => context.managementOnly);
        const tools: Record<string, Tool> = {};
        const routes = new Map<string, ToolExecutionRoute>();
        const bound = new Set<string>();
        for (const { source, context } of management ? [management] : captured) {
            const executeTool = context.executeTool?.bind(context);
            for (const [name, tool] of Object.entries(context.tools)) {
                if (bound.has(name)) continue;
                if (context.preserveTools) {
                    if (routes.has(name)) this.logger.warn('Tool conflicts with an observation-bound tool', { name, source: routes.get(name)?.source.name });
                    bound.add(name);
                }
                tools[name] = tool;
                routes.set(name, { source, executeTool, settlesOnAbort: context.toolsSettlingOnAbort?.has(name) === true });
            }
        }
        return { tools, routes, preserveTools: captured.some(({ context }) => context.preserveTools) };
    }

    private async measureContexts(measure: InputMeasure, captured: readonly CapturedSourceContext[], batch?: ToolBatch, feedback?: object) {
        const { tools, preserveTools } = this.collectTools(captured);
        return measure(await this.collectMessages(captured, batch, feedback), tools, preserveTools);
    }

    private async fitContexts(measure: InputMeasure, captured: CapturedSourceContext[], batch?: ToolBatch,
        sealedFeedback?: object): Promise<FittedModelRequest | undefined> {
        const owner = captured.find(item => item.context.fitModelBudget && (!batch?.feedbackSource || batch.feedbackSource === item.source));
        if (!owner) return;
        const fit = await owner.context.fitModelBudget!(async (candidate, feedback) =>
            this.measureContexts(measure, captured.map(item => item === owner ? { source: owner.source, context: candidate } : item),
                batch, sealedFeedback ?? feedback), !!batch && !sealedFeedback);
        if (fit.context) {
            const release = owner.context.release?.bind(owner.context);
            owner.context = release ? { ...fit.context, release } : fit.context;
        }
        return fit;
    }

    private async releaseContexts(retained: CapturedSourceContext[]): Promise<void> {
        for (const { source, context } of retained.reverse()) {
            try { await context.release?.(); }
            catch (error) { this.logger.error(`Failed to release context from ${source.name}:`, error); }
        }
    }

    private outcomeStatus(result: ToolResult): ToolOutcomeStatus {
        return result.outcomeStatus ?? (result.error ? 'failed' : 'succeeded');
    }

    /**
     * 执行工具调用
     * 
     * ✅ 优化: 使用 Tool → Source 映射，避免遍历
     */
    private async executeToolCalls(
        toolCalls: Array<{
            toolCallId: string;
            toolName: string;
            args: unknown;
        }>,
        routes: ReadonlyMap<string, ToolExecutionRoute>,
        turn: ToolTurn,
        expansion?: (source: ContextDrivenSource, previous: readonly ToolResult[]) => ToolExecutionBudget
    ): Promise<ToolResult[]> {
        const results: ToolResult[] = [];

        for (const toolCall of toolCalls) {
            // 使用本轮路由查找对应的 source
            const route = routes.get(toolCall.toolName);
            const source = route?.source;

            if (turn.closing) {
                results.push({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, outcomeStatus: 'rejected',
                    error: { code: 'E_TOOL_NOT_DISPATCHED', message: 'The session closed before this Tool call was dispatched.' } });
                continue;
            }
            if (!this.running || (source && this.sourceEnabledMap.get(source.name) === false)) {
                results.push({
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    outcomeStatus: 'rejected',
                    error: { code: 'E_SOURCE_UNAVAILABLE', message: 'The driver or tool source is no longer active' },
                });
                continue;
            }

            if (source) {
                const execute = route.executeTool;
                if (!execute) {
                    results.push({
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        outcomeStatus: 'rejected',
                        error: { code: 'E_SOURCE_UNAVAILABLE', message: 'The captured context has no executor for this tool.' },
                    });
                    continue;
                }
                const controller = new AbortController();
                this.runningTool = { source: source.name, controller };
                try {
                    const execution = execute(toolCall.toolName, toolCall.args, toolCall.toolCallId,
                        expansion?.(source, results), controller.signal);
                    const result = await (route.settlesOnAbort ? execution : Promise.race([execution, turn.interrupted]));

                    if (result === TOOL_TURN_CLOSED) {
                        results.push({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, outcomeStatus: 'unknown',
                            error: { code: 'E_TOOL_OUTCOME_UNKNOWN', message: 'The session closed while this Tool call was running.' } });
                    } else if (result) {
                        results.push(result);
                        this.logger.debug(
                            `Tool ${toolCall.toolName} executed by ${source.name}`
                        );
                    } else {
                        // Source 返回 undefined，Tool 不属于它
                        this.logger.warn(
                            `Tool ${toolCall.toolName} not found in ${source.name}`
                        );
                        results.push({
                            toolCallId: toolCall.toolCallId,
                            toolName: toolCall.toolName,
                            outcomeStatus: 'rejected',
                            error: {
                                code: 'E_TOOL_NOT_FOUND',
                                message: `Tool ${toolCall.toolName} not found`,
                            },
                        });
                    }
                } catch (error) {
                    this.logger.error(
                        `Error executing tool ${toolCall.toolName}:`,
                        error
                    );
                    results.push({
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        outcomeStatus: 'unknown',
                        error: {
                            code: 'E_EXECUTION_ERROR',
                            message:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    });
                } finally {
                    this.runningTool = undefined;
                }
            } else {
                // 没有找到对应的 source
                this.logger.warn(
                    `No DrivenSource found for tool: ${toolCall.toolName}`
                );
                results.push({
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    outcomeStatus: 'rejected',
                    error: {
                        code: 'E_TOOL_NOT_FOUND',
                        message: `No DrivenSource can execute tool: ${toolCall.toolName}`,
                    },
                });
            }
        }

        return results;
    }

    /**
     * 设置状态
     */
    private async setState(newState: AgentState): Promise<void> {
        const oldState = this.state;
        if (oldState === newState) return;

        this.logger.info(`State transition: ${oldState} → ${newState}`);
        this.state = newState;

        // 触发状态变化回调
        if (this.config.onStateChange) {
            this.config.onStateChange(oldState, newState);
        }
    }

    /**
     * 处理更新信号
     * 
     * ✅ 修复后：非阻塞模式，只负责设置标志位和唤醒
     * 
     * 核心改进：
     * - 不再阻塞等待 idle 状态
     * - 只设置 pendingUpdate 标志位
     * - 尝试唤醒主循环（即使丢失信号也无妨，Loop 会检查标志位）
     */
    private async handleUpdate(): Promise<void> {
        this.requestRun();
    }

    /**
     * 请求调度一次 run
     * 
     * 语义：多次更新信号合并为一次 run
     */
    private requestRun(): void {
        if (!this.running) {
            return;
        }

        this.pending = true;

        // When paused, keep the pending flag but don't drain —
        // resume() will kick off drainPendingRuns()
        if (this.paused) {
            return;
        }

        void this.drainPendingRuns();
    }

    /**
     * 单飞行 drain：保证 run 非重入，且合并连续更新
     */
    private async drainPendingRuns(): Promise<void> {
        if (this.runInFlight) {
            return;
        }

        this.runInFlight = (async () => {
            do {
                this.pending = false;
                await this.run();
            } while (this.pending && this.running && !this.paused);
        })().finally(() => {
            this.runInFlight = null;
        });

        await this.runInFlight;
    }

    /**
     * 运行主循环 (一次 run)
     * 
     * 完整的 LLM ReAct 循环：
     * 1. 收集 Messages 和 Tools
     * 2. 调用 LLM
     * 3. 如果有 ToolCalls:
     *    - 执行 ToolCalls
     *    - 等待 Source 发送新信号 (Tool 执行完成后)
     * 4. 回到 idle 状态
     */
    private async run(): Promise<void> {
        await this.setState('thinking');
        const retained: CapturedSourceContext[] = [];
        let turn: ToolTurn | undefined;

        try {
            // 1. 收集 Messages 和 Tools
            await this.captureContexts(retained);
            if (!this.running) return;
            const hasWindowPlanner = retained.some(({ context }) => context.fitModelBudget);
            const measure = hasWindowPlanner && this.config.llm.inputBudget ? await this.llmClient.createInputMeasurement() : undefined;
            if (measure) {
                const fit = await this.fitContexts(measure, retained);
                if (fit && fit.measurement.estimated > fit.measurement.inputLimit) throw inputBudgetExceeded(fit.measurement);
            }
            const messages = await this.collectMessages(retained);
            const { tools, routes, preserveTools } = this.collectTools(retained);
            if (!this.running) return;

            this.logger.info('Run iteration:', {
                messagesCount: messages.length,
                toolsCount: Object.keys(tools).length,
            });

            // 2. 调用 LLM (若配置了流式回调，实时推送增量文本/推理)
            let admitted = false;
            const response = await this.llmClient.call(messages, tools, {
                preserveTools,
                beforeRequest: async signature => {
                    if (!this.running || signature === this.lastInputSignature) throw REQUEST_SKIPPED;
                    for (const { context } of retained) {
                        if (!this.running) throw REQUEST_SKIPPED;
                        if (retained.some(item => item.context.managementOnly) && !context.managementOnly) continue;
                        await context.adopt?.();
                    }
                    if (!this.running) throw REQUEST_SKIPPED;
                    this.lastInputSignature = signature;
                    this.lastModelRequestFailed = false;
                    admitted = true;
                },
                onTextDelta: this.config.onTextDelta,
                onReasoningDelta: this.config.onReasoningDelta,
            }).catch(error => {
                if (admitted) this.lastModelRequestFailed = true;
                throw error;
            });
            // stop/dispose of the owning session cannot admit a late model call.
            if (!this.running) return;

            this.logger.info('LLM response:', {
                textLength: response.text.length,
                toolCallsCount: response.toolCalls.length,
                finishReason: response.finishReason,
            });

            const assistant = response.assistantMessage ?? (response.toolCalls.length ? {
                role: 'assistant' as const, content: response.toolCalls.map(call => ({
                    type: 'tool-call' as const, toolName: call.toolName, toolCallId: call.toolCallId, input: call.args,
                })),
            } : undefined);
            if (response.toolCalls.length) this.toolTurn = turn = createToolTurn();
            if (assistant && this.config.onAssistantMessage) {
                this.logger.debug('Emitting onAssistantMessage event');
                this.config.onAssistantMessage(assistant);
            }

            const { usage } = response;
            if (usage && this.config.onLLMUsage) {
                void (async () => {
                    try { await this.config.onLLMUsage?.(usage); }
                    catch (error) { this.logger.warn('Model usage observer failed', { error }); }
                })();
            }

            // 3. 如果有 ToolCalls
            if (turn && assistant) {
                await this.setState('executing');

                this.logger.info(`Executing ${response.toolCalls.length} tool calls...`);

                const results = await this.executeToolCalls(response.toolCalls, routes, turn, measure && ((source, previous) => ({
                    checkExpansion: async (candidate, proposed) => {
                        const captured: CapturedSourceContext[] = [];
                        try {
                            for (const active of this.getActiveSources()) {
                                captured.push({ source: active, context: active === source ? candidate : await this.captureSource(active) });
                            }
                            const results = [...previous, proposed, ...response.toolCalls.slice(previous.length + 1)
                                .map(call => ({ toolName: call.toolName, toolCallId: call.toolCallId, result: { pending: true } }))];
                            const batch = { assistant, results, routes, feedbackSource: source };
                            const trial = await this.fitContexts(measure, captured.map(item => ({ ...item })), batch);
                            if (!trial) return await this.measureContexts(measure, captured, batch);
                            if (!trial.feedback || trial.measurement.estimated > trial.measurement.inputLimit) return trial.measurement;
                            const sealed = await this.fitContexts(measure, captured, batch, trial.feedback);
                            return (sealed ?? trial).measurement;
                        } finally { await this.releaseContexts(captured.filter(item => item.source !== source)); }
                    },
                })));
                const counts = { succeeded: 0, rejected: 0, failed: 0, accepted: 0, unknown: 0 };
                for (const result of results) counts[this.outcomeStatus(result)] += 1;

                this.logger.info('Tool execution completed:', {
                    resultsCount: results.length,
                    successCount: counts.succeeded,
                    errorCount: counts.rejected + counts.failed,
                    rejectedCount: counts.rejected,
                    failedCount: counts.failed,
                    acceptedCount: counts.accepted,
                    unknownCount: counts.unknown,
                });

                // ✅ 新增: 发射 toolresult message 事件
                let budgetFailure: unknown;
                if (this.config.onToolResult) {
                    let feedback: object | undefined;
                    const feedbackSource = retained.find(({ source, context }) => context.fitModelBudget &&
                        results.some(result => routes.get(result.toolName)?.source === source))?.source;
                    if (measure && feedbackSource && this.running) {
                        try {
                            const prepareFeedback = async () => {
                                const next: CapturedSourceContext[] = [];
                                try {
                                    await this.captureContexts(next);
                                    return await this.fitContexts(measure, next, { assistant, results, routes, feedbackSource });
                                } finally { await this.releaseContexts(next); }
                            };
                            const plan = await Promise.race([prepareFeedback(), turn.interrupted]);
                            if (plan !== TOOL_TURN_CLOSED && !turn.closing) {
                                plan?.retainFeedback?.();
                                feedback = plan?.feedback;
                                if (plan && plan.measurement.estimated > plan.measurement.inputLimit)
                                    budgetFailure = inputBudgetExceeded(plan.measurement);
                            }
                        } catch (error) { budgetFailure = error; }
                    }
                    const toolMessage = this.createToolMessage(results, feedback, result => routes.get(result.toolName)?.source === feedbackSource);
                    this.logger.debug('Emitting onToolResult event');
                    await this.config.onToolResult(toolMessage, results);
                }
                turn.delivered();
                this.toolTurn = undefined;
                if (budgetFailure) throw budgetFailure;

                // Outcomes alone never schedule retries. In particular an unknown
                // result is not evidence that the Tool call had no side effects.
                // A new user message or source update may request a fresh turn.

                // ✅ 关键改进: 执行完 Tool 后，不立即进入下一循环
                // 而是回到 idle，等待 Source 发送新信号
                // 
                // 原因：
                // - Tool 执行完成后，Source 需要更新状态 (如 TUI App 更新 Snapshot)
                // - Source 更新后会发送新信号，AgentDriver 再次进入循环
                // - 这样可以确保 LLM 看到最新的状态
                this.logger.info('Tool execution finished. Returning to idle, waiting for source signals...');
            } else {
                // 没有 ToolCalls，说明 LLM 完成了思考
                this.logger.info('No tool calls. LLM finished thinking.');
            }

            // 回到 idle 状态
            await this.setState('idle');

        } catch (error) {
            turn?.failed(error);
            if (error === REQUEST_SKIPPED) return;
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Error in run loop:', normalizedError.stack ?? normalizedError.message);
            this.config.onRunError?.(normalizedError);
            await this.setState('idle');
        } finally {
            await this.releaseContexts(retained);
            await this.setState('idle');
        }
    }

    /**
     * 创建 Tool Message
     * 
     * 将 ToolResult[] 转换为 Vercel AI SDK 的 CoreToolMessage
     * 
     * @param results - ToolResult 数组
     * @returns Tool Message
     */
    private createToolMessage(results: readonly ToolResult[], feedback?: object, isRelated = (_result: ToolResult) => false): ModelMessage {
        let included = false;
        return {
            role: 'tool',
            content: results.map((result) => {
                const report = feedback && isRelated(result) ? included && 'report_id' in feedback ? { report_id: feedback.report_id } : feedback
                    : undefined;
                included ||= report !== undefined;
                return { type: 'tool-result', toolCallId: result.toolCallId, toolName: result.toolName,
                    output: this.toolOutput(result, report) };
            }) as any,
        };
    }

    private toolOutput(result: ToolResult, feedback?: object): unknown {
        const status = result.outcomeStatus;
        const uncertain = status === 'unknown' || status === 'accepted';
        const error = result.error ?? (status && status !== 'succeeded' ? {
            code: uncertain ? 'TOOL_RESULT_UNCONFIRMED' : 'TOOL_EXECUTION_FAILED',
            message: uncertain ? 'Tool completion could not be confirmed.' : 'Tool execution failed.',
        } : undefined);
        return error ? { type: 'error-json', value: {
            ...error, ...(result.result === undefined ? {} : { result: result.result }),
            ...(feedback ? { window_budget: feedback } : {}),
            ...(uncertain ? { retryable: false,
                message: error.message + ' The Tool call may have had effects. Check the application View before retrying.' } : {}),
        } } : { type: 'json', value: feedback ? { result: result.result ?? { success: true }, window_budget: feedback }
            : result.result ?? { success: true } };
    }

    /**
     * 启动 AgentDriver
     */
    start(): void {
        if (this.running) {
            this.logger.warn('AgentDriver already running');
            return;
        }

        this.running = true;
        this.logger.info('AgentDriver started');
    }

    /**
     * 停止 AgentDriver
     */
    stop(): void {
        this.running = false;
        this.runningTool?.controller.abort();
        this.logger.info('AgentDriver stopped');
    }

    /** Stop scheduling and wait for the published turn's results to be delivered to the Host. */
    closeToolTurn(): Promise<void> {
        const turn = this.toolTurn;
        if (this.running) this.stop();
        turn?.close();
        return turn?.completion ?? Promise.resolve();
    }

    /**
     * 手动触发工作循环
     * 
     * 用于测试或手动触发
     */
    async trigger(): Promise<void> {
        if (this.state !== 'idle') {
            this.logger.warn('AgentDriver is busy, marking update instead');
        }

        if (!this.runInFlight && this.lastModelRequestFailed) {
            this.lastInputSignature = null;
            this.lastModelRequestFailed = false;
        }
        this.requestRun();
    }

    /**
     * 暂停 AgentDriver
     * 
     * 不停止运行，只阻止新的 LLM 调用触发。
     * 当前正在进行的 run() 会完成，之后进入 idle 并不再 drain。
     */
    pause(): void {
        if (this.paused) return;
        this.paused = true;
        this.logger.info('AgentDriver paused');
    }

    /**
     * 恢复 AgentDriver
     * 
     * 如果暂停期间有 pending 更新，立即触发一次 run。
     */
    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        this.logger.info('AgentDriver resumed');
        if (this.pending && this.running) {
            void this.drainPendingRuns();
        }
    }

    /**
     * 是否处于暂停状态
     */
    isPaused(): boolean {
        return this.paused;
    }

    /**
     * 清理资源
     */
    dispose(): void {
        this.runningTool?.controller.abort();
        const errors: unknown[] = [];
        for (const unsubscribe of this.unsubscribers.splice(0)) {
            try { unsubscribe(); }
            catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Failed to unsubscribe Driver sources');
        this.logger.info('AgentDriver V2 disposed');
    }
    
}
