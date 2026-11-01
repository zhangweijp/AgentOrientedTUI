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
 * import type { IKernel, OperationResult } from '@aotui/runtime';
 * ```
 * 
 * ### For Integration (Adapters Layer)
 * ```typescript
 * import { SemanticAOTUIDrivenSource } from '@aotui/runtime/adapters';
 * ```
 * 
 * ## ⚠️ Internal APIs
 * Engine layer exports (Desktop, ViewTree, Registry, etc.) are for framework
 * contributors only. They may change without notice.
 * 
 * @module @aotui/runtime
 */

// ============================================================================
// Public runtime and host contracts.
// Keep this list explicit so internal SPI/Engine additions do not become public
// accidentally.
// ============================================================================
export { createRuntime, type RuntimeConfig, type RuntimeConfigInput, defineRuntimeConfig } from './facades/index.js';
export { Kernel } from './kernel/index.js';

export {
    AOTUIError,
    ERROR_CODES,
    createOperationError,
    failedResult,
    createDesktopId,
    createAppId,
    createViewId,
    isDesktopId,
    isAppId,
    isViewId,
    SEMANTIC_INTERACTION_MODES,
} from './spi/index.js';
export type {
    AppConfig,
    AppContext,
    AppDiscoveryInfo,
    AppInteractionOptions,
    AppID,
    AppLaunchConfig,
    AppScopeResult,
    AppState,
    AppStatePersistence,
    AOAppEntry,
    AOAppManifest,
    AOAppRuntime,
    AOAppView,
    CloseOperation,
    CloseReport,
    DesktopCloseOperation,
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
    OperationError,
    OperationResult,
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
    RuntimeCloseOperation,
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
export { AppRegistry } from './engine/app/index.js';
export type { LoadedApp, AppRegistryEntry, AppRegistryOptions, AppRegistryInstallOptions, TUIConfig, AppConfigEntry } from './engine/app/index.js';

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

// ============================================================================
// 🔴 REMOVED: Engine Layer Exports
//
// [方案 B] Engine internals are no longer exported to external consumers.
// Component View implementation is internal to Worker Runtime (AppKernel).
//
// For Runtime internal use (tests), import directly via relative paths:
//   import { ViewTree } from './engine/view/tree.js';
//
// If you need functionality that was previously exported, consider:
// 1. Is there an SPI interface you should use instead?
// 2. Should this functionality be exposed through the SDK layer?
// ============================================================================
