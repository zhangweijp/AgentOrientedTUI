import { VIEW_TYPE_PARAMETERS_MODE, type OrdinaryParameterContract } from '../core/tool/ordinary-parameter-contract.js';
import { canonicalJson } from '../core/snapshot/json.js';
import { SNAPSHOT_VALUE_ARGUMENT_LIMITS, SNAPSHOT_VALUE_ENVELOPE_LIMITS } from '../core/tool/snapshot-value-arguments.js';
import { selectedRefParameters } from '../core/tool/versioned-ref-declarations.js';
import { captureInvocationJson, captureInvocationTerminal, PARAMETERS_V4_CAPABILITY, executionMatchesTool,
  exact, invocationExecution, invocationObject, invocationToolDescriptorV3, text } from './worker-message-capture.js';
import type { ViewToolInvokeV4Message, ViewToolInvokeV4Response, ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';
import type { ToolDescriptorV3, ObservedToolExecutionV3, JsonValue } from '../core/snapshot/types.js';
import type { ToolResultData } from '../spi/core/tool-result.js';

export const PARAMETERS_MODE = VIEW_TYPE_PARAMETERS_MODE;
export { PARAMETERS_V4_CAPABILITY };
export function captureTypeParametersRequest(input: unknown): ViewToolInvokeV4Message {
  const value = captureInvocationJson(input);
  if (!invocationObject(value) || !exact(value, ['type', 'requestId', 'appId', 'instanceId', 'snapshotId', 'tool',
      'argumentMode', 'execution', 'rawArgs', 'effectiveArgs', 'refSources']) || value.type !== 'VIEW_TOOL_INVOKE_V4' ||
      value.argumentMode !== PARAMETERS_MODE || !['requestId', 'appId', 'instanceId', 'snapshotId'].every(k => text(value[k])) ||
      !invocationToolDescriptorV3(value.tool) || !invocationExecution(value.execution) ||
      !invocationObject(value.rawArgs) || !invocationObject(value.effectiveArgs) || !Array.isArray(value.refSources)) throw new Error('Invalid parameter request');
  const tool = value.tool as unknown as ToolDescriptorV3, execution = value.execution as unknown as ObservedToolExecutionV3;
  if (tool.execution.kind !== 'view-type' || execution.kind !== 'view-type' || !executionMatchesTool(tool, execution))
    throw new Error('Invalid ViewType execution identity');
  captureInvocationJson(value.rawArgs, SNAPSHOT_VALUE_ARGUMENT_LIMITS);
  captureInvocationJson(value.effectiveArgs, SNAPSHOT_VALUE_ARGUMENT_LIMITS);
  return value as unknown as ViewToolInvokeV4Message;
}

/** Captured request after full binding verification, using that registration's compiled contract. */
export function validateTypeParameters(message: ViewToolInvokeV4Message, contract: OrdinaryParameterContract | undefined | null): ToolResultData {
  const invalid = (code = 'E_INVALID_ARGS'): ToolResultData => ({ success: false, error: { code, message: 'Parameters or Ref provenance do not match the registered contract' } });
  if (!contract || contract.revision !== PARAMETERS_MODE) return invalid('REF_CONTRACT_UNSUPPORTED');
  try {
    const raw = message.rawArgs, effective = message.effectiveArgs;
    if (!invocationObject(raw) || !invocationObject(effective)) return invalid();
    if (!(contract.validateModelInput ?? contract.validate)(raw).ok || !(contract.validateResolvedInput ?? contract.validate)(effective).ok) return invalid();
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
      toolId: message.tool.id, activationId: message.execution.activationId }, effectiveArgs: effective, refSources: message.refSources }, SNAPSHOT_VALUE_ENVELOPE_LIMITS);
    return { success: true };
  } catch { return invalid('REF_ARGUMENT_BUDGET_EXCEEDED'); }
}
export function captureTypeParametersTerminal(input: unknown, expected: Readonly<{ requestId: string; appId: string; instanceId: string }>) {
  return captureInvocationTerminal(input, expected, 'VIEW_TOOL_INVOKE_V4_RESPONSE', PARAMETERS_MODE);
}
export function typeParametersResponse(input: unknown, terminal: ViewToolInvocationTerminal): ViewToolInvokeV4Response | null {
  try {
    if (!invocationObject(input)) return null;
    const header: Record<string, string> = {};
    for (const key of ['requestId', 'appId', 'instanceId']) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !('value' in field) || !text(field.value)) return null;
      header[key] = field.value;
    }
    const response = captureInvocationJson({ ...header, type: 'VIEW_TOOL_INVOKE_V4_RESPONSE', argumentMode: PARAMETERS_MODE, success: true, terminal });
    return captureTypeParametersTerminal(response, header as { requestId: string; appId: string; instanceId: string }) ? response as unknown as ViewToolInvokeV4Response : null;
  } catch { return null; }
}
