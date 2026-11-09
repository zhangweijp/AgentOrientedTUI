/** App identity passed by Runtime when opening an App.
 * Business state belongs to the App; projection and renderer capabilities
 * are supplied through the component RuntimeContext.
 */
import type { DesktopID, AppID } from '../core/types.js';

export interface AppContext {
    readonly desktopId: DesktopID;
    readonly appId: AppID;
}
