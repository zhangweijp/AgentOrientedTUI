import type { AppID, DesktopID } from './identity.js';

/** Identity of an App instance during lifecycle callbacks. */
export interface AppContext {
    readonly desktopId: DesktopID;
    readonly appId: AppID;
}
