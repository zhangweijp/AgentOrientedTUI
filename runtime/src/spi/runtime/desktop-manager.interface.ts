import type { DesktopID, AppState, DesktopStatus } from '../core/types.js';
import type { IDesktop } from './kernel.interface.js';
import type { IRuntimeContext } from './context.interface.js';
import type { DesktopCloseOptions, DesktopCloseHandle, RuntimeCloseHandle } from './close.interface.js';

/** The actual Desktop services consumed by Kernel. */
export interface IDesktopManager {
    create(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID>;
    get(desktopId: DesktopID): IDesktop | undefined;
    listDesktopIds(): DesktopID[];
    getAppStates(desktopId: DesktopID): AppState[];
    getDesktopInfo(desktopId: DesktopID): { status: DesktopStatus; createdAt: number } | undefined;
    suspend(desktopId: DesktopID): Promise<void>;
    resume(desktopId: DesktopID): Promise<void>;
    beginShutdown(): RuntimeCloseHandle;
    beginDesktopShutdown(id: DesktopID, options?: DesktopCloseOptions): DesktopCloseHandle;
}
