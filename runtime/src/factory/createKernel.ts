import type { RuntimeCloseReporting } from '../spi/runtime/close.interface.js';
import type { RuntimeInteractionAccess } from '../spi/runtime/app-interaction.interface.js';
/**
 * Kernel Factory - createKernel
 * 
 * Factory function that creates a properly configured Kernel instance.
 * This is the recommended way to instantiate the Kernel.
 * 
 * This factory keeps Runtime composition in one place.
 * 
 * @module @aotui/runtime/factory
 */

import { Kernel } from '../kernel/index.js';
import type {
    IKernel,
    IDesktopManager,
} from '../spi/index.js';

/**
 * Creates a new Kernel instance with default implementations.
 * 
 * This factory wires up:
 * @param desktopManager - The Desktop manager implementation
 * @returns A configured IKernel instance
 * 
 * @example
 * ```typescript
 * import { createKernel } from '@aotui/runtime';
 * import { DesktopManager } from '@aotui/runtime';
 * 
 * const kernel = createKernel(new DesktopManager());
 * ```
 */
export function createKernel(
    desktopManager: IDesktopManager
): IKernel & RuntimeCloseReporting & RuntimeInteractionAccess {
    return new Kernel(desktopManager);
}
