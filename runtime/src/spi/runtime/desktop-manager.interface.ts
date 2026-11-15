import type { DesktopID } from '../core/types.js';
import type { IDesktop } from './kernel.interface.js';
import type { IRuntimeContext } from './context.interface.js';
import type { DesktopCloseOptions, DesktopCloseHandle, RuntimeCloseHandle } from './close.interface.js';

/** The actual Desktop services consumed by Kernel. */
export interface IDesktopManager {
    create(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID>;
    get(desktopId: DesktopID): IDesktop | undefined;
    listDesktopIds(): DesktopID[];
    beginShutdown(): RuntimeCloseHandle;
    beginDesktopShutdown(id: DesktopID, options?: DesktopCloseOptions): DesktopCloseHandle;
}
