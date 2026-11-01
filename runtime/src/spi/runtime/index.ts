/** Runtime and Host contracts retained by the supported SPI surface. */
export type {
    IDesktop,
    AppDiscoveryInfo,
    IKernel,
    ShutdownOptions,
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
} from './kernel.interface.js';
export type {
    CloseReport, AppManagerCloseReport, DesktopCloseReport, RuntimeCloseReport,
    CloseOperation, AppManagerCloseOperation, DesktopCloseOperation, RuntimeCloseOperation,
    RuntimeCloseReporting, DesktopCloseOptions, InteractionCloseReport,
} from './close.interface.js';
export { SEMANTIC_INTERACTION_MODES } from './app-interaction.interface.js';
export type { InteractionMode, AppInteractionOptions, AppScopeResult, RuntimeInteractionAccess, DesktopInteractionAccess } from './app-interaction.interface.js';

export type { IRuntimeContext } from './context.interface.js';
export type { ILLMOutputChannelService } from './llm-output-channel.interface.js';
export type { IDesktopManager } from './desktop-manager.interface.js';
export type { IProjectionPort, ProjectionChange, ProjectionToken } from './projection.interface.js';
export type { IViewOwnedToolPort, ViewToolDefinition, ViewToolRegistrationOptions, SafeOrdinaryInvoker, SafeRefInvoker } from './view-owned-tools.interface.js';
export type { AppLifecyclePort, AppLifecycleCallbacks, AppCleanupReport } from './app-lifecycle.interface.js';
export type { AppStatePersistence } from './state-persistence.interface.js';
