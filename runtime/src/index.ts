/**
 * @aotui/runtime - AOTUI Runtime Package
 * 
 * This is the main entry point for the AOTUI runtime.
 * 
 * ## Recommended Imports
 * 
 * ### For Host Integrators
 * ```typescript
 * import { createRuntime } from '@aotui/runtime';
 * ```
 * 
 * ### For Types (SPI Layer)
 * ```typescript
 * import type { IKernel, ToolResult } from '@aotui/runtime';
 * ```
 * 
 * ### For Integration (Adapters Layer)
 * ```typescript
 * import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
 * ```
 * 
 * ## ⚠️ Internal APIs
 * Engine implementations stay internal. Use the explicit package exports
 * below and the pure semantic contracts from `@aotui/runtime/core`.
 * 
 * @module @aotui/runtime
 */

// ============================================================================
// Public runtime and host contracts.
// Keep this list explicit so internal SPI/Engine additions do not become public
// accidentally.
// ============================================================================
export { createRuntime, type RuntimeConfig, type RuntimeOptions } from './facades/facades.js';
export { defineRuntimeConfig, type RuntimeConfigInput } from './spi/config/index.js';
export type {
    AppInteraction,
    AppInteractionPolicy,
    AppInvocation,
    ReceiptQuery,
    InvocationReceipt,
    ReceiptAccess,
    InvokeResult,
    ObserveResult,
    AppPreviewResult,
    InvocationContext,
    ReceiptMetadata,
    Issue as InteractionIssue,
} from './core/invocation/app-interaction-types.js';
export type { Observation, ObservationSelection, ObservationGrant, ObservedTool } from './core/invocation/observation-types.js';

export {
    AOTUIError,
    createDesktopId,
    createAppId,
    createViewId,
} from './spi/index.js';
export type {
    AppContext,
    AppDiscoveryInfo,
    AppInteractionOptions,
    AppID,
    AppLaunchConfig,
    AppInteractionResult,
    AppStatePersistence,
    CloseHandle,
    CloseReport,
    DesktopCloseHandle,
    DesktopCloseOptions,
    DesktopCloseReport,
    DesktopID,
    ErrorCode,
    IDesktop,
    IKernel,
    InteractionCloseReport,
    LLMUsageEvent,
    ToolError,
    ToolResult,
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
    RuntimeCloseHandle,
    RuntimeCloseReport,
    ShutdownOptions,
    UpdateSignal,
    ViewID,
} from './spi/index.js';

// ============================================================================
// 🟢 Public: App Registry (Third-Party App Management)
// Used by Product Layer to load and manage third-party TUI apps
// ============================================================================
export type { StateStorageBackend } from './engine/app/state-storage-host.js';
export { AppRegistry } from './engine/app/registry.js';
export type { LoadedApp, AppRegistryEntry, AppRegistryOptions, AppRegistryInstallOptions, AppRegistryFailure, AppDiscoveryResult, AppInstallResult } from './engine/app/registry.js';
export type { TUIConfig, AppConfigEntry } from './engine/app/config.js';
