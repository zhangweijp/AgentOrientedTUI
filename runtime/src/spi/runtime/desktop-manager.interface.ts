/**
 * SPI Layer - Desktop Manager Interface (Composition)
 * 
 * 管理 Desktop 实例的完整生命周期和并发控制。
 * 
 * [RFC-004] Interface Composition:
 * IDesktopManager 现在是一个组合类型，由 5 个聚焦的原子接口组成。
 * 这允许未来的实现按需拆分，同时保持对现有消费者的向后兼容。
 * 
 * @module @aotui/runtime/spi
 */

import type { IDesktopRepository } from './desktop-repository.interface.js';
import type { IAppInstaller } from './app-installer.interface.js';
import type { IDesktopStateAccessor } from './desktop-state-accessor.interface.js';
import type { IDesktopLifecycleController } from './desktop-lifecycle.interface.js';
import type { DesktopID } from '../core/index.js';
import type { IRuntimeContext } from './context.interface.js'; // New
import type { DesktopCloseOptions, DesktopCloseOperation, RuntimeCloseOperation } from './close.interface.js';

// ...

export interface IDesktopManager extends
    IDesktopRepository,
    IAppInstaller,
    IDesktopStateAccessor,
    IDesktopLifecycleController {
    beginShutdown(): RuntimeCloseOperation;
    beginDesktopShutdown(id: DesktopID, options?: DesktopCloseOptions): DesktopCloseOperation;
    // Override create to include context
    create(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID>;

    /**
     * 列出当前仍由 runtime 托管的所有 Desktop。
     */
    listDesktopIds(): DesktopID[];

}

