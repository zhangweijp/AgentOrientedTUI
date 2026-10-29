import type { AppLifecycleAck } from '../../adapters/app-lifecycle-protocol.js';
import type { AppCleanupReport } from '../runtime/app-lifecycle.interface.js';
import type { StatePersistenceOffer, StatePersistenceAck, StateStorageRequest, StateStorageResponse } from '../../adapters/storage/state-storage-protocol.js';
import type { ManagedPersistenceReport } from '../../worker-runtime/state-persistence.js';
/**
 * Worker Protocol - Message Definitions
 * 
 * 定义主线程与 Worker 之间的 IPC 消息协议。
 * 这是 SDK Worker Runtime 和 Runtime AppWorkerHost 的统一契约。
 * 
 * ## 消息流向
 * 
 * - **MainToWorkerMessage**: 主线程 → Worker (请求)
 * - **WorkerToMainMessage**: Worker → 主线程 (响应/推送)
 * 
 * ## 设计原则
 * 
 * 1. 所有消息都有 `type` 字段用于区分
 * 2. 请求消息都有 `requestId` 用于匹配响应
 * 3. Worker 可以主动推送消息 (如 DOM_UPDATE)
 * 
 * @module @aotui/runtime/spi/worker-protocol
 */

import type { RequestID, AppID, DesktopID, ViewID, OperationID, SnapshotID, DataPayload } from './types.js';
import type { OperationResult } from '../core/index.js';
import type { AppLaunchConfig } from '../app/app-config.interface.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../../core/snapshot/types.js';
import type { SnapshotValueRefSource } from '../../core/tool/snapshot-value-arguments.js';

// ============================================================================
// Re-export WorkerMessageType from canonical source
// ============================================================================
// WorkerMessageType is defined in worker-message.interface.ts (Single Source of Truth)
// We re-export it here for convenience when importing from worker-protocol
export type { WorkerMessageType } from '../runtime/worker-message.interface.js';

// ============================================================================
// Main → Worker Messages
// ============================================================================


/**
 * App 初始化消息
 */
export interface InitMessage {
    type: 'INIT';
    persistence?: StatePersistenceOffer;
    appLifecycle?: AppLifecycleAck;
    requestId: RequestID;
    appId: AppID;
    desktopId: DesktopID;
    /** App 模块路径 (动态 import) */
    appModulePath: string;
    /** 应用启动配置 (Configuration Injection) */
    config?: AppLaunchConfig;
    /** M2: Runtime-generated logical App execution instance token. */
    appInstanceId?: string;
    /** M2: opt-in observational Snapshot transport (never changes legacy execution). */
    snapshotShadow?: boolean;
    /** Internal M4 opt-in, only for read-only source-bound Tool execution. */
    experimentalReadOnlyViewTools?: boolean;
    /** Separate opt-in: validate mutating Tool bindings without invoking handlers. */
    experimentalVersionedMutations?: boolean;
    requestedCapabilities?: string[];
}

/**
 * App 生命周期消息
 */
export interface AppLifecycleMessage {
    type: 'APP_STOP' | 'APP_OPEN' | 'APP_PAUSE' | 'APP_RESUME' | 'APP_CLOSE' | 'APP_DELETE' | 'APP_SHUTDOWN' | 'APP_REINITIALIZE';
    requestId: RequestID;
    reason?: string;
}

/**
 * View 生命周期消息
 */
export interface ViewLifecycleMessage {
    type: 'VIEW_DISMOUNT';
    requestId: RequestID;
    viewId: ViewID;
    parentId?: ViewID | null;
}

/**
 * Operation 执行消息
 */
export interface OperationMessage {
    type: 'APP_OPERATION' | 'VIEW_OPERATION';
    requestId: RequestID;
    viewId?: ViewID;
    operation: OperationID;
    args: Record<string, unknown>;
    snapshotId: SnapshotID;
}

/**
 * Internal M4 Stage 3, opt-in source-bound READ-ONLY execution.
 * A Runtime Host may emit only a tool/target selected from its pinned V2 Store.
 * A Worker must revalidate against its current, instance-owned registry.
 */
export interface ViewToolInvokeMessage {
    type: 'VIEW_TOOL_INVOKE';
    requestId: RequestID;
    appId: AppID;
    instanceId: string;
    tool: ToolDescriptorV2;
    target: ToolTargetV2;
    args: Record<string, unknown>;
}

/** Internal versioned Ref transport; declaration support alone cannot enable it. */
export interface ViewToolInvokeRefV1Message {
    type: 'VIEW_TOOL_INVOKE_REF_V1';
    requestId: RequestID;
    appId: AppID;
    instanceId: string;
    snapshotId: string;
    tool: ToolDescriptorV2;
    target: ToolTargetV2;
    argumentMode: 'snapshot-value-v1';
    rawArgs: Readonly<Record<string, unknown>>;
    effectiveArgs: Readonly<Record<string, unknown>>;
    refSources: readonly SnapshotValueRefSource[];
}

export type { InteractionModeV1, InteractionMode } from '../runtime/app-interaction.interface.js';
export type { SnapshotValueParameterContract } from '../../core/tool/snapshot-value-parameter-contract.js';
export interface ViewToolInvokeRefV2Message extends Omit<ViewToolInvokeRefV1Message, 'type' | 'argumentMode'> {
    type: 'VIEW_TOOL_INVOKE_REF_V2'; argumentMode: 'snapshot-value-v2';
}
export interface ViewToolInvokeRefV2Response extends Omit<ViewToolInvokeRefV1Response, 'type' | 'argumentMode'> {
    type: 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE'; argumentMode: 'snapshot-value-v2';
}
export type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
export type {CreateIfAbsentOutcome,CreateIfAbsentTerminal} from '../../core/tool/create-if-absent-contract.js';
import type {CreateIfAbsentTerminal} from '../../core/tool/create-if-absent-contract.js';
export interface ViewToolInvokeCreateIfAbsentV1Message {
    type:'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1';requestId:RequestID;appId:AppID;instanceId:string;snapshotId:string;
    tool:ToolDescriptorV2;target:ToolTargetV2;argumentMode:'create-if-absent-v1';args:Readonly<Record<string,unknown>>;
}
export interface ViewToolInvokeCreateIfAbsentV1Response {
    type:'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE';requestId:RequestID;appId:AppID;instanceId:string;
    argumentMode:'create-if-absent-v1';success:true;terminal:CreateIfAbsentTerminal;
}
import type { ViewToolInvocationTerminal, RefV1Terminal } from '../../core/tool/invocation-terminal.js';
export type { ViewToolInvocationTerminal, RefV1Terminal } from '../../core/tool/invocation-terminal.js';

export interface ViewToolInvokeOrdinaryV1Message {
    type: 'VIEW_TOOL_INVOKE_ORDINARY_V1';
    requestId: RequestID; appId: AppID; instanceId: string; snapshotId: string;
    tool: ToolDescriptorV2; target: ToolTargetV2; argumentMode: 'ordinary-v1';
    args: Readonly<Record<string, unknown>>;
}
export interface ViewToolInvokeOrdinaryV1Response {
    type: 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE';
    requestId: RequestID; appId: AppID; instanceId: string; argumentMode: 'ordinary-v1';
    success: true; terminal: ViewToolInvocationTerminal;
}

export interface ViewToolInvokeOrdinaryV2Message {
    type: 'VIEW_TOOL_INVOKE_ORDINARY_V2';
    requestId: RequestID; appId: AppID; instanceId: string; snapshotId: string;
    tool: ToolDescriptorV2; target: ToolTargetV2; argumentMode: 'ordinary-v2';
    args: Readonly<Record<string, unknown>>;
}
export interface ViewToolInvokeOrdinaryV2Response {
    type: 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE';
    requestId: RequestID; appId: AppID; instanceId: string; argumentMode: 'ordinary-v2';
    success: true; terminal: ViewToolInvocationTerminal;
}

export interface ViewToolInvokeRefV1Response {
    type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE';
    requestId: RequestID;
    appId: AppID;
    instanceId: string;
    argumentMode: 'snapshot-value-v1';
    success: true;
    terminal: RefV1Terminal;
}

/** No Handler invocation: confirm the Worker still owns the exact binding. */
export type ViewToolValidateMessage = Omit<ViewToolInvokeMessage, 'type' | 'args'> & {
    type: 'VIEW_TOOL_VALIDATE';
};

/**
 * 外部事件消息
 */
export interface ExternalEventMessage {
    type: 'EXTERNAL_EVENT';
    requestId: RequestID;
    viewId: ViewID;
    eventType: string;
    data: Record<string, unknown>;
}


/**
 * 终止消息
 */
export interface TerminateMessage {
    type: 'TERMINATE';
}

/**
 * 重置 Worker 状态消息 (用于 Worker 池复用)
 */
export interface ResetMessage {
    type: 'RESET';
    requestId: RequestID;
}

/**
 * [RFC-006] ViewLink Mount 消息
 */
export interface ViewMountByLinkMessage {
    type: 'VIEW_MOUNT_BY_LINK';
    requestId: RequestID;
    parentViewId: ViewID;
    linkId: string;
}

/**
 * [RFC-011] LLM Output Push 消息
 * [RFC-020] 支持结构化 payload { reasoning?, content? }
 * 
 * 主线程推送 LLM 输出文本到 Worker，用于 SDK 的 useLLMOutputChannel
 */
export interface LLMOutputPushMessage {
    type: 'LLM_OUTPUT_PUSH';
    /** [RFC-020] LLM 思考/推理过程 */
    reasoning?: string;
    /** LLM 最终回复内容 */
    content?: string;
    eventType: 'complete';
    timestamp: number;
    meta?: {
        model?: string;
        usage?: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
    };
}

/**
 * 主线程 → Worker 消息联合类型
 */
export type MainToWorkerMessage =
    | ViewToolInvokeOrdinaryV2Message
    | StateStorageResponse
    | InitMessage
    | AppLifecycleMessage
    | ViewLifecycleMessage
    | ViewMountByLinkMessage
    | OperationMessage
    | ViewToolInvokeMessage
    | ViewToolInvokeCreateIfAbsentV1Message
    | ViewToolInvokeOrdinaryV1Message
    | ViewToolInvokeRefV2Message
    | ViewToolInvokeRefV1Message
    | ViewToolValidateMessage
    | ExternalEventMessage
    | TerminateMessage
    | ResetMessage
    | LLMOutputPushMessage;

// ============================================================================
// Worker → Main Messages
// ============================================================================

/**
 * 错误信息结构
 */
export interface WorkerError {
    code: string;
    message: string;
}

/**
 * 响应消息基类
 */
export interface ResponseBase {
    requestId: RequestID;
    success: boolean;
}

/**
 * 初始化完成响应
 */
export interface InitResponse extends ResponseBase {
    type: 'INIT_RESPONSE';
    persistence?: StatePersistenceAck;
    appLifecycle?: AppLifecycleAck;
    acceptedCapabilities?: string[];
    appInstanceId?: string;
}

/**
 * 生命周期完成响应
 */
export interface LifecycleResponse extends ResponseBase {
    type: 'LIFECYCLE_RESPONSE';
    persistence?: ManagedPersistenceReport;
    appCleanup?: AppCleanupReport;
}

/**
 * Operation 结果响应
 */
export interface OperationResponse extends ResponseBase {
    type: 'OPERATION_RESPONSE';
    result: OperationResult;
}


/**
 * 错误响应
 */
export interface ErrorResponse extends ResponseBase {
    type: 'ERROR_RESPONSE';
    success: false;
    error: WorkerError;
}

/**
 * Worker 主动请求: 通知更新
 */
export interface UpdateRequest {
    type: 'REQUEST_UPDATE';
}

/**
 * Worker 主动请求: mount 子 View
 */
export interface MountChildRequest {
    type: 'REQUEST_MOUNT_CHILD';
    viewId: ViewID;
}

/**
 * Worker 主动请求: dismount 子 View
 */
export interface DismountChildRequest {
    type: 'REQUEST_DISMOUNT_CHILD';
    viewId: ViewID;
}



/**
 * Worker 主动推送: Snapshot Fragment
 * 
 * [RFC-001] Worker-Side Transformation
 * Worker 直接执行 Transformer，推送 Markdown + IndexMap，
 * 避免主线程 HTML 解析开销。
 */
export interface SnapshotFragmentPush {
    type: 'SNAPSHOT_FRAGMENT';
    /** App ID */
    appId: AppID;
    /** Worker capture timestamp, diagnostic only (not a uniqueness token). */
    timestamp: number;
    /** Runtime-provisioned App instance identity; optional for old Workers. */
    appInstanceId?: string;
    /** TUI Markdown for this App */
    markup: string;
    /** Partial IndexMap (app-scoped paths) */
    indexMap: Record<string, DataPayload>;

    /**
     * View 级片段
     *
     * 每个 View 独立维护 timestamp，支持消息按 View 更新时间排序。
     */
    views?: Array<{
        viewId: ViewID;
        viewType: string;
        viewName?: string;
        markup: string;
        timestamp: number;
    }>;
    /**
     * [RFC-007] View tree markdown for Application Info section
     * 
     * Format:
     * ```markdown
     * ## Application View Tree
     * - [Chat](view:view_0, mounted)
     *     ↳ [Detail](link:CD_0)
     * ```
     */
    viewTree?: string;
    /** Version for incremental updates (future) */
    version?: number;
    /** M2 optional correlation with a PREPARED draft from the same capture. */
    shadowCaptureSeq?: number;
    shadowInstanceId?: string;

    /**
     * [RFC-012] Signal Suppression Flag
     * 
     * When true, main thread should update snapshot cache but NOT emit UpdateSignal.
     * Used by passive apps (signalPolicy: 'never') to maintain data freshness
     * without triggering Agent reaction loops.
     */
    suppressSignal?: boolean;
}

/**
 * M2 Shadow: a prepared, versioned App Snapshot Draft from a Worker Producer.
 * Wire data is untrusted until the Runtime Core validator accepts it.
 * No handler functions or live Ref objects are part of this contract.
 */
export interface SnapshotPreparedPush {
    type: 'SNAPSHOT_PREPARED';
    draft: unknown;
}

/** M2 Shadow: worker could not prepare or transport a Draft. */
export interface SnapshotPrepareFailedPush {
    type: 'SNAPSHOT_PREPARE_FAILED';
    appId: AppID;
    instanceId: string;
    producerSeq: number;
    sourceEpoch: number;
    error: { code: 'SNAPSHOT_INVALID' | 'SNAPSHOT_SERIALIZATION_ERROR'; message: string };
}

/**
 * 重置完成响应
 */
export interface ResetResponse extends ResponseBase {
    type: 'RESET_RESPONSE';
}

/**
 * Worker → 主线程消息联合类型
 */
export type WorkerToMainMessage =
    | StateStorageRequest
    | ViewToolInvokeOrdinaryV2Response
    | ViewToolInvokeCreateIfAbsentV1Response
    | ViewToolInvokeOrdinaryV1Response
    | ViewToolInvokeRefV2Response
    | ViewToolInvokeRefV1Response
    | InitResponse
    | LifecycleResponse
    | OperationResponse
    | ErrorResponse
    | UpdateRequest
    | MountChildRequest
    | DismountChildRequest

    | SnapshotFragmentPush
    | SnapshotPreparedPush
    | SnapshotPrepareFailedPush
    | ResetResponse;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * 检查是否为响应消息
 */
export function isResponse(msg: WorkerToMainMessage): msg is ResponseBase & WorkerToMainMessage {
    return 'requestId' in msg && 'success' in msg;
}

/**
 * 检查是否为请求消息 (Worker 主动发起)
 */
export function isRequest(msg: WorkerToMainMessage): boolean {
    return msg.type.startsWith('REQUEST_');
}



/**
 * 检查是否为 Snapshot Fragment 推送
 * [RFC-001] Worker-Side Transformation
 */
export function isSnapshotFragment(msg: WorkerToMainMessage): msg is SnapshotFragmentPush {
    return msg.type === 'SNAPSHOT_FRAGMENT';
}
