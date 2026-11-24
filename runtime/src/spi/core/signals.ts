/**
 * SPI Layer - Signal Types
 * 
 * 定义 Runtime 发出的信号类型。
 */

import type { AppID, DesktopID } from '@aotui/core';

/**
 * 更新信号
 * 
 * 当 Desktop 状态发生变化时发出。
 */
export interface UpdateSignal {
    readonly desktopId: DesktopID;
    readonly appId: AppID;
    readonly instanceId: string;
    readonly timestamp: number;
    readonly reason: 'view_updated' | 'projection_failed' | 'projection_recovered' | 'app_opened' | 'app_closed' | 'attention_requested';
}
