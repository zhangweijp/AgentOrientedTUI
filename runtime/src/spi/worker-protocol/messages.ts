import { VIEW_TYPE_PARAMETERS_MODE } from '../../core/tool/ordinary-parameter-contract.js';
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
 * 3. Worker 可以主动推送 Semantic Snapshot 发布结果
 * 
 * @module @aotui/runtime/spi/worker-protocol
 */

import type { RequestID, AppID, DesktopID, ViewID } from './types.js';
import type { AppLaunchConfig } from '../app/app-config.interface.js';
import type { ObservedToolExecutionV3, ToolDescriptorV3 } from '../../core/snapshot/types.js';
import type { SnapshotValueRefSource } from '../../core/tool/snapshot-value-arguments.js';
import type { LLMOutputEventMeta } from '../core/llm-output.js';

// ============================================================================
// Main → Worker Messages
// ============================================================================


/**
 * App 初始化消息
 */
export interface InitMessage {
    type: 'INIT';
    persistence: StatePersistenceOffer;
    appLifecycle: AppLifecycleAck;
    requestId: RequestID;
    appId: AppID;
    desktopId: DesktopID;
    /** App 模块路径 (动态 import) */
    appModulePath: string;
    /** Canonical registered name, never an alias or an App execution identity. */
    appName?: string;
    /** 应用启动配置 (Configuration Injection) */
    config?: AppLaunchConfig;
    /** M2: Runtime-generated logical App execution instance token. */
    appInstanceId: string;
    requestedCapabilities: string[];
}

/**
 * App 生命周期消息
 */
export interface AppLifecycleMessage {
    type: 'APP_STOP' | 'APP_OPEN' | 'APP_PAUSE' | 'APP_RESUME' | 'APP_CLOSE' | 'APP_DELETE' | 'APP_SHUTDOWN' | 'APP_REINITIALIZE';
    requestId: RequestID;
    reason?: string;
}

export type { InteractionMode } from '../runtime/app-interaction.interface.js';
export type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { ViewToolInvocationTerminal } from '../../core/tool/invocation-terminal.js';
export type { ViewToolInvocationTerminal } from '../../core/tool/invocation-terminal.js';

/** Qualified parameters retain ViewType execution and separate Snapshot Ref provenance. */
export type ViewToolInvokeV4Message = Readonly<{
    type: 'VIEW_TOOL_INVOKE_V4'; requestId: RequestID; appId: AppID; instanceId: string; snapshotId: string;
    tool: ToolDescriptorV3; argumentMode: typeof VIEW_TYPE_PARAMETERS_MODE;
    execution: Extract<ObservedToolExecutionV3, { kind: 'view-type' }>;
    rawArgs: Readonly<Record<string, unknown>>; effectiveArgs: Readonly<Record<string, unknown>>;
    refSources: readonly SnapshotValueRefSource[];
}>;
export type ViewToolInvokeV4Response = Readonly<{
    type: 'VIEW_TOOL_INVOKE_V4_RESPONSE'; requestId: RequestID; appId: AppID; instanceId: string;
    argumentMode: typeof VIEW_TYPE_PARAMETERS_MODE; success: true; terminal: ViewToolInvocationTerminal;
}>;

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
    meta?: Pick<LLMOutputEventMeta, 'model' | 'providerId' | 'modelId' | 'usage'>;
}

/**
 * 主线程 → Worker 消息联合类型
 */
export type MainToWorkerMessage =
    | Readonly<{ type: 'FLUSH_PROJECTION'; requestId: RequestID }>
    | ViewToolInvokeV4Message
    | StateStorageResponse
    | InitMessage
    | AppLifecycleMessage
    | ExternalEventMessage
    | TerminateMessage
    | ResetMessage
    | LLMOutputPushMessage;

// ============================================================================
// Worker → Main Messages
// ============================================================================

/** Developer-only installation details, never part of ToolResult or close summaries. */
export interface WorkerInitializationDiagnostic {
    readonly phase: 'INIT' | 'OPEN';
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
    readonly truncated?: true;
}

export interface WorkerError {
    code: string;
    message: string;
    diagnostic?: WorkerInitializationDiagnostic;
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
    persistence: StatePersistenceAck;
    appLifecycle: AppLifecycleAck;
    acceptedCapabilities: string[];
    appInstanceId: string;
}

/**
 * 生命周期完成响应
 */
export interface LifecycleResponse extends ResponseBase {
    type: 'LIFECYCLE_RESPONSE';
    persistence?: ManagedPersistenceReport;
    appCleanup?: AppCleanupReport;
    error?: WorkerError;
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
 * Semantic publication: a prepared, versioned App Snapshot Draft from a Worker Producer.
 * Wire data is untrusted until the Runtime Core validator accepts it.
 * No handler functions or live Ref objects are part of this contract.
 */
export interface SnapshotPreparedPush {
    type: 'SNAPSHOT_PREPARED';
    requestId?: RequestID;
    draft: unknown;
    suppressSignal: boolean;
}

/** Worker could not prepare or transport a Semantic Draft. */
export interface SnapshotPrepareFailedPush {
    type: 'SNAPSHOT_PREPARE_FAILED';
    requestId?: RequestID;
    appId: AppID;
    instanceId: string;
    producerSeq: number;
    sourceEpoch: number;
    error: { code: 'SNAPSHOT_INVALID' | 'SNAPSHOT_SERIALIZATION_ERROR'; message: string };
    suppressSignal: boolean;
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
    | ViewToolInvokeV4Response
    | InitResponse
    | LifecycleResponse
    | ErrorResponse
    | UpdateRequest
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
