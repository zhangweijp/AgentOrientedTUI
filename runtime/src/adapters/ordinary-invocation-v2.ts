import { copyJson } from '../core/snapshot/json.js';
import { compileOrdinaryProfile } from '../core/tool/ordinary-parameter-profile.js';
import {
  captureInvocationJson,
  captureInvocationTerminal,
  exact,
  invocationObject,
  invocationTarget,
  text,
} from './view-tool-invocation-v1.js';
import type {
  ViewToolInvokeOrdinaryV2Message,
  ViewToolInvokeOrdinaryV2Response,
  ViewToolInvocationTerminal,
} from '../spi/worker-protocol/messages.js';

export const ORDINARY_V2_MODE = 'ordinary-v2';
export const ORDINARY_V2_CAPABILITY = 'view-tool-ordinary-invoke/v2';
export function captureOrdinaryV2Request(input: unknown): ViewToolInvokeOrdinaryV2Message {
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
    value.type !== 'VIEW_TOOL_INVOKE_ORDINARY_V2' ||
    value.argumentMode !== ORDINARY_V2_MODE ||
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
    !invocationObject(value.args) ||
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
  captureInvocationJson(value.args, { maxDepth: 24, maxNodes: 10_000,
    maxApproxBytes: 128 * 1024, maxCanonicalBytes: 128 * 1024 });
  return value as unknown as ViewToolInvokeOrdinaryV2Message;
}
export function validOrdinaryV2Arguments(message: ViewToolInvokeOrdinaryV2Message): boolean {
  const contract = compileOrdinaryProfile(message.tool.inputSchema);
  return contract !== null && contract.validate(message.args).ok;
}
export function captureOrdinaryV2Terminal(
  input: unknown,
  expected: Readonly<{ requestId: string; appId: string; instanceId: string }>
) {
  return captureInvocationTerminal(
    input,
    expected,
    'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE',
    ORDINARY_V2_MODE
  );
}
export function ordinaryV2Response(
  input: unknown,
  terminal: ViewToolInvocationTerminal
): ViewToolInvokeOrdinaryV2Response | null {
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
      type: 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE',
      argumentMode: ORDINARY_V2_MODE,
      success: true,
      terminal,
    });
    return captureOrdinaryV2Terminal(
      response,
      header as { requestId: string; appId: string; instanceId: string }
    )
      ? (response as unknown as ViewToolInvokeOrdinaryV2Response)
      : null;
  } catch {
    return null;
  }
}
