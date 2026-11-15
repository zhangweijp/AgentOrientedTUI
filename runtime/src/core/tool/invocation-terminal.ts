import type { ToolResultData } from '../../spi/core/tool-result.js';

export const ORDINARY_INVOKER_ABI_V3 = 'ordinary-invoker/v3' as const;
export type ViewToolInvocationTerminal =
    | { phase: 'not-entered'; result: ToolResultData }
    | { phase: 'entered-returned'; result: ToolResultData };
export type SafeOrdinaryInvoker = (effectiveArgs: Readonly<Record<string, unknown>>) => Promise<ViewToolInvocationTerminal>;
