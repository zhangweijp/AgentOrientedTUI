import { copyJson } from '../core/snapshot/json.js';
import { isClosedEmptyOrdinarySchema } from '../core/tool/view-owned-tools.js';
import {
  captureInvocationJson,
  captureInvocationTerminal,
  exact,
  invocationObject,
  invocationTarget,
  text,
} from './view-tool-invocation-v1.js';
import type {
  ViewToolInvokeOrdinaryV1Message,
  ViewToolInvokeOrdinaryV1Response,
  ViewToolInvocationTerminal,
} from '../spi/worker-protocol/messages.js';

export const ORDINARY_V1_MODE = 'ordinary-v1';
export const ORDINARY_V1_CAPABILITY = 'view-tool-ordinary-invoke/v1';
export function captureOrdinaryV1Request(input: unknown): ViewToolInvokeOrdinaryV1Message {
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
    value.type !== 'VIEW_TOOL_INVOKE_ORDINARY_V1' ||
    value.argumentMode !== ORDINARY_V1_MODE ||
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
    throw new Error('Invalid ordinary request');
  copyJson(
    {
      name: value.tool.name,
      description: value.tool.description,
      inputSchema: value.tool.inputSchema,
      isMutating: value.tool.isMutating,
    },
    { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 }
  );
  return value as unknown as ViewToolInvokeOrdinaryV1Message;
}
export function validOrdinaryV1Arguments(message: ViewToolInvokeOrdinaryV1Message): boolean {
  return (
    message.tool.isMutating === false &&
    isClosedEmptyOrdinarySchema(message.tool.inputSchema) &&
    invocationObject(message.args) &&
    Reflect.ownKeys(message.args).length === 0
  );
}
export function captureOrdinaryV1Terminal(
  input: unknown,
  expected: Readonly<{ requestId: string; appId: string; instanceId: string }>
) {
  return captureInvocationTerminal(
    input,
    expected,
    'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE',
    ORDINARY_V1_MODE
  );
}
export function ordinaryV1Response(
  input: unknown,
  terminal: ViewToolInvocationTerminal
): ViewToolInvokeOrdinaryV1Response | null {
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
      type: 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE',
      argumentMode: ORDINARY_V1_MODE,
      success: true,
      terminal,
    });
    return captureOrdinaryV1Terminal(
      response,
      header as { requestId: string; appId: string; instanceId: string }
    )
      ? (response as unknown as ViewToolInvokeOrdinaryV1Response)
      : null;
  } catch {
    return null;
  }
}
