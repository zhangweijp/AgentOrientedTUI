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
    AppState,
    DesktopID,
    DesktopState,
    DesktopStatus,
    ViewID,
} from './core/types.js';
export {
    createAppId,
    createDesktopId,
    createViewId,
} from './core/id-factory.js';
export type { ToolError, ToolResult } from './core/tool-result.js';
export { AOTUIError, ERROR_CODES } from './core/errors.js';
export type { ErrorCode } from './core/errors.js';
export type { UpdateSignal } from './core/signals.js';
export type { LLMOutputEvent, LLMOutputEventMeta, LLMOutputListener } from './core/llm-output.js';

// App factory, configuration, lifecycle, and semantic View integration.
export type { AppKernelConfig, AppReinitializeContext, SignalPolicy } from './app/app-kernel.interface.js';
export type { AppContext } from './app/store.interface.js';
export type { AppLaunchConfig } from './app/app-config.interface.js';
export type { TUIAppFactory } from './app/app-factory.interface.js';
export { isTUIAppFactory, hasViewTypeToolAuthoringProtocol } from './app/app-factory.interface.js';
export type { IRefExporter, IRefBinding, RefValueCheck } from './app/ref-exporter.interface.js';
export type { IRefRegistry } from './app/ref-exporter.interface.js';

// Managed App initialization and instance ports.
export type {
    AppStatePersistence,
    AppInstance,
    AppProjectionFrame,
    ExternalAppEvent,
    RuntimeContext,
    StateBinding,
    StateBindingStatus,
    StateFlushReport,
    StateIssue,
    StateValue,
} from './app/app-instance.interface.js';

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
export { SEMANTIC_INTERACTION_MODES } from './runtime/app-interaction.interface.js';
export type {
    AppInteractionOptions,
    AppInteractionResult,
    InteractionMode,
} from './runtime/app-interaction.interface.js';
export type { IRuntimeContext } from './runtime/context.interface.js';
export type { ILLMOutputChannelService } from './runtime/llm-output-channel.interface.js';

// SDK-facing Runtime ports. These are typed capabilities, not Worker IPC.
export type { IProjectionPort, ProjectionToken } from './runtime/projection.interface.js';
export type {
    IViewOwnedToolPort,
} from './runtime/view-owned-tools.interface.js';
export type { IAppTypeToolPort, AppTypeToolDefinition, AppTypeToolRegistrationOptions, AppFrameTool, SafeOrdinaryInvoker } from './runtime/app-type-tools.interface.js';
export type { AppCleanupReport, AppLifecycleCallbacks, AppLifecyclePort } from './runtime/app-lifecycle.interface.js';

export { captureAppMetadata } from './app/app-metadata.js';
export type { AppMetadata } from './app/app-metadata.js';
export { VIEW_TYPE_TOOL_PROTOCOL } from './runtime/app-type-tools.interface.js';
export { APP_LIFECYCLE_PROTOCOL, APP_LIFECYCLE_VERSION } from './runtime/app-lifecycle.interface.js';
export { STATE_SESSION_PROTOCOL, STATE_SESSION_VERSION } from './runtime/state-persistence.interface.js';
export { SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY } from './worker-protocol/types.js';
