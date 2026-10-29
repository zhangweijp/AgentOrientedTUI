import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createAiSdkTools, createAotuiMcpServer } from '../src/adapters.js';
import { createSession, defineAction } from '../src/kernel.js';
import { openTaskView, TaskRepository } from '../src/task-app.js';
import type { ActionResult, Observation, Session } from '../src/contracts.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

function fixture(outcome?: ActionResult) {
  const session = createSession();
  disposers.push(() => session.close());
  const repository = new TaskRepository([{ id: 'a', title: 'First task' }, { id: 'b', title: 'Second task' }]);
  const action = outcome && defineAction({
    name: 'test_outcome', description: 'Return a business outcome.',
    input: z.strictObject({}), execute: () => outcome,
  });
  openTaskView(session, repository, 'tasks', action || undefined);
  return { session, repository };
}

function invocation(observation: Observation, invocationId: string) {
  return {
    observationId: observation.id,
    actionBindingId: observation.views[0]!.items[0]!.actions[0]!.bindingId,
    invocationId,
    input: {},
  };
}

async function memoryClient(session: Session) {
  const server = createAotuiMcpServer(session);
  disposers.push(() => server.close());
  const client = new Client({ name: 'aotui-test', version: '0.0.0' });
  disposers.push(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('real SDK adapters without network or a live model', () => {
  it('runs the AI SDK tool loop and preserves the original target and toolCallId', async () => {
    const { session, repository } = fixture();
    const observation = session.observe();
    const request = invocation(observation, 'sdk-call-1');
    const execute = vi.spyOn(session, 'execute');
    const tools = createAiSdkTools(session, observation);
    repository.reorder(['b', 'a']);
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({ doGenerate: [
      {
        content: [{ type: 'tool-call', toolCallId: request.invocationId, toolName: 'aotui_execute',
          input: JSON.stringify({ actionBindingId: request.actionBindingId, input: {} }) }],
        finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
      },
      { content: [{ type: 'text', text: 'Done.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] },
    ] });
    const result = await new ToolLoopAgent({ model, tools }).generate({
      prompt: `Complete the first observed task. Observation: ${JSON.stringify(observation)}`,
    });
    expect(result.text).toBe('Done.');
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(execute.mock.calls[0]![0]).toEqual(request);
    expect(repository.get('a')!.done).toBe(true);
    expect(repository.get('b')!.done).toBe(false);
    expect(repository.writes).toBe(1);
  });

  it('lists, observes and executes through MCP v2 SDK in-memory transports', async () => {
    const { session, repository } = fixture();
    const client = await memoryClient(session);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['aotui_execute', 'aotui_observe']);
    const observed = await client.callTool({ name: 'aotui_observe', arguments: {} });
    const observation = observed.structuredContent as unknown as Observation;
    expect(observation.sessionId).toBe(session.id);
    repository.reorder(['b', 'a']);
    const request = invocation(observation, 'mcp-call-1');
    const result = await client.callTool({ name: 'aotui_execute', arguments: request });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 'succeeded', value: { id: 'a', done: true } });
    expect(repository.get('b')!.done).toBe(false);
    expect((await client.callTool({ name: 'aotui_execute', arguments: request })).structuredContent).toEqual(result.structuredContent);
    expect(repository.writes).toBe(1);
  });

  it('rejects stale observations and observations from a different server session', async () => {
    const { session, repository } = fixture();
    const observation = session.observe();
    const client = await memoryClient(session);
    repository.rename('a', 'Changed elsewhere');
    const stale = await client.callTool({ name: 'aotui_execute', arguments: invocation(observation, 'stale') });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ status: 'rejected', code: 'STALE_RESOURCE' });
    const foreign = fixture();
    const result = await client.callTool({ name: 'aotui_execute', arguments: invocation(foreign.session.observe(), 'foreign') });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'rejected' });
    expect(repository.writes + foreign.repository.writes).toBe(0);
  });

  it.each<ActionResult>([
    { status: 'rejected', code: 'DENIED', message: 'Business refused.' },
    { status: 'failed', code: 'FAILED', message: 'Execution failed.', effects: 'partial' },
    { status: 'unknown', code: 'UNCERTAIN', message: 'Remote effect is unknown.' },
    { status: 'accepted', operationId: 'operation-42' },
  ])('preserves the complete $status result over MCP', async outcome => {
    const { session } = fixture(outcome);
    const client = await memoryClient(session);
    const result = await client.callTool({ name: 'aotui_execute', arguments: invocation(session.observe(), 'outcome') });
    expect(result.structuredContent).toEqual(outcome);
    expect(result.isError).toBe(outcome.status !== 'accepted');
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(outcome) }]);
  });

  it('also crosses the current protocol handler through an in-process fetch transport', async () => {
    const { session, repository } = fixture();
    const handler = createMcpHandler(() => createAotuiMcpServer(session));
    disposers.push(() => handler.close());
    const client = new Client({ name: 'aotui-current-protocol-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    disposers.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL('http://aotui.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const result = await client.callTool({ name: 'aotui_observe', arguments: {} });
    const observation = result.structuredContent as unknown as Observation;
    const completed = await client.callTool({ name: 'aotui_execute', arguments: invocation(observation, 'current-era') });
    expect(completed.structuredContent).toMatchObject({ status: 'succeeded', value: { id: 'a' } });
    expect(repository.get('a')!.done).toBe(true);
    expect(repository.writes).toBe(1);
  });
});
