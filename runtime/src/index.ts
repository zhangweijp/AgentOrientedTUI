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
export { createRuntime, type RuntimeConfig } from './facades/facades.js';
export { createCandidateScope } from './engine/core/candidate-scope.js';
export { defineRuntimeConfig, type RuntimeConfigInput } from './spi/config/index.js';
export type {
    AppInteractionPolicy,
    AppInvocation,
    CancellationSignal,
    PublicRefValue,
    ReadPublicRefsResult,
    ObservationCandidate,
    PrepareObservationResult,
    InspectRefMode, InspectRefResult,
    TurnSelection,
    ReceiptQuery,
    InvocationReceipt,
    AppPreviewResult,
    InvocationContext,
    ReceiptMetadata,
    InteractionIssue,
} from '@aotui/core';
export type { Observation, ObservationWindowSelection, ViewIdentity, ObservationGrant, ObservedTool, ObservedRef,
    RefConsumer, RefGrant } from '@aotui/core';
export type { RefPath } from '@aotui/core';
export type { AppWindows, AppWindowTarget, ViewWindow, ViewWindowTarget, ViewCloseResult } from './spi/runtime/windows.js';

export { AOTUIError } from '@aotui/core';
export { createDesktopId, createAppId } from './spi/core/id-factory.js';
export type {
    AppContext,
    AppID,
    AppLaunchConfig,
    DesktopID,
    ErrorCode,
    ProjectionLimitOverrides,
    ProjectionLimits,
    ToolError,
    ToolResult,
} from '@aotui/core';
export type { UpdateSignal } from './spi/core/signals.js';
export type { ActiveTurn, AdoptTurnResult, AppDiscoveryInfo, AppPolicyTarget, CandidateScope, CreateDesktopOptions, IDesktop,
    IKernel, InvokeResult, OpenAppOptions, ReceiptAccess, ReceiptLocator, RunningApp, RunningAppResult,
    RegisterPendingAppOptions } from './spi/runtime/kernel.interface.js';
export type { AppInteractionOptions } from './spi/runtime/app-interaction.interface.js';
export type {
    AppExecutionBackend, AppExecutionEvent, AppExecutionHandle, AppExecutionIssue, AppExecutionLaunch,
    AppExecutionProjection, AppExecutionRequest,
} from './spi/runtime/execution-backend.js';
export type {
    AppCloseHandle,
    AppCloseReport,
    CloseHandle,
    CloseReport,
    DesktopCloseHandle,
    DesktopCloseReport,
    InteractionCloseReport,
    RuntimeCloseHandle,
    RuntimeCloseReport,
} from './spi/runtime/close.interface.js';

export { readAppManifest, type AppManifest } from './engine/app/manifest.js';
