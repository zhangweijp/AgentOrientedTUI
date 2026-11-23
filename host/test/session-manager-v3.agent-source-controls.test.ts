import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '@aotui/runtime';
import { Config } from '../src/config/config.js';
import { DesktopManager } from '../src/core/desktop-manager.js';
import { LLMConfigService } from '../src/core/llm-config-service.js';
import { MessageService } from '../src/core/message-service.js';
import { MCP } from '../src/mcp/index.js';
import { ModelRegistry } from '../src/services/model-registry.js';
import { SessionManagerV3 } from '../src/core/session-manager-v3.js';
import * as db from '../src/db/index.js';

// Persisted Topic overrides remain authoritative, even after an Agent template is migrated.
describe('SessionManagerV3 persisted source controls', () => {
  let manager: SessionManagerV3 | null = null;
  afterEach(async () => {
    await manager?.cleanup();
    manager = null;
    vi.restoreAllMocks();
  });

  it('preserves explicit application disables and repairs only a selected item', async () => {
    const controls = {
      apps: { enabled: true, disabledItems: ['system_ide', 'terminal'] },
      mcp: { enabled: false, disabledItems: ['server:playwright'] },
      skill: { enabled: false, disabledItems: ['existing-skill'] },
    };
    vi.spyOn(db, 'getTopic').mockReturnValue({ id: 'topic', sourceControls: controls } as any);
    const persist = vi.spyOn(db, 'updateTopic').mockImplementation(() => {});
    manager = new SessionManagerV3({} as any, {} as any, {} as any, {} as any);
    expect(await manager.getSourceControlState('topic')).toEqual(controls);
    await manager.setSourceItemEnabled('topic', 'apps', 'system_ide', true);
    const expected = { ...controls, apps: { enabled: true, disabledItems: ['terminal'] } };
    expect(await manager.getSourceControlState('topic')).toEqual(expected);
    expect(persist).toHaveBeenCalledWith('topic', { sourceControls: expected, updatedAt: expect.any(Number) });
  });
  it('applies an Agent’s disabled MCP state after reading Topic controls before session creation', async () => {
    const topicId = 'topic_with_legacy_agent';
    vi.spyOn(db, 'getTopic').mockReturnValue({
      id: topicId, title: 'Topic', agentId: 'agent', status: 'hot', createdAt: 1, updatedAt: 1,
    });
    const persist = vi.spyOn(db, 'updateTopic').mockImplementation(() => {});
    vi.spyOn(Config, 'get').mockResolvedValue({
      mcp: { tools: { type: 'local', command: ['fixture-never-executed'] } },
      agents: { list: [{
        id: 'agent', name: 'Agent', prompt: '', modelId: '', enabledApps: [], enabledSkills: {},
        enabledMCPs: ['tools'], disabledMcpTools: ['tools::search'], skin: {},
      }] },
    });
    const catalog = vi.spyOn(MCP, 'tools').mockRejectedValue(new Error('MCP is closed for this Topic'));
    const kernel = createRuntime();
    const llm = new LLMConfigService(new ModelRegistry());
    vi.spyOn(llm, 'resolveLLMConfig').mockResolvedValue({ model: 'synthetic', provider: { id: 'openai' } });
    manager = new SessionManagerV3(kernel, new DesktopManager({ kernel }), llm, new MessageService());

    expect((await manager.getSourceControlState(topicId)).mcp).toEqual({ enabled: false, allowedServers: ['tools'], disabledItems: ['tools::search'] });
    await manager.ensureSession(topicId);
    expect((await manager.getSourceControlState(topicId)).mcp).toEqual({ enabled: false, allowedServers: ['tools'], disabledItems: ['tools::search'] });
    const source = manager.getSession(topicId)?.sources.mcp;
    await expect(source?.getContext()).resolves.toEqual({ messages: [], tools: {} });
    expect(catalog).not.toHaveBeenCalled();

    const sessionManager = manager;
    await expect(sessionManager.setSourceEnabled(topicId, 'mcp', true)).rejects.toThrow('MCP permissions need to be reconfigured');
    expect(persist).not.toHaveBeenCalled();
    await manager.setSourceEnabled(topicId, 'mcp', false);
    expect((await manager.getSourceControlState(topicId)).mcp).toEqual({ enabled: false, allowedServers: ['tools'], disabledItems: [] });
    expect(persist).toHaveBeenCalledWith(topicId, expect.objectContaining({
      sourceControls: expect.objectContaining({ mcp: { enabled: false, allowedServers: ['tools'], disabledItems: [] } }),
    }));
  });

});
