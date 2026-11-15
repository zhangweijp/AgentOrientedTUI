import type { ToolResult } from '../core/tool-result.js';

export const VIEW_TYPE_TOOL_PROTOCOL = 'view-type-tools-v5' as const;

/** One shared business contract for an operation on a ViewType. */
export interface AppTypeToolDefinition {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One candidate handler on one View. Functions stay in the App execution environment. */
export interface AppFrameBinding {
    readonly name: string;
    readonly enabled: boolean;
    readonly execute: (args: Readonly<Record<string, unknown>>) => ToolResult | Promise<ToolResult>;
}
