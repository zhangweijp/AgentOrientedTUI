import type { StateStorageBackend } from '../engine/app/state-storage-host.js';
/**
 * SDK Layer - Runtime Facade
 * 
 * 提供简化的 Runtime 创建和使用接口。
 * 这是大多数开发者的入口点。
 * 
 */

import { DesktopManager } from '../engine/core/manager.js';
import { Kernel } from '../kernel/index.js';
import type { IKernel } from '../spi/index.js';
import {
    type RuntimeConfig,
    type RuntimeConfigInput,
    defineRuntimeConfig
} from '../spi/config/index.js';

export type { RuntimeConfig };

export interface RuntimeOptions {
    readonly storageBackend?: StateStorageBackend;
}

// ============================================================================
// Runtime factory
// ============================================================================

/**
 * 创建 AOTUI Runtime 实例
 * 
 * 这是最简单的入口点，封装了所有内部依赖的创建。
 * 
 * @example
 * ```typescript
 * import { createRuntime, defineRuntimeConfig } from '@aotui/runtime';
 * 
 * // 零配置
 * const runtime = createRuntime();
 * 
 * // 自定义配置 (RFC-005)
 * const config = defineRuntimeConfig({
 *   worker: { timeoutMs: 60000 }
 * });
 * const runtime = createRuntime(config);
 * 
 * const desktopId = await runtime.createDesktop();
 * await runtime.installDynamicWorkerApp(desktopId, '/absolute/path/to/app.mjs');
 * ```
 */
export function createRuntime(input: RuntimeConfigInput = {}, options?: RuntimeOptions): IKernel {
    const config: RuntimeConfig = defineRuntimeConfig(input);
    const desktopManager = new DesktopManager(config, options?.storageBackend);
    return new Kernel(desktopManager);
}

