import type { ViewIdentity } from '@aotui/core';
import type { Issue } from '@aotui/core/internal';
import type { ToolResult } from '@aotui/core';
import type { ViewRegion } from '@aotui/core';
import type { AppID } from '@aotui/core';

export interface ViewWindowTarget extends ViewIdentity {
    readonly appId: AppID;
    readonly instanceId: string;
}

export interface ViewWindow extends ViewIdentity {
    readonly type: string;
    readonly name: string;
    readonly region: ViewRegion;
    /** Present when collapsed, including when the Agent supplied no note. */
    readonly note?: string;
    readonly canClose: boolean;
}

export interface AppWindows {
    readonly appId: AppID;
    readonly instanceId: string;
    /** Changes when the user collapses or expands a Window on this App. */
    readonly revision: number;
    /** Present when the entire App is collapsed. */
    readonly note?: string;
    readonly views: readonly ViewWindow[];
}

export type ViewCloseResult =
    | Readonly<{ status: 'closed' | 'accepted'; result: Extract<ToolResult, { success: true }> }>
    | Readonly<{ status: 'rejected'; issue: Issue; result?: Extract<ToolResult, { success: false }> }>
    | Readonly<{ status: 'unknown'; issue: Issue }>;
