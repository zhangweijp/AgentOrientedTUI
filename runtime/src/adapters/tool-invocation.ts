import type { ToolParameterContract } from '../core/tool/tool-parameters.js';
import { canonicalJson } from '../core/snapshot/json.js';
import { RAW_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ENVELOPE_LIMITS, TOOL_REQUEST_LIMITS } from '../core/snapshot/snapshot-support.js';
import { selectedRefParameters } from '../core/tool/ref-parameters.js';
import { captureInvocationJson, captureToolInvocationTerminal,
  exact, invocationReceiver, invocationObject, invocationToolDescriptor, text } from './worker-message-capture.js';
import type { ViewToolInvokeMessage, ViewToolInvokeResponse } from '../spi/worker-protocol/messages.js';
import type { JsonValue } from '../core/snapshot/types.js';
import type { ToolResultData } from '../core/tool/tool-result.js';

export function captureToolInvocation(input: unknown): ViewToolInvokeMessage {
  const value = captureInvocationJson(input, TOOL_REQUEST_LIMITS);
  if (!invocationObject(value) || !exact(value, ['type', 'requestId', 'appId', 'instanceId', 'snapshotId', 'tool',
      'receiver', 'rawArgs', 'effectiveArgs', 'refSources']) || value.type !== 'VIEW_TOOL_INVOKE' ||
      !['requestId', 'appId', 'instanceId', 'snapshotId'].every(k => text(value[k])) ||
      !invocationToolDescriptor(value.tool) || !invocationReceiver(value.receiver) ||
      !invocationObject(value.rawArgs) || !invocationObject(value.effectiveArgs) || !Array.isArray(value.refSources)) throw new Error('Invalid Tool invocation');
  captureInvocationJson(value.rawArgs, RAW_TOOL_ARGUMENT_LIMITS);
  captureInvocationJson(value.effectiveArgs, RESOLVED_TOOL_ARGUMENT_LIMITS);
  return value as unknown as ViewToolInvokeMessage;
}

/** Captured request after full binding verification, using that registration's compiled contract. */
export function validateInvocationParameters(message: ViewToolInvokeMessage, contract: ToolParameterContract | undefined | null): ToolResultData {
  const invalid = (code = 'E_INVALID_ARGS'): ToolResultData => ({ success: false, error: { code, message: 'Parameters or Ref provenance do not match the registered contract' } });
  if (!contract) return invalid('REF_CONTRACT_UNSUPPORTED');
  try {
    const raw = message.rawArgs, effective = message.effectiveArgs;
    if (!invocationObject(raw) || !invocationObject(effective) ||
        Object.hasOwn(raw, 'view_id') || Object.hasOwn(effective, 'view_id')) return invalid();
    if (!contract.validateModelInput(raw).ok || !contract.validateResolvedInput(effective).ok) return invalid();
    const fields = contract.schema.properties as Readonly<Record<string, JsonValue>>;
    const slots = selectedRefParameters(fields, raw);
    if (message.refSources.length !== slots.length) return invalid();
    const expected = { ...raw };
    for (let i = 0; i < slots.length; i++) {
      const { param, field, refId } = slots[i]!, source = message.refSources[i];
      if (!invocationObject(source as unknown as JsonValue) || !exact(source as unknown as Readonly<Record<string, JsonValue>>,
          ['param', 'refId', 'kind', 'refType', 'snapshotId', 'viewId', 'viewInstanceId']) ||
          source!.param !== param || !text(source!.refId) || `${source!.viewId}.${source!.refId}` !== refId || source!.kind !== 'snapshot-value' ||
          source!.refType !== (field as Readonly<Record<string, JsonValue>>)['x-aotui-ref-kind'] || source!.snapshotId !== message.snapshotId ||
          !text(source!.viewId) || !text(source!.viewInstanceId)) return invalid();
      expected[param] = effective[param]!;
    }
    if (canonicalJson(expected) !== canonicalJson(effective)) return invalid();
    captureInvocationJson({ source: { appId: message.appId, instanceId: message.instanceId, snapshotId: message.snapshotId,
      toolId: message.tool.id, receiver: message.receiver }, effectiveArgs: effective, refSources: message.refSources }, RESOLVED_TOOL_ENVELOPE_LIMITS);
    return { success: true };
  } catch { return invalid('REF_ARGUMENT_BUDGET_EXCEEDED'); }
}
export function toolInvocationResponse(input: unknown, terminal: ViewToolInvokeResponse['terminal']): ViewToolInvokeResponse | null {
  try {
    if (!invocationObject(input)) return null;
    const header: Record<string, string> = {};
    for (const key of ['requestId', 'appId', 'instanceId']) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !('value' in field) || !text(field.value)) return null;
      header[key] = field.value;
    }
    const response = captureInvocationJson({ ...header, type: 'VIEW_TOOL_INVOKE_RESPONSE', success: true, terminal });
    return captureToolInvocationTerminal(response, header as { requestId: string; appId: string; instanceId: string }) ? response as unknown as ViewToolInvokeResponse : null;
  } catch { return null; }
}
