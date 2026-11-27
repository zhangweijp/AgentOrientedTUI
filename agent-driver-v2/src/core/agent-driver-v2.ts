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
import { assembleContextRegions, getClientToolCallIds, getToolResultIds } from './context-regions.js';

const REQUEST_SKIPPED = Symbol('model request skipped');
const TOOL_TURN_CLOSED = Symbol('tool turn closed');

interface CapturedSourceContext {
    source: ContextDrivenSource;
    context: DrivenSourceContext;
    release?: DrivenSourceContext['release'];
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

function recoveryHistory(messages: readonly MessageWithTimestamp[]): MessageWithTimestamp[] {
    const history = messages.filter(message => message.region === undefined || message.region === 'session')
        .sort((a, b) => b.timestamp - a.timestamp);
    const user = history.find(message => message.role === 'user');
    const lastResult = history.findIndex(message => message.role === 'tool');
    const result = history[lastResult];
    const ids = result ? new Set(getToolResultIds(result)) : undefined;
    const callIndex = ids ? history.findIndex((message, index) => index > lastResult &&
        getClientToolCallIds(message).some(id => ids.has(id))) : -1;
    const call = history[callIndex];
    const clientIds = new Set(call ? getClientToolCallIds(call) : []);
    const paired = new Set(call ? history.slice(0, callIndex).filter(message =>
        getToolResultIds(message).some(id => clientIds.has(id))) : []);
    const delivered = new Set([...paired].flatMap(getToolResultIds));
    const complete = !!call && [...clientIds].every(id => delivered.has(id));
    return messages.filter(message => (message.role === 'system' && message.region !== 'dynamic') ||
        message === user || complete && (message === call || paired.has(message)));
}

/**
 * AgentDriverV2 - 核心类
 */
export class AgentDriverV2 {
    private static nextId = 1;

    private readonly driverId: number;
    private sources: ContextDrivenSource[];
    private unsubscribers: (() => void)[] = [];
    private updateDebounced: (() => void) & { cancel(): void };
    private logger: Logger;
    private config: AgentDriverV2Config;
    private llmClient: LLMClient;
    private sourceEnabledMap = new Map<string, boolean>();

    // 状态机
    private state: AgentState = 'idle';
    private pending: false | 'update' | 'explicit' = false;
    private runInFlight: Promise<void> | null = null;
    private runController?: AbortController;
    private toolTurn?: ToolTurn;
    private runningTool?: { source: string; controller: AbortController };
    private lastInputSignature: string | null = null;
    private lastRunFailed = false;

    private running = false;
    private paused = false;
    private disposed = false;

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
        return this.pending !== false;
    }

    setSourceEnabled(sourceName: string, enabled: boolean): void {
        this.sourceEnabledMap.set(sourceName, enabled);
        if (!enabled && this.runningTool?.source === sourceName) this.runningTool.controller.abort();
        if (this.running) this.updateDebounced();
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
        // A Source may announce its initial context synchronously during subscription.
        let subscribing = true;
        this.sources.forEach((source) => {
            const unsubscribe = source.onUpdate(() => {
                this.logger.debug(`Update signal from source: ${source.name}`);
                if (!this.disposed && (subscribing || this.running)) this.updateDebounced();
            });
            this.unsubscribers.push(unsubscribe);
        });
        subscribing = false;

        this.logger.info(`Listening to ${this.sources.length} driven sources`);
    }

    /**
     * 收集所有消息
     * 
     * ✅ 简化: 直接聚合，按时间戳排序
     * - 每个 source 已经保证消息去重
     * - AgentDriver 只需拼接并排序
     */
    private async collectMessages(captured: readonly CapturedSourceContext[], management: CapturedSourceContext | undefined,
        batch?: ToolBatch, feedback?: object, notices: readonly string[] = []): Promise<ModelMessage[]> {
        const history = captured.flatMap(item => item === management ? [] : item.context.messages);
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
        const allMessages = management ? [...management.context.messages, ...recoveryHistory(history)] : history;
        if (notices.length) allMessages.push({ role: 'user', region: 'dynamic', timestamp: 0,
            content: 'Optional tools unavailable for this request.\n' + notices.join('\n') });

        const normalizedTimedMessages = allMessages.filter(message => message.role !== 'assistant' ||
            (typeof message.content === 'string' ? message.content.trim().length > 0 : message.content.length > 0));

        const normalized = assembleContextRegions(normalizedTimedMessages);

        const toolMessages = normalized.filter((message) => message.role === 'tool');
        const nonToolMessages = normalized.filter((message) => message.role !== 'tool');
        const usedToolMessages = new Set<number>();
        const reordered: ModelMessage[] = [];

        for (const message of nonToolMessages) {
            reordered.push(message);

            const toolCallIds = getClientToolCallIds(message);
            if (toolCallIds.length === 0) {
                continue;
            }

            toolMessages.forEach((toolMessage, index) => {
                if (!usedToolMessages.has(index) && getToolResultIds(toolMessage).some(id => toolCallIds.includes(id))) {
                    usedToolMessages.add(index);
                    reordered.push(toolMessage);
                }
            });
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
                const callIds = getClientToolCallIds(message);
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

                const matchedParts = message.content.filter(part => (
                    part?.type === 'tool-result'
                    && typeof part.toolCallId === 'string'
                    && pendingIds.delete(part.toolCallId)
                ));

                if (matchedParts.length === 0) {
                    this.logger.warn('Dropping tool message because no toolCallId matches pending assistant tool-calls');
                    continue;
                }

                protocolSafe.push({
                    ...message,
                    content: matchedParts,
                });
                continue;
            }

            pendingToolCallIds = null;
            protocolSafe.push(message);
        }

        return protocolSafe;
    }

    /** Capture once per source; never silently replace a failed atomic capture. */
    private async captureContexts(retained: CapturedSourceContext[], signal?: AbortSignal): Promise<void> {
        for (const source of this.getActiveSources()) {
            signal?.throwIfAborted();
            try {
                const context = await this.captureSource(source, signal);
                retained.push({ source, context, release: context.release?.bind(context) });
            } catch (error) {
                this.logger.error(`Failed to capture context from ${source.name}:`, error);
                // An atomic source is part of the current working state. A failed
                // capture must fail the turn, not silently omit that state.
                throw error;
            }
            // A late capture must first be retained for its one release.
            signal?.throwIfAborted();
        }
    }

    private async captureSource(source: ContextDrivenSource, signal?: AbortSignal): Promise<DrivenSourceContext> {
        const policy = await this.llmClient.toolSchemaPolicy();
        signal?.throwIfAborted();
        return source.getContext(policy);
    }

    private async prepareRequest(captured: readonly CapturedSourceContext[], batch?: ToolBatch, feedback?: object) {
        const management = captured.find(({ context }) => context.managementOnly);
        const selected = management ? [management] : captured;
        const { tools, routes, owners, preserveTools } = this.collectTools(selected);
        const policy = await this.llmClient.toolSchemaPolicy();
        const notices: string[] = [];
        // Check only the final tool winners, never a context borrowed solely for history.
        if (policy.check) for (const [name, tool] of Object.entries(tools)) {
            if (tool.type === 'provider') continue;
            const issue = policy.check(await asSchema(tool.inputSchema).jsonSchema);
            if (!issue) continue;
            const error = new ProviderToolSchemaError(policy.label, name, issue.path, issue.reason);
            const owner = owners.get(name);
            // Only a Source that has no adopted observation can safely omit an optional tool here.
            if (owner?.context.preserveTools || owner?.context.adopt) throw error;
            notices.push(error.message);
            delete tools[name];
            routes.delete(name);
            owners.delete(name);
        }
        return { selected, tools, routes, owners, preserveTools,
            messages: await this.collectMessages(captured, management, batch, feedback, notices) };
    }

    private collectTools(selected: readonly CapturedSourceContext[]) {
        const tools: Record<string, Tool> = Object.create(null);
        const routes = new Map<string, ToolExecutionRoute>();
        const owners = new Map<string, CapturedSourceContext>();
        for (const owner of selected) {
            const { source, context } = owner;
            const executeTool = context.executeTool?.bind(context);
            for (const [name, tool] of Object.entries(context.tools)) {
                const previous = owners.get(name);
                if (previous?.context.preserveTools) {
                    if (context.preserveTools || context.adopt)
                        throw new ProviderToolSchemaError('Driver', name, '$.tools', 'A selected observation has a conflicting tool route.');
                    continue;
                }
                if (previous?.context.adopt)
                    throw new ProviderToolSchemaError('Driver', name, '$.tools', 'A selected observation has a conflicting tool route.');
                if (previous && context.preserveTools)
                    this.logger.warn('Tool conflicts with an observation-bound tool', { name, source: previous.source.name });
                tools[name] = tool;
                owners.set(name, owner);
                // Provider-executed capabilities and history registrations are never Source executors.
                if (tool.type === 'provider') routes.delete(name);
                else routes.set(name, { source, executeTool, settlesOnAbort: context.toolsSettlingOnAbort?.has(name) === true });
            }
        }
        return { tools, routes, owners, preserveTools: selected.some(({ context }) => context.preserveTools) };
    }

    private async measureContexts(measure: InputMeasure, captured: readonly CapturedSourceContext[], batch?: ToolBatch, feedback?: object) {
        const { messages, tools, preserveTools } = await this.prepareRequest(captured, batch, feedback);
        return measure(messages, tools, preserveTools);
    }

    private async fitContexts(measure: InputMeasure, captured: CapturedSourceContext[], batch?: ToolBatch,
        sealedFeedback?: object): Promise<FittedModelRequest | undefined> {
        const owner = captured.find(item => item.context.fitModelBudget && (!batch?.feedbackSource || batch.feedbackSource === item.source));
        if (!owner) return;
        const fit = await owner.context.fitModelBudget!(async (candidate, feedback) =>
            this.measureContexts(measure, captured.map(item => item === owner ? { source: owner.source, context: candidate } : item),
                batch, sealedFeedback ?? feedback), !!batch && !sealedFeedback);
        if (fit.context) {
            owner.release ??= owner.context.release?.bind(owner.context);
            owner.context = fit.context;
        }
        return fit;
    }

    private async releaseContexts(retained: CapturedSourceContext[]): Promise<boolean> {
        let failed = false;
        for (const { source, context, release } of retained.reverse()) {
            try { await (release ?? context.release?.bind(context))?.(); }
            catch (error) {
                failed = true;
                this.logger.error(`Failed to release context from ${source.name}:`, error);
            }
        }
        return failed;
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
        signal: AbortSignal,
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
            if (signal.aborted || !this.running || (source && this.sourceEnabledMap.get(source.name) === false)) {
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
        try {
            void Promise.resolve(this.config.onStateChange?.(oldState, newState))
                .catch(error => this.logger.error('State observer failed:', error));
        } catch (error) {
            this.logger.error('State observer failed:', error);
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
    private requestRun(explicit = false): void {
        if (!this.running) {
            return;
        }

        if (explicit || !this.pending) this.pending = explicit ? 'explicit' : 'update';

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
    private drainPendingRuns(): void {
        if (this.runInFlight) return;

        // Register the owner before any Source or state callback can reenter trigger().
        this.runInFlight = Promise.resolve().then(async () => {
            try {
                while (this.pending && this.running && !this.paused) {
                    const explicit = this.pending === 'explicit';
                    this.pending = false;
                    try { await this.run(explicit); }
                    catch (error) {
                        this.lastRunFailed = true;
                        this.logger.error('Driver run cleanup failed:', error);
                    }
                }
            } finally {
                this.runInFlight = null;
            }
        }).catch(error => this.logger.error('Driver drain failed:', error));
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
    private async run(explicit = false): Promise<void> {
        if (!this.running || this.runController) return;
        const controller = new AbortController();
        this.runController = controller;
        const { signal } = controller;
        const retained: CapturedSourceContext[] = [];
        let turn: ToolTurn | undefined;

        try {
            await this.setState('thinking');
            signal.throwIfAborted();
            // 1. 收集 Messages 和 Tools
            await this.captureContexts(retained, signal);
            signal.throwIfAborted();
            const hasWindowPlanner = retained.some(({ context }) => context.fitModelBudget);
            const measure = hasWindowPlanner && this.config.llm.inputBudget ? await this.llmClient.createInputMeasurement() : undefined;
            signal.throwIfAborted();
            if (measure) {
                const fit = await this.fitContexts(measure, retained);
                signal.throwIfAborted();
                if (fit && fit.measurement.estimated > fit.measurement.inputLimit) throw inputBudgetExceeded(fit.measurement);
            }
            const { selected, messages, tools, routes, owners, preserveTools } = await this.prepareRequest(retained);
            signal.throwIfAborted();

            this.logger.info('Run iteration:', {
                messagesCount: messages.length,
                toolsCount: Object.keys(tools).length,
            });

            // 2. 调用 LLM (若配置了流式回调，实时推送增量文本/推理)
            const { onTextDelta, onReasoningDelta } = this.config;
            const response = await this.llmClient.call(messages, tools, {
                preserveTools, signal,
                beforeRequest: async (signature, offered) => {
                    signal.throwIfAborted();
                    // Optional capability filtering is allowed only without a retained observation grant.
                    if (offered) for (const [name, owner] of owners) {
                        if (offered.has(name)) continue;
                        if (owner.context.adopt)
                            throw new ProviderToolSchemaError('Driver', name, '$.tools', 'The selected observation cannot be adopted with an omitted tool.');
                        routes.delete(name);
                    }
                    // Retain successful-input deduplication; a new explicit intent may retry a failed run.
                    if (signature === this.lastInputSignature && !(explicit && this.lastRunFailed)) throw REQUEST_SKIPPED;
                    for (const { context } of selected) {
                        signal.throwIfAborted();
                        await context.adopt?.();
                    }
                    signal.throwIfAborted();
                    this.lastInputSignature = signature;
                    this.lastRunFailed = false;
                },
                onTextDelta: onTextDelta && (delta => { if (!signal.aborted) onTextDelta(delta); }),
                onReasoningDelta: onReasoningDelta && (delta => { if (!signal.aborted) onReasoningDelta(delta); }),
            });
            // The original signal stays aborted even if stop() was followed by start().
            signal.throwIfAborted();

            const assistant = response.assistantMessage ?? (response.toolCalls.length ? {
                role: 'assistant' as const, content: response.toolCalls.map(call => ({
                    type: 'tool-call' as const, toolName: call.toolName, toolCallId: call.toolCallId, input: call.args,
                })),
            } : undefined);
            const content = assistant?.content;
            const { usage } = response;
            this.logger.info('LLM response:', {
                textLength: typeof content === 'string' ? content.length
                    : content?.reduce((length, part) => length + (part.type === 'text' ? part.text.length : 0), 0) ?? 0,
                toolCallsCount: response.toolCalls.length,
                usage: usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
            });
            if (response.toolCalls.length || response.toolMessages?.length) this.toolTurn = turn = createToolTurn();
            if (assistant && this.config.onAssistantMessage) {
                this.logger.debug('Emitting onAssistantMessage event');
                this.config.onAssistantMessage(assistant);
            }

            if (usage && this.config.onLLMUsage) {
                void (async () => {
                    try { await this.config.onLLMUsage?.(usage); }
                    catch (error) { this.logger.warn('Model usage observer failed', { error }); }
                })();
            }

            // SDK-completed protocol operations have no Source execution receipt.
            for (const toolMessage of response.toolMessages ?? []) await this.config.onToolResult?.(toolMessage, []);
            if (turn && response.toolCalls.length === 0) {
                turn.delivered();
                this.toolTurn = undefined;
            }

            // 3. 如果有 ToolCalls
            if (turn && assistant && response.toolCalls.length > 0) {
                await this.setState('executing');

                this.logger.info(`Executing ${response.toolCalls.length} tool calls...`);

                const results = await this.executeToolCalls(response.toolCalls, routes, turn, signal, measure && ((source, previous) => ({
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
                if (counts.unknown > 0) this.lastRunFailed = true;

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
                    const feedbackSource = selected.find(({ source, context }) => context.fitModelBudget &&
                        results.some(result => routes.get(result.toolName)?.source === source))?.source;
                    if (measure && feedbackSource && !signal.aborted && !turn.closing) {
                        try {
                            const prepareFeedback = async () => {
                                const next: CapturedSourceContext[] = [];
                                try {
                                    await this.captureContexts(next, signal);
                                    signal.throwIfAborted();
                                    return await this.fitContexts(measure, next, { assistant, results, routes, feedbackSource });
                                } finally { await this.releaseContexts(next); }
                            };
                            const plan = await Promise.race([prepareFeedback(), turn.interrupted]);
                            if (plan !== TOOL_TURN_CLOSED && !turn.closing && !signal.aborted) {
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

        } catch (error) {
            turn?.failed(error);
            if (error === REQUEST_SKIPPED) return;
            this.lastRunFailed = true;
            // Cancellation of unpublished model work is not a failed business delivery.
            if (signal.aborted && !turn) return;
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Error in run loop:', normalizedError.stack ?? normalizedError.message);
            try {
                void Promise.resolve(this.config.onRunError?.(normalizedError))
                    .catch(observerError => this.logger.error('Run error observer failed:', observerError));
            } catch (observerError) {
                this.logger.error('Run error observer failed:', observerError);
            }
        } finally {
            try {
                if (await this.releaseContexts(retained)) this.lastRunFailed = true;
            } finally {
                this.runController = undefined;
                await this.setState('idle');
            }
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
        if (this.disposed) return;
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
        this.pending = false;
        this.updateDebounced.cancel();
        if (this.runController) {
            this.lastRunFailed = true;
            this.runController.abort();
        }
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

        this.requestRun(true);
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
        this.disposed = true;
        this.stop();
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
