/**
 * Supported contracts shared by Runtime, SDK, and the product Host.
 *
 * Worker IPC and manager implementation fragments stay behind their source
 * modules; the Host-facing manager contract remains available here.
 * @module @aotui/runtime/spi
 */

// Core identifiers, state values, results, errors, and notifications.
export type {
    AppID,
    DesktopID,
} from './core/types.js';
export {
    createAppId,
    createDesktopId,
} from './core/id-factory.js';
export type { ToolError, ToolResult } from '../core/tool/tool-result.js';
export { AOTUIError } from './core/errors.js';
export type { ErrorCode } from './core/errors.js';
export type { UpdateSignal } from './core/signals.js';
export type { LLMUsageEvent } from './core/llm-usage.js';
export type { ProjectionLimits, ProjectionLimitOverrides } from '../core/invocation/observation-types.js';

// App factory, configuration, lifecycle, and semantic View integration.
export type { AppKernelConfig, AppReinitializeContext, SignalPolicy } from './app/app-kernel.interface.js';
export type { AppContext } from './app/store.interface.js';
export type { AppLaunchConfig } from './app/app-config.interface.js';
export type { TUIAppFactory } from './app/app-factory.interface.js';
export { isTUIAppFactory, hasViewTypeToolAuthoringProtocol, VIEW_TYPE_TOOL_PROTOCOL } from './app/app-factory.interface.js';
export { createRefCapture, type RefCapture, type RefValueCheck } from '../core/snapshot/ref-capture.js';
export { DEFAULT_SNAPSHOT_LIMITS } from '../core/snapshot/snapshot-support.js';

// Managed App initialization and instance ports.
export type {
    AppStatePersistence,
    AppInstance,
    RuntimeContext,
    StateBinding,
    StateBindingStatus,
    StateFlushReport,
    StateIssue,
    StateValue,
} from './app/app-instance.interface.js';
export type { AppFrameRef, AppFrameView, AppProjectionFrame, PreparedProjection, ProjectionCommitResult, ProjectionOptions } from '../core/projection/coordinator.js';

// Product Host contracts and lifecycle/reporting semantics.
export type {
    AppDiscoveryInfo,
    IDesktop,
    IKernel,
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
} from './runtime/kernel.interface.js';
export type {
    AppManagerCloseHandle,
    AppManagerCloseReport,
    CloseHandle,
    CloseReport,
    DesktopCloseHandle,
    DesktopCloseOptions,
    DesktopCloseReport,
    InteractionCloseReport,
    RuntimeCloseHandle,
    RuntimeCloseReport,
    ShutdownOptions,
} from './runtime/close.interface.js';
export type {
    AppInteractionOptions,
    AppInteractionResult,
} from './runtime/app-interaction.interface.js';
export type { IRuntimeContext } from './runtime/context.interface.js';

// SDK-facing Runtime ports. These are typed capabilities, not Worker IPC.
export type { AppTypeToolDefinition, AppFrameBinding } from '../core/tool/view-owned-tools.js';
export type { AppCleanupReport, AppLifecycleCallbacks, AppLifecyclePort } from './runtime/app-lifecycle.interface.js';

export { captureAppMetadata } from './app/app-metadata.js';
export type { AppMetadata } from './app/app-metadata.js';
export { APP_LIFECYCLE_PROTOCOL, APP_LIFECYCLE_VERSION } from './runtime/app-lifecycle.interface.js';
export { STATE_SESSION_PROTOCOL, STATE_SESSION_VERSION } from './runtime/state-persistence.interface.js';
export { WORKER_PROTOCOL } from './worker-protocol/types.js';
