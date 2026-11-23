/**
 * @aotui/host - SessionManagerV3
 * 
 * Topic-Desktop-AgentDriver 生命周期管理器
 * 
 * 职责:
 * - 管理 Topic 和 Desktop 的一一对应关系
 * - 按需创建 Session (Desktop + AgentDriver + DrivenSources)
 * - 自动清理空闲 Session
 * - 并发限制和资源管理
 * 
 * 设计原则:
 * - **DIP**: 依赖 IKernel 接口，不依赖具体实现
 * - **SRP**: 只负责 Session 生命周期，不负责业务逻辑
 * - **资源管理**: 空闲清理 + 并发限制，防止内存泄漏
 */

import { AOTUIError, createDesktopId, type DesktopCloseHandle, type IKernel, type ReceiptAccess } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2, ModelInputError, ProviderToolSchemaError, type LLMConfig, type ToolResult } from '@aotui/agent-driver-v2';
import type { ModelMessage } from 'ai';
import { EventEmitter } from 'events';
import type { LLMConfigService } from './llm-config-service.js';
import type { MessageService } from './message-service.js';
import { HostDrivenSourceV2 } from '../adapters/host-driven-source.js';
import { SystemPromptDrivenSource } from '../adapters/system-prompt-source.js';
import { McpDrivenSource } from '../mcp/source.js';
import { SkillDrivenSource } from '../skills/skill-driven-source.js';
import type { Session, SessionManagerConfig, GuiUpdateEvent, ModelUsageEvent } from '../types/session.js';
import { Logger } from '../utils/logger.js';
import type { DesktopManager } from './desktop-manager.js';
import * as db from '../db/index.js';
import { projectService } from './project-service.js';
import { isMcpItemKey, parseMcpServerItemKey, MCP_PERMISSION_RECONFIGURE } from '../shared/source-control-keys.js';
import { Config } from '../config/config.js';
import { applySourceControlsToSources, createSourceControlsFromAgent, normalizeSourceControlsSnapshot, type SourceControlsSnapshot } from './source-controls.js';
import { PendingAppReceipts, type AppReceiptMessageQuery } from './pending-app-receipts.js';
import { checkCloseTasks, checkDesktopClose, DesktopCloseError, rethrowAfterCleanup, rethrowAfterDesktopClose } from './desktop-close.js';

type SourceControl = { enabled: boolean; disabledItems: Set<string> };
type TopicSourceControls = {
    apps: SourceControl;
    mcp: SourceControl & { allowedServers?: Set<string> };
    skill: SourceControl;
};
type ClosingSession = { started: Promise<DesktopCloseHandle | undefined>; completion: Promise<void> };
type OpeningSession = { completion: Promise<Session>; closing?: ClosingSession };

/**
 * SessionManagerV3
 * 
 * 管理 Topic-Desktop-AgentDriver 的完整生命周期
 */
export class SessionManagerV3 extends EventEmitter {
    private sessions: Map<string, Session> = new Map();
    private readonly inFlightSessions = new Map<string, OpeningSession>();
    private kernel: IKernel;
    private desktopManager: DesktopManager;
    private llmConfigService: LLMConfigService;
    private messageService: MessageService;
    private logger: Logger;
    private cleanupTimer: NodeJS.Timeout | null = null;
    private compactionGlobalPolicyCache: {
        loadedAt: number;
        value: {
            enabled?: boolean;
            minMessages?: number;
            keepRecentMessages?: number;
            hardFallbackThresholdTokens?: number;
        };
    } | null = null;
    private sourceControlsByTopic = new Map<string, TopicSourceControls>();

    // 配置
    private config: Required<SessionManagerConfig>;

    constructor(
        kernel: IKernel,
        desktopManager: DesktopManager,
        llmConfigService: LLMConfigService,
        messageService: MessageService,
        config?: SessionManagerConfig
    ) {
        super();
        this.kernel = kernel;
        this.desktopManager = desktopManager;
        this.llmConfigService = llmConfigService;
        this.messageService = messageService;
        this.logger = new Logger('SessionManagerV3');

        // 合并默认配置
        this.config = {
            maxSessions: config?.maxSessions ?? 10,
            idleTimeoutMs: config?.idleTimeoutMs ?? 30 * 60 * 1000, // 30分钟
            cleanupIntervalMs: config?.cleanupIntervalMs ?? 5 * 60 * 1000, // 5分钟
        };

        // 启动定期清理任务
        this.startCleanupTask();

        this.logger.info('SessionManagerV3 initialized', {
            maxSessions: this.config.maxSessions,
            idleTimeoutMs: this.config.idleTimeoutMs,
        });
    }

    /**
     * 获取 Session (不创建)
     */
    getSession(topicId: string): Session | undefined {
        const session = this.sessions.get(topicId);
        if (session?.closing) return undefined;
        if (session) session.lastAccessTime = Date.now();
        return session;
    }

    async readAppReceipt(topicId: string, query: AppReceiptMessageQuery, timeoutMs?: number): Promise<ReceiptAccess> {
        const session = this.sessions.get(topicId);
        if (!session || session.closing) return { kind: 'unavailable', code: 'RECEIPT_LOCATOR_UNAVAILABLE', message: 'The owning topic session is unavailable.' };
        return session.appReceipts.read(query, {
            desktop: session.desktop,
            kernel: this.kernel,
            isCurrent: () => this.sessions.get(topicId) === session && !session.closing,
            isAppEnabled: installationId => session.sources.aotui.isAppEnabled(installationId),
        }, timeoutMs);
    }

    /**
     * 确保 Session 存在（幂等 + 并发去重）
     */
    async ensureSession(topicId: string): Promise<Session> {
        const opening = this.inFlightSessions.get(topicId);
        const closing = opening?.closing ?? this.sessions.get(topicId)?.closing;
        if (closing) {
            await closing.completion.catch(() => {});
            if (opening) await opening.completion.catch(() => {});
            return this.ensureSession(topicId);
        }
        if (opening) return opening.completion;

        const existing = this.getSession(topicId);
        if (existing) return existing;

        const createPromise = Promise.resolve().then(async () => {
            const active = [...this.sessions.values()].filter(session => !session.closing).length;
            if (active >= this.config.maxSessions) await this.evictOldestSession();
            return this.createSession(topicId);
        });

        const task: OpeningSession = { completion: createPromise.finally(() => {
            if (!task.closing) this.inFlightSessions.delete(topicId);
        }) };
        this.inFlightSessions.set(topicId, task);
        return task.completion;
    }

    /**
     * 创建 Session
     * 
     * @param topicId - Topic ID
     * @returns Session 实例
     */
    private async createSession(topicId: string): Promise<Session> {
        // 1. 创建 Desktop（通过 DesktopManager，确保 Apps 被安装）
        const desktopId = createDesktopId(topicId);

        const topic = db.getTopic(topicId);
        const config = topic?.agentId ? await Config.get() : undefined;
        const agent = config?.agents?.list.find(item => item.id === topic?.agentId);
        const modelSelection = topic?.modelOverride?.trim() ? topic.modelOverride : agent?.modelId;
        const effectiveLLMConfig = await this.llmConfigService.resolveLLMConfig(modelSelection);
        const effectiveSystemPrompt = agent?.prompt || topic?.promptOverride?.trim() || this.getSystemPrompt();

        const projectPath = topic?.projectId
            ? projectService.getProject(topic.projectId)?.path
            : undefined;
        const appConfig = projectPath
            ? { projectPath, workspace_dir_path: projectPath }
            : undefined;

        const { desktop } = await this.desktopManager.createDesktop(desktopId, appConfig);
        let sourceControls: TopicSourceControls | undefined;
        let appReceipts: PendingAppReceipts | undefined;
        let aotuiSource: SemanticAOTUIDrivenSource | undefined;
        let agentDriver: AgentDriverV2 | undefined;
        let session: Session | undefined;
        try {
            sourceControls = await this.getOrInitSourceControls(topicId, config);
            if (desktop.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId });

            const receipts = appReceipts = new PendingAppReceipts();
            aotuiSource = new SemanticAOTUIDrivenSource(desktop, this.kernel, {
                includeInstruction: true,
                onReceiptPending: (locator, result, subcallId) => receipts.remember(locator, result, subcallId),
            });
            const sources: Session['sources'] = {
                systemPrompt: new SystemPromptDrivenSource({ systemPrompt: effectiveSystemPrompt }),
                aotui: aotuiSource,
                host: new HostDrivenSourceV2(this.messageService, topicId),
                skill: new SkillDrivenSource({ projectPath }),
                mcp: new McpDrivenSource(sourceControls.mcp.allowedServers),
            };
            const controls = applySourceControlsToSources(this.snapshotSourceControls(sourceControls), {
                aotuiSource, mcpSource: sources.mcp, skillSource: sources.skill,
            });
            agentDriver = this.createAgentDriver(topicId, sources, effectiveLLMConfig, receipts);
            agentDriver.setSourceEnabled(sources.skill.name, controls.skill.enabled);
            agentDriver.setSourceEnabled(sources.mcp.name, controls.mcp.enabled);
            if (desktop.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId });

            const now = Date.now();
            session = { topicId, desktop, agentDriver, sources, appReceipts: receipts,
                state: 'active', createdAt: now, lastAccessTime: now };
            this.sessions.set(topicId, session);
            this.emit('message', { topicId, type: 'agent_state', state: 'idle' } satisfies GuiUpdateEvent);
            // A Topic subscription can outlive its previous Desktop.
            this.emit('message', { topicId, type: 'snapshot' } satisfies GuiUpdateEvent);
            if (session.closing || desktop.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId });

            this.logger.info('Session created', { topicId, desktopId, agentDriverId: agentDriver.getId() });
            return session;
        } catch (error) {
            if (session) {
                const { completion } = this.beginSessionClose(session);
                return rethrowAfterCleanup(error, () => completion);
            }
            if (sourceControls && this.sourceControlsByTopic.get(topicId) === sourceControls) {
                this.sourceControlsByTopic.delete(topicId);
            }
            appReceipts?.clear();
            return rethrowAfterDesktopClose(desktop, error, () => this.releaseSessionComponents(agentDriver, aotuiSource));
        }
    }

    private createAgentDriver(topicId: string, sources: Session['sources'], config: LLMConfig, appReceipts: PendingAppReceipts): AgentDriverV2 {
        const isCurrent = () => {
            const session = this.sessions.get(topicId);
            return session?.appReceipts === appReceipts && !session.closing;
        };
        const { model: modelId, provider: { id: providerId } } = config;
        return new AgentDriverV2({
            sources: [sources.systemPrompt, sources.aotui, sources.host, sources.skill, sources.mcp],
            llm: this.llmConfigService.withModelInputBudget(config),
            onAssistantMessage: (message) => {
                if (isCurrent()) this.handleMessage(topicId, 'assistant', message);
            },
            onToolResult: (message, results) => {
                const session = this.sessions.get(topicId);
                if (session?.appReceipts === appReceipts)
                    this.handleMessage(topicId, 'tool', message, results, !session.closing);
            },
            onTextDelta: (delta) => {
                if (!isCurrent()) return;
                const event: GuiUpdateEvent = {
                    topicId,
                    type: 'text_delta',
                    delta,
                };
                this.emit('message', event);
            },
            onReasoningDelta: (delta) => {
                if (!isCurrent()) return;
                const event: GuiUpdateEvent = {
                    topicId,
                    type: 'reasoning_delta',
                    delta,
                };
                this.emit('message', event);
            },
            onLLMUsage: (usage) => {
                if (isCurrent()) {
                    this.emit('model-usage', { kind: 'topic', sessionId: topicId, providerId, modelId, usage } satisfies ModelUsageEvent);
                }
            },
            onStateChange: (_oldState, newState) => {
                if (!isCurrent()) return;

                const event: GuiUpdateEvent = {
                    topicId,
                    type: 'agent_state',
                    state: newState,
                };
                this.emit('message', event);
            },
            onRunError: (error) => {
                if (isCurrent()) this.handleAgentRunError(topicId, error);
            },
        });
    }

    private async getOrInitSourceControls(topicId: string, config?: Config.InfoType): Promise<TopicSourceControls> {
        const existing = this.sourceControlsByTopic.get(topicId);
        if (existing) return existing;

        const topic = db.getTopic(topicId);
        let snapshot = topic?.sourceControls;
        if (!snapshot && topic?.agentId) {
            const agent = (config ?? await Config.get()).agents?.list.find(item => item.id === topic.agentId);
            if (agent) {
                snapshot = createSourceControlsFromAgent(agent, Object.keys(await this.desktopManager.getAppsConfig()));
            }
        }

        // Another read or update may have initialized this Topic while config was loading.
        const initialized = this.sourceControlsByTopic.get(topicId);
        if (initialized) return initialized;

        const controls = normalizeSourceControlsSnapshot(snapshot);
        const toControl = ({ enabled, disabledItems }: SourceControlsSnapshot['apps']): SourceControl =>
            ({ enabled, disabledItems: new Set(disabledItems) });
        const next = {
            apps: toControl(controls.apps),
            mcp: {
                ...toControl(controls.mcp),
                allowedServers: controls.mcp.allowedServers === undefined ? undefined : new Set(controls.mcp.allowedServers),
            },
            skill: toControl(controls.skill),
        };
        this.sourceControlsByTopic.set(topicId, next);
        return next;
    }

    private normalizeCompactionPolicy(input?: {
        enabled?: boolean;
        minMessages?: number;
        keepRecentMessages?: number;
        hardFallbackThresholdTokens?: number;
    }): {
        enabled?: boolean;
        minMessages?: number;
        keepRecentMessages?: number;
        hardFallbackThresholdTokens?: number;
    } {
        if (!input) return {};

        const next: {
            enabled?: boolean;
            minMessages?: number;
            keepRecentMessages?: number;
            hardFallbackThresholdTokens?: number;
        } = {};

        if (typeof input.enabled === 'boolean') {
            next.enabled = input.enabled;
        }
        if (Number.isInteger(input.minMessages) && (input.minMessages as number) > 0) {
            next.minMessages = input.minMessages;
        }
        if (Number.isInteger(input.keepRecentMessages) && (input.keepRecentMessages as number) > 0) {
            next.keepRecentMessages = input.keepRecentMessages;
        }
        if (Number.isInteger(input.hardFallbackThresholdTokens) && (input.hardFallbackThresholdTokens as number) > 0) {
            next.hardFallbackThresholdTokens = input.hardFallbackThresholdTokens;
        }

        return next;
    }

    private async getGlobalCompactionPolicy(): Promise<{
        enabled?: boolean;
        minMessages?: number;
        keepRecentMessages?: number;
        hardFallbackThresholdTokens?: number;
    }> {
        const now = Date.now();
        if (this.compactionGlobalPolicyCache && now - this.compactionGlobalPolicyCache.loadedAt < 15_000) {
            return this.compactionGlobalPolicyCache.value;
        }

        try {
            const config = await Config.get();
            const rawExperimental = (config as { experimental?: unknown }).experimental;
            const rawCompaction = rawExperimental && typeof rawExperimental === 'object'
                ? (rawExperimental as Record<string, unknown>).contextCompaction
                : undefined;
            const value = this.normalizeCompactionPolicy(
                rawCompaction && typeof rawCompaction === 'object'
                    ? (rawCompaction as {
                        enabled?: boolean;
                        minMessages?: number;
                        keepRecentMessages?: number;
                        hardFallbackThresholdTokens?: number;
                    })
                    : undefined,
            );

            this.compactionGlobalPolicyCache = {
                loadedAt: now,
                value,
            };
            return value;
        } catch (error) {
            this.logger.warn('Failed to load global context compaction policy, using defaults', { error });
            return {};
        }
    }

    private async resolveCompactionPolicy(topicId: string): Promise<{
        enabled: boolean;
        minMessages: number;
        keepRecentMessages: number;
        hardFallbackThresholdTokens: number;
    }> {
        const defaults = {
            enabled: false,
            minMessages: 14,
            keepRecentMessages: 8,
            hardFallbackThresholdTokens: 4_500,
        };

        const globalPolicy = await this.getGlobalCompactionPolicy();
        const topicPolicy = this.normalizeCompactionPolicy(db.getTopic(topicId)?.contextCompaction);

        return {
            enabled: topicPolicy.enabled ?? globalPolicy.enabled ?? defaults.enabled,
            minMessages: topicPolicy.minMessages ?? globalPolicy.minMessages ?? defaults.minMessages,
            keepRecentMessages: topicPolicy.keepRecentMessages ?? globalPolicy.keepRecentMessages ?? defaults.keepRecentMessages,
            hardFallbackThresholdTokens:
                topicPolicy.hardFallbackThresholdTokens
                ?? globalPolicy.hardFallbackThresholdTokens
                ?? defaults.hardFallbackThresholdTokens,
        };
    }

    async getSourceControlState(topicId: string): Promise<SourceControlsSnapshot> {
        return this.snapshotSourceControls(await this.getOrInitSourceControls(topicId));
    }

    private snapshotSourceControls(controls: TopicSourceControls): SourceControlsSnapshot {
        const snapshot = ({ enabled, disabledItems }: SourceControl): SourceControlsSnapshot['apps'] =>
            ({ enabled, disabledItems: [...disabledItems].sort((a, b) => a.localeCompare(b)) });
        const mcp: SourceControlsSnapshot['mcp'] = snapshot(controls.mcp);
        if (controls.mcp.allowedServers) mcp.allowedServers = [...controls.mcp.allowedServers].sort((a, b) => a.localeCompare(b));
        return { apps: snapshot(controls.apps), mcp, skill: snapshot(controls.skill) };
    }

    async setSourceEnabled(topicId: string, source: 'apps' | 'mcp' | 'skill', enabled: boolean): Promise<void> {
        const controls = await this.getOrInitSourceControls(topicId);
        const session = this.sessions.get(topicId);
        if (source === 'mcp') {
            const invalid = Array.from(controls.mcp.disabledItems).filter(key => !isMcpItemKey(key));
            if (enabled && invalid.length) throw new Error(MCP_PERMISSION_RECONFIGURE);
            if (invalid.length) {
                session?.sources.mcp.setEnabled(false);
                for (const key of invalid) {
                    controls.mcp.disabledItems.delete(key);
                    session?.sources.mcp.setToolEnabled(key, true);
                }
            }
        }
        controls[source].enabled = enabled;
        db.updateTopic(topicId, { sourceControls: this.snapshotSourceControls(controls), updatedAt: Date.now() });

        if (session) {
            if (source === 'apps') {
                session.sources.aotui.setAppsEnabled(enabled);
            } else if (source === 'mcp') {
                session.agentDriver.setSourceEnabled(session.sources.mcp.name, enabled);
                session.sources.mcp.setEnabled(enabled);
            } else {
                session.agentDriver.setSourceEnabled(session.sources.skill.name, enabled);
                session.sources.skill.setEnabled(enabled);
            }
        }
    }

    async setSourceItemEnabled(topicId: string, source: 'apps' | 'mcp' | 'skill', itemName: string, enabled: boolean): Promise<void> {
        if (source === 'mcp' && !isMcpItemKey(itemName)) throw new Error(MCP_PERMISSION_RECONFIGURE);
        const controls = await this.getOrInitSourceControls(topicId);
        const serverName = source === 'mcp' ? parseMcpServerItemKey(itemName) : null;
        const allowedServers = controls.mcp.allowedServers;
        if (serverName && allowedServers) {
            if (enabled) allowedServers.add(serverName);
            else allowedServers.delete(serverName);
            controls.mcp.disabledItems.delete(itemName);
        } else if (enabled) {
            controls[source].disabledItems.delete(itemName);
        } else {
            controls[source].disabledItems.add(itemName);
        }
        db.updateTopic(topicId, { sourceControls: this.snapshotSourceControls(controls), updatedAt: Date.now() });

        const session = this.sessions.get(topicId);
        if (session) {
            if (source === 'apps') {
                session.sources.aotui.setAppEnabled(itemName, enabled);
            } else if (source === 'mcp') {
                if (serverName) session.sources.mcp.setServerEnabled(serverName, enabled);
                else session.sources.mcp.setToolEnabled(itemName, enabled);
            } else {
                session.sources.skill.setSkillEnabled(itemName, enabled);
            }
        }
    }

    syncTopicPromptOverride(topicId: string): void {
        const session = this.sessions.get(topicId);
        if (!session) {
            return;
        }

        const topic = db.getTopic(topicId);
        const effectiveSystemPrompt = topic?.promptOverride?.trim() || this.getSystemPrompt();
        session.sources.systemPrompt.setSystemPrompt(effectiveSystemPrompt);

        this.logger.info('Synced topic prompt override to active session', {
            topicId,
            overridden: Boolean(topic?.promptOverride?.trim()),
        });
    }

    /**
     * 发送用户消息
     * 
     * @param topicId - Topic ID
     * @param content - 消息内容
     */
    async sendMessage(
        topicId: string,
        content: string,
        messageId?: string,
        attachments: Array<{ id: string; mime: string; url: string; filename?: string }> = []
    ): Promise<void> {
        const session = await this.ensureSession(topicId);

        const compactionPolicy = await this.resolveCompactionPolicy(topicId);
        const topicModelHint = db.getTopic(topicId)?.modelOverride;

        const fallbackCompaction = session.sources.host.maybeCompactByThreshold({
            enabled: compactionPolicy.enabled,
            maxContextTokens: compactionPolicy.hardFallbackThresholdTokens,
            minMessages: compactionPolicy.minMessages,
            keepRecentMessages: compactionPolicy.keepRecentMessages,
            modelHint: topicModelHint,
        });
        if (fallbackCompaction.compacted) {
            for (const syntheticMessage of fallbackCompaction.syntheticMessages) {
                const eventType = syntheticMessage.role === 'tool' ? 'tool' : 'assistant';
                const event: GuiUpdateEvent = {
                    topicId,
                    type: eventType,
                    message: syntheticMessage as ModelMessage,
                };
                this.emit('message', event);
            }

            this.logger.info('Hard fallback context compaction applied before user message', {
                topicId,
                thresholdTokens: fallbackCompaction.thresholdTokens,
                currentTokens: fallbackCompaction.currentTokens,
                compactedMessageCount: fallbackCompaction.compactedMessageCount,
                cleanedToolResultCount: fallbackCompaction.cleanedToolResultCount,
            });
        }

        // 1. 保存到数据库
        const activityTimestamp = Date.now();
        const hasAttachments = attachments.length > 0;
        const text = content.trim();
        const parts: any[] = [];
        if (text.length > 0) {
            parts.push({ type: 'text', text });
        }
        if (hasAttachments) {
            for (const attachment of attachments) {
                let data: string = attachment.url;
                if (attachment.url.startsWith('data:')) {
                    const match = attachment.url.match(/^data:[^;]+;base64,(.*)$/);
                    data = match?.[1] || '';
                }
                parts.push({
                    type: 'file',
                    data,
                    mediaType: attachment.mime,
                    filename: attachment.filename,
                });
            }
        }

        const userMessage: ModelMessage = {
            role: 'user',
            content: hasAttachments ? parts : content,
        } as ModelMessage & { id?: string; timestamp?: number };
        if (messageId) {
            (userMessage as any).id = messageId;
        }
        (userMessage as any).timestamp = activityTimestamp;
        const saved = this.messageService.addMessage(topicId, userMessage);

        // 1.1 更新 Topic 活跃时间（用于会话列表排序与「x m ago」展示）
        db.updateTopic(topicId, { updatedAt: activityTimestamp });

        // 2. 通知 HostDrivenSource
        session.sources.host.notifyNewMessage();

        // 3. 触发 GUI 更新事件
        const event: GuiUpdateEvent = {
            topicId,
            type: 'user',
            message: saved,
        };
        this.emit('message', event);

    }

    /**
     * 切换 Topic
     * 
     * @param topicId - Topic ID
     * @returns Session 实例
     */
    async switchTopic(topicId: string): Promise<Session | null> {
        return this.getSession(topicId) || null;
    }

    /**
     * 销毁 Session
     * 
     * @param topicId - Topic ID
     */
    destroySession(topicId: string): Promise<void> {
        return this.closeSession(topicId)?.completion ?? Promise.resolve();
    }

    /**
     * Gracefully shutdown a Session
     * 
     * Allows apps to flush state before closing the Desktop.
     */
    async shutdownSession(topicId: string): Promise<void> {
        const closing = this.closeSession(topicId);
        if (!closing) return;
        const handle = await closing.started;
        if (!handle) return;
        const result = await handle.wait({ timeoutMs: 5000 });
        if (result.status === 'deadline') throw new DesktopCloseError('CLOSE_DEADLINE_EXCEEDED', result.report);
        await closing.completion;
    }

    private closeSession(topicId: string): ClosingSession | undefined {
        const opening = this.inFlightSessions.get(topicId);
        if (opening?.closing) return opening.closing;
        const session = this.sessions.get(topicId);
        if (session) return this.beginSessionClose(session);
        if (!opening) return;
        const closing = opening.completion.then(created => this.beginSessionClose(created), () => undefined);
        const started = closing.then(task => task?.started);
        const completion = closing.then(task => task?.completion).finally(() => { this.inFlightSessions.delete(topicId); });
        void started.catch(() => {});
        void completion.catch(() => {});
        return opening.closing = { started, completion };
    }

    private beginSessionClose(session: Session): NonNullable<Session['closing']> {
        if (session.closing) return session.closing;
        const local = this.releaseSessionComponents(session.agentDriver, session.sources.aotui);
        const closeDesktop = () => session.desktop.beginClose();
        const started = local.then(closeDesktop, closeDesktop);
        const desktop = started.then(handle => handle.completion).then(checkDesktopClose);
        const completion = Promise.allSettled([local, desktop])
            .then(results => checkCloseTasks(results, 'TOPIC_SESSION_CLOSE_FAILED'))
            .finally(() => {
                session.appReceipts.clear();
                session.state = 'destroyed';
                if (this.sessions.get(session.topicId) !== session) return;
                this.sessions.delete(session.topicId);
                this.sourceControlsByTopic.delete(session.topicId);
            });
        void completion.catch(() => {});
        return session.closing = { started, completion };
    }

    private async releaseSessionComponents(
        agentDriver: AgentDriverV2 | undefined,
        aotuiSource: SemanticAOTUIDrivenSource | undefined,
    ): Promise<void> {
        const results = await Promise.allSettled([
            Promise.resolve().then(() => agentDriver?.closeToolTurn()),
            Promise.resolve().then(() => agentDriver?.dispose()),
            Promise.resolve().then(() => aotuiSource?.dispose()),
        ]);
        checkCloseTasks(results, 'TOPIC_SESSION_COMPONENT_CLEANUP_FAILED');
    }

    /**
     * 暂停 Session的 AgentDriver
     */
    pauseSession(topicId: string): void {
        const session = this.getSession(topicId);
        if (!session) {
            this.logger.warn('pauseSession: session not found', { topicId });
            return;
        }
        session.agentDriver.pause();
        session.state = 'paused';
        this.logger.info('Session paused', { topicId });
        this.emit('message', { topicId, type: 'agent_paused' } as GuiUpdateEvent);
    }

    /**
     * 恢复 Session的 AgentDriver
     */
    resumeSession(topicId: string): void {
        const session = this.getSession(topicId);
        if (!session) {
            this.logger.warn('resumeSession: session not found', { topicId });
            return;
        }
        session.agentDriver.resume();
        session.state = 'active';
        this.logger.info('Session resumed', { topicId });
        this.emit('message', { topicId, type: 'agent_resumed' } as GuiUpdateEvent);
    }

    /**
     * 驱逐最旧的 Session
     */
    private async evictOldestSession(): Promise<void> {
        let oldest: Session | undefined;
        for (const session of this.sessions.values()) {
            if (!session.closing && (!oldest || session.lastAccessTime < oldest.lastAccessTime)) oldest = session;
        }
        if (oldest) {
            const { topicId, lastAccessTime } = oldest;
            this.logger.warn('Evicting oldest session', { topicId, idleTimeMs: Date.now() - lastAccessTime });
            await this.beginSessionClose(oldest).completion.catch(error => this.logger.error('Failed to evict session', { topicId, error }));
        }
    }

    /**
     * 定期清理空闲 Session
     */
    private startCleanupTask(): void {
        this.cleanupTimer = setInterval(async () => {
            const now = Date.now();
            const toDestroy: Session[] = [];

            for (const session of this.sessions.values()) {
                const idleTime = now - session.lastAccessTime;
                if (!session.closing && idleTime > this.config.idleTimeoutMs) {
                    toDestroy.push(session);
                }
            }

            if (toDestroy.length > 0) {
                this.logger.info('Cleaning up idle sessions', {
                    count: toDestroy.length,
                    topics: toDestroy.map(session => session.topicId),
                });

                const results = await Promise.allSettled(toDestroy.map(session => this.beginSessionClose(session).completion));
                for (const result of results) if (result.status === 'rejected')
                    this.logger.error('Failed to close idle session', { error: result.reason });
            }
        }, this.config.cleanupIntervalMs);

        // 避免阻止进程退出
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    /**
     * 停止清理任务
     */
    stopCleanupTask(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /**
     * 处理 AgentDriver 消息
     * 
     * @param topicId - Topic ID
     * @param type - 消息类型
     * @param message - 消息内容
     */
    private handleMessage(
        topicId: string,
        type: 'assistant' | 'tool',
        message: ModelMessage,
        toolResults?: readonly ToolResult[],
        publish = true,
    ): void {
        // 🔍 打印消息详情
        console.log('\n=== SessionManagerV3.handleMessage ===');
        console.log('Topic ID:', topicId);
        console.log('Type:', type);
        console.log('Role:', message?.role);
        console.log('Content type:', Array.isArray(message?.content) ? 'parts' : typeof message?.content);
        if (Array.isArray(message?.content)) {
            const partTypes = message.content.map((part: any) => part?.type).filter(Boolean);
            console.log('Part types:', partTypes.join(', '));
        }
        console.log('Message:', JSON.stringify(message, null, 2));
        console.log('Listeners count:', this.listenerCount('message'));
        console.log('=====================================\n');

        // 1. 保存到数据库
        const session = this.sessions.get(topicId);
        let saved: ReturnType<MessageService['addMessage']> | undefined;
        try {
            saved = this.messageService.addMessage(topicId, message);
        } finally {
            if (toolResults) session?.appReceipts.associate(saved?.id, toolResults);
        }
        if (!publish) return;

        // A persisted tool receipt is new conversation input, even when a read-only
        // call did not change a View. Schedule observation of that result;
        // this does not replay the Tool call. Final assistant text is not a trigger.
        if (type === 'tool') {
            session?.sources.host.notifyNewMessage();
        }

        // 2. 触发 GUI 更新（通过事件总线）
        const event: GuiUpdateEvent = {
            topicId,
            type,
            message: saved,
        };
        this.emit('message', event);

    }

    private handleAgentRunError(topicId: string, error: Error): void {
        const { category, userFacingMessage } = this.classifyAgentError(error);
        const inputError = error instanceof ModelInputError || error instanceof ProviderToolSchemaError;

        this.logger.warn('Agent run failed; emitting user-visible error message', {
            topicId,
            category,
            error: error.message,
        });

        const assistantErrorMessage = {
            role: 'assistant',
            content: userFacingMessage,
            metadata: {
                isAgentError: true,
                errorCategory: category,
                rawError: error.message,
                ...(inputError ? { errorCode: error.code, errorDetails: error.details } : {}),
            },
        } as unknown as ModelMessage;

        if (inputError) {
            this.emit('message', { topicId, type: 'assistant', message: assistantErrorMessage });
        } else {
            this.handleMessage(topicId, 'assistant', assistantErrorMessage);
        }
    }

    private classifyAgentError(error: Error): {
        category: 'model_input' | 'provider' | 'network' | 'rate_limit' | 'unknown';
        userFacingMessage: string;
    } {
        if (error instanceof ModelInputError || error instanceof ProviderToolSchemaError)
            return { category: 'model_input', userFacingMessage: error.message };
        const raw = error.message || 'Unknown error';
        const normalized = raw.toLowerCase();

        if (
            normalized.includes('api key') ||
            normalized.includes('unauthorized') ||
            normalized.includes('invalid_api_key') ||
            normalized.includes('authentication') ||
            normalized.includes('forbidden') ||
            normalized.includes('401') ||
            normalized.includes('403')
        ) {
            return {
                category: 'provider',
                userFacingMessage: `LLM 调用失败：Provider 认证异常（API Key 或模型配置不可用）。\n请打开 Settings 检查 Provider、Model 与 API Key 后重试。\n\n技术详情：${raw}`,
            };
        }

        if (
            normalized.includes('network') ||
            normalized.includes('fetch failed') ||
            normalized.includes('enotfound') ||
            normalized.includes('econnrefused') ||
            normalized.includes('etimedout') ||
            normalized.includes('socket hang up') ||
            normalized.includes('internet')
        ) {
            return {
                category: 'network',
                userFacingMessage: `LLM 调用失败：网络不可用或请求超时。\n请检查网络连接、代理配置或稍后重试。\n\n技术详情：${raw}`,
            };
        }

        if (
            normalized.includes('rate limit') ||
            normalized.includes('too many requests') ||
            normalized.includes('quota') ||
            normalized.includes('429')
        ) {
            return {
                category: 'rate_limit',
                userFacingMessage: `LLM 调用失败：请求频率/额度受限。\n请稍后重试，或切换到其他可用模型。\n\n技术详情：${raw}`,
            };
        }

        return {
            category: 'unknown',
            userFacingMessage: `LLM 调用失败：${raw}\n请检查当前 Provider 配置或稍后重试。`,
        };
    }

    /**
     * 获取系统提示词
     * 
     * @returns 系统提示词内容
     */
    private getSystemPrompt(): string {
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
     * 获取 Session 信息（用于调试和监控）
     */
    getSessionInfo(): Array<{
        topicId: string;
        state: string;
        createdAt: number;
        lastAccessTime: number;
        idleTimeMs: number;
    }> {
        const now = Date.now();
        const info: Array<any> = [];

        for (const [topicId, session] of this.sessions.entries()) {
            info.push({
                topicId,
                state: session.state,
                createdAt: session.createdAt,
                lastAccessTime: session.lastAccessTime,
                idleTimeMs: now - session.lastAccessTime,
            });
        }

        return info;
    }

    /**
     * 检查 Session 是否存在
     */
    hasSession(topicId: string): boolean {
        return this.sessions.has(topicId);
    }

    /**
     * 获取 Session 数量
     */
    getSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * 清理所有 Session（用于关闭应用）
     */
    async cleanup(): Promise<void> {
        this.logger.info('Cleaning up all sessions', {
            count: this.sessions.size,
        });

        // 停止清理任务
        this.stopCleanupTask();

        // 销毁所有 Session
        const topicIds = new Set([...this.sessions.keys(), ...this.inFlightSessions.keys()]);
        const results = await Promise.allSettled([...topicIds].map(topicId => this.destroySession(topicId)));

        this.logger.info('All sessions cleaned up');
        checkCloseTasks(results, 'TOPIC_SESSION_CLEANUP_FAILED');
    }
}
