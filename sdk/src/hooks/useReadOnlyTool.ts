import { h, type VNode } from 'preact';
import { useContext, useLayoutEffect, useMemo, useRef } from './preact-hooks.js';
import { ViewRuntimeContext } from '../contexts/view-runtime-context.js';
import { invokeOrdinaryParameterTool } from '../utils/ordinary-parameter-tool.js';
import type { InferArgs, OperationResult } from '../operation/types.js';
import type { UseViewTypeToolResult, TypeToolUI } from './useViewTypeTool.js';

type Common = { readonly required?: boolean; readonly desc?: string; readonly refType?: never; readonly refSource?: never };
type Length = { readonly minLength?: number; readonly maxLength?: number; readonly min?: never; readonly max?: never; readonly pattern?: never };
type Text = Omit<Length, 'pattern'> & { readonly pattern?: string };
type Range = { readonly min?: number; readonly max?: number; readonly minLength?: never; readonly maxLength?: never; readonly pattern?: never };
type PlainObject = Record<string, unknown>;
type Scalar<T extends string, V, C> = { readonly type: T; readonly default?: V; readonly constraints?: C; readonly options?: never; readonly itemType?: never };
type ArrayField<T extends string, V> = { readonly type: 'array'; readonly itemType: T; readonly default?: readonly V[]; readonly constraints?: Length; readonly options?: never };
export type OrdinaryParamDef = Common & (
  Scalar<'string', string, Text> | Scalar<'number', number, Range> |
  Scalar<'boolean', boolean, Record<string, never>> | Scalar<'object', PlainObject, Record<string, never>> |
  { readonly type: 'enum'; readonly options: readonly string[]; readonly default?: string; readonly constraints?: Text; readonly itemType?: never } |
  ArrayField<'string', string> | ArrayField<'number', number> | ArrayField<'boolean', boolean> | ArrayField<'object', PlainObject>
);
export type OrdinaryParams = Record<string, OrdinaryParamDef>;
export type SnapshotValueRefParamDef = {
  readonly type: 'reference'; readonly required: true; readonly refSource: 'snapshot-value-v1';
  readonly refType?: string; readonly desc?: string;
  readonly default?: never; readonly constraints?: never; readonly options?: never; readonly itemType?: never;
};
export type ReadOnlyParams = Record<string, OrdinaryParamDef | SnapshotValueRefParamDef>;
export type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ReadOnlyToolArgs<T extends ReadOnlyParams> = DeepReadonly<InferArgs<T>>;
export interface ReadOnlyToolOptions<T extends ReadOnlyParams> {
  readonly description: string;
  readonly params: T;
  readonly additionalProperties?: boolean;
  readonly enabled?: boolean;
}
export type ReadOnlyToolHandler<T extends ReadOnlyParams> = (args: ReadOnlyToolArgs<T>) => OperationResult | Promise<OperationResult>;
const unavailable = async (): Promise<OperationResult> => ({ success: false, error: {
  code: 'TOOL_EXECUTION_UNAVAILABLE', message: 'This Tool requires its negotiated read-only channel',
} });

export function experimental_useReadOnlyTool<const T extends ReadOnlyParams>(
  name: string, options: ReadOnlyToolOptions<T>, handler: ReadOnlyToolHandler<T>,
): UseViewTypeToolResult {
  const context = useContext(ViewRuntimeContext), port = context?.viewTools;
  if (!port) throw new Error('ORDINARY_PARAMETERS_UNSUPPORTED: Runtime read-only Tool port is required');
  if (!options || typeof options !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(options)))
    throw new Error('Invalid read-only Tool declaration');
  const fields = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' ||
      !['description', 'params', 'additionalProperties', 'enabled'].includes(key) ||
      !fields[key]!.enumerable || !('value' in fields[key]!)) ||
      typeof name !== 'string' || !name.trim() || typeof fields.description?.value !== 'string' ||
      !fields.description.value.trim() || !fields.params || typeof handler !== 'function' ||
      (fields.additionalProperties && typeof fields.additionalProperties.value !== 'boolean') ||
      (fields.enabled && typeof fields.enabled.value !== 'boolean')) throw new Error('Invalid read-only Tool declaration');
  const description = fields.description.value as string, params: unknown = fields.params.value;
  const additionalProperties = (fields.additionalProperties?.value ?? false) as boolean;
  const enabled = (fields.enabled?.value ?? true) as boolean;
  let classification: Readonly<{ kind: 'ordinary' | 'snapshot-value'; fingerprint: string }>;
  if (typeof port.fingerprintReadOnlyParams === 'function') classification = port.fingerprintReadOnlyParams(params, additionalProperties);
  else {
    if (port.fingerprintReadOnlyParams !== undefined) throw new Error('READONLY_PARAMETERS_UNSUPPORTED: Invalid Runtime classification port');
    if (port.safeOrdinaryParametersInvocationSupport !== 'ordinary-v2' || typeof port.fingerprintOrdinaryParams !== 'function')
      throw new Error('ORDINARY_PARAMETERS_UNSUPPORTED: Runtime ordinary-v2 port is required');
    classification = { kind: 'ordinary', fingerprint: port.fingerprintOrdinaryParams(params, additionalProperties) };
  }
  if (!classification || typeof classification.fingerprint !== 'string' ||
      (classification.kind !== 'ordinary' && classification.kind !== 'snapshot-value'))
    throw new Error('READONLY_PARAMETERS_UNSUPPORTED: Invalid Runtime parameter classification');
  if (classification.kind === 'ordinary' && (port.safeOrdinaryParametersInvocationSupport !== 'ordinary-v2' || typeof port.fingerprintOrdinaryParams !== 'function'))
    throw new Error('ORDINARY_PARAMETERS_UNSUPPORTED: Runtime ordinary-v2 port is required');
  if (classification.kind === 'snapshot-value' && port.safeSnapshotValueParametersInvocationSupport !== 'snapshot-value-v2')
    throw new Error('READONLY_PARAMETERS_UNSUPPORTED: Runtime has no matching read-only parameter contract port');
  const key = classification.fingerprint;
  const committedHandler = useRef(handler);
  const registered = useRef<{ name: string; description: string; key: string; release(): void }>();
  useLayoutEffect(() => () => { registered.current?.release(); registered.current = undefined; },
    [port, context.meta.viewId, context.meta.viewGeneration]);
  // Compare with the actual committed fingerprint, including mutations between render and layout.
  useLayoutEffect(() => {
    const previous = registered.current;
    if (!enabled) { previous?.release(); registered.current = undefined; }
    else if (!previous || previous.name !== name || previous.description !== description || previous.key !== key) {
      previous?.release(); registered.current = undefined;
      let capturedKey = key;
      const release = port.registerTool(name, { description, params: params as Record<string, unknown>, isMutating: false, handler: unavailable }, classification.kind === 'snapshot-value' ? {
        safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2', additionalProperties,
        createSafeSnapshotValueParametersInvoker: contract => {
          capturedKey = contract.fingerprint;
          return args => invokeOrdinaryParameterTool({ validate: contract.validateEffective }, args, effective =>
            committedHandler.current(effective as ReadOnlyToolArgs<T>));
        },
      } : {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2', additionalProperties,
        createSafeOrdinaryParametersInvoker: contract => {
          capturedKey = contract.fingerprint;
          return args => invokeOrdinaryParameterTool(contract, args, effective =>
            committedHandler.current(effective as ReadOnlyToolArgs<T>));
        },
      });
      registered.current = { name, description, key: capturedKey, release };
    }
    committedHandler.current = handler;
  });
  const Tool = useMemo<TypeToolUI>(() => ({ children }) => enabled ? h('tool-ref', {
    'view-type': context.meta.viewType, 'tool-name': name, desc: description,
  }, children || name) as VNode : null, [enabled, name, description, context.meta.viewType]);
  return [Tool];
}
