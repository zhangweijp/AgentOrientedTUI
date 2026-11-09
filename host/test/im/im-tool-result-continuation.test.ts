import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { format } from 'node:util';
import { HostManagerV2 } from '../../src/core/host-manager-v2.js';
import { IMSessionManager } from '../../src/im/im-session-manager.js';
import { IMDrivenSource } from '../../src/im/im-driven-source.js';
import { McpDrivenSource } from '../../src/mcp/source.js';
import { AgentDriverV2, jsonSchema, type DrivenSourceContext, type MessageWithTimestamp, type ToolResult } from '@aotui/agent-driver-v2';
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js';
import type { ModelRegistry } from '../../src/services/model-registry.js';

type Message = Parameters<LLMClient['call']>[0][number];
const fixture = vi.hoisted(() => ({
  history: new Map<string, MessageWithTimestamp[]>(),
  quietTools: {} as DrivenSourceContext['tools'],
  quietHandlers: new Map<string, (args: unknown, id: string) => Promise<ToolResult>>(),
  mcpTools: {} as Record<string, unknown>,
  events: [] as Array<Record<string, unknown>>,
  models: [] as Array<{ at: number; messages: Message[]; toolNames: string[] }>,
  toolMessages: [] as Message[],
  diagnostics: [] as Array<{ level: string; text: string }>,
  quietExecutions: 0, mcpExecutions: 0, captures: 0,
  released: [] as number[],
}));
const record = (kind: string, data: Record<string, unknown> = {}) => {
  fixture.events.push({ at: Date.now(), kind, ...structuredClone(data) });
};

// Replace external storage/configuration/resources; retain the IM and MCP Sources,
// session manager, current compiled Driver, and Host callbacks.
vi.mock('../../src/core/message-service-v2.js', () => ({
  MessageServiceV2: class { getMessages() { return []; } },
}));
vi.mock('../../src/core/llm-config-service.js', () => ({
  LLMConfigService: class {
    async getActiveLLMConfig() { return { model: 'openai:controlled-im-receipt', apiKey: 'unused-no-network' }; }
  },
}));
vi.mock('../../src/core/session-manager-v3.js', () => ({
  SessionManagerV3: class { on() {} async cleanup() {} },
}));
vi.mock('../../src/config/config.js', () => ({
  Config: { get: async () => ({
    agents: { list: [{ id: 'probe-agent', prompt: 'Controlled IM receipt probe.', enabledApps: ['probe-app'], enabledMCPs: ['probe-server'] }] },
    mcp: { 'probe-server': {} },
    experimental: { contextCompaction: { enabled: false } },
  }) },
}));
vi.mock('../../src/im/message-store.js', () => ({
  listIMMessages: (key: string) => structuredClone(fixture.history.get(key) ?? []),
  appendIMMessage: (key: string, message: MessageWithTimestamp) => {
    record('append-store-call', { key, message });
    fixture.history.set(key, [...(fixture.history.get(key) ?? []), structuredClone(message)]);
  },
  replaceIMMessages: (key: string, messages: MessageWithTimestamp[]) => {
    record('replace-store-call', { key, messages });
    fixture.history.set(key, structuredClone(messages));
  },
}));
vi.mock('../../src/im/session-store.js', () => ({
  upsertIMSession: () => {}, deleteIMSession: () => {}, getIMSession: () => null, listIMSessions: () => [],
}));
vi.mock('../../src/skills/skill-driven-source.js', () => ({
  SkillDrivenSource: class {
    name = 'controlled-empty-skill';
    setEnabled() {} setSkillEnabled() {}
    onUpdate() { return () => {}; }
    async getContext() { return { messages: [], tools: {} }; }
  },
}));
vi.mock('../../src/mcp/index.js', () => ({ MCP: { tools: async () => fixture.mcpTools } }));
vi.mock('@aotui/agent-driver-adapter', () => ({
  SemanticAOTUIDrivenSource: class {
    name = 'controlled-aotui';
    enabled = true;
    setEnabled(enabled: boolean) { this.enabled = enabled; }
    setAppEnabled() {}
    onUpdate() { return () => {}; }
    async getContext(): Promise<DrivenSourceContext> {
      const capture = ++fixture.captures;
      record('context-capture', { capture });
      return {
        messages: [], tools: this.enabled ? { ...fixture.quietTools } : {},
        executeTool: async (name: string, args: unknown, id: string) => {
          const handler = fixture.quietHandlers.get(name);
          if (!handler) return undefined;
          fixture.quietExecutions++;
          record('quiet-handler-enter', { name, args, id });
          try {
            const result = await handler(args, id);
            record('quiet-handler-return', { result });
            return result;
          } finally {
            record('quiet-handler-settled', { name, id });
          }
        },
        release: () => { fixture.released.push(capture); record('context-release', { capture }); },
      };
    }
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const scenarios = ['threshold', 'success', 'failed', 'unknown', 'accepted', 'multi',
  'mcp-same-window', 'pending-mix', 'stop', 'disable'] as const;
const results: Array<Record<string, unknown>> = [];
const diagnostics: Array<Record<string, unknown>> = [];
beforeEach(() => {
  fixture.history.clear(); fixture.quietHandlers.clear();
  fixture.quietTools = {}; fixture.mcpTools = {};
  fixture.events = []; fixture.models = []; fixture.toolMessages = []; fixture.diagnostics = [];
  fixture.quietExecutions = 0; fixture.mcpExecutions = 0; fixture.captures = 0; fixture.released = [];
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      fixture.diagnostics.push({ level, text: format(...args) });
    });
  }
});
afterAll(() => {
  // Optional complete evidence export; ordinary test runs need no output path.
  const file = process.env.AOTUI_B07_RESULT_FILE;
  if (!file) return;
  writeFileSync(file, JSON.stringify({ records: results }, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(file + '.diagnostics.json', JSON.stringify(diagnostics, null, 2) + '\n', { flag: 'wx' });
});

describe('IM tool receipts continue through the real Host and Driver', () => {
  it.each(scenarios)('%s', async scenario => {
    const gate = deferred(), entered = deferred();
    let driver: AgentDriverV2 | undefined;
    let host: HostManagerV2 | undefined;
    let offGui: (() => void) | undefined, offIM: (() => void) | undefined, offMcp: (() => void) | undefined;
    let pendingBeforeReceipt: boolean | undefined;
    let quietWindowStartedAt: number | undefined;
    let testPassed = false;
    let failure: string | undefined;
    const noNetwork = vi.fn(async () => { throw new Error('Real network forbidden by IM receipt regression'); });
    vi.stubGlobal('fetch', noNetwork);
    const schema = jsonSchema({ type: 'object', properties: {}, additionalProperties: false });
    const quietNames = scenario === 'multi' ? ['quiet_a', 'quiet_b']
      : ['mcp-same-window', 'pending-mix', 'stop'].includes(scenario) ? ['quiet_b']
      : scenario === 'threshold' ? [] : ['quiet_a'];
    for (const name of quietNames) {
      fixture.quietTools[name] = { description: 'Controlled tool with no Source update', inputSchema: schema };
      fixture.quietHandlers.set(name, async (_args, id) => {
        if (scenario === 'pending-mix' || scenario === 'stop' || (scenario === 'multi' && name === 'quiet_a')) {
          entered.resolve();
          await gate.promise;
        }
        if (scenario === 'disable') {
          if (!driver) throw new Error('Driver missing');
          driver.setSourceEnabled('mcp-driven-source', false);
          record('disable-mcp');
        }
        if (scenario === 'unknown') throw new Error('controlled effect may have happened');
        if (scenario === 'failed') return { toolName: name, toolCallId: id, outcomeStatus: 'failed', error: { code: 'CONTROLLED_FAILURE', message: 'Controlled read failure' } };
        if (scenario === 'accepted') return { toolName: name, toolCallId: id, outcomeStatus: 'accepted', result: { job: 'controlled-job', state: 'pending' } };
        return { toolName: name, toolCallId: id, outcomeStatus: 'succeeded', result: { value: name + '-result' } };
      });
    }
    if (['mcp-same-window', 'pending-mix', 'disable'].includes(scenario)) {
      fixture.mcpTools = {
        mcp_read: {
          description: 'Actual McpDrivenSource controlled tool', inputSchema: schema,
          execute: async () => { fixture.mcpExecutions++; record('mcp-handler'); return 'mcp-result'; },
        },
      };
    }
    const toolNames = scenario === 'threshold' ? ['context_compact']
      : ['mcp-same-window', 'pending-mix'].includes(scenario) ? ['mcp_read', 'quiet_b']
      : scenario === 'disable' ? ['quiet_a', 'mcp_read'] : quietNames;
    const calls = toolNames.map((name, i) => ({
      toolName: name, toolCallId: 'call-' + (i + 1),
      args: name === 'context_compact' ? { summary: 'Continue the task after this receipt.', minMessages: 20, keepRecentMessages: 2 } : {},
    }));
    const assistantCall: Message = { role: 'assistant', content: calls.map(call => ({
      type: 'tool-call' as const, toolName: call.toolName, toolCallId: call.toolCallId, input: call.args,
    })) };
    const finalAssistant: Message = { role: 'assistant', content: 'Observed the receipt.' };
    const callModel = vi.spyOn(LLMClient.prototype, 'call').mockImplementation(async (messages, tools) => {
      fixture.models.push({ at: Date.now(), messages: structuredClone(messages), toolNames: Object.keys(tools).sort() });
      record('model-call', { number: fixture.models.length });
      if (fixture.models.length > 4) throw new Error('Unexpected assistant self-wake');
      if (fixture.models.length === 1) return { text: '', toolCalls: calls, assistantMessage: assistantCall, finishReason: 'tool-calls' };
      return { text: 'Observed the receipt.', toolCalls: [], assistantMessage: finalAssistant, finishReason: 'stop' };
    });
    try {
      host = new HostManagerV2('unused-desktop-topic', {} as ModelRegistry);
      const desktop = { id: 'probe-desktop' };
      const kernel = { getDesktop: () => desktop };
      const desktops = { createDesktop: async () => ({ desktopId: desktop.id }), deleteDesktop: async () => {}, getAppsConfig: async () => ({ 'probe-app': {} }) };
      type Init = Parameters<HostManagerV2['initAgentDriver']>;
      await host.initAgentDriver(desktop as Init[0], kernel as unknown as Init[1], desktops as unknown as Init[2]);
      const sessionKey = 'agent:probe-agent:controlled:direct:probe-peer';
      await host.sendIMMessage({
        sessionKey, agentId: 'probe-agent', channel: 'controlled', chatType: 'direct', peerId: 'probe-peer',
        body: 'Execute the controlled tool and observe its receipt.', messageId: 'incoming-1', senderId: 'probe-peer',
        chatId: 'probe-chat', timestamp: 9_990, triggerAgent: false,
      });
      const sessions = host['imSessionManager'];
      if (!(sessions instanceof IMSessionManager)) throw new Error('Expected real IMSessionManager');
      const session = sessions.getSession(sessionKey);
      if (!session || !(session.agentDriver instanceof AgentDriverV2) || !(session.source instanceof IMDrivenSource)) {
        throw new Error('Expected real current Driver and IM Source instances');
      }
      driver = session.agentDriver;
      const source = session.source;
      const sources: readonly unknown[] = driver['sources'];
      const actualMcp = sources.find(item => item instanceof McpDrivenSource);
      if (!(actualMcp instanceof McpDrivenSource)) throw new Error('Expected real MCP Source');
      offMcp = actualMcp.onUpdate(() => record('mcp-source-update'));
      offIM = source.onUpdate(() => record('im-source-update'));
      const executeIM = vi.spyOn(source as unknown as { executeCompaction: NonNullable<DrivenSourceContext['executeTool']> }, 'executeCompaction');
      offGui = host.onGuiUpdate(event => {
        if (event.type === 'tool') {
          fixture.toolMessages.push(structuredClone(event.message as Message));
          record('gui-tool-receipt', { message: event.message });
        } else if (event.type === 'assistant') {
          record('gui-assistant', { message: event.message });
        }
      });

      // The only explicit trigger starts round one. Production owns continuation.
      await driver.trigger();
      const firstRun = driver['runInFlight'];
      expect(firstRun).not.toBeNull();
      if (scenario === 'pending-mix') {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(300);
        expect(driver.hasPendingUpdate()).toBe(true);
        expect(fixture.models).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(50);
        pendingBeforeReceipt = driver.hasPendingUpdate();
        expect(pendingBeforeReceipt).toBe(true);
        record('pending-before-receipt', { pending: pendingBeforeReceipt });
        gate.resolve();
      } else if (scenario === 'stop' || scenario === 'multi') {
        await entered.promise;
        expect(fixture.events.filter(event => event.kind === 'quiet-handler-enter').map(event => event.name))
          .toEqual([scenario === 'multi' ? 'quiet_a' : 'quiet_b']);
        expect(fixture.toolMessages).toHaveLength(0);
        if (scenario === 'stop') { driver.stop(); record('stop-during-handler'); }
        gate.resolve();
      }
      await firstRun;
      record('after-first-drain', { models: fixture.models.length, pending: driver.hasPendingUpdate() });
      if (scenario !== 'pending-mix') await vi.advanceTimersByTimeAsync(300);
      await driver['runInFlight'];
      const expectedModels = scenario === 'stop' ? 1 : 2;
      expect(fixture.models, 'The model must observe the receipt without a test notification').toHaveLength(expectedModels);
      expect(driver['runInFlight']).toBeNull();
      if (scenario !== 'stop') {
        expect(fixture.events.filter(event => event.kind === 'gui-assistant').at(-1)?.message).toEqual(finalAssistant);
      }

      // In particular the pending case has already completed its second assistant
      // and all work before this full quiet window can expose an extra timer.
      quietWindowStartedAt = Date.now();
      record('quiet-window-start', { models: fixture.models.length, workSettled: true });
      await vi.advanceTimersByTimeAsync(600);
      await driver['runInFlight'];
      record('quiet-window-end', { models: fixture.models.length });
      expect(fixture.models).toHaveLength(expectedModels);
      expect(callModel).toHaveBeenCalledTimes(expectedModels);
      expect(noNetwork).not.toHaveBeenCalled();
      expect(fixture.toolMessages).toHaveLength(1);
      const receipt = fixture.toolMessages[0];
      if (receipt.role !== 'tool') throw new Error('Expected tool receipt');
      expect(receipt.content).toHaveLength(toolNames.length);
      expect(receipt.content.map(part => 'toolCallId' in part ? part.toolCallId : undefined)).toEqual(calls.map(call => call.toolCallId));
      expect(receipt.content.map(part => 'toolName' in part ? part.toolName : undefined)).toEqual(toolNames);
      if (expectedModels === 2) {
        expect(fixture.models[1].messages.find(message => message.role === 'tool')?.content).toEqual(receipt.content);
        const modelCall = fixture.models[1].messages.find(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(part => part.type === 'tool-call'));
        expect(modelCall?.content).toEqual(assistantCall.content);
      }
      if (scenario === 'pending-mix') {
        expect(fixture.events.filter(event => event.kind === 'im-source-update')).toHaveLength(0);
      }
      if (scenario === 'threshold') {
        expect(executeIM).toHaveBeenCalledExactlyOnceWith('context_compact', calls[0].args, 'call-1');
        expect(receipt).toMatchObject({ content: [{ output: { type: 'json', value: { success: false, note: expect.stringContaining('did not meet minMessages threshold') } } }] });
      }
      if (scenario === 'unknown') expect(receipt).toMatchObject({ content: [{ output: { type: 'error-json', value: {
        code: 'E_EXECUTION_ERROR', retryable: false, message: expect.stringContaining('The Tool call may have had effects. Check the application View before retrying.'),
      } } }] });
      if (scenario === 'accepted') expect(receipt).toMatchObject({ content: [{ output: { type: 'error-json', value: {
        code: 'TOOL_RESULT_UNCONFIRMED', retryable: false, result: { job: 'controlled-job', state: 'pending' },
        message: expect.stringContaining('The Tool call may have had effects. Check the application View before retrying.'),
      } } }] });
      if (scenario === 'failed') expect(receipt).toMatchObject({ content: [{ output: { type: 'error-json', value: { code: 'CONTROLLED_FAILURE', message: 'Controlled read failure' } } }] });
      if (scenario === 'success' || scenario === 'multi') {
        expect(receipt.content).toEqual(quietNames.map((name, i) => ({
          type: 'tool-result', toolCallId: calls[i].toolCallId, toolName: name,
          output: { type: 'json', value: { value: name + '-result' } },
        })));
      }
      expect(fixture.quietExecutions).toBe(scenario === 'threshold' ? 0 : scenario === 'multi' ? 2 : 1);
      expect(fixture.mcpExecutions).toBe(['mcp-same-window', 'pending-mix'].includes(scenario) ? 1 : 0);
      if (scenario === 'disable') {
        expect(receipt).toMatchObject({ content: [{ toolName: 'quiet_a' }, { toolName: 'mcp_read', output: { value: { code: 'E_SOURCE_UNAVAILABLE' } } }] });
        expect(fixture.models[1].toolNames).not.toContain('mcp_read');
      }
      expect(fixture.captures).toBe(expectedModels);
      expect(fixture.released).toEqual(Array.from({ length: expectedModels }, (_, i) => i + 1));
      testPassed = true;
    } catch (error) {
      failure = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally {
      gate.resolve();
      if (driver) { driver.stop(); await driver['runInFlight']; driver.dispose(); }
      offGui?.(); offIM?.(); offMcp?.();
      await host?.dispose();
      await vi.runOnlyPendingTimersAsync();
      results.push({
        scenario, testPassed, failure, pendingBeforeReceipt, quietWindowStartedAt,
        modelCalls: fixture.models.length, quietExecutions: fixture.quietExecutions, mcpExecutions: fixture.mcpExecutions,
        imNotifications: fixture.events.filter(event => event.kind === 'im-source-update').length,
        sourceNotifications: fixture.events.filter(event => event.kind === 'mcp-source-update').length,
        captures: fixture.captures, released: [...fixture.released], networkCalls: noNetwork.mock.calls.length,
        models: structuredClone(fixture.models), toolMessages: structuredClone(fixture.toolMessages),
        history: structuredClone([...fixture.history]), events: structuredClone(fixture.events),
      });
      diagnostics.push({ scenario, failure, console: fixture.diagnostics });
      vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
    }
  });
});
