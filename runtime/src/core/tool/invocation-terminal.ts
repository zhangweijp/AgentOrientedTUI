import type { OperationResult } from '../../spi/core/operations.js';
export type ViewToolInvocationTerminal =
    | { phase: 'not-entered'; result: OperationResult }
    | { phase: 'entered-returned'; result: OperationResult; failureEffects?: 'none' | 'partial' };
export type SafeRefInvoker = (effectiveArgs: Readonly<Record<string, unknown>>) => Promise<ViewToolInvocationTerminal>;
export type SafeOrdinaryInvoker = SafeRefInvoker;
