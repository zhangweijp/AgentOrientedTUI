import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { Config } from '../src/config/config.js';

describe('tRPC agents router', () => {
    let caller: ReturnType<typeof appRouter.createCaller>;

    beforeEach(() => {
        caller = appRouter.createCaller({
            hostManager: {} as any,
            llmConfigService: {} as any,
            modelRegistry: {} as any,
            messageService: {} as any,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports legacy MCP permissions so the Agent can be reconfigured', async () => {
        vi.spyOn(Config, 'getGlobal').mockResolvedValue({
            agents: {
                list: [
                    {
                        id: 'agent_1',
                        name: 'Agent 1',
                        prompt: '',
                        modelId: 'openai:gpt-4.1',
                        enabledApps: [],
                        enabledSkills: {},
                        enabledMCPs: ['server-a'],
                        disabledMcpTools: ['server-a::search'],
                        skin: {},
                    },
                ],
                activeAgentId: 'agent_1',
            },
        } as any);

        const result = await caller.agents.getAgents();
        expect(result.list[0]).toMatchObject({
            disabledMcpTools: ['server-a::search'],
            mcpPermissionIssue: expect.stringContaining('Select servers and tools again and save.'),
        });
    });

    it('saveAgents accepts and persists disabledMcpTools', async () => {
        const updateSpy = vi.spyOn(Config, 'updateGlobal').mockResolvedValue(undefined);

        await caller.agents.saveAgents({
            list: [
                {
                    id: 'agent_1',
                    name: 'Agent 1',
                    prompt: '',
                    modelId: 'openai:gpt-4.1',
                    enabledApps: [],
                    enabledSkills: {},
                    enabledMCPs: ['server-a'],
                    disabledMcpTools: ['mcp-server-a-search'],
                    skin: {},
                },
            ],
            activeAgentId: 'agent_1',
        });

        expect(updateSpy).toHaveBeenCalledWith({
            agents: {
                list: [
                    expect.objectContaining({
                        id: 'agent_1',
                        disabledMcpTools: ['mcp-server-a-search'],
                    }),
                ],
                activeAgentId: 'agent_1',
            },
        });
    });
});
