import assert from 'node:assert/strict';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';

export function scriptedProviderReply(calls, complete = true) {
  const delta = calls.length ? { tool_calls: calls.map(([id, name, args], index) => ({
    id, index, type: 'function', function: { name, arguments: JSON.stringify(args) },
  })) } : { content: 'Done' };
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'ref-fixture', model: 'fixture', created: 1,
    choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
  const tail = complete ? chunk({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n' : '';
  return new Response(chunk(delta, null) + tail, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** Exercise the real model serialization, with only HTTP transport scripted. */
export async function runProviderTurn(source, turn, calls, onRequest) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(turn.body, undefined);
    turn.body = init.body;
    await onRequest?.();
    return scriptedProviderReply(calls);
  };
  const finished = Promise.withResolvers();
  const driver = new AgentDriverV2({
    sources: [{ name: 'history', onUpdate: () => () => {}, getContext: () => ({
      messages: [{ role: 'user', content: 'Select visible items.', timestamp: 2 }], tools: {},
    }) }, { name: source.name, onUpdate: () => () => {}, async getContext() {
      const context = await source.getContext();
      return { ...context, async release() { await context.release(); finished.resolve(); },
        async executeTool(...args) {
          const result = await context.executeTool(...args);
          turn.toolResults.push(result);
          return result;
        } };
    } }],
    llm: { model: 'fixture', provider: { id: 'ref-test', baseURL: 'https://fixture.invalid/v1' }, apiKey: 'fixture',
      inputBudget: () => ({ contextWindow: turn.window, maxOutputTokens: 256 }) },
    onRunError(error) { turn.error = { code: error.code, message: error.message, details: error.details }; },
  });
  const timer = setTimeout(() => finished.reject(new Error('Context was not released for ' + turn.label)), 10000);
  try { await Promise.all([driver.trigger(), finished.promise]); }
  finally { clearTimeout(timer); driver.stop(); driver.dispose(); globalThis.fetch = originalFetch; }
}
