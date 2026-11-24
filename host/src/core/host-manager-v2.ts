/**
 * @aotui/host - HostManager V2
 *
 * 管理当前 Topic 和 GUI 事件，会话操作委托给 SessionManagerV3。
 */

import type { ModelMessage } from 'ai';
import { AgentDriverV2, ModelInputError, ProviderToolSchemaError, type LLMConfig, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { createDesktopId, type IDesktop, type IKernel } from '@aotui/runtime';
import type { AppConfigEntry } from '../app-distribution/app-catalog.js';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { readDesktopPreview } from './desktop-preview.js';
import { MessageService } from './message-service.js';
import { Logger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import { LLMConfigService } from './llm-config-service.js';
import { SessionManagerV3 } from './session-manager-v3.js';
import type { ModelRegistry } from '../services/model-registry.js';
import type { GuiUpdateEvent, ModelUsageEvent } from '../types/session.js';
import type {
    CatalogSearchResponse,
    InstallAppOptions,
    InstallAppResult
} from './desktop-manager.js';
import { SystemPromptDrivenSource } from '../adapters/system-prompt-source.js';
import { SkillDrivenSource } from '../skills/skill-driven-source.js';
import { McpDrivenSource } from '../mcp/source.js';
import { IMSessionManager, type IMCreatedAgentDriver } from '../im/im-session-manager.js';
import { IMDrivenSource } from '../im/im-driven-source.js';
import type { IMInboundMessage } from '../im/types.js';
import { appendIMMessage, listIMMessages, replaceIMMessages } from '../im/message-store.js';
import { deleteIMSession, getIMSession, listIMSessions, upsertIMSession, type IMPersistedSession } from '../im/session-store.js';
import { Config } from '../config/config.js';
import { checkCloseTasks } from './desktop-close.js';
import { PendingAppReceipts, type AppReceiptMessageQuery } from './pending-app-receipts.js';
import type { ReceiptAccess } from '@aotui/runtime';
import {
    applySourceControlsToSources,
    createSourceControlsFromAgent,
    type SourceControlsSnapshot,
} from './source-controls.js';

/**
 * HostManager V2 (Simplified)
 */
export class HostManagerV2 {
    private sessionManager: SessionManagerV3 | null = null;
    private imSessionManager: IMSessionManager | null = null;
    private messageService: MessageService;
    private currentTopicId: string;
    private logger: Logger;
    private events: EventEmitter;
    private llmConfigService: LLMConfigService;
    private kernel: IKernel | null = null;
    private imRuntimeProvider: (() => unknown) | null = null;
    private readonly imMessageIds = new WeakMap<MessageWithTimestamp, string>();
    private readonly imAppReceipts = new WeakMap<object, { receipts: PendingAppReceipts; source: SemanticAOTUIDrivenSource }>();

    private desktopManager: import('./desktop-manager.js').DesktopManager | null = null;

    constructor(defaultTopicId: string, modelRegistry: ModelRegistry) {
        this.currentTopicId = defaultTopicId;
        this.messageService = new MessageService();
        this.logger = new Logger('HostManagerV2');
        this.events = new EventEmitter();
        this.llmConfigService = new LLMConfigService(modelRegistry);
    }

    /**
     * 初始化 AgentDriver
     * 
     * 使用 SessionManagerV3 替代直接创建 AgentDriver
     */
    async initAgentDriver(
        kernel: IKernel,
        desktopManager: import('./desktop-manager.js').DesktopManager,
    ): Promise<void> {
        this.kernel = kernel;
        this.desktopManager = desktopManager;
        
        // 创建 SessionManagerV3
        this.sessionManager = new SessionManagerV3(
            desktopManager,
            this.llmConfigService,
            this.messageService
        );
        
        // 监听 SessionManager 事件
        this.sessionManager.on('message', (event: GuiUpdateEvent) => {
            this.emitGuiUpdate(event);
        });
        this.sessionManager.on('model-usage', (event: ModelUsageEvent) => this.events.emit('model-usage', event));

        this.imSessionManager = new IMSessionManager({
            createDesktop: async sessionKey => {
                const { desktop } = await this.requireDesktopManager().createDesktop(createDesktopId(sessionKey));
                return desktop;
            },
            createSource: ({ sessionKey }) => new IMDrivenSource({
                sessionKey,
                loadHistory: async (key) => listIMMessages(key).map(({ id, ...message }) => {
                    this.imMessageIds.set(message, id);
                    return message;
                }),
                persistMessage: (key, message) => { this.imMessageIds.set(message, appendIMMessage(key, message)); },
                replaceHistory: async (key, messages) => replaceIMMessages(key, messages, this.imMessageIds),
            }),
            persistSession: async (session) => {
                upsertIMSession(session);
            },
            deletePersistedSession: async (sessionKey) => {
                deleteIMSession(sessionKey);
            },
            createAgentDriver: input => this.createIMAgentDriver(input),
        });
        
        // ✅ 修复: 不再提前创建 Session，等 GUI 连接时按需创建
        // 这样避免创建用户不会使用的 default_topic Session
        
        this.logger.info('AgentDriver initialized via SessionManagerV3 (lazy session creation)');
    }

    /**
     * 用户发送消息
     * 
     * @param content - 消息内容
     * @param topicId - Topic ID（可选，默认使用 currentTopicId）
     */
    async sendUserMessage(
        content: string,
        topicId?: string,
        messageId?: string,
        attachments?: Array<{ id: string; mime: string; url: string; filename?: string }>
    ): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }
        
        const targetTopicId = topicId || this.currentTopicId;
        await this.sessionManager.sendMessage(targetTopicId, content, messageId, attachments);
    }

    async sendIMMessage(message: IMInboundMessage): Promise<void> {
        if (!this.imSessionManager) {
            throw new Error('IMSessionManager not initialized. Call initAgentDriver first.');
        }

        const compactionPolicy = await this.resolveIMCompactionPolicy(message.agentId);
        const session = await this.imSessionManager.ensureSession(message.sessionKey, message.agentId);
        const fallbackCompaction = await session.source.maybeCompactByThreshold({
            enabled: compactionPolicy.enabled,
            maxContextTokens: compactionPolicy.hardFallbackThresholdTokens,
            minMessages: compactionPolicy.minMessages,
            keepRecentMessages: compactionPolicy.keepRecentMessages,
            modelHint: compactionPolicy.modelHint,
        });
        if (fallbackCompaction.compacted) {
            for (const syntheticMessage of fallbackCompaction.syntheticMessages) {
                this.emitGuiUpdate({
                    topicId: message.sessionKey,
                    type: syntheticMessage.role === 'tool' ? 'tool' : 'assistant',
                    message: syntheticMessage as ModelMessage,
                });
            }

            this.logger.info('Hard fallback IM context compaction applied before inbound user message', {
                sessionKey: message.sessionKey,
                thresholdTokens: fallbackCompaction.thresholdTokens,
                currentTokens: fallbackCompaction.currentTokens,
                compactedMessageCount: fallbackCompaction.compactedMessageCount,
                cleanedToolResultCount: fallbackCompaction.cleanedToolResultCount,
            });
        }

        await this.imSessionManager.dispatch(message);

        this.emitGuiUpdate({
            topicId: message.sessionKey,
            type: 'user',
            message: {
                role: 'user',
                content: message.body,
            } as ModelMessage,
        });
    }

    /**
     * 切换主题
     */
    async switchTopic(topicId: string): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }
        
        this.currentTopicId = topicId;
        this.logger.info('Switched topic', { topicId });
    }

    /**
     * 为指定 Topic 创建或获取 Session
     * 
     * 用于 REST API 创建 Topic 时初始化 Session
     */
    async ensureSessionForTopic(topicId: string): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }
        
        await this.sessionManager.ensureSession(topicId);
        this.logger.info('Session initialized for topic', { topicId });
    }

    /**
     * 暂停指定 Topic 的 AgentDriver
     */
    pauseAgent(topicId: string): void {
        if (!this.sessionManager) return;
        this.sessionManager.pauseSession(topicId);
    }

    /**
     * 恢复指定 Topic 的 AgentDriver
     */
    resumeAgent(topicId: string): void {
        if (!this.sessionManager) return;
        this.sessionManager.resumeSession(topicId);
    }

    /**
     * Gracefully shutdown a Session without deleting data
     */
    async shutdownSession(topicId: string): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }

        await this.sessionManager.shutdownSession(topicId);
        this.logger.info('Session shutdown', { topicId });
    }

    /**
     * 监听 GUI 更新事件
     */
    onGuiUpdate(callback: (event: any) => void): () => void {
        this.events.on('gui-update', callback);
        return () => this.events.off('gui-update', callback);
    }

    onModelUsage(listener: (event: ModelUsageEvent) => void): () => void {
        const observe = async (event: ModelUsageEvent) => {
            try { await listener(event); }
            catch (error) { this.logger.warn('Model usage observer failed', { sessionId: event.sessionId, error }); }
        };
        this.events.on('model-usage', observe);
        return () => this.events.off('model-usage', observe);
    }

    /**
     * 获取消息
     */
    getMessages(topicId?: string): ModelMessage[] {
        return this.messageService.getMessages(topicId || this.currentTopicId);
    }

    getIMSessions(): IMPersistedSession[] {
        return listIMSessions();
    }

    getIMSession(sessionKey: string): IMPersistedSession | null {
        return getIMSession(sessionKey);
    }

    getIMMessages(sessionKey: string): ReturnType<typeof listIMMessages> {
        return listIMMessages(sessionKey);
    }

    readIMAppReceipt(sessionKey: string, query: AppReceiptMessageQuery, timeoutMs?: number): Promise<ReceiptAccess> {
        const session = this.imSessionManager?.getSession(sessionKey);
        const binding = session && this.imAppReceipts.get(session.source);
        if (!session || !binding) return Promise.resolve({ kind: 'unavailable', code: 'RECEIPT_LOCATOR_UNAVAILABLE',
            message: 'The owning IM session is unavailable.' });
        return binding.receipts.read(query, { desktop: session.desktop,
            isCurrent: () => this.imSessionManager?.getSession(sessionKey) === session,
            isAppEnabled: installationId => binding.source.isAppEnabled(installationId) }, timeoutMs);
    }

    setIMRuntimeProvider(provider: (() => unknown) | null): void {
        this.imRuntimeProvider = provider;
    }

    getIMRuntime(): unknown {
        return this.imRuntimeProvider ? this.imRuntimeProvider() : {};
    }

    async getDesktopPreview(topicId: string) {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }

        // Creation belongs to session.create; a late preview must not reopen a closed Topic.
        const session = this.sessionManager.getSession(topicId);
        if (!session || session.state === 'destroyed') {
            throw new Error(`Session not available for preview: ${topicId}`);
        }
        return readDesktopPreview(session.desktop);
    }

    /**
     * 获取 LLM 配置服务
     * 
     * 允许外部访问配置管理
     */
    getLLMConfigService(): LLMConfigService {
        return this.llmConfigService;
    }
    
    /**
     * 获取 SessionManager (用于高级功能)
     */
    getSessionManager(): SessionManagerV3 | null {
        return this.sessionManager;
    }

    getSourceControlState(topicId: string): Promise<SourceControlsSnapshot> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }

        return this.sessionManager.getSourceControlState(topicId);
    }

    syncTopicPromptOverride(topicId: string): void {
        if (!this.sessionManager) return;
        this.sessionManager.syncTopicPromptOverride(topicId);
    }

    setSourceEnabled(topicId: string, source: 'apps' | 'mcp' | 'skill', enabled: boolean): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }

        return this.sessionManager.setSourceEnabled(topicId, source, enabled);
    }

    setSourceItemEnabled(topicId: string, source: 'apps' | 'mcp' | 'skill', itemName: string, enabled: boolean): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized. Call initAgentDriver first.');
        }

        return this.sessionManager.setSourceItemEnabled(topicId, source, itemName, enabled);
    }

    async getAppsConfig(): Promise<Record<string, AppConfigEntry>> {
        return this.requireDesktopManager().getAppsConfig();
    }

    async getAppDetail(name: string): Promise<AppConfigEntry> {
        return this.requireDesktopManager().getAppDetail(name);
    }

    async searchAppsCatalog(query?: string): Promise<CatalogSearchResponse> {
        return this.requireDesktopManager().searchAppsCatalog(query);
    }

    async installApp(source: string, options?: InstallAppOptions): Promise<InstallAppResult> {
        return this.requireDesktopManager().installApp(source, options);
    }

    async updateApp(name: string): Promise<InstallAppResult> {
        return this.requireDesktopManager().updateApp(name);
    }

    async removeApp(name: string): Promise<void> {
        await this.requireDesktopManager().removeApp(name);
    }

    async setAppEnabled(name: string, enabled: boolean): Promise<void> {
        await this.requireDesktopManager().setAppEnabled(name, enabled);
    }

    private requireDesktopManager(): import('./desktop-manager.js').DesktopManager {
        if (!this.desktopManager) {
            throw new Error('DesktopManager not initialized. Call initAgentDriver first.');
        }
        return this.desktopManager;
    }

    private emitGuiUpdate(event: GuiUpdateEvent): void {
        console.log(`[HostManagerV2] Forward message: topic=${event.topicId}, type=${event.type}, listeners=${this.events.listenerCount('gui-update')}`);
        this.events.emit('gui-update', {
            type: event.type,
            message: event.message,
            topicId: event.topicId,
            state: (event as { state?: string }).state,
            delta: (event as { delta?: string }).delta,
        });
    }

    private async createIMAgentDriver(input: {
        sessionKey: string;
        agentId: string;
        desktop: IDesktop;
        source: IMDrivenSource;
    }): Promise<IMCreatedAgentDriver> {
        const { llmConfig, systemPrompt, sourceControls } = await this.resolveIMAgentConfig(input.agentId);
        const { model: modelId, provider: { id: providerId } } = llmConfig;
        const systemPromptSource = new SystemPromptDrivenSource({
            systemPrompt,
        });
        const receipts = new PendingAppReceipts();
        const aotuiSource = new SemanticAOTUIDrivenSource(input.desktop, {
            includeInstruction: true,
            onReceiptPending: (locator, result, subcallId) => receipts.remember(locator, result, subcallId),
        });
        const skillDrivenSource = new SkillDrivenSource();
        const mcpDrivenSource = new McpDrivenSource(new Set(sourceControls.mcp.allowedServers));
        applySourceControlsToSources(sourceControls, {
            aotuiSource,
            mcpSource: mcpDrivenSource,
            skillSource: skillDrivenSource,
        });
        const isCurrent = () => this.imSessionManager?.getSession(input.sessionKey)?.source === input.source;

        const agentDriver = new AgentDriverV2({
            sources: [
                systemPromptSource,
                aotuiSource,
                input.source,
                skillDrivenSource,
                mcpDrivenSource,
            ],
            llm: this.llmConfigService.withModelInputBudget(llmConfig),
            onAssistantMessage: (message) => {
                if (!isCurrent()) return;
                input.source.addMessage(message);
                this.emitGuiUpdate({
                    topicId: input.sessionKey,
                    type: 'assistant',
                    message,
                });
            },
            onToolResult: (message, results) => {
                const available = isCurrent();
                if (!available && !this.imSessionManager?.ownsSource(input.sessionKey, input.source)) return;
                const saved = input.source.addMessage(message);
                if (results) receipts.associate(this.imMessageIds.get(saved), results);
                if (!available) return;
                if (!agentDriver.hasPendingUpdate()) {
                    input.source.notifyUpdate();
                }
                this.emitGuiUpdate({
                    topicId: input.sessionKey,
                    type: 'tool',
                    message,
                });
            },
            onTextDelta: (delta) => {
                if (!isCurrent()) return;
                this.emitGuiUpdate({
                    topicId: input.sessionKey,
                    type: 'text_delta',
                    delta,
                });
            },
            onReasoningDelta: (delta) => {
                if (!isCurrent()) return;
                this.emitGuiUpdate({
                    topicId: input.sessionKey,
                    type: 'reasoning_delta',
                    delta,
                });
            },
            onLLMUsage: (usage) => {
                if (!isCurrent()) return;
                this.events.emit('model-usage', { kind: 'im', sessionId: input.sessionKey, providerId, modelId, usage } satisfies ModelUsageEvent);
            },
            onStateChange: (_oldState, newState) => {
                if (!isCurrent()) return;
                this.emitGuiUpdate({
                    topicId: input.sessionKey,
                    type: 'agent_state',
                    state: newState,
                });
            },
            onRunError: (error) => {
                if (isCurrent()) this.handleIMAgentRunError(input.sessionKey, input.source, error);
            },
        });

        this.imAppReceipts.set(input.source, { receipts, source: aotuiSource });
        return {
            agentDriver,
            sourceControls,
            disposeSources: async () => {
                try {
                    const closed = await Promise.allSettled([agentDriver.closeToolTurn(), aotuiSource.dispose()]);
                    checkCloseTasks(closed, 'IM_SESSION_COMPONENT_CLEANUP_FAILED');
                } finally {
                    this.imAppReceipts.delete(input.source);
                    receipts.clear();
                }
            },
        };
    }

    private async resolveIMAgentConfig(agentId: string): Promise<{
        llmConfig: LLMConfig;
        systemPrompt: string;
        sourceControls: SourceControlsSnapshot;
    }> {
        const config = await Config.get();
        const agent = config.agents?.list.find(item => item.id === agentId);
        return {
            llmConfig: await this.llmConfigService.resolveLLMConfig(agent?.modelId),
            systemPrompt: agent?.prompt || this.getDefaultSystemPrompt(),
            sourceControls: createSourceControlsFromAgent(agent, Object.keys(await this.getAppsConfig())),
        };
    }

    private async resolveIMCompactionPolicy(agentId: string): Promise<{
        enabled: boolean;
        minMessages: number;
        keepRecentMessages: number;
        hardFallbackThresholdTokens: number;
        modelHint: string;
    }> {
        const defaults = {
            enabled: true,
            minMessages: 14,
            keepRecentMessages: 8,
            hardFallbackThresholdTokens: 4_500,
            modelHint: '',
        };

        const config = await Config.get();
        const experimental = (config as any)?.experimental;
        const globalCompaction = experimental && typeof experimental === 'object'
            ? (experimental as Record<string, any>).contextCompaction
            : undefined;
        const agents = Array.isArray((config as any)?.agents?.list) ? (config as any).agents.list : [];
        const agent = agents.find((item: any) => item?.id === agentId);
        const modelHint = typeof agent?.modelId === 'string' ? agent.modelId.trim() : '';

        return {
            enabled: globalCompaction?.enabled !== false,
            minMessages: Number.isInteger(globalCompaction?.minMessages) && globalCompaction.minMessages > 0
                ? globalCompaction.minMessages
                : defaults.minMessages,
            keepRecentMessages: Number.isInteger(globalCompaction?.keepRecentMessages) && globalCompaction.keepRecentMessages > 0
                ? globalCompaction.keepRecentMessages
                : defaults.keepRecentMessages,
            hardFallbackThresholdTokens: Number.isInteger(globalCompaction?.hardFallbackThresholdTokens) && globalCompaction.hardFallbackThresholdTokens > 0
                ? globalCompaction.hardFallbackThresholdTokens
                : defaults.hardFallbackThresholdTokens,
            modelHint,
        };
    }

    private handleIMAgentRunError(sessionKey: string, source: IMDrivenSource, error: Error): void {
        const normalized = (error.message || 'Unknown error').toLowerCase();
        let userFacingMessage = `LLM 调用失败：${error.message || 'Unknown error'}\n请检查当前 Provider 配置或稍后重试。`;
        const inputError = error instanceof ModelInputError || error instanceof ProviderToolSchemaError;

        if (inputError) {
            userFacingMessage = error.message;
        } else if (
            normalized.includes('api key') ||
            normalized.includes('unauthorized') ||
            normalized.includes('invalid_api_key') ||
            normalized.includes('authentication') ||
            normalized.includes('forbidden') ||
            normalized.includes('401') ||
            normalized.includes('403')
        ) {
            userFacingMessage = `LLM 调用失败：Provider 认证异常（API Key 或模型配置不可用）。\n请打开 Settings 检查 Provider、Model 与 API Key 后重试。\n\n技术详情：${error.message}`;
        } else if (
            normalized.includes('network') ||
            normalized.includes('fetch failed') ||
            normalized.includes('enotfound') ||
            normalized.includes('econnrefused') ||
            normalized.includes('etimedout') ||
            normalized.includes('socket hang up') ||
            normalized.includes('internet')
        ) {
            userFacingMessage = `LLM 调用失败：网络不可用或请求超时。\n请检查网络连接、代理配置或稍后重试。\n\n技术详情：${error.message}`;
        } else if (
            normalized.includes('rate limit') ||
            normalized.includes('too many requests') ||
            normalized.includes('quota') ||
            normalized.includes('429')
        ) {
            userFacingMessage = `LLM 调用失败：触发了 Provider 的速率限制或额度限制。\n请稍后重试，或切换模型/Provider。\n\n技术详情：${error.message}`;
        }

        const assistantErrorMessage = {
            role: 'assistant',
            content: userFacingMessage,
            metadata: {
                isAgentError: true,
                rawError: error.message,
                ...(inputError ? { errorCategory: 'model_input', errorCode: error.code, errorDetails: error.details } : {}),
            },
        } as unknown as ModelMessage;

        if (!inputError) source.addMessage(assistantErrorMessage);
        this.emitGuiUpdate({
            topicId: sessionKey,
            type: 'assistant',
            message: assistantErrorMessage,
        });
    }

    private getDefaultSystemPrompt(): string {
        return `You are an AI assistant with access to a TUI (Text User Interface) desktop.

Your capabilities:
- Access and interact with applications through text-based commands
- Execute tools to read, write, and manage files
- Use the AOTUI IDE for code editing and project management
- Maintain conversation context across multiple sessions

Guidelines:
- Always confirm before destructive actions
- Provide clear explanations of your actions
- Use appropriate tools for each task
- Respect user privacy and data security

Remember: You control the Desktop. The user communicates with you through applications.`;
    }

    /**
     * 清理资源
     */
    async dispose(): Promise<void> {
        const results = await Promise.allSettled([
            this.sessionManager?.cleanup(),
            this.imSessionManager?.destroyAllSessions(),
        ]);
        this.events.removeAllListeners();
        this.logger.info('HostManagerV2 disposed');
        checkCloseTasks(results, 'HOST_SESSION_CLEANUP_FAILED');
    }
}
