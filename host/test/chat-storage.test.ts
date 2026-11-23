import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js';
import type { ModelMessage } from 'ai';
import { LLMConfigService } from '../src/core/llm-config-service.js';
import { MessageService } from '../src/core/message-service.js';
import { HostDrivenSourceV2 } from '../src/adapters/host-driven-source.js';
import { IMDrivenSource } from '../src/im/im-driven-source.js';
import { listIMMessages } from '../src/im/message-store.js';
import * as db from '../src/db/index.js';
import { createHostV2Core } from '../src/server/host-v2.js';
import { ModelRegistry } from '../src/services/model-registry.js';
import { appRouter } from '../src/trpc/router.js';
import type { GuiUpdateEvent } from '../src/types/session.js';

it('writes and reloads ModelMessage history through the current Host while leaving retired tables readable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-chat-history-'));
    const location = join(home, 'host.sqlite');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('DB_PATH', location);
    vi.spyOn(LLMConfigService.prototype, 'resolveLLMConfig').mockResolvedValue({
        model: 'local-synthetic', provider: { id: 'openai' },
        inputBudget: async () => ({ contextWindow: 32_000, maxOutputTokens: 1_000 }),
        modelCapabilities: { input: { pdf: true } },
    });
    vi.spyOn(LLMClient.prototype, 'createInputMeasurement').mockResolvedValue(undefined);
    const provider = vi.spyOn(LLMClient.prototype, 'call').mockResolvedValue({
        text: 'Stored answer', toolCalls: [], finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: [{ type: 'reasoning', text: 'reasoned' }, { type: 'text', text: 'Stored answer' }] },
    });
    let host: Awaited<ReturnType<typeof createHostV2Core>> | undefined;
    let off: { unsubscribe(): void } | undefined;
    try {
        await db.initDatabase();
        db.closeDatabase();
        const initial = await db.initDatabase();
        const tableNames = () => db.getDb().exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0].values.flat();
        expect(tableNames()).toEqual(expect.arrayContaining(['messages_v2', 'llm_configs']));
        expect(tableNames()).not.toContain('messages');
        expect(tableNames()).not.toContain('message_parts');

        db.createTopic({ id: 'archive', title: 'Archive', status: 'cold', createdAt: 1, updatedAt: 1 });
        initial.run(`
            CREATE TABLE messages (id TEXT PRIMARY KEY, topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE, content TEXT);
            CREATE TABLE message_parts (id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, text_content TEXT);
            INSERT INTO messages VALUES ('historical-message', 'archive', 'old text');
            INSERT INTO message_parts VALUES ('historical-part', 'historical-message', 'old part');
        `);
        const messages = new MessageService();
        messages.addMessage('archive', { role: 'assistant', content: 'V2 archive' });
        const legacyRows = () => db.getDb().exec('SELECT * FROM messages; SELECT * FROM message_parts;');
        const archive = legacyRows();
        db.closeDatabase();
        const beforeStartup = await readFile(location);
        await db.initDatabase();
        expect(legacyRows()).toEqual(archive);
        expect(await readFile(location)).toEqual(beforeStartup);

        const registry = new ModelRegistry();
        host = await createHostV2Core(registry);
        const caller = appRouter.createCaller({
            hostManager: host.hostManager, llmConfigService: host.llmConfigService, modelRegistry: registry, messageService: messages,
        });
        const topic = await caller.db.createTopic({ title: 'Current history' });
        await caller.session.create({ id: topic.id });
        const events: GuiUpdateEvent[] = [];
        off = (await caller.session.events({ id: topic.id })).subscribe({ next: event => events.push(event) });

        await caller.chat.send({ id: topic.id, content: 'Read this', messageId: 'client-id',
            attachments: [{ id: 'attachment', mime: 'application/pdf', filename: 'sample.pdf', url: 'data:application/pdf;base64,YQ==' }],
        });
        await vi.waitFor(() => expect(events.some(event => event.type === 'assistant')).toBe(true));
        expect(provider).toHaveBeenCalled();
        const streamedUser = events.find(event => event.type === 'user')?.message;
        expect(streamedUser).toMatchObject({ id: 'client-id', role: 'user', content: [
            { type: 'text', text: 'Read this' },
            { type: 'file', data: 'YQ==', mediaType: 'application/pdf', filename: 'sample.pdf' },
        ] });
        const part: ModelMessage = { role: 'tool', content: [
            { type: 'tool-result', toolCallId: 'receipt', toolName: 'verify', output: { type: 'json', value: { saved: true } } },
        ], providerOptions: { fixture: { request: 'recorded' } } };
        messages.addMessage(topic.id, part);
        const stored = await caller.db.getMessages({ id: topic.id });
        expect(stored.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(stored[0]).toEqual(streamedUser);
        expect(stored.at(-1)).toMatchObject(part);

        off.unsubscribe();
        off = undefined;
        await host.hostManager.dispose();
        db.closeDatabase();
        await db.initDatabase();
        expect(await caller.db.getMessages({ id: topic.id })).toEqual(stored);
        expect(await caller.db.getMessages({ id: 'archive' })).toEqual([expect.objectContaining({ content: 'V2 archive' })]);
        await caller.db.deleteTopic({ id: topic.id });
        expect(await caller.db.getMessages({ id: topic.id })).toEqual([]);
        expect(legacyRows()).toEqual(archive);
    } finally {
        off?.unsubscribe();
        await host?.imRuntimeBridge.stop();
        await host?.hostManager.dispose();
        db.closeDatabase();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    }
});

it('rejects a retired schema before changing the database file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'host-retired-schema-'));
    const location = join(folder, 'retired.sqlite');
    vi.stubEnv('DB_PATH', location);
    try {
        const initial = await db.initDatabase();
        initial.run('ALTER TABLE im_sessions DROP COLUMN source_controls');
        db.persistDatabase();
        db.closeDatabase();
        const original = await readFile(location);

        await expect(db.initDatabase()).rejects.toThrow('Use a current database or a new DB_PATH.');
        expect(() => db.getDb()).toThrow('Database not initialized');
        expect(await readFile(location)).toEqual(original);
    } finally {
        db.closeDatabase();
        vi.unstubAllEnvs();
        await rm(folder, { recursive: true, force: true });
    }
});

it('fails to prepare Topic and IM history in a retired tool format without rewriting it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'host-retired-tool-message-'));
    const location = join(folder, 'retired-tool-message.sqlite');
    vi.stubEnv('DB_PATH', location);
    try {
        const initial = await db.initDatabase();
        db.createTopic({ id: 'topic', title: 'Topic', status: 'cold', createdAt: 1, updatedAt: 1 });
        const content = JSON.stringify([{ type: 'tool-result', toolCallId: 'call', toolName: 'test', result: 'obsolete' }]);
        initial.run("INSERT INTO messages_v2 (id, topic_id, role, content, timestamp) VALUES ('topic-result', 'topic', 'tool', ?, 1)", [content]);
        initial.run("INSERT INTO im_messages (id, session_key, role, content, timestamp) VALUES ('im-result', 'im', 'tool', ?, 1)", [content]);
        db.persistDatabase();
        const original = await readFile(location);

        const topic = new HostDrivenSourceV2(new MessageService(), 'topic');
        const im = new IMDrivenSource({ sessionKey: 'im', loadHistory: async key => listIMMessages(key) });
        await expect(topic.getContext()).rejects.toThrow('Stored tool message topic-result uses an unsupported format.');
        await expect(im.getContext()).rejects.toThrow('Stored tool message im-result uses an unsupported format.');
        expect(await readFile(location)).toEqual(original);
    } finally {
        db.closeDatabase();
        vi.unstubAllEnvs();
        await rm(folder, { recursive: true, force: true });
    }
});
