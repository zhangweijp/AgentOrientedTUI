import type { ToolResultData } from './tool-result.js';

export type ViewToolInvocationTerminal =
    | { phase: 'not-entered'; result: ToolResultData }
    | { phase: 'entered-returned'; result: ToolResultData };
