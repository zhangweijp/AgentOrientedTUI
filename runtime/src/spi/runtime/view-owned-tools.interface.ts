import type { OperationResult } from '../core/operations.js';
import type { SafeRefInvoker, SafeOrdinaryInvoker } from '../../core/tool/invocation-terminal.js';
export type { SafeRefInvoker, SafeOrdinaryInvoker } from '../../core/tool/invocation-terminal.js';
import type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { SnapshotValueParameterContract } from '../../core/tool/snapshot-value-parameter-contract.js';
/** Trusted registration metadata, never part of a Tool Schema or Snapshot. */
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
export type ViewToolRegistrationOptions = OrdinaryParametersRegistrationOptions | SnapshotValueParametersRegistrationOptions;

/** A Tool declaration owned by the currently mounted View instance. */
export interface ViewToolDefinition {
    readonly target?: import('../../core/snapshot/types.js').ToolTargetSelector;
    readonly description: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly isMutating?: boolean;
    readonly handler: (args: Record<string, unknown>) => OperationResult | Promise<OperationResult>;
}

/** M4 Stage 1 opt-in View-local Tool registration; not an execution authority. */
export interface IViewOwnedToolPort {
    readonly targetSelectorSupport?: 'argument-v1';
    /** Declaration preservation only; never Ref argument execution support. */
    readonly refDeclarationSupport?: 'snapshot-value-v1';
    readonly safeOrdinaryParametersInvocationSupport?: 'ordinary-v2';
    readonly safeSnapshotValueParametersInvocationSupport?: 'snapshot-value-v2';
    fingerprintReadOnlyParams?(params: unknown, additionalProperties: boolean): Readonly<{ kind: 'ordinary' | 'snapshot-value'; fingerprint: string }>;
    fingerprintOrdinaryParams?(params: unknown, additionalProperties: boolean): string;
    mount(viewId: string, viewType: string): string;
    unmount(viewInstanceId: string): void;
    registerTool(viewInstanceId: string, toolName: string, definition: ViewToolDefinition,
        options: ViewToolRegistrationOptions): () => void;
}
