import type { OperationResult } from '../../spi/core/operations.js';
import type { CreateIfAbsentTerminal } from './create-if-absent-contract.js';
export type ViewToolInvocationTerminal =
    | { phase: 'not-entered'; result: OperationResult }
    | { phase: 'entered-returned'; result: OperationResult; failureEffects?: 'none' | 'partial' };
export type RefV1Terminal = ViewToolInvocationTerminal;
export type SafeRefInvoker = (effectiveArgs: Readonly<Record<string, unknown>>) => Promise<RefV1Terminal>;
export type SafeOrdinaryInvoker = SafeRefInvoker;
export type SafeCreateIfAbsentInvoker = (args: Readonly<Record<string, unknown>>) => Promise<CreateIfAbsentTerminal>;
