/**
 * @aotui/runtime - AOTUI Runtime Package
 * 
 * This is the main entry point for the AOTUI runtime.
 * 
 * ## Recommended Imports
 * 
 * ### For App Developers (SDK Layer)
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
export { createRuntime, type RuntimeConfig } from './facades/facades.js';
export { defineRuntimeConfig, type RuntimeConfigInput } from './spi/config/index.js';
export { Kernel } from './kernel/index.js';

export {
    AOTUIError,
    ERROR_CODES,
    createDesktopId,
    createAppId,
    createViewId,
    SEMANTIC_INTERACTION_MODES,
} from './spi/index.js';
export type {
    AppContext,
    AppDiscoveryInfo,
    AppInteractionOptions,
    AppID,
    AppLaunchConfig,
    AppScopeResult,
    AppState,
    AppStatePersistence,
    CloseHandle,
    CloseReport,
    DesktopCloseHandle,
    DesktopCloseOptions,
    DesktopCloseReport,
    DesktopID,
    DesktopState,
    DesktopStatus,
    ErrorCode,
    IDesktop,
    IDesktopManager,
    IKernel,
    InteractionMode,
    InteractionCloseReport,
    LLMOutputEvent,
    LLMOutputEventMeta,
    LLMOutputListener,
    ToolError,
    ToolResult,
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
    RuntimeCloseHandle,
    RuntimeCloseReport,
    RuntimeCloseReporting,
    RuntimeInteractionAccess,
    ShutdownOptions,
    UpdateSignal,
    ViewID,
} from './spi/index.js';

// ============================================================================
// 🟢 Public: App Registry (Third-Party App Management)
// Used by Product Layer to load and manage third-party TUI apps
// ============================================================================
export { AppRegistry } from './engine/app/registry.js';
export type { LoadedApp, AppRegistryEntry, AppRegistryOptions, AppRegistryInstallOptions } from './engine/app/registry.js';
export type { TUIConfig, AppConfigEntry } from './engine/app/config.js';

// ============================================================================
// 🟢 Public: App Distribution Helpers
// Used by Product Layer / CLI for discovery and installation workflows
// ============================================================================
export {
    searchCatalog,
    type CatalogSearchResult
} from './cli/catalog.js';
export {
    resolveCatalog,
    resolveCatalogOptionsFromConfig,
    type ResolvedCatalog
} from './cli/catalog-resolver.js';
export {
    parseInstallSource,
} from './cli/sources.js';
export {
    installNpmPackage,
} from './cli/npm-installer.js';

