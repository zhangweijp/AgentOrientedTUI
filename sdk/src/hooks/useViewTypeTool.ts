/**
 * AOTUI SDK - useViewTypeTool Hook
 *
 * Registers a Tool on the current mounted View instance. Ordinary parameters
 * use ordinary-v2; a single read-only snapshot Ref uses snapshot-value-v2.
 *
 * @module @aotui/sdk/hooks/useViewTypeTool
 */

import { h, type VNode } from 'preact';
import { useContext, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { ViewRuntimeContext } from '../contexts/view-runtime-context.js';
import { invokeOrdinaryParameterTool } from '../utils/ordinary-parameter-tool.js';
import { captureToolTarget, type ToolTarget } from '../utils/tool-target.js';
import type { InferArgs, OperationResult, ParamSchema } from '../operation/types.js';

/** A required, read-only Ref resolved from the current observation's snapshot. */
export type SnapshotValueRefParamDef = Readonly<{
    type: 'reference';
    required: true;
    refSource: 'snapshot-value-v1';
    refType?: string;
    desc?: string;
    default?: never;
    constraints?: never;
    options?: never;
    itemType?: never;
}>;

export type DeepReadonly<T> = T extends readonly (infer Value)[] ? readonly DeepReadonly<Value>[]
    : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

type HasReferenceParameter<T extends ParamSchema> = Extract<T[keyof T], { type: 'reference' }> extends never ? false : true;
type HasBroadParameterKeys<T extends ParamSchema> = string extends keyof T ? true : false;
type ReferenceFieldsAreValid<T extends ParamSchema> = Exclude<
    Extract<T[keyof T], { type: 'reference' }>, SnapshotValueRefParamDef
> extends never ? true : false;

type CommonToolOptions<T extends ParamSchema> = Readonly<{
    target?: ToolTarget;
    isMutating?: boolean;
    additionalProperties?: boolean;
    description: string;
    params: T;
}>;

/** View-local Tool configuration. Ref declarations are explicitly read-only. */
export type TypeToolOptions<T extends ParamSchema = ParamSchema> = CommonToolOptions<T> & (
    HasBroadParameterKeys<T> extends true ? unknown
        : HasReferenceParameter<T> extends true
            ? ReferenceFieldsAreValid<T> extends true ? { readonly isMutating: false } : { readonly params: never }
            : unknown
);

/** Arguments are read-only for explicitly read-only Tools and all Ref Tools. */
export type TypeToolArgs<T extends ParamSchema, Options = unknown> = HasReferenceParameter<T> extends true
    ? DeepReadonly<InferArgs<T>>
    : Options extends { readonly isMutating: false } ? DeepReadonly<InferArgs<T>> : InferArgs<T>;

/** View-local Tool handler result. */
export type TypeToolHandler<T = any> = (args: T) => OperationResult | Promise<OperationResult>;

/** Props passed to the Tool UI renderer. */
export interface TypeToolUIProps { children?: string }

/** Inline `<tool-ref>` renderer returned by the Hook. */
export type TypeToolUI = (props: TypeToolUIProps) => VNode | null;

/** Return shape of `useViewTypeTool`. */
export type UseViewTypeToolResult = [TypeToolUI];

const unavailableHandler = async (): Promise<OperationResult> => ({
    success: false,
    error: { code: 'TOOL_EXECUTION_UNAVAILABLE', message: 'Use the negotiated Tool channel' },
});

/**
 * Register a View-local Tool. The current View instance and optional target
 * selector are captured by the SDK; execution uses the committed V2 contract.
 */
export function useViewTypeTool<const T extends ParamSchema, const Options extends TypeToolOptions<T>>(
    toolName: string,
    options: Options & Readonly<{ params: T }>,
    handler: TypeToolHandler<TypeToolArgs<T, Options>>,
    config?: { enabled?: boolean },
): UseViewTypeToolResult {
    const ctx = useContext(ViewRuntimeContext);
    if (!ctx) throw new Error('[AOTUI SDK] useViewTypeTool must be used within a View');

    const port = ctx.viewTools;
    if (!port) throw new Error('[AOTUI SDK] View-local Tools require a Runtime View-owned Tool port');
    if (typeof toolName !== 'string' || toolName.trim().length === 0 || typeof handler !== 'function') {
        throw new Error('Invalid View-local Tool declaration');
    }

    const optionPrototype = options && typeof options === 'object' ? Object.getPrototypeOf(options) : undefined;
    if (optionPrototype !== Object.prototype && optionPrototype !== null) throw new Error('Invalid View-local Tool declaration');
    const optionFields = Object.getOwnPropertyDescriptors(options);
    const allowedOptions = new Set(['description', 'params', 'isMutating', 'additionalProperties', 'target']);
    for (const key of Reflect.ownKeys(optionFields)) {
        if (typeof key !== 'string' || !allowedOptions.has(key)) throw new Error('Invalid View-local Tool declaration');
        if (!optionFields[key]!.enumerable || !('value' in optionFields[key]!)) {
            throw new Error('Accessors/hidden properties are forbidden');
        }
    }
    const description = optionFields.description?.value;
    const params = optionFields.params?.value as T;
    const isMutating = optionFields.isMutating?.value;
    const additionalProperties = optionFields.additionalProperties?.value ?? false;
    if (typeof description !== 'string' || description.trim().length === 0 || !params || typeof params !== 'object' ||
        typeof isMutating !== 'undefined' && typeof isMutating !== 'boolean' ||
        typeof additionalProperties !== 'boolean') {
        throw new Error('Invalid View-local Tool declaration');
    }

    const configPrototype = config && typeof config === 'object' ? Object.getPrototypeOf(config) : undefined;
    if (config && configPrototype !== Object.prototype && configPrototype !== null) throw new Error('Invalid View-local Tool configuration');
    const configFields = Object.getOwnPropertyDescriptors(config ?? {});
    if (Reflect.ownKeys(configFields).some(key => key !== 'enabled' ||
        !configFields[key as string]!.enumerable || !('value' in configFields[key as string]!))) {
        throw new Error('Invalid View-local Tool configuration');
    }
    const enabled = configFields.enabled?.value ?? true;
    if (typeof enabled !== 'boolean') throw new Error('Invalid View-local Tool configuration');

    const parameterFields = Object.values(Object.getOwnPropertyDescriptors(params));
    const requestsRefDeclaration = parameterFields.some(field => {
        if (!('value' in field)) throw new Error('Accessors/hidden properties are forbidden');
        const value = field.value;
        return value && typeof value === 'object' &&
            (Object.hasOwn(value, 'refSource') || Object.hasOwn(value, 'x-aotui-ref'));
    });
    const hasReferenceParameter = parameterFields.some(field => 'value' in field && field.value &&
        typeof field.value === 'object' && Object.getOwnPropertyDescriptor(field.value, 'type')?.value === 'reference');
    const usesSnapshotValue = requestsRefDeclaration || hasReferenceParameter;

    let invocationKind: 'ordinary' | 'snapshot-value';
    let localParamsKey: string;
    if (usesSnapshotValue) {
        if (!requestsRefDeclaration || port.refDeclarationSupport !== 'snapshot-value-v1') {
            throw new Error('REF_CONTRACT_UNSUPPORTED: Runtime cannot preserve this View-local Ref declaration');
        }
        if (isMutating !== false) throw new Error('REF_DECLARATION_INVALID: Ref declarations require an explicitly read-only Tool');
        if (typeof port.fingerprintReadOnlyParams !== 'function') {
            throw new Error('READONLY_PARAMETERS_UNSUPPORTED: Runtime snapshot-value-v2 classifier is required');
        }
        const classification = port.fingerprintReadOnlyParams(params, additionalProperties);
        if (!classification || typeof classification.fingerprint !== 'string' || classification.kind !== 'snapshot-value') {
            throw new Error('READONLY_PARAMETERS_UNSUPPORTED: Invalid Runtime parameter classification');
        }
        if (port.safeSnapshotValueParametersInvocationSupport !== 'snapshot-value-v2') {
            throw new Error('READONLY_PARAMETERS_UNSUPPORTED: Runtime has no matching read-only parameter contract port');
        }
        invocationKind = 'snapshot-value';
        localParamsKey = classification.fingerprint;
    } else {
        if (port.safeOrdinaryParametersInvocationSupport !== 'ordinary-v2' || typeof port.fingerprintOrdinaryParams !== 'function') {
            throw new Error('ORDINARY_PARAMETERS_UNSUPPORTED: Runtime ordinary-v2 port is required');
        }
        invocationKind = 'ordinary';
        localParamsKey = port.fingerprintOrdinaryParams(params, additionalProperties);
    }

    const target = captureToolTarget(optionFields.target?.value, port.targetSelectorSupport);
    const targetKey = JSON.stringify(target);
    const viewType = ctx.meta.viewType ?? '';
    const committedHandler = useRef(handler);
    const registered = useRef<{
        name: string;
        description: string;
        key: string;
        kind: 'ordinary' | 'snapshot-value';
        targetKey?: string;
        mutating: boolean;
        release(): void;
    }>();

    useLayoutEffect(() => { committedHandler.current = handler; });
    useLayoutEffect(() => () => {
        registered.current?.release();
        registered.current = undefined;
    }, [port, ctx.meta.viewId, ctx.viewGeneration]);
    useLayoutEffect(() => {
        const previous = registered.current;
        const mutating = isMutating ?? true;
        if (!enabled) {
            previous?.release();
            registered.current = undefined;
            return;
        }
        if (previous && previous.name === toolName && previous.description === description &&
            previous.key === localParamsKey && previous.kind === invocationKind &&
            previous.targetKey === targetKey && previous.mutating === mutating) return;

        previous?.release();
        registered.current = undefined;
        let committedKey = localParamsKey;
        const definition = {
            description,
            params,
            isMutating: mutating,
            ...(target ? { target } : {}),
            handler: unavailableHandler,
        };
        const registrationOptions = invocationKind === 'snapshot-value' ? {
            safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' as const,
            additionalProperties,
            createSafeSnapshotValueParametersInvoker: (contract: any) => {
                committedKey = contract.fingerprint;
                return (args: unknown) => invokeOrdinaryParameterTool({ validate: contract.validateEffective }, args,
                    effective => committedHandler.current(effective as TypeToolArgs<T, Options>));
            },
        } : {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2' as const,
            additionalProperties,
            createSafeOrdinaryParametersInvoker: (contract: any) => {
                committedKey = contract.fingerprint;
                return (args: unknown) => invokeOrdinaryParameterTool(contract, args,
                    effective => committedHandler.current(effective as TypeToolArgs<T, Options>));
            },
        };
        const release = port.registerTool(toolName, definition, registrationOptions);
        registered.current = {
            name: toolName,
            description,
            key: committedKey,
            kind: invocationKind,
            targetKey,
            mutating,
            release,
        };
    });

    const Tool = useMemo(() => {
        const UIComponent = ({ children }: TypeToolUIProps): VNode | null => enabled ? h('tool-ref', {
            'view-type': viewType,
            'tool-name': toolName,
            desc: description,
        }, children || toolName) as VNode : null;
        (UIComponent as any).displayName = `TypeToolUI(${viewType}.${toolName})`;
        return UIComponent;
    }, [enabled, viewType, toolName, description]);

    return [Tool];
}
