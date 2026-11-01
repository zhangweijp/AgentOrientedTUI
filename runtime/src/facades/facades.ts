import type { RuntimeCloseReporting } from '../spi/runtime/close.interface.js';
import type { RuntimeInteractionAccess } from '../spi/runtime/app-interaction.interface.js';
/**
 * SDK Layer - Runtime Facade
 * 
 * 提供简化的 Runtime 创建和使用接口。
 * 这是大多数开发者的入口点。
 * 
 * [DIP] Uses createKernel factory for proper dependency injection.
 */

import { DesktopManager } from '../engine/core/index.js';
import { createKernel } from '../factory/createKernel.js';
import type { IKernel } from '../spi/index.js';
import {
    RUNTIME_DEFAULTS,
    type RuntimeConfig,
    type RuntimeConfigInput,
    defineRuntimeConfig
} from '../spi/config/index.js';

export { RUNTIME_DEFAULTS, type RuntimeConfig, type RuntimeConfigInput, defineRuntimeConfig };

// ============================================================================
// Runtime factory
// ============================================================================

/**
 * 创建 AOTUI Runtime 实例
 * 
 * 这是最简单的入口点，封装了所有内部依赖的创建。
 * 
 * [DIP] Uses createKernel factory internally to maintain proper dependency injection.
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
 * await runtime.installDynamicApp(desktopId, new MyChatApp());
 * ```
 */
export function createRuntime(input: RuntimeConfigInput = {}): IKernel & RuntimeCloseReporting & RuntimeInteractionAccess {
    const config: RuntimeConfig = defineRuntimeConfig(input);
    const desktopManager = new DesktopManager(config);
    return createKernel(desktopManager);
}

