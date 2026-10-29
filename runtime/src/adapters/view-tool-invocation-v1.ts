import { canonicalJson, copyJson, utf8Size, type JsonCopyLimits } from '../core/snapshot/json.js';
import type { JsonValue } from '../core/snapshot/types.js';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';
export const VIEW_TOOL_V1_MESSAGE_LIMITS = Object.freeze({
  maxDepth: 50,
  maxNodes: 32_000,
  maxApproxBytes: 512 * 1024,
  maxCanonicalBytes: 512 * 1024,
});
type JsonObject = Readonly<Record<string, JsonValue>>;
export function invocationObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exact(value: JsonObject, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
export function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
export function captureInvocationJson(
  input: unknown,
  limits: JsonCopyLimits & { readonly maxCanonicalBytes: number } = VIEW_TOOL_V1_MESSAGE_LIMITS
): JsonValue {
  const value = copyJson(input, limits);
  if (utf8Size(canonicalJson(value)) > limits.maxCanonicalBytes)
    throw new RangeError('Ref message exceeds budget');
  return value;
}

export function invocationTarget(value: JsonValue | undefined): boolean {
  return (
    invocationObject(value) &&
    exact(value, ['viewId', 'viewInstanceId', 'bindingVersion']) &&
    text(value.viewId) &&
    text(value.viewInstanceId) &&
    Number.isSafeInteger(value.bindingVersion) &&
    (value.bindingVersion as number) > 0
  );
}

export function captureInvocationTerminal(
  input: unknown,
  expected: Readonly<{
    requestId: string;
    appId: string;
    instanceId: string;
  }>,
  responseType: string,
  mode: string
): ViewToolInvocationTerminal | null {
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
      value.type !== responseType ||
      value.requestId !== expected.requestId ||
      value.appId !== expected.appId ||
      value.instanceId !== expected.instanceId ||
      value.argumentMode !== mode ||
      value.success !== true ||
      !invocationObject(value.terminal) ||
      !exact(value.terminal, ['phase', 'result', ...(Object.hasOwn(value.terminal, 'failureEffects') ? ['failureEffects'] : [])])
    )
      return null;
    const { phase, result, failureEffects } = value.terminal;
    if (
      !['not-entered', 'entered-returned'].includes(phase as string) ||
      !invocationObject(result) ||
      typeof result.success !== 'boolean' ||
      Object.keys(result).some((k) => !['success', 'data', 'error'].includes(k)) ||
      (phase === 'not-entered' && result.success !== false) ||
      (Object.hasOwn(value.terminal, 'failureEffects') &&
        (phase !== 'entered-returned' || result.success !== false || failureEffects !== 'none' && failureEffects !== 'partial')) ||
      (Object.hasOwn(result, 'data') && !invocationObject(result.data)) ||
      (Object.hasOwn(result, 'error') &&
        (!invocationObject(result.error) ||
          !text(result.error.code) ||
          typeof result.error.message !== 'string' ||
          Object.keys(result.error).some((k) => !['code', 'message', 'context'].includes(k)) ||
          (Object.hasOwn(result.error, 'context') && !invocationObject(result.error.context))))
    )
      return null;
    return value.terminal as unknown as ViewToolInvocationTerminal;
  } catch {
    return null;
  }
}
