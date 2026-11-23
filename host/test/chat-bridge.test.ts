import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatBridge } from '../src/gui/ChatBridge.js';
import type { Topic } from '../src/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('ChatBridge Host-only', () => {
    const topic: Topic = {
        id: 'desktop_test',
        title: 'Test',
        createdAt: 1,
        updatedAt: 1,
        status: 'hot'
    };

    beforeEach(() => {
        (ChatBridge as any).instance = null;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        (ChatBridge as any).instance = null;
    });

    it('creates topics through tRPC', async () => {
        const bridge = ChatBridge.getInstance();
        
        const mockTrpcClient = {
            db: {
                createTopic: {
                    mutate: vi.fn().mockResolvedValue(topic)
                }
            }
        };

        // Mock getTrpcClient
        (bridge as any).getTrpcClient = () => mockTrpcClient;

        const created = await bridge.createTopic('Test');

        expect(created?.id).toBe(topic.id);
        expect(mockTrpcClient.db.createTopic.mutate).toHaveBeenCalledWith({ title: 'Test' });
    });

    it('loads the first preview without a cached snapshot or a user message', async () => {
        const bridge = ChatBridge.getInstance();
        const preview = { applications: [{ installationId: 'app_0', name: 'ide', status: 'pending', views: [] }], diagnostics: [] };
        const create = vi.fn().mockResolvedValue({ id: topic.id });
        const query = vi.fn().mockResolvedValue(preview);
        const subscribe = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
        const notify = vi.fn();
        (bridge as any).getTrpcClient = () => ({ session: {
            create: { mutate: create }, preview: { query }, events: { subscribe },
        } });
        bridge.subscribe(notify);
        expect(bridge.getDesktopPreview(topic.id)).toBeUndefined();
        await bridge.requestDesktopPreview(topic.id);
        expect(create).toHaveBeenCalledWith({ id: topic.id, lazy: true });
        expect(query).toHaveBeenCalledWith({ id: topic.id });
        expect(subscribe).toHaveBeenCalledOnce();
        expect(bridge.getDesktopPreview(topic.id)).toBe(preview);
        expect(notify).toHaveBeenCalledWith({ type: 'snapshot', topicId: topic.id });
    });

    it('loads current ModelMessages and merges live updates by id during history retrieval', async () => {
        const bridge = ChatBridge.getInstance();
        const stored = [
            { id: 'user', role: 'user', timestamp: 1, content: 'Edit two files' },
            { id: 'calls', role: 'assistant', timestamp: 2, content: [
                { type: 'reasoning', text: 'Inspect both files' },
                { type: 'text', text: 'I will update both.' },
                { type: 'tool-call', toolName: 'edit', toolCallId: 'one', input: { file: 'one.txt' } },
                { type: 'tool-call', toolName: 'edit', toolCallId: 'two', input: { file: 'two.txt' } },
            ] },
            { id: 'results', role: 'tool', timestamp: 3, content: [
                { type: 'tool-result', toolName: 'edit', toolCallId: 'one', output: { type: 'text', value: 'Saved' } },
                { type: 'tool-result', toolName: 'edit', toolCallId: 'two', output: { type: 'error-text', value: 'Conflict' } },
            ] },
        ];
        let resolveHistory!: (history: typeof stored) => void;
        const query = vi.fn(() => new Promise<typeof stored>(resolve => { resolveHistory = resolve; }));
        (bridge as any).getTrpcClient = () => ({ db: { getMessages: { query } } });
        (bridge as any).topics.set(topic.id, topic);
        const loading = bridge.setActiveTopic(topic.id);

        const receive = (event: object) => (bridge as any).handleSessionEvent({ topicId: topic.id, ...event });
        receive({ type: 'text_delta', delta: 'Working' });
        receive({ type: 'reasoning_delta', delta: 'Reading' });
        expect(bridge.getAgentThinking(topic.id)).toBe('Working');
        expect(bridge.getAgentReasoning(topic.id)).toBe('Reading');

        const final = { id: 'final', role: 'assistant', timestamp: 4, content: '[{"type":"text","text":"literal"}]' };
        receive({ type: 'assistant', message: final });
        receive({ type: 'tool', message: stored[2] });
        resolveHistory(stored);
        await loading;

        expect(query).toHaveBeenCalledExactlyOnceWith({ id: topic.id });
        const messages = bridge.getMessages(topic.id);
        expect(messages.map(message => message.id)).toEqual(['user', 'calls', 'results', 'final']);
        expect(messages[1]).toMatchObject({ messageType: 'tool_call', metadata: {
            reasoning: 'Inspect both files', text: 'I will update both.',
            toolCalls: [{ toolCallId: 'one', toolName: 'edit' }, { toolCallId: 'two', toolName: 'edit' }],
        } });
        expect(messages[2]).toMatchObject({ messageType: 'tool_result', metadata: {
            toolResults: [
                { toolName: 'edit', toolCallId: 'one', result: 'Saved', isError: false },
                { toolName: 'edit', toolCallId: 'two', result: 'Conflict', isError: true },
            ],
        } });
        expect(messages[3].content).toBe(final.content);
        expect(bridge.getAgentThinking(topic.id)).toBe('');
        expect(bridge.getAgentReasoning(topic.id)).toBe('');
    });

    it('reads IM runtime through tRPC', async () => {
        const bridge = ChatBridge.getInstance();
        const runtime = {
            started: true,
            channels: [
                {
                    id: 'feishu',
                    runtime: {
                        accountIds: ['default'],
                    },
                },
            ],
        };

        const mockTrpcClient = {
            im: {
                getRuntime: {
                    query: vi.fn().mockResolvedValue(runtime),
                },
            },
        };

        (bridge as any).getTrpcClient = () => mockTrpcClient;

        await expect((bridge as any).getImRuntime()).resolves.toEqual(runtime);
        expect(mockTrpcClient.im.getRuntime.query).toHaveBeenCalledTimes(1);
    });

    it('passes agentId when creating topic with overrides', async () => {
        const bridge = ChatBridge.getInstance();

        const mockTrpcClient = {
            db: {
                createTopic: {
                    mutate: vi.fn().mockResolvedValue({ ...topic, id: 'desktop_agent' })
                }
            }
        };

        (bridge as any).getTrpcClient = () => mockTrpcClient;

        await bridge.createTopic('Agent Topic', 'project_1', {
            modelOverride: 'openai:gpt-4.1',
            promptOverride: 'system prompt',
            agentId: 'agent_alpha',
            sourceControls: {
                apps: { enabled: true, disabledItems: [] },
                mcp: { enabled: true, disabledItems: [] },
                skill: { enabled: true, disabledItems: [] },
            },
        });

        expect(mockTrpcClient.db.createTopic.mutate).toHaveBeenCalledWith({
            title: 'Agent Topic',
            projectId: 'project_1',
            modelOverride: 'openai:gpt-4.1',
            promptOverride: 'system prompt',
            agentId: 'agent_alpha',
            sourceControls: {
                apps: { enabled: true, disabledItems: [] },
                mcp: { enabled: true, disabledItems: [] },
                skill: { enabled: true, disabledItems: [] },
            },
        });
    });

    it('clears active topic without stale rebound', async () => {
        const bridge = ChatBridge.getInstance();
        const events: Array<{ type: string; topicId?: string }> = [];

        (bridge as any).topics.set(topic.id, topic);
        (bridge as any).messages.set(topic.id, []);

        const unsubscribe = bridge.subscribe((event) => {
            events.push({ type: event.type, topicId: event.topicId });
        });

        await bridge.setActiveTopic(topic.id);
        expect(bridge.getActiveTopicId()).toBe(topic.id);

        bridge.clearActiveTopic();

        expect(bridge.getActiveTopicId()).toBeNull();
        expect(events.some(e => e.type === 'topic' && e.topicId === topic.id)).toBe(true);
        expect(events.some(e => e.type === 'topic' && e.topicId === undefined)).toBe(true);

        unsubscribe();
    });

    it('normalizes assistant reasoning + text without prefixing Reasoning block', () => {
        const bridge = ChatBridge.getInstance();
        const normalized = [
            {
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'Analyze the request' },
                    { type: 'text', text: 'Final answer' },
                ],
            },
        ].map(message => (bridge as any).toDisplayMessage(message));

        expect(normalized).toHaveLength(1);
        expect(normalized[0].messageType).toBe('text');
        expect(normalized[0].content).toBe('Final answer');
        expect(normalized[0].metadata?.reasoning).toBe('Analyze the request');
    });

    it('keeps reasoning-only assistant message as raw reasoning text', () => {
        const bridge = ChatBridge.getInstance();
        const normalized = [
            {
                role: 'assistant',
                content: [{ type: 'reasoning', text: 'Thinking in progress' }],
            },
        ].map(message => (bridge as any).toDisplayMessage(message));

        expect(normalized).toHaveLength(1);
        expect(normalized[0].messageType).toBe('reasoning');
        expect(normalized[0].content).toBe('Thinking in progress');
        expect(normalized[0].metadata?.reasoning).toBe('Thinking in progress');
    });

    it('normalizes user file parts into attachment metadata for image and pdf', () => {
        const bridge = ChatBridge.getInstance();
        const normalized = [
            {
                id: 'msg_with_files',
                role: 'user',
                content: [
                    { type: 'text', text: 'Please inspect attachments' },
                    { type: 'file', mediaType: 'image/png', data: 'abcd', filename: 'diagram.png' },
                    { type: 'file', mediaType: 'application/pdf', data: 'efgh', filename: 'design.pdf' },
                ],
            },
        ].map(message => (bridge as any).toDisplayMessage(message));

        expect(normalized).toHaveLength(1);
        expect(normalized[0].content).toBe('Please inspect attachments');
        expect(normalized[0].metadata?.attachments).toEqual([
            {
                id: 'msg_with_files_att_0',
                mime: 'image/png',
                url: 'data:image/png;base64,abcd',
                filename: 'diagram.png',
            },
            {
                id: 'msg_with_files_att_1',
                mime: 'application/pdf',
                url: 'data:application/pdf;base64,efgh',
                filename: 'design.pdf',
            },
        ]);
    });

    it('strips attachments from non-user messages (tool-result bridge disabled)', () => {
        const bridge = ChatBridge.getInstance();
        const normalized = [
            {
                id: 'tool_result_1',
                role: 'tool',
                content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'mock_tool', output: { type: 'text', value: 'ok' } }],
                metadata: {
                    attachments: [
                        {
                            id: 'att_tool_1',
                            mime: 'image/png',
                            url: 'data:image/png;base64,abcd',
                            filename: 'tool.png',
                        },
                    ],
                },
            },
        ].map(message => (bridge as any).toDisplayMessage(message));

        expect(normalized).toHaveLength(1);
        expect(normalized[0].role).toBe('tool');
        expect(normalized[0].metadata?.attachments).toBeUndefined();
        expect(normalized[0].metadata?.toolResults[0].toolName).toBe('mock_tool');
    });

    it('hides IM session-shaped topics from GUI topic list', () => {
        const bridge = ChatBridge.getInstance();

        (bridge as any).topics.set('topic_normal', {
            id: 'topic_normal',
            title: 'Normal Topic',
            createdAt: 1,
            updatedAt: 2,
            status: 'hot',
        });
        (bridge as any).topics.set('agent:agent-a:feishu:direct:ou_123', {
            id: 'agent:agent-a:feishu:direct:ou_123',
            title: 'IM Session',
            createdAt: 1,
            updatedAt: 3,
            status: 'hot',
        });

        expect(bridge.getTopics()).toEqual([
            expect.objectContaining({
                id: 'topic_normal',
            }),
        ]);
    });
});

describe('Database topic persistence', () => {
    it('persists projectId on topic creation', async () => {
        const dbPath = path.join(
            os.tmpdir(),
            `system-chat-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`
        );
        process.env.DB_PATH = dbPath;
        const db = await import('../src/db/index.js');

        await db.initDatabase();

        const topic = {
            id: 'topic_test',
            title: 'Test Topic',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'hot' as const,
            projectId: 'project_test'
        };

        db.createTopic(topic);
        const stored = db.getTopic(topic.id);

        expect(stored?.projectId).toBe('project_test');

        db.closeDatabase();
        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { force: true });
        }
    });

    it('filters IM session-shaped topic ids from getAllTopics', async () => {
        const dbPath = path.join(
            os.tmpdir(),
            `system-chat-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`
        );
        process.env.DB_PATH = dbPath;
        const db = await import('../src/db/index.js');

        await db.initDatabase();

        db.createTopic({
            id: 'topic_visible',
            title: 'Visible Topic',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'hot',
        });
        db.createTopic({
            id: 'agent:agent-a:feishu:direct:ou_hidden',
            title: 'Hidden IM Topic',
            createdAt: Date.now(),
            updatedAt: Date.now() + 1,
            status: 'hot',
        });

        expect(db.getAllTopics()).toEqual([
            expect.objectContaining({
                id: 'topic_visible',
            }),
        ]);

        db.closeDatabase();
        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { force: true });
        }
    });
});
