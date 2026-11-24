export { AOTUIError, type ErrorCode } from './errors.js';
export { captureAppMetadata, type AppMetadata } from './app/app-metadata.js';
export {
    hasViewTypeToolAuthoringProtocol, isTUIAppFactory, readAppFactory, VIEW_TYPE_TOOL_PROTOCOL,
    type TUIAppFactory,
} from './app/app-factory.interface.js';
export { APP_LIFECYCLE_PROTOCOL, type AppLifecycleCallbacks, type AppLifecyclePort } from './app/app-lifecycle.interface.js';
export { STATE_SESSION_PROTOCOL, type AppStatePersistence, type StatePersistenceOptions } from './app/state-persistence.interface.js';
export type { AppInstance, RuntimeContext } from './app/app-instance.interface.js';
export type { AppContext } from './app/app-kernel.interface.js';
export type { AppLaunchConfig } from './app/app-config.interface.js';
export type { AppID, DesktopID } from './app/identity.js';

export {
    MARKDOWN_VIEW_FORMAT, SNAPSHOT_SCHEMA_VERSION, ViewMultiplicity, ViewRegion,
    isInstanceName, isViewTypeName,
} from './snapshot/types.js';
export type {
    AppIdentityRead, AppIdentityReader, AppSnapshot, CommitResult, HoldResult, JsonValue, PreparedAppSnapshotDraft,
    PreparedSnapshotFailure, RefDescriptor, RefLookup, RefScope, RefSelector, RefTarget, SnapshotCommitter, SnapshotCore,
    SnapshotHold, SnapshotIssue, SnapshotIssueCode, SnapshotLifecycle, SnapshotLimits, SnapshotLookup, SnapshotRead,
    SnapshotStore, SnapshotStoreOptions, SnapshotStoreStats, ToolDescriptor, ToolRoute, ViewContent,
    ViewSnapshot, ViewToolBinding, ViewToolReceiver,
} from './snapshot/types.js';
export { canonicalJson, checkWireJson, copyJson, copyWireJson, SnapshotDataError, utf8Size, type JsonCopyLimits } from './snapshot/json.js';
export { DEFAULT_SNAPSHOT_LIMITS, refKey } from './snapshot/snapshot-support.js';
export { DEFAULT_PROJECTION_LIMITS, normalizeProjectionLimits } from './snapshot/projection-limits.js';
export { createRefCapture, type RefCapture, type RefValueCheck } from './snapshot/ref-capture.js';

export { compileToolParameters, compileValueSchema } from './tool/tool-parameters.js';
export type {
    ParameterDiagnostic, ToolParameterCompileResult, ToolParameterContract, ToolParameterValidation,
} from './tool/tool-parameters.js';
export type { ViewToolInvocationTerminal } from './tool/invocation-terminal.js';
export { isToolResultData, type ToolError, type ToolResult, type ToolResultData } from './tool/tool-result.js';

export type { LocalRefUse, RefPath } from './tool/ref-path.js';
export type { SnapshotValueRefSource } from './tool/snapshot-value-arguments.js';
export type {
    ObservationJsonLimits, ProjectionLimits,
    ProjectionLimitOverrides, ViewIdentity, RefIdentity, ObservationSource,
    ObservationWindowSelection, ObservedView, ObservedTool, ObservedRef,
    RefConsumer, RefGrant, Observation, ObservationGrant, ObservationIssueCode,
    ObservationIssue, ObservationRegistryStats,
} from './invocation/observation-types.js';
export type {
    AppInteraction, AppInteractionPolicy, AppInteractionSource, AppInvocation, AppPreviewResult, BusinessDetails,
    CancellationSignal, ConsoleInputPath, ConsoleInputs, ExecutionBinding, ExecutionFact, ExecutionPhase,
    ExecutionResolver, InstanceInteraction, InteractionLimitOverrides, InteractionLimits, InteractionStats,
    InvocationContext, InvocationJsonLimits, InvocationOutcome, InvocationReceipt, InvocationSource, InvokeResult, Issue as InteractionIssue,
    ObserveResult, ReceiptAccess, ReceiptMetadata, ReceiptQuery,
    ActiveTurn, AdoptTurnResult, ObservationCandidate, PrepareObservationResult, InspectRefMode, InspectRefResult, TurnSelection,
} from './invocation/app-interaction-types.js';
export type { AppFrameRef, AppFrameView, AppProjectionFrame, PreparedProjection, ProjectionCommitResult, ProjectionOptions, ProjectionSource } from './projection/coordinator.js';
export type { AppFrameBinding, AppViewTypeDefinition, ViewInstance, ViewOwnedToolLimits, ViewOwnedToolsStats } from './tool/view-owned-tools.js';
export type { StateValue, StateAddress, StateValueLimits, StateIssueCode, StateIssue, StateReadResult, StateMutationResult, StateReleaseResult, StateStorage, Rejected as StateRejected } from './persistence/state-storage.js';
export type { StateSessionLimits, StateFlushEntry, StateFlushReport, StateDisposeReport } from './persistence/state-session.js';
