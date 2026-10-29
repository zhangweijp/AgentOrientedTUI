import type { TypeToolDefinition } from '../app/public-types.js';
import type { SafeRefInvoker, SafeOrdinaryInvoker, SafeCreateIfAbsentInvoker } from '../../core/tool/invocation-terminal.js';
export type { SafeRefInvoker, SafeOrdinaryInvoker, SafeCreateIfAbsentInvoker } from '../../core/tool/invocation-terminal.js';
import type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { SnapshotValueParameterContract } from '../../core/tool/snapshot-value-parameter-contract.js';
/** Trusted registration metadata, never part of a Tool Schema or Snapshot. */
export interface RefRegistrationOptions {
    readonly safeRefInvocationMode: 'snapshot-value-v1';
    readonly createSafeRefInvoker?: (committedParams: Readonly<Record<string, unknown>>) => SafeRefInvoker;
}

export interface CreateIfAbsentRegistrationOptions {
    readonly safeCreateIfAbsentInvocationMode:'create-if-absent-v1';
    readonly createSafeCreateIfAbsentInvoker:(committedParams:Readonly<Record<string,unknown>>)=>SafeCreateIfAbsentInvoker;
}
export interface OrdinaryRegistrationOptions {
    readonly safeOrdinaryInvocationMode: 'ordinary-v1';
    readonly createSafeOrdinaryInvoker?: (committedParams: Readonly<Record<string, unknown>>) => SafeOrdinaryInvoker;
}
export interface OrdinaryParametersRegistrationOptions {
    readonly safeOrdinaryParametersInvocationMode: 'ordinary-v2';
    readonly additionalProperties: boolean;
    readonly createSafeOrdinaryParametersInvoker: (contract: OrdinaryParameterContract) => SafeOrdinaryInvoker;
}
export interface SnapshotValueParametersRegistrationOptions {
    readonly safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2';
    readonly additionalProperties: boolean;
    readonly createSafeSnapshotValueParametersInvoker: (contract: SnapshotValueParameterContract) => SafeRefInvoker;
}
export type ViewToolRegistrationOptions = RefRegistrationOptions | OrdinaryRegistrationOptions | CreateIfAbsentRegistrationOptions | OrdinaryParametersRegistrationOptions | SnapshotValueParametersRegistrationOptions;

/** M4 Stage 1 opt-in View-local Tool registration; not an execution authority. */
export interface IViewOwnedToolPort {
    /** Declaration preservation only; never Ref argument execution support. */
    readonly refDeclarationSupport?: 'snapshot-value-v1';
    readonly safeRefInvocationSupport?: 'snapshot-value-v1';
    readonly safeOrdinaryInvocationSupport?: 'ordinary-v1';
    readonly safeOrdinaryParametersInvocationSupport?: 'ordinary-v2';
    readonly safeSnapshotValueParametersInvocationSupport?: 'snapshot-value-v2';
    fingerprintReadOnlyParams?(params: unknown, additionalProperties: boolean): Readonly<{ kind: 'ordinary' | 'snapshot-value'; fingerprint: string }>;
    fingerprintOrdinaryParams?(params: unknown, additionalProperties: boolean): string;
    readonly safeCreateIfAbsentInvocationSupport?: 'create-if-absent-v1';
    mount(viewId: string, viewType: string): string;
    unmount(viewInstanceId: string): void;
    registerTool(viewInstanceId: string, toolName: string, definition: TypeToolDefinition,
        options?: ViewToolRegistrationOptions): () => void;
    /** Read-only canonical contract key; does not register or evaluate getters. */
    fingerprintParams(params: unknown): string;
}
