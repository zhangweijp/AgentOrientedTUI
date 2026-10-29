import { tool, type ToolSet } from 'ai';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ActionResult, Observation, Session } from './contracts.js';

/** One generic tool for this experiment; per-action input schemas remain in the observation. */
export function createAiSdkTools(session: Session, observation: Observation): ToolSet {
  if (observation.sessionId !== session.id) throw new Error('Observation belongs to a different session.');
  const bindingIds = observation.views.flatMap(view =>
    view.items.flatMap(item => item.actions.map(action => action.bindingId)));
  if (!bindingIds.length) return {};
  return {
    aotui_execute: tool({
      description: 'Execute a binding from the supplied observation. Input must match that binding\'s inputSchema.',
      inputSchema: z.strictObject({ actionBindingId: z.enum(bindingIds), input: z.json() }),
      execute: ({ actionBindingId, input }, { toolCallId, abortSignal }) => session.execute({
        observationId: observation.id,
        actionBindingId,
        invocationId: toolCallId,
        input,
      }, abortSignal ? { signal: abortSignal } : undefined),
    }),
  };
}

function toMcpResult(value: Observation | ActionResult): CallToolResult {
  const structuredContent = z.json().parse(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: 'status' in value && ['rejected', 'failed', 'unknown'].includes(value.status),
  };
}

/** A server instance is bound to one session; callers cannot select another session. */
export function createAotuiMcpServer(session: Session): McpServer {
  const server = new McpServer({ name: 'aotui-semantic-kernel', version: '0.0.0' });
  server.registerTool('aotui_observe', {
    description: 'Read the current immutable observation and its available action bindings.',
    inputSchema: z.strictObject({}),
  }, () => toMcpResult(session.observe()));
  server.registerTool('aotui_execute', {
    description: 'Execute against the original observation; preserve rejected, accepted, and unknown outcomes.',
    inputSchema: z.strictObject({
      observationId: z.string().min(1),
      actionBindingId: z.string().min(1),
      invocationId: z.string().min(1),
      input: z.json(),
    }),
  }, async (invocation, context) => toMcpResult(await session.execute(
    invocation,
    context.mcpReq.signal ? { signal: context.mcpReq.signal } : undefined,
  )));
  return server;
}
