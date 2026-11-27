import type { ViewIdentity } from '@aotui/core';
import type { ViewRegion } from '@aotui/core';
import type { AppID } from '@aotui/core';

export interface AppWindowTarget {
    readonly appId: AppID;
    readonly instanceId: string;
}

export interface ViewWindowTarget extends AppWindowTarget, ViewIdentity {}

export interface ViewWindow extends ViewIdentity {
    readonly type: string;
    readonly name: string;
    readonly region: ViewRegion;
    readonly canClose: boolean;
}

export interface AppWindows {
    readonly appId: AppID;
    readonly instanceId: string;
    readonly views: readonly ViewWindow[];
}
