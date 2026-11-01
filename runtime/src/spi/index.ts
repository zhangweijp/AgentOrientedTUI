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
    DataPayload,
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
export type { OperationError, OperationResult } from './core/operations.js';
export { AOTUIError, ERROR_CODES } from './core/errors.js';
export type { ErrorCode } from './core/errors.js';
export type { UpdateSignal } from './core/signals.js';
export type { LLMOutputEvent, LLMOutputEventMeta, LLMOutputListener } from './core/llm-output.js';

// App factory, configuration, lifecycle, and semantic View integration.
export type { IAOTUIApp } from './app/app.interface.js';
export type { AppKernelConfig, AppReinitializeContext, SignalPolicy } from './app/app-kernel.interface.js';
export type { AppContext } from './app/store.interface.js';
export type { AppLaunchConfig } from './app/app-config.interface.js';
export type { TUIAppFactory } from './app/app-factory.interface.js';
export { isTUIAppFactory } from './app/index.js';
export type { IRefExporter } from './app/ref-exporter.interface.js';
export type { IRefRegistry, IViewMeta } from './app/public-types.js';

// SDK component factory and its managed Runtime context.
export type {
    AppStatePersistence,
    ComponentFactory,
    ComponentRenderer,
    RuntimeContext,
    StateBinding,
    StateBindingStatus,
    StateFlushReport,
    StateIssue,
    StateValue,
} from './component-factory.interface.js';

// Product Host contracts and lifecycle/reporting semantics.
export type {
    AppDiscoveryInfo,
    IDesktop,
    IKernel,
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
} from './runtime/kernel.interface.js';
export type {
    AppManagerCloseOperation,
    AppManagerCloseReport,
    CloseOperation,
    CloseReport,
    DesktopCloseOperation,
    DesktopCloseOptions,
    DesktopCloseReport,
    InteractionCloseReport,
    RuntimeCloseOperation,
    RuntimeCloseReport,
    RuntimeCloseReporting,
    ShutdownOptions,
} from './runtime/close.interface.js';
export { SEMANTIC_INTERACTION_MODES } from './runtime/app-interaction.interface.js';
export type {
    AppInteractionOptions,
    AppScopeResult,
    DesktopInteractionAccess,
    InteractionMode,
    RuntimeInteractionAccess,
} from './runtime/app-interaction.interface.js';
export type { IDesktopManager } from './runtime/desktop-manager.interface.js';
export type { IRuntimeContext } from './runtime/context.interface.js';
export type { ILLMOutputChannelService } from './runtime/llm-output-channel.interface.js';

// SDK-facing Runtime ports. These are typed capabilities, not Worker IPC.
export type { IProjectionPort, ProjectionChange, ProjectionToken } from './runtime/projection.interface.js';
export type {
    IViewOwnedToolPort,
    SafeOrdinaryInvoker,
    SafeRefInvoker,
    ViewToolDefinition,
    ViewToolRegistrationOptions,
} from './runtime/view-owned-tools.interface.js';
export type { AppCleanupReport, AppLifecycleCallbacks, AppLifecyclePort } from './runtime/app-lifecycle.interface.js';
