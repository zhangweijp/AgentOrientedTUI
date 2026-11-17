import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js';
import { Config } from '../src/config/config.js';
import type { Mcp } from '../src/config/mcp-schema.js';
import { MCP } from '../src/mcp/index.js';
import { McpDrivenSource } from '../src/mcp/source.js';
import { appRouter } from '../src/trpc/router.js';
import { createSourceControlsFromAgent, applySourceControlsToSources } from '../src/core/source-controls.js';
import { buildMcpServerItemKey, buildMcpToolItemKey } from '../src/shared/source-control-keys.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-same-name.mjs', import.meta.url));
const west = buildMcpToolItemKey('west', 'search');
const archive = buildMcpToolItemKey('west-archive', 'search');
const replacement = buildMcpToolItemKey('replacement', 'search');
const localServer = (label: string): Mcp => ({ type: 'local', command: [process.execPath, fixture, label], enabled: true });

async function driverToolNames(source: McpDrivenSource): Promise<string[]> {
    const seen: string[][] = [];
    const model = vi.spyOn(LLMClient.prototype, 'call').mockImplementation(async (_messages, tools) => {
        seen.push(Object.keys(tools).sort());
        return { text: '', toolCalls: [], finishReason: 'stop' };
    });
    const driver = new AgentDriverV2({ llm: { model: 'local-probe', provider: { id: 'openai' } }, sources: [source] });
    try {
        await driver.trigger();
        await driver['runInFlight'];
        expect(seen).toHaveLength(1);
        return seen[0];
    } finally {
        driver.stop();
        driver.dispose();
        model.mockRestore();
    }
}

it('validates configuration and exposes exact Agent, Topic and global permissions to the Driver', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-mcp-config-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const configDir = join(home, '.agentina');
    const file = join(configDir, 'mcp.json');
    const caller = appRouter.createCaller({} as Parameters<typeof appRouter.createCaller>[0]);
    try {
        await mkdir(configDir);
        const retired = { enabled: true, disabled: true, command: process.execPath, args: [fixture, 'retired'] };
        const original = JSON.stringify({
            mcp: { west: localServer('west'), 'west-archive': localServer('archive'), retired },
            mcpServers: { 'old-shape': localServer('old-shape') },
        });
        await writeFile(file, original);

        const config = await caller.mcp.getConfig();
        expect(Object.keys(config.mcp)).toEqual(['west', 'west-archive']);
        expect(config.issues).toEqual([expect.stringContaining('MCP server "retired" has invalid settings')]);
        expect(await readFile(file, 'utf8')).toBe(original);
        const runtime = await caller.mcp.getRuntime();
        expect(runtime).not.toHaveProperty('old-shape');
        expect(runtime).toMatchObject({
            west: { status: 'connected', tools: [{ name: 'search', enabled: true }] },
            'west-archive': { status: 'connected', tools: [{ name: 'search', enabled: true }] },
            retired: { status: 'failed', tools: [] },
        });
        await expect(caller.mcp.setServerEnabled({ name: 'retired', enabled: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(caller.mcp.updateConfig({ mcp: { retired } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(await readFile(file, 'utf8')).toBe(original);

        const agent = {
            id: 'agent', name: 'Agent', prompt: '', modelId: '', enabledMCPs: ['west-archive'],
            enabledApps: [], enabledSkills: {}, disabledMcpTools: [], skin: {},
        };
        const agentControls = createSourceControlsFromAgent(agent, []);
        const agentSource = new McpDrivenSource(new Set(agentControls.mcp.allowedServers));
        applySourceControlsToSources(agentControls, { mcpSource: agentSource });
        expect(await driverToolNames(agentSource)).toEqual([archive]);
        const scoped = await agentSource.getContext();
        const receipt = await scoped.executeTool?.(archive, {}, 'archive');
        expect(receipt?.result).toBe('{"content":[{"type":"text","text":"archive"}]}');
        expect(await scoped.executeTool?.(west, {}, 'denied')).toBeUndefined();

        const topicSource = new McpDrivenSource();
        applySourceControlsToSources({ ...agentControls, mcp: { enabled: true, disabledItems: [archive] } }, { mcpSource: topicSource });
        expect(await driverToolNames(topicSource)).toEqual([west]);
        topicSource.setServerEnabled('west', false);
        expect(await driverToolNames(topicSource)).toEqual([]);

        await expect(caller.agents.saveAgents({ list: [{ ...agent, disabledMcpTools: ['west::search'] }], activeAgentId: agent.id }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });
        const legacy = new McpDrivenSource();
        applySourceControlsToSources(createSourceControlsFromAgent({ ...agent, disabledMcpTools: ['search'] }, []), { mcpSource: legacy });
        expect(await driverToolNames(legacy)).toEqual([]);

        const originalContext = await new McpDrivenSource().getContext();
        expect(Object.keys(originalContext.tools).sort()).toEqual([archive, west]);
        await Promise.all([
            caller.mcp.setToolEnabled({ serverName: 'west', toolName: 'search', enabled: false }),
            caller.mcp.setToolEnabled({ serverName: 'west', toolName: 'retired-tool', enabled: false }),
        ]);
        expect(new Set((await Config.getMcp()).mcp.west.disabledTools)).toEqual(new Set(['search', 'retired-tool']));
        expect(JSON.parse(await readFile(file, 'utf8')).mcp.retired).toEqual(retired);
        expect(await driverToolNames(new McpDrivenSource())).toEqual([archive]);
        expect(await originalContext.executeTool?.(west, {}, 'revoked')).toMatchObject({
            outcomeStatus: 'rejected', error: { code: 'E_SOURCE_UNAVAILABLE' },
        });

        await caller.mcp.setServerEnabled({ name: 'west-archive', enabled: false });
        expect(await driverToolNames(new McpDrivenSource())).toEqual([]);
        expect(await scoped.executeTool?.(archive, {}, 'stale')).toMatchObject({ outcomeStatus: 'rejected' });
        expect(buildMcpServerItemKey('west')).toBe('server:west');

        await caller.mcp.updateConfig({ mcp: { replacement: localServer('replacement') } });
        expect((await caller.mcp.getConfig()).issues).toEqual([]);
        expect(JSON.parse(await readFile(file, 'utf8')).mcpServers).toEqual({ 'old-shape': localServer('old-shape') });
        const current = await new McpDrivenSource().getContext();
        expect((await current.executeTool?.(replacement, {}, 'new'))?.result).toContain('replacement');
        expect(await originalContext.executeTool?.(west, {}, 'old')).toMatchObject({ outcomeStatus: 'rejected' });
        expect(await driverToolNames(agentSource)).toEqual([]);
    } finally {
        await Promise.all(['west', 'west-archive', 'replacement', 'old-shape'].map(name => MCP.disconnect(name)));
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);
