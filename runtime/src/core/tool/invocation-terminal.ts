export const ORDINARY_INVOCATION_MODE = 'ordinary-v2' as const;
import type { ToolResultData } from '../../spi/core/tool-result.js';
export type ViewToolInvocationTerminal =
    | { phase: 'not-entered'; result: ToolResultData }
    | { phase: 'entered-returned'; result: ToolResultData; failureEffects?: 'none' | 'partial' };
export type SafeOrdinaryInvoker = (effectiveArgs: Readonly<Record<string, unknown>>) => Promise<ViewToolInvocationTerminal>;
