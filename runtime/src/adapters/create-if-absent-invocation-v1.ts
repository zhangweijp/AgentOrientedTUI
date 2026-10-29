import { copyJson } from '../core/snapshot/json.js';
import { parseActionOutcome } from '../core/invocation/invocation-outcome.js';
import type { CreateIfAbsentTerminal } from '../core/tool/create-if-absent-contract.js';
import {
  captureInvocationJson,
  exact,
  invocationObject,
  invocationTarget,
  text,
} from './view-tool-invocation-v1.js';
import type {
  ViewToolInvokeCreateIfAbsentV1Message,
  ViewToolInvokeCreateIfAbsentV1Response,
} from '../spi/worker-protocol/messages.js';

export const CREATE_IF_ABSENT_V1_MODE = 'create-if-absent-v1';
export const CREATE_IF_ABSENT_V1_CAPABILITY = 'view-tool-create-if-absent-invoke/v1';
export function captureCreateIfAbsentV1Request(
  input: unknown
): ViewToolInvokeCreateIfAbsentV1Message {
  const value = captureInvocationJson(input);
  if (
    !invocationObject(value) ||
    !exact(value, [
      'type',
      'requestId',
      'appId',
      'instanceId',
      'snapshotId',
      'tool',
      'target',
      'argumentMode',
      'args',
    ]) ||
    value.type !== 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1' ||
    value.argumentMode !== CREATE_IF_ABSENT_V1_MODE ||
    !['requestId', 'appId', 'instanceId', 'snapshotId'].every((k) => text(value[k])) ||
    !invocationObject(value.tool) ||
    !exact(value.tool, [
      'id',
      'name',
      'viewType',
      'description',
      'inputSchema',
      'isMutating',
      'targets',
    ]) ||
    !['id', 'name', 'viewType', 'description'].every((k) =>
      text((value.tool as Record<string, unknown>)[k])
    ) ||
    typeof value.tool.isMutating !== 'boolean' ||
    !invocationObject(value.tool.inputSchema) ||
    value.tool.inputSchema.type !== 'object' ||
    !Array.isArray(value.tool.targets) ||
    !value.tool.targets.every(invocationTarget) ||
    !invocationTarget(value.target)
  )
    throw new Error('Invalid creation request');
  copyJson(
    {
      name: value.tool.name,
      description: value.tool.description,
      inputSchema: value.tool.inputSchema,
      isMutating: value.tool.isMutating,
    },
    { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 }
  );
  return value as unknown as ViewToolInvokeCreateIfAbsentV1Message;
}
export function captureCreateIfAbsentV1Terminal(
  input: unknown,
  expected: Readonly<{ requestId: string; appId: string; instanceId: string }>
): CreateIfAbsentTerminal | null {
  try {
    const value = captureInvocationJson(input);
    if (
      !invocationObject(value) ||
      !exact(value, [
        'type',
        'requestId',
        'appId',
        'instanceId',
        'argumentMode',
        'success',
        'terminal',
      ]) ||
      value.type !== 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE' ||
      value.argumentMode !== CREATE_IF_ABSENT_V1_MODE ||
      value.requestId !== expected.requestId ||
      value.appId !== expected.appId ||
      value.instanceId !== expected.instanceId ||
      value.success !== true ||
      !invocationObject(value.terminal) ||
      !exact(value.terminal, ['phase', 'outcome'])
    )
      return null;
    const outcome = parseActionOutcome(value.terminal.outcome!);
    if (
      value.terminal.phase === 'not-entered'
        ? outcome.status !== 'rejected'
        : value.terminal.phase !== 'entered-returned' ||
          !['succeeded', 'failed', 'unknown'].includes(outcome.status)
    )
      return null;
    return value.terminal as unknown as CreateIfAbsentTerminal;
  } catch {
    return null;
  }
}
export function createIfAbsentV1Response(
  input: unknown,
  terminal: CreateIfAbsentTerminal
): ViewToolInvokeCreateIfAbsentV1Response | null {
  try {
    if (!invocationObject(input)) return null;
    const header: Record<string, string> = {};
    for (const key of ['requestId', 'appId', 'instanceId']) {
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (!d || !('value' in d) || !text(d.value)) return null;
      header[key] = d.value;
    }
    const response = captureInvocationJson({
      ...header,
      type: 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE',
      argumentMode: CREATE_IF_ABSENT_V1_MODE,
      success: true,
      terminal,
    });
    return captureCreateIfAbsentV1Terminal(
      response,
      header as { requestId: string; appId: string; instanceId: string }
    )
      ? (response as unknown as ViewToolInvokeCreateIfAbsentV1Response)
      : null;
  } catch {
    return null;
  }
}
