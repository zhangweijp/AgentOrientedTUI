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
 * ### For Host Types
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
 * below and the separate `@aotui/core` package for portable semantics.
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
    CancellationSignal,
    ConsoleInputs,
    ConsoleInputPath,
    RequestSources,
    RequestSourceSelection,
    ReceiptQuery,
    InvocationReceipt,
    ReceiptAccess,
    InvokeResult,
    ObserveResult,
    AppPreviewResult,
    InvocationContext,
    ReceiptMetadata,
    InteractionIssue,
} from '@aotui/core';
export type { Observation, ObservationSelection, ObservationWindowSelection, ViewIdentity, ObservationGrant, ObservedTool, ObservedRef, ObservedRefPath,
    ProgramToolInput, ProgramRefPath, RefConsumer, RefGrant, RefPathGrant } from '@aotui/core';
export type { RefPath } from '@aotui/core';
export type { AppWindows, ViewWindow, ViewWindowTarget, ViewCloseResult } from './spi/runtime/windows.js';

export { AOTUIError } from '@aotui/core';
export { createDesktopId, createAppId } from './spi/core/id-factory.js';
export type {
    AppContext,
    AppID,
    AppLaunchConfig,
    AppStatePersistence,
    DesktopID,
    ErrorCode,
    ProjectionLimitOverrides,
    ProjectionLimits,
    ToolError,
    ToolResult,
} from '@aotui/core';
export type { UpdateSignal } from './spi/core/signals.js';
export type { AppDiscoveryInfo, IDesktop, IKernel, RegisterPendingAppOptions, ReinitializeDesktopAppsOptions, ReinitializeDesktopAppsResult } from './spi/runtime/kernel.interface.js';
export type { AppInteractionOptions, AppInteractionResult } from './spi/runtime/app-interaction.interface.js';
export type {
    CloseHandle,
    CloseReport,
    DesktopCloseHandle,
    DesktopCloseOptions,
    DesktopCloseReport,
    InteractionCloseReport,
    RuntimeCloseHandle,
    RuntimeCloseReport,
    ShutdownOptions,
} from './spi/runtime/close.interface.js';

export type { StateStorageBackend } from '@aotui/core/internal';
export { readAppManifest, type AppManifest } from './engine/app/manifest.js';
