/**
 * ChatBridge - Host Connection Client for GUI
 * 
 * - IPC (Electron tRPC): Topics/Messages/Snapshot/Agent 状态
 */
import type { DisplayMessage, Topic, Project, ImageAttachment } from '../types.js';
import type { ToolResultPart } from 'ai';
import type { GuiUpdateEvent } from '../types/session.js';
import type { ImConfig } from '../config/im-schema.js';
import type { SourceControlsSnapshot } from '../core/source-controls.js';
import { createMessageId } from '../types/messages.js';
import { createTRPCProxyClient } from '@trpc/client';
import type { Unsubscribable } from '@trpc/server/observable';
import { ipcLink } from 'electron-trpc/renderer';
import superjson from 'superjson';
import type { AppRouter } from '../trpc/router.js';
import type { DesktopPreview } from '../core/desktop-preview.js';
import { isIMSessionKey } from '../im/routing.js';

// Event types for subscribers
export interface ChatUpdateEvent {
    type: 'message' | 'topic' | 'snapshot' | 'snapshot_error' | 'agent_state' | 'agent_reasoning' | 'agent_paused' | 'agent_resumed' | 'init';
    topicId?: string;
    data?: unknown;
}

export type ChatSubscriber = (event: ChatUpdateEvent) => void;

type SessionSubscription = { subscription?: Unsubscribable; snapshotRead?: Promise<void>; snapshotDirty?: boolean };

// ============ ChatBridge ============

export class ChatBridge {
    private static instance: ChatBridge | null = null;

    // Connections
    private trpcClient: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
    private trpcSubscriptions: Map<string, SessionSubscription> = new Map();

    // State
    private projects: Project[] = []; // [RFC-025]
    private topics: Map<string, Topic> = new Map();
    private messages: Map<string, DisplayMessage[]> = new Map();
    private previews = new Map<string, DesktopPreview>();
    private agentStates: Map<string, string> = new Map();
    private agentPaused: Map<string, boolean> = new Map();  // [RFC-014]
    private streamingTexts: Map<string, string> = new Map();
    private streamingReasonings: Map<string, string> = new Map();
    private subscribers: Set<ChatSubscriber> = new Set();
    private activeTopicId: string | null = null;

    private constructor() {
        // Private constructor for singleton
    }

    static getInstance(): ChatBridge {
        if (!ChatBridge.instance) {
            ChatBridge.instance = new ChatBridge();
        }
        return ChatBridge.instance;
    }

    // ============ Connection ============

    async connect(): Promise<void> {
        if (!this.isIpcAvailable()) {
            console.error('[ChatBridge] Electron IPC not available. ChatBridge requires Electron environment.');
            return;
        }
        await this.loadInitialData();
    }

    private async loadInitialData(): Promise<void> {
        try {
            const topics = await this.getTrpcClient().db.getTopics.query();
            topics.forEach((t: Topic) => this.topics.set(t.id, t));

            // [RFC-025] Load projects
            this.projects = await this.getTrpcClient().project.list.query();

            this.notify({ type: 'init' });
        } catch (error) {
            console.error('[ChatBridge] Failed to load initial data:', error);
        }
    }

    private async loadMessagesForTopic(topicId: string): Promise<void> {
        try {
            const messages = await this.getTrpcClient().db.getMessages.query({ id: topicId });
            if (!this.topics.has(topicId)) return;

            const history = new Map(messages.map(message => [message.id, this.toDisplayMessage(message)]));
            for (const live of this.getMessages(topicId)) {
                if (!history.has(live.id)) history.set(live.id, live);
            }
            this.messages.set(topicId, Array.from(history.values()).sort((a, b) => a.timestamp - b.timestamp));
        } catch (error) {
            console.error(`[ChatBridge] Failed to load messages for topic ${topicId}:`, error);
        }
    }

    isConnected(): boolean {
        return this.isIpcAvailable();
    }

    // ============ API - Topics ============

    async createTopic(
        title: string,
        projectId?: string,
        options?: {
            modelOverride?: string;
            promptOverride?: string;
            agentId?: string;
            sourceControls?: SourceControlsSnapshot;
        }
    ): Promise<Topic | null> {
        try {
            const topic = await this.getTrpcClient().db.createTopic.mutate({
                title,
                projectId,
                modelOverride: options?.modelOverride,
                promptOverride: options?.promptOverride,
                agentId: options?.agentId,
                sourceControls: options?.sourceControls,
            });
            this.topics.set(topic.id, topic);
            this.messages.set(topic.id, []);
            this.activeTopicId = topic.id;
            // [Refactor] Do NOT create Runtime Session eagerly.
            // Session will be auto-created by Backend when the first message is sent.
            // await this.ensureSessionReady(topic.id, true); 
            this.notify({ type: 'topic', topicId: topic.id });
            return topic;
        } catch (error) {
            console.error('[ChatBridge] Error creating topic:', error);
            return null;
        }
    }

    // ============ API - Messages ============

    async sendMessage(topicId: string, content: string, attachments: ImageAttachment[] = []): Promise<DisplayMessage | null> {
        try {
            // 1. Ensure Desktop is active (Lazy Activation)
            await this.activateDesktop(topicId);

            const messageId = createMessageId();

            await this.ensureSessionReady(topicId, true);

            // Optimistic update: Add message to local state immediately
            // [Fix] Move Optimistic Update BEFORE network call for instant feedback
            const optimisticMessage: DisplayMessage = {
                id: messageId,
                role: 'user',
                content,
                timestamp: Date.now(),
                metadata: attachments.length > 0 ? { attachments } : undefined,
            };

            const msgs = this.messages.get(topicId) || [];
            msgs.push(optimisticMessage);
            this.messages.set(topicId, msgs);
            this.notify({ type: 'message', topicId, data: optimisticMessage });

            // [Fix] Race Condition: Give tRPC Subscription a moment to establish handshake
            // before sending the message that triggers the stream.
            await new Promise(resolve => setTimeout(resolve, 50));

            await this.getTrpcClient().chat.send.mutate({
                id: topicId,
                content,
                messageId,
                attachments,
            });

            return optimisticMessage;
        } catch (error) {
            console.error('[ChatBridge] Error sending message:', error);
            throw error;
        }
    }

    // ============ API - Snapshots ============

    async requestDesktopPreview(topicId: string): Promise<void> {
        let owner = this.trpcSubscriptions.get(topicId);
        if (!owner) { owner = {}; this.trpcSubscriptions.set(topicId, owner); }
        await this.ensureSessionReady(topicId, true);
        if (this.trpcSubscriptions.get(topicId) === owner) await this.refreshSnapshot(topicId, owner);
    }

    private refreshSnapshot(topicId: string, owner: SessionSubscription): Promise<void> {
        owner.snapshotDirty = true;
        if (owner.snapshotRead) return owner.snapshotRead;
        // One read per connection; invalidations during a read request the latest state again.
        owner.snapshotRead = Promise.resolve().then(async () => {
            try {
                while (owner.snapshotDirty && this.trpcSubscriptions.get(topicId) === owner) {
                    owner.snapshotDirty = false;
                    try {
                        const preview = await this.getTrpcClient().session.preview.query({ id: topicId });
                        if (this.trpcSubscriptions.get(topicId) !== owner) return;
                        if (owner.snapshotDirty) continue;
                        this.previews.set(topicId, preview);
                        this.notify({ type: 'snapshot', topicId });
                    } catch (error) {
                        if (this.trpcSubscriptions.get(topicId) !== owner) return;
                        if (!owner.snapshotDirty) throw error;
                    }
                }
            } finally { owner.snapshotRead = undefined; }
        });
        return owner.snapshotRead;
    }

    // ============ [RFC-014] Agent Lifecycle Control ============

    async pauseAgent(topicId: string): Promise<void> {
        await this.ensureSessionReady(topicId, true);
        await this.getTrpcClient().chat.pause.mutate({ id: topicId });
    }

    async resumeAgent(topicId: string): Promise<void> {
        await this.ensureSessionReady(topicId, true);
        await this.getTrpcClient().chat.resume.mutate({ id: topicId });
    }

    // ============ [RFC-025] Project Management ============

    getProjects(): Project[] {
        return this.projects;
    }

    async createProject(path: string, name?: string): Promise<Project> {
        const project = await this.getTrpcClient().project.create.mutate({ path, name });
        this.projects = await this.getTrpcClient().project.list.query();
        this.notify({ type: 'init' }); // Notify global update
        return project;
    }

    async deleteProject(id: string): Promise<void> {
        await this.getTrpcClient().project.delete.mutate({ id });
        this.projects = await this.getTrpcClient().project.list.query();
        this.notify({ type: 'init' });
    }

    async openProject(id: string): Promise<void> {
        await this.getTrpcClient().project.open.mutate({ id });
        this.projects = await this.getTrpcClient().project.list.query();
        this.notify({ type: 'init' });
    }

    async pickProjectFolder(): Promise<string | null> {
        return await this.getTrpcClient().project.pickFolder.mutate();
    }

    // [RFC-015] Shutdown: 关机但保留数据
    async shutdownDesktop(topicId: string): Promise<void> {
        this.releaseSessionSubscription(topicId);
        this.previews.delete(topicId);
        this.notify({ type: 'snapshot', topicId });
        await this.getTrpcClient().session.shutdown.mutate({ id: topicId });
    }

    async deleteTopic(topicId: string): Promise<void> {
        try {
            this.releaseSessionSubscription(topicId);
            await this.getTrpcClient().db.deleteTopic.mutate({ id: topicId });
            this.topics.delete(topicId);
            this.messages.delete(topicId);
            this.previews.delete(topicId);
            this.agentStates.delete(topicId);
            this.agentPaused.delete(topicId);
            this.streamingTexts.delete(topicId);
            this.streamingReasonings.delete(topicId);
            if (this.activeTopicId === topicId) this.activeTopicId = null;
            this.notify({ type: 'topic', topicId });
        } catch (error) {
            console.error('[ChatBridge] Failed to delete topic:', error);
        }
    }

    async renameTopic(topicId: string, newTitle: string): Promise<void> {
        try {
            await this.getTrpcClient().db.renameTopic.mutate({ id: topicId, title: newTitle });
            const topic = this.topics.get(topicId);
            if (topic) {
                this.topics.set(topicId, { ...topic, title: newTitle, updatedAt: Date.now() });
                this.notify({ type: 'topic', topicId });
            }
        } catch (error) {
            console.error('[ChatBridge] Failed to rename topic:', error);
        }
    }

    isAgentPaused(topicId: string): boolean {
        return this.agentPaused.get(topicId) || false;
    }

    getAgentState(topicId: string): string {
        return this.agentStates.get(topicId) || 'IDLE';
    }

    /**
     * 计算用于 UI 展示的 Agent 显示状态
     * 
     * - sleeping: Session 未激活（不封驱 Desktop）
     * - paused:   Session 已激活且用户点击了暂停
     * - working:  AgentDriver 处于 thinking / executing
     * - idle:     Session 已激活，AgentDriver 空闲等待
     */
    getDisplayAgentState(topicId: string): 'sleeping' | 'idle' | 'working' | 'paused' {
        if (!this.agentStates.has(topicId)) return 'sleeping';
        if (this.agentPaused.get(topicId)) return 'paused';
        const state = this.agentStates.get(topicId) || 'IDLE';
        if (state === 'THINKING' || state === 'EXECUTING') return 'working';
        return 'idle';
    }

    // ============ Topic Management ============

    getTopics(): Topic[] {
        // Return sorted by updated time desc
        return Array.from(this.topics.values())
            .filter((topic) => !isIMSessionKey(topic.id))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getTopic(topicId: string): Topic | undefined {
        return this.topics.get(topicId);
    }

    patchTopic(topicId: string, patch: Partial<Topic>): void {
        const current = this.topics.get(topicId);
        if (!current) return;
        this.topics.set(topicId, {
            ...current,
            ...patch,
            updatedAt: Date.now(),
        });
        this.notify({ type: 'topic', topicId });
    }

    getMessages(topicId: string): DisplayMessage[] {
        return this.messages.get(topicId) ?? [];
    }

    getDesktopPreview(topicId: string): DesktopPreview | undefined {
        return this.previews.get(topicId);
    }

    getAgentThinking(topicId: string): string {
        const state = this.agentStates.get(topicId);
        // 流式输出文本优先显示
        const streamingText = this.streamingTexts.get(topicId) || '';
        if (streamingText) return streamingText;
        return state === 'THINKING' || state === 'EXECUTING' ? 'Agent is thinking...' : '';
    }

    getAgentReasoning(topicId: string): string {
        return this.streamingReasonings.get(topicId) || '';
    }

    getActiveTopicId(): string | null {
        return this.activeTopicId;
    }

    clearActiveTopic(): void {
        this.activeTopicId = null;
        this.notify({ type: 'topic' });
    }

    async setActiveTopic(topicId: string): Promise<void> {
        if (this.topics.has(topicId)) {
            const reloadHistory = this.activeTopicId !== topicId || !this.messages.has(topicId);
            this.activeTopicId = topicId;
            if (reloadHistory) {
                await this.loadMessagesForTopic(topicId);
            }

            this.notify({ type: 'topic', topicId });
        }
    }

    /**
     * Explicitly activate the desktop connection
     */
    async activateDesktop(topicId: string): Promise<void> {
        if (!this.previews.has(topicId)) await this.requestDesktopPreview(topicId);
        else await this.ensureSessionReady(topicId, true);
    }

    // ============ Subscription ============

    subscribe(callback: ChatSubscriber): () => void {
        this.subscribers.add(callback);
        return () => {
            this.subscribers.delete(callback);
            if (this.subscribers.size === 0) {
                for (const topicId of this.trpcSubscriptions.keys()) this.releaseSessionSubscription(topicId);
            }
        };
    }

    private notify(event: ChatUpdateEvent): void {
        this.subscribers.forEach(cb => cb(event));
    }

    // ============ Utilities ============

    private isIpcAvailable(): boolean {
        return typeof (globalThis as any).electronTRPC !== 'undefined';
    }

    /**
     * Public method to access tRPC client for direct API calls
     */
    public getTrpcClient(): ReturnType<typeof createTRPCProxyClient<AppRouter>> {
        if (!this.trpcClient) {
            this.trpcClient = createTRPCProxyClient<AppRouter>({
                transformer: superjson,
                links: [ipcLink()],
            });
        }
        return this.trpcClient;
    }

    private async ensureSessionReady(topicId: string, lazy: boolean): Promise<void> {
        let owner = this.trpcSubscriptions.get(topicId);
        if (!owner) { owner = {}; this.trpcSubscriptions.set(topicId, owner); }
        await this.getTrpcClient().session.create.mutate({ id: topicId, lazy });
        if (this.trpcSubscriptions.get(topicId) === owner) this.ensureSessionSubscription(topicId, owner);
    }

    private toDisplayMessage(message: NonNullable<GuiUpdateEvent['message']>): DisplayMessage {
        const { id = createMessageId(), timestamp = Date.now(), metadata, role, content } = message;
        const { attachments: _attachments, ...metadataWithoutAttachments } = metadata ?? {};
        const base: DisplayMessage = {
            id, timestamp, role, messageType: 'text',
            content: typeof content === 'string' ? content : '',
            metadata: role === 'user' ? metadata : metadataWithoutAttachments,
        };
        if (typeof content === 'string') return base;

        if (message.role === 'user') {
            const attachments: ImageAttachment[] = [];
            const lines: string[] = [];
            for (const part of message.content as Exclude<typeof message.content, string>) {
                if (part.type === 'text') {
                    lines.push(part.text);
                    continue;
                }
                const mime = part.mediaType ?? 'image/*';
                if (!mime.startsWith('image/') && mime !== 'application/pdf') continue;
                const value = part.type === 'image' ? part.image : part.data;
                if (!value) continue;
                const raw = value instanceof URL ? value.href : value;
                if (typeof raw !== 'string') continue;
                const url = /^(data:|https?:\/\/|file:\/\/)/i.test(raw) ? raw : `data:${mime};base64,${raw}`;
                attachments.push({
                    id: `${id}_att_${attachments.length}`, mime, url,
                    filename: part.type === 'file' ? part.filename : undefined,
                });
            }
            return {
                ...base,
                content: lines.join('\n'),
                metadata: attachments.length ? { ...metadata, attachments } : metadata,
            };
        }

        if (message.role === 'assistant') {
            const parts = message.content as Exclude<typeof message.content, string>;
            const text = parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
            const reasoning = parts.flatMap(part => part.type === 'reasoning' ? [part.text] : []).join('');
            const toolCalls = parts.flatMap(part => part.type === 'tool-call'
                ? [{ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
                : []);
            if (toolCalls.length) {
                return {
                    ...base,
                    content: text,
                    messageType: 'tool_call',
                    metadata: { ...base.metadata, toolCalls, text, reasoning },
                };
            }
            return {
                ...base,
                content: text || reasoning,
                messageType: !text && reasoning ? 'reasoning' : 'text',
                metadata: reasoning ? { ...base.metadata, reasoning } : base.metadata,
            };
        }

        if (message.role === 'tool') {
            const toolResults = message.content.flatMap(part => {
                if (part.type !== 'tool-result') return [];
                const { result, isError } = this.normalizeToolOutput(part.output);
                return [{ toolCallId: part.toolCallId, toolName: part.toolName, result, isError }];
            });
            if (toolResults.length) {
                return {
                    ...base,
                    content: toolResults.map(({ result }) => typeof result === 'string' ? result : JSON.stringify(result, null, 2)).join('\n'),
                    messageType: 'tool_result',
                    metadata: { ...base.metadata, toolResults },
                };
            }
        }

        return base;
    }

    private releaseSessionSubscription(topicId: string): void {
        const owner = this.trpcSubscriptions.get(topicId);
        this.trpcSubscriptions.delete(topicId);
        owner?.subscription?.unsubscribe();
    }

    private ensureSessionSubscription(topicId: string, owner: SessionSubscription): void {
        if (owner.subscription) return;
        let active = true;
        let transport: Unsubscribable | undefined;
        const subscription = { unsubscribe: () => {
            if (!active) return;
            active = false;
            if (owner.subscription === subscription) owner.subscription = undefined;
            transport?.unsubscribe();
        } };
        // Reserve before subscribe: errors or data can be delivered synchronously.
        owner.subscription = subscription;
        try {
            transport = this.getTrpcClient().session.events.subscribe(
                { id: topicId },
                {
                    onData: (event) => {
                        if (!active || this.trpcSubscriptions.get(topicId) !== owner || event.topicId !== topicId) return;
                        this.handleSessionEvent(event);
                    },
                    onError: (error: unknown) => {
                        if (!active || this.trpcSubscriptions.get(topicId) !== owner) return;
                        subscription.unsubscribe();
                        console.error('[ChatBridge] tRPC session events error:', error);
                        this.handleSessionEvent({ type: 'snapshot_error', topicId,
                            error: error instanceof Error ? error.message : String(error) });
                    },
                }
            );
            if (!active || this.trpcSubscriptions.get(topicId) !== owner) transport.unsubscribe();
        } catch (error) {
            subscription.unsubscribe();
            throw error;
        }
    }

    private handleSessionEvent(event: GuiUpdateEvent): void {
        const { type: eventType, topicId, message } = event;

        if (eventType === 'snapshot' && topicId) {
            const owner = this.trpcSubscriptions.get(topicId);
            if (owner?.snapshotRead) owner.snapshotDirty = true;
            else if (owner) void this.refreshSnapshot(topicId, owner).catch(error => {
                if (this.trpcSubscriptions.get(topicId) === owner) this.handleSessionEvent({
                    type: 'snapshot_error', topicId, error: error instanceof Error ? error.message : String(error),
                });
            });
            return;
        }

        if (eventType === 'snapshot_error' && topicId) {
            console.error('[ChatBridge] Preview error:', event.error);
            this.notify({ type: 'snapshot_error', topicId, data: event.error });
            return;
        }

        // Handle AI SDK v6 GuiUpdateEvent (from SessionManagerV3 → HostManagerV2)
        if (eventType === 'agent_state' && topicId) {
            const state = event.state;
            if (state) {
                this.agentStates.set(topicId, state.toUpperCase());
                this.notify({ type: 'agent_state', topicId, data: state.toUpperCase() });
            }
            return;
        }

        if (eventType === 'agent_paused' && topicId) {
            this.agentPaused.set(topicId, true);
            this.notify({ type: 'agent_paused', topicId, data: true });
            return;
        }

        if (eventType === 'agent_resumed' && topicId) {
            this.agentPaused.set(topicId, false);
            this.notify({ type: 'agent_resumed', topicId, data: false });
            return;
        }

        // Handle streaming text deltas from LLM — pipe through agentThinking
        if (eventType === 'text_delta' && topicId) {
            const delta = event.delta;
            if (delta) {
                this.handleTextDelta(topicId, delta);
            }
            return;
        }

        // Handle streaming reasoning deltas from LLM — pipe through agentReasoning
        if (eventType === 'reasoning_delta' && topicId) {
            const delta = event.delta;
            if (delta) {
                this.handleReasoningDelta(topicId, delta);
            }
            return;
        }

        if ((eventType === 'assistant' || eventType === 'tool' || eventType === 'user') && message) {
            this.receiveMessage(topicId, message);
            return;
        }
    }

    /**
     * 处理 LLM 流式文本增量
     * 
     * 将增量文本追加到 streamingText 缓冲区，并通过 agentThinking 路径
     * 实时显示在 "Generating Response..." 区域。
     * 当最终 assistant 完整消息到达时（receiveMessage），
     * 缓冲区被清空，agentThinking 恢复为空。
     */
    private handleTextDelta(topicId: string, delta: string): void {
        const current = this.streamingTexts.get(topicId) || '';
        const updated = current + delta;
        this.streamingTexts.set(topicId, updated);
        this.notify({ type: 'agent_state', topicId, data: 'THINKING' });
    }

    /**
     * 处理 LLM 流式推理增量
     */
    private handleReasoningDelta(topicId: string, delta: string): void {
        const current = this.streamingReasonings.get(topicId) || '';
        const updated = current + delta;
        this.streamingReasonings.set(topicId, updated);
        this.notify({ type: 'agent_reasoning', topicId, data: updated });
    }

    private receiveMessage(topicId: string, message: NonNullable<GuiUpdateEvent['message']>): void {
        const display = this.toDisplayMessage(message);
        if (message.role === 'assistant') {
            this.streamingTexts.delete(topicId);
            this.streamingReasonings.delete(topicId);
        }

        const messages = this.getMessages(topicId).slice();
        const index = messages.findIndex(existing => existing.id === display.id);
        if (index < 0) messages.push(display);
        else messages[index] = display;

        this.messages.set(topicId, messages.sort((a, b) => a.timestamp - b.timestamp));
        this.notify({ type: 'message', topicId, data: display });
    }

    private normalizeToolOutput(output: ToolResultPart['output']): { result: unknown; isError: boolean } {
        if (output.type === 'execution-denied') return { result: output, isError: true };
        const result = output.value;
        const isError = output.type === 'error-json' || output.type === 'error-text' || this.isFailedReceipt(result);
        return { result, isError };
    }

    private isFailedReceipt(result: unknown): boolean {
        return result !== null && typeof result === 'object' && 'success' in result && result.success === false;
    }

    // ============ LLM Config Methods ============

    async getAllLLMConfigs() {
        return this.getTrpcClient().llmConfig.getAll.query();
    }

    async getActiveLLMConfig() {
        return this.getTrpcClient().llmConfig.getActive.query();
    }

    async createLLMConfig(data: any): Promise<any> {
        return this.getTrpcClient().llmConfig.create.mutate(data);
    }

    async updateLLMConfig(id: number, data: any): Promise<void> {
        await this.getTrpcClient().llmConfig.update.mutate({ id, data });
    }

    async deleteLLMConfig(id: number): Promise<void> {
        await this.getTrpcClient().llmConfig.delete.mutate({ id });
    }

    async setActiveLLMConfig(id: number): Promise<void> {
        await this.getTrpcClient().llmConfig.setActive.mutate({ id });
    }

    // ============ Custom Provider Methods ============

    async listCustomProviders(): Promise<any[]> {
        return this.getTrpcClient().llmConfig.customProvidersList.query();
    }

    async createCustomProvider(input: { name: string; baseUrl: string; protocol: 'openai' | 'anthropic'; apiKey?: string }): Promise<any> {
        return this.getTrpcClient().llmConfig.customProvidersCreate.mutate(input);
    }

    async updateCustomProvider(id: string, data: { name?: string; baseUrl?: string; protocol?: 'openai' | 'anthropic'; apiKey?: string }): Promise<any> {
        return this.getTrpcClient().llmConfig.customProvidersUpdate.mutate({ id, data });
    }

    async deleteCustomProvider(id: string): Promise<any> {
        return this.getTrpcClient().llmConfig.customProvidersDelete.mutate({ id });
    }

    async createCustomModelConfig(input: { customProviderId: string; modelId: string; name?: string; temperature?: number; setActive?: boolean }): Promise<any> {
        return this.getTrpcClient().llmConfig.customModelConfigsCreate.mutate(input);
    }

    // ============ Agents Methods ============

    async getAgents(): Promise<{ list: any[]; activeAgentId: string | null }> {
        return this.getTrpcClient().agents.getAgents.query();
    }

    async saveAgents(list: any[], activeAgentId: string | null): Promise<any> {
        return this.getTrpcClient().agents.saveAgents.mutate({ list, activeAgentId });
    }

    // ============ IM Config Methods ============

    async getImConfig() {
        return this.getTrpcClient().im.getConfig.query();
    }

    async getImRuntime(): Promise<any> {
        return this.getTrpcClient().im.getRuntime.query();
    }

    async saveImConfig(im: ImConfig) {
        return this.getTrpcClient().im.updateConfig.mutate({ im });
    }
}

// Export singleton getter
export function useChatBridge(): ChatBridge {
    return ChatBridge.getInstance();
}
