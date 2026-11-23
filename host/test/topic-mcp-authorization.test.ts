import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js';
import { LLMConfigService } from '../src/core/llm-config-service.js';
import { MessageService } from '../src/core/message-service.js';
import * as db from '../src/db/index.js';
import { MCP } from '../src/mcp/index.js';
import { createHostV2Core } from '../src/server/host-v2.js';
import { ModelRegistry } from '../src/services/model-registry.js';
import { appRouter } from '../src/trpc/router.js';

it('keeps the Topic directory and Driver within the saved MCP server selection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-topic-permissions-'));
    const configPath = join(home, '.agentina');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('DB_PATH', join(home, 'host.sqlite'));
    const fixture = fileURLToPath(new URL('./fixtures/mcp-same-name.mjs', import.meta.url));
    const server = (name: string) => ({ type: 'local' as const, command: [process.execPath, fixture, name], enabled: true });
    const west = server('west'), archive = server('archive');
    const agent = { id: 'agent', name: 'Agent', modelId: '', prompt: '', enabledMCPs: ['west'],
        enabledApps: [], enabledSkills: {}, disabledMcpTools: [], skin: {} };

    vi.spyOn(LLMConfigService.prototype, 'resolveLLMConfig').mockResolvedValue({
        model: 'synthetic', provider: { id: 'openai' }, apiKey: 'fixture-only',
        inputBudget: async () => ({ contextWindow: 32_000, maxOutputTokens: 1_000, capabilities: { toolCall: true } }),
    });
    const requests = new Map<string, string[]>();
    vi.spyOn(LLMClient.prototype, 'call').mockImplementation(async (messages, tools) => {
        const prompt = messages.findLast(message => message.role === 'user'
            && typeof message.content === 'string' && message.content.startsWith('Check permissions '));
        if (typeof prompt?.content === 'string') {
            requests.set(prompt.content, Object.keys(tools).filter(key => key.startsWith('mcp-')).sort());
        }
        return { text: 'Observed the configured tools', toolCalls: [], finishReason: 'stop',
            assistantMessage: { role: 'assistant', content: 'Observed the configured tools' } };
    });

    let host: Awaited<ReturnType<typeof createHostV2Core>> | undefined;
    try {
        await mkdir(configPath);
        await writeFile(join(configPath, 'mcp.json'), JSON.stringify({ mcp: { west }, agents: { list: [agent] } }));
        const registry = new ModelRegistry();
        host = await createHostV2Core(registry);
        const caller = appRouter.createCaller({
            hostManager: host.hostManager, llmConfigService: host.llmConfigService, modelRegistry: registry,
            messageService: new MessageService(),
        });
        const topic = await caller.db.createTopic({ title: 'Agent-owned topic', agentId: agent.id });
        const enabledServers = async (id: string) => {
            const { mcp } = await caller.sourceControl.getTopic({ id });
            return mcp.groups.filter(group => group.enabled).map(group => group.serverName);
        };
        const request = async (id: string, step: string, expected: string[]) => {
            const content = 'Check permissions ' + step;
            await caller.chat.send({ id, content });
            await vi.waitFor(() => expect(requests.get(content)).toEqual(expected));
        };
        const reopen = async (id: string) => {
            await caller.session.shutdown({ id });
            expect(host?.hostManager.getSessionManager()?.getSession(id)).toBeUndefined();
            db.closeDatabase();
            await db.initDatabase();
            await caller.session.create({ id });
        };

        expect(await enabledServers(topic.id)).toEqual(['west']);
        await caller.session.create({ id: topic.id });
        await request(topic.id, 'initially', ['mcp-west-search']);

        await caller.mcp.updateConfig({ mcp: { west, archive } });
        expect(await enabledServers(topic.id)).toEqual(['west']);
        await request(topic.id, 'after adding a global server', ['mcp-west-search']);

        await caller.sourceControl.setSourceEnabled({ id: topic.id, source: 'skill', enabled: true });
        await reopen(topic.id);
        expect(db.getTopic(topic.id)?.sourceControls?.mcp).toEqual({ enabled: true, disabledItems: [], allowedServers: ['west'] });
        expect(await enabledServers(topic.id)).toEqual(['west']);
        await request(topic.id, 'after reopening', ['mcp-west-search']);

        await caller.sourceControl.setItemEnabled({ id: topic.id, source: 'mcp', itemName: 'server:archive', enabled: true });
        expect(await enabledServers(topic.id)).toEqual(['archive', 'west']);
        await request(topic.id, 'after explicitly allowing archive', ['mcp-archive-search', 'mcp-west-search']);
        await reopen(topic.id);
        expect(db.getTopic(topic.id)?.sourceControls?.mcp.allowedServers).toEqual(['archive', 'west']);
        await request(topic.id, 'after reopening the selection', ['mcp-archive-search', 'mcp-west-search']);

        const session = host.hostManager.getSessionManager()?.getSession(topic.id);
        expect(session).toBeDefined();
        const captured = await session!.sources.mcp.getContext();
        expect(captured.tools).toHaveProperty('mcp-west-search');

        await caller.sourceControl.setItemEnabled({ id: topic.id, source: 'mcp', itemName: 'server:west', enabled: false });
        expect(await enabledServers(topic.id)).toEqual(['archive']);
        expect(await captured.executeTool?.('mcp-west-search', {}, 'revoked')).toMatchObject({
            outcomeStatus: 'rejected', error: { code: 'E_SOURCE_UNAVAILABLE' },
        });
        await request(topic.id, 'after explicitly disabling west', ['mcp-archive-search']);
        await reopen(topic.id);
        expect(await enabledServers(topic.id)).toEqual(['archive']);

        const cold = await caller.db.createTopic({ title: 'Cold Topic', agentId: agent.id });
        await caller.sourceControl.setSourceEnabled({ id: cold.id, source: 'skill', enabled: true });
        expect(db.getTopic(cold.id)?.sourceControls?.mcp.allowedServers).toEqual(['west']);

        const unbound = await caller.db.createTopic({ title: 'Topic without an Agent' });
        expect(await enabledServers(unbound.id)).toEqual(['archive', 'west']);
        expect(host.hostManager.getSessionManager()?.getSession(unbound.id)).toBeUndefined();

        const priorTopic = db.getTopic(unbound.id);
        const promptOverride = 'Use the enabled tools';
        const mcp = { enabled: true, disabledItems: ['server:archive'] };
        const retiredUpdate = {
            id: unbound.id,
            promptOverride,
            sourceControls: {
                apps: { enabled: false, disabledItems: [] },
                mcp,
                skill: { enabled: false, disabledItems: [] },
            },
        };
        await expect(caller.db.updateTopicConfig(retiredUpdate)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(db.getTopic(unbound.id)).toEqual(priorTopic);
        expect(await enabledServers(unbound.id)).toEqual(['archive', 'west']);

        await caller.sourceControl.setItemEnabled({ id: unbound.id, source: 'mcp', itemName: 'server:archive', enabled: false });
        await expect(caller.db.updateTopicConfig({ id: unbound.id, promptOverride })).resolves.toEqual({ success: true });
        expect(db.getTopic(unbound.id)).toMatchObject({ promptOverride, sourceControls: { mcp } });
        expect(await enabledServers(unbound.id)).toEqual(['west']);
        await caller.session.create({ id: unbound.id });
        await request(unbound.id, 'after updating cold Topic permissions', ['mcp-west-search']);
        expect(await enabledServers(unbound.id)).toEqual(['west']);
        await reopen(unbound.id);
        expect(db.getTopic(unbound.id)?.sourceControls?.mcp).toEqual(mcp);
        expect(await enabledServers(unbound.id)).toEqual(['west']);
        await request(unbound.id, 'after reopening the cold Topic', ['mcp-west-search']);

        const explicit = await caller.db.createTopic({ title: 'Topic with explicit controls', agentId: agent.id, sourceControls: {
            apps: { enabled: false, disabledItems: [] },
            mcp: { enabled: true, disabledItems: ['server:west'] },
            skill: { enabled: false, disabledItems: [] },
        } });
        expect(await enabledServers(explicit.id)).toEqual(['archive']);
        await request(explicit.id, 'with explicit Topic settings', ['mcp-archive-search']);

        const defaults = explicit.sourceControls!;
        const draft = await caller.db.createTopic({ title: 'Topic from a scoped draft', agentId: agent.id, sourceControls: {
            ...defaults, mcp: { enabled: true, disabledItems: [], allowedServers: ['archive'] },
        } });
        expect(db.getTopic(draft.id)?.sourceControls?.mcp.allowedServers).toEqual(['archive']);
        expect(await enabledServers(draft.id)).toEqual(['archive']);
    } finally {
        await host?.imRuntimeBridge.stop();
        await host?.hostManager.dispose();
        await Promise.all(['west', 'archive'].map(name => MCP.disconnect(name)));
        db.closeDatabase();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);
