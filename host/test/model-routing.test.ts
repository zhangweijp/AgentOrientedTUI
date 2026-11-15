import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { MessageServiceV2 } from '../src/core/message-service-v2.js';
import * as db from '../src/db/index.js';
import { buildSessionKey } from '../src/im/routing.js';
import { MCP } from '../src/mcp/index.js';
import { createHostV2Core } from '../src/server/host-v2.js';
import { ModelRegistry } from '../src/services/model-registry.js';
import { appRouter } from '../src/trpc/router.js';

const activeModel = 'openai/team:fast';
const agentModel = 'vendor/model:suffix';
const openaiURL = 'https://default.test/v1';
const routerURL = 'https://openrouter.ai/api/v1';
const customURL = 'https://compatible.test/v1';
const anthropicURL = 'https://anthropic-proxy.test/v1';
const providerModel = (id: string, output: number, tool_call: boolean) => ({
    // The routing fixture loads the standard desktop Apps and their complete Tool inventory.
    id, name: id, tool_call, modalities: { input: ['text'] }, limit: { context: 64_000, output },
});
const catalog = {
    openai: { id: 'openai', name: 'OpenAI', api: openaiURL, models: {
        [activeModel]: providerModel('openai/' + activeModel, 301, true),
        local: providerModel('openai/local', 302, false),
    } },
    openrouter: { id: 'openrouter', name: 'OpenRouter', api: routerURL, models: {
        [agentModel]: providerModel('openrouter/' + agentModel, 411, false),
    } },
};

function sse(frames: object[]) {
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
}

function modelResponse(model: string, anthropic: boolean) {
    if (anthropic) {
        return sse([
            { type: 'message_start', message: { id: 'fixture', type: 'message', model, role: 'assistant',
                content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'confirmed' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
            { type: 'message_stop' },
        ]);
    }
    return sse([{ id: 'fixture', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'confirmed' }, finish_reason: 'stop' }] }]);
}

it('routes persisted and explicit models through Desktop and IM using the selected endpoint and credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-model-routing-'));
    const configDir = join(home, '.agentina');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('DB_PATH', join(home, 'host.sqlite'));
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-openai-env-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'unrelated-anthropic-env-key');
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    vi.stubEnv('OPENAI_BASE_URL', undefined);
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);

    const requests: { url: string; key: string | null; model: string; maxTokens: number; tools: unknown[] }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (url === 'https://models.dev/api.json') return Response.json(catalog);
        const headers = new Headers(init.headers);
        const { model, max_tokens, tools } = JSON.parse(String(init.body));
        const anthropic = url === anthropicURL + '/messages';
        requests.push({ url, key: headers.get(anthropic ? 'x-api-key' : 'authorization'), model, maxTokens: max_tokens, tools: tools ?? [] });
        return modelResponse(model, anthropic);
    });

    let host: Awaited<ReturnType<typeof createHostV2Core>> | undefined;
    try {
        await mkdir(configDir, { recursive: true });
        const agent = { id: 'agent', name: 'Fixture Agent', prompt: 'Reply with a confirmation.',
            modelId: 'openrouter:' + agentModel, enabledApps: [], enabledSkills: {},
            enabledMCPs: ['routing'], disabledMcpTools: [], skin: {} };
        const fixture = fileURLToPath(new URL('./fixtures/mcp-same-name.mjs', import.meta.url));
        await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ agents: { list: [agent] },
            mcp: { routing: { type: 'local', command: [process.execPath, fixture, 'routing'], enabled: true } },
        }));
        await writeFile(join(configDir, 'config.json'), JSON.stringify({ modelInputLimits: {
            ['openai:openai:local@' + customURL]: { contextWindow: 16_000, maxOutputTokens: 512, capabilities: { toolCall: false } },
            ['anthropic:anthropic/team:custom@' + anthropicURL]: { contextWindow: 16_000, maxOutputTokens: 768, capabilities: { toolCall: false } },
        } }));

        // A pre-existing ambiguous record can be opened and repaired in Settings.
        await db.initDatabase();
        const savedIM = buildSessionKey(agent.id, 'fixture', 'direct', 'saved-peer');
        db.getDb().run('ALTER TABLE im_sessions DROP COLUMN source_controls');
        db.getDb().run('INSERT INTO im_sessions VALUES (?, ?, ?, ?, ?, NULL, 1, 2, 3)',
            [savedIM, agent.id, 'fixture', 'direct', 'saved-peer']);
        db.getDb().run(`INSERT INTO llm_configs (name, model, is_active, created_at, updated_at)
            VALUES ('Ambiguous old row', 'gpt-4', 1, 1, 1)`);
        db.persistDatabase();
        db.closeDatabase();
        const registry = new ModelRegistry();
        host = await createHostV2Core(registry);
        const caller = appRouter.createCaller({
            hostManager: host.hostManager, llmConfigService: host.llmConfigService, modelRegistry: registry,
            messageService: new MessageServiceV2(),
        });
        const legacy = await caller.llmConfig.getActive();
        expect(legacy).toMatchObject({ model: 'gpt-4', isActive: true });
        expect(host.hostManager.getIMSession(savedIM)).toMatchObject({ sessionKey: savedIM, lastAccessTime: 3 });
        const invalid = await caller.db.createTopic({ title: 'Needs settings repair' });
        await expect(caller.session.create({ id: invalid.id })).rejects.toThrow('Reselect the model in Settings');
        expect(host.hostManager.getSessionManager()?.getSession(invalid.id)).toBeUndefined();
        expect(await caller.llmConfig.getActive()).toEqual(legacy);
        expect(requests).toEqual([]);

        db.getDb().run("UPDATE llm_configs SET model = 'openai:local' WHERE is_active = 1");
        expect(await host.llmConfigService.resolveLLMConfig())
            .toMatchObject({ model: 'local', provider: { id: 'openai', baseURL: openaiURL } });

        const lookup = await caller.modelRegistry.getModels({ providerId: 'openai' });
        expect(lookup).toContainEqual(expect.objectContaining({ id: activeModel, catalogId: 'openai/' + activeModel }));
        const active = await caller.llmConfig.create({ name: 'Configured OpenAI', providerId: 'openai',
            model: 'openai/' + activeModel, apiKey: 'fixture-active', temperature: 0.7, maxSteps: 1 });
        await caller.llmConfig.setActive({ id: active.id });

        const desktop = async (topic: Awaited<ReturnType<typeof caller.db.createTopic>>,
            expected: Omit<typeof requests[number], 'tools'>, tool?: string) => {
            const next = requests.length;
            await caller.session.create({ id: topic.id });
            await caller.chat.send({ id: topic.id, content: 'Confirm the selected model.' });
            await vi.waitFor(() => expect(host?.hostManager.getMessages(topic.id)).toContainEqual(
                expect.objectContaining({ role: 'assistant', content: 'confirmed' })));
            expect(requests.slice(next)).toHaveLength(1);
            expect(requests[next]).toMatchObject(expected);
            expect(requests[next]?.tools).toEqual(tool
                ? expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: tool }) })])
                : []);
            await caller.session.shutdown({ id: topic.id });
        };
        await desktop(await caller.db.createTopic({ title: 'Active config' }),
            { url: openaiURL + '/chat/completions', key: 'Bearer fixture-active', model: activeModel, maxTokens: 301 },
            'mcp-routing-search');
        expect((await caller.llmConfig.getActive())?.model).toBe('openai/' + activeModel);

        await desktop(await caller.db.createTopic({ title: 'Topic before agent', agentId: agent.id, modelOverride: 'openai/local' }),
            { url: openaiURL + '/chat/completions', key: 'Bearer fixture-active', model: 'local', maxTokens: 302 });

        const before = requests.length;
        expect((await host.llmConfigService.resolveLLMConfig('openrouter:' + agentModel)).apiKey).toBeUndefined();
        const missing = await caller.db.createTopic({ title: 'No cross-Provider key', agentId: agent.id });
        await caller.chat.send({ id: missing.id, content: 'An API key is missing.' });
        await vi.waitFor(() => expect(JSON.stringify(host?.hostManager.getMessages(missing.id))).toContain('API key not found'));
        expect(requests).toHaveLength(before);
        await caller.session.shutdown({ id: missing.id });

        vi.stubEnv('OPENROUTER_API_KEY', 'fixture-openrouter-env');
        const routerRoute = { url: routerURL + '/chat/completions', key: 'Bearer fixture-openrouter-env', model: agentModel, maxTokens: 411 };
        await desktop(await caller.db.createTopic({ title: 'Inherit agent model', agentId: agent.id }), routerRoute);
        const imStart = requests.length;
        const sessionKey = buildSessionKey(agent.id, 'fixture', 'direct', 'test-peer');
        await host.hostManager.sendIMMessage({ sessionKey, agentId: agent.id, channel: 'fixture',
            chatType: 'direct', peerId: 'test-peer', body: 'Confirm the IM model.', messageId: 'im-message',
            senderId: 'sender', chatId: 'chat', timestamp: Date.now(), triggerAgent: true });
        await vi.waitFor(() => expect(host?.hostManager.getIMMessages(sessionKey)).toContainEqual(
            expect.objectContaining({ role: 'assistant', content: 'confirmed' })));
        expect(requests.slice(imStart)).toEqual([{ ...routerRoute, tools: [] }]);
        expect(host.hostManager.getIMSession(sessionKey)?.sourceControls?.mcp.allowedServers).toEqual(['routing']);

        const proxy = await caller.llmConfig.customProvidersCreate({ id: 'openai', name: 'Local compatible',
            protocol: 'openai', baseUrl: customURL, apiKey: 'fixture-compatible' });
        const proxyModel = await caller.llmConfig.customModelConfigsCreate({ customProviderId: proxy.id, modelId: 'openai:local' });
        await caller.llmConfig.setActive({ id: proxyModel.id });
        await desktop(await caller.db.createTopic({ title: 'Custom active' }),
            { url: customURL + '/chat/completions', key: 'Bearer fixture-compatible', model: 'openai:local', maxTokens: 512 });
        await desktop(await caller.db.createTopic({ title: 'Explicit official model with same-named custom Provider',
            modelOverride: 'openai:' + activeModel }),
            { url: openaiURL + '/chat/completions', key: 'Bearer fixture-active', model: activeModel, maxTokens: 301 },
            'mcp-routing-search');

        const anthropic = await caller.llmConfig.customProvidersCreate({ id: 'an-proxy', name: 'Anthropic proxy',
            protocol: 'anthropic', baseUrl: anthropicURL, apiKey: 'fixture-an-old' });
        const claude = 'anthropic/team:custom';
        await caller.llmConfig.customModelConfigsCreate({ customProviderId: anthropic.id, modelId: claude });
        await caller.llmConfig.customProvidersUpdate({ id: anthropic.id, data: { apiKey: 'fixture-an-new' } });
        await desktop(await caller.db.createTopic({ title: 'Custom Anthropic', modelOverride: anthropic.id + ':' + claude }),
            { url: anthropicURL + '/messages', key: 'fixture-an-new', model: claude, maxTokens: 768 });
        await caller.llmConfig.customProvidersUpdate({ id: anthropic.id, data: { apiKey: '' } });
        await expect(host.llmConfigService.resolveLLMConfig(anthropic.id + ':' + claude))
            .rejects.toThrow('Set its key in Settings');

        await caller.llmConfig.update({ id: active.id, data: { providerId: 'openrouter', model: agentModel } });
        expect((await caller.llmConfig.getAll()).find(row => row.id === active.id))
            .toMatchObject({ providerId: 'openrouter', baseUrl: routerURL, apiKey: undefined });
    } finally {
        await host?.imRuntimeBridge.stop();
        await host?.hostManager.dispose();
        await MCP.disconnect('routing');
        db.closeDatabase();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);
