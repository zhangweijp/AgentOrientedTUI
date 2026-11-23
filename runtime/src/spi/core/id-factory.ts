import { randomUUID } from 'node:crypto';
import type { DesktopID, AppID } from '@aotui/core';

/** Use the supplied Desktop ID or generate one. */
export function createDesktopId(id?: string): DesktopID {
    return (id ?? `dt_${randomUUID().slice(0, 8)}`) as DesktopID;
}

/** Mark an existing App ID. Registration assigns the actual running ID. */
export function createAppId(id: string): AppID {
    if (typeof id !== 'string') throw new TypeError('App ID must be a string');
    return id as AppID;
}
