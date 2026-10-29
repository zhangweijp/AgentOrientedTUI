import type { RuntimeCloseReporting } from '../spi/runtime/close.interface.js';
import type { RuntimeInteractionAccess } from '../spi/runtime/app-interaction.interface.js';
/**
 * Kernel Factory - createKernel
 * 
 * Factory function that creates a properly configured Kernel instance.
 * This is the recommended way to instantiate the Kernel.
 * 
 * [DIP] The Kernel depends on the IDispatcher interface.
 * This factory wires up the concrete implementations, keeping Kernel pure.
 * 
 * @module @aotui/runtime/factory
 */

import { Kernel } from '../kernel/index.js';
import { Dispatcher } from '../engine/system/index.js';
import type {
    IKernel,
    IDesktopManager,
    IRegistry,
    ISystemOperationRegistry,
} from '../spi/index.js';

/**
 * Creates a new Kernel instance with default implementations.
 * 
 * This factory wires up:
 * - Dispatcher (for Operation routing)
 * 
 * @param desktopManager - The Desktop manager implementation
 * @param snapshotRegistry - The Snapshot registry implementation
 * @param systemOps - The System Operation registry
 * @returns A configured IKernel instance
 * 
 * @example
 * ```typescript
 * import { createKernel } from '@aotui/runtime';
 * import { DesktopManager, SnapshotRegistry, SystemOperationRegistry } from '@aotui/runtime';
 * 
 * const kernel = createKernel(
 *     new DesktopManager(),
 *     new SnapshotRegistry(),
 *     new SystemOperationRegistry()
 * );
 * ```
 */
export function createKernel(
    desktopManager: IDesktopManager,
    snapshotRegistry: IRegistry,
    systemOps: ISystemOperationRegistry
): IKernel & RuntimeCloseReporting & RuntimeInteractionAccess {
    return new Kernel(
        desktopManager,
        snapshotRegistry,
        new Dispatcher(),
        systemOps
    );
}
