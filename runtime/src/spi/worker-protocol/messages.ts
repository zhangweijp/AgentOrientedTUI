import type { AppLifecycleAck } from '../../adapters/app-lifecycle-protocol.js';
import type { AppCleanupReport } from '../runtime/app-lifecycle.interface.js';
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
 */

import type { WORKER_PROTOCOL, RequestID, AppID, DesktopID } from './types.js';
import type { AppLaunchConfig } from '@aotui/core';
import type { JsonValue, ViewToolReceiver } from '@aotui/core';
import type { SnapshotDraftEnvelope, SnapshotPrepareIssue } from '@aotui/core/producer';
import type { ProjectionLimits } from '@aotui/core';
import type { UpdateSignal } from '../core/signals.js';

// ============================================================================
// Main → Worker Messages
// ============================================================================


/**
 * App 初始化消息
 */
export interface InitMessage {
    type: 'INIT';
    timeoutMs: number;
    appLifecycle: AppLifecycleAck;
    projectionLimits: ProjectionLimits;
    requestId: RequestID;
    appId: AppID;
    desktopId: DesktopID;
    /** App 模块路径 (动态 import) */
    appModulePath: string;
    /** Canonical registered name, never an alias or an App execution identity. */
    appName?: string;
    /** 应用启动配置 (Configuration Injection) */
    config?: AppLaunchConfig;
    /** Host-assigned identity of this App execution. */
    appInstanceId: string;
    protocol: typeof WORKER_PROTOCOL;
    toolsEnabled: boolean;
}

/**
 * App 生命周期消息
 */
export interface AppLifecycleMessage {
    type: 'APP_STOP' | 'APP_OPEN' | 'APP_CLOSE';
    requestId: RequestID;
}

import type { LocalRefUse, ToolRoute, ViewToolInvocationTerminal } from '@aotui/core';
export type { ViewToolInvocationTerminal } from '@aotui/core';

/** The qualified receiver and Ref provenance are distinct from business parameters. */
export type ViewToolInvokeMessage = Readonly<{
    type: 'VIEW_TOOL_INVOKE'; requestId: RequestID; appId: AppID; instanceId: string;
    tool: ToolRoute;
    receiver: ViewToolReceiver;
    effectiveArgs: Readonly<Record<string, JsonValue>>;
    localRefs: readonly LocalRefUse[];
}>;
export type ViewCloseMessage = Readonly<{
    type: 'VIEW_CLOSE'; requestId: RequestID; appId: AppID; instanceId: string;
    viewId: string; viewInstanceId: string;
}>;
export type ViewToolInvokeResponse = Readonly<{
    type: 'VIEW_TOOL_INVOKE_RESPONSE'; requestId: RequestID; appId: AppID; instanceId: string;
    success: true;
    terminal: ViewToolInvocationTerminal | Readonly<{ phase: 'finished-unknown' }>;
}>;

/**
 * 主线程 → Worker 消息联合类型
 */
export type MainToWorkerMessage =
    | Readonly<{ type: 'FLUSH_PROJECTION'; requestId: RequestID; known?: SnapshotDraftEnvelope }>
    | ViewToolInvokeMessage
    | ViewCloseMessage
    | InitMessage
    | AppLifecycleMessage;

// ============================================================================
// Worker → Main Messages
// ============================================================================

/** Developer-only installation details, never part of ToolResult or close summaries. */
export interface WorkerInitializationDiagnostic {
    readonly phase: 'INIT' | 'OPEN';
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly path?: string;
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
    appLifecycle: AppLifecycleAck;
    projectionLimits: ProjectionLimits;
    protocol: typeof WORKER_PROTOCOL;
    toolsEnabled: boolean;
    appInstanceId: string;
}

/**
 * 生命周期完成响应
 */
export interface LifecycleResponse extends ResponseBase {
    type: 'LIFECYCLE_RESPONSE';
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
 * Semantic publication: a prepared, versioned App Snapshot Draft from a Worker Producer.
 * Wire data is untrusted until the Runtime Core validator accepts it.
 * No handler functions or live Ref objects are part of this contract.
 */
export interface SnapshotPreparedPush {
    type: 'SNAPSHOT_PREPARED';
    requestId?: RequestID;
    draft: unknown;
}

/** Worker could not prepare or transport a Semantic Draft. */
export interface SnapshotPrepareFailedPush {
    type: 'SNAPSHOT_PREPARE_FAILED';
    requestId?: RequestID;
    appId: AppID;
    instanceId: string;
    producerSeq: number;
    sourceEpoch: number;
    error: SnapshotPrepareIssue;
}

export type AppEventMessage = Readonly<{ type: 'APP_EVENT'; appId: AppID; instanceId: string;
    reason: Extract<UpdateSignal['reason'], 'view_updated' | 'projection_recovered' | 'attention_requested'> }>;

export type ProjectionCurrentMessage = SnapshotDraftEnvelope & Readonly<{ type: 'PROJECTION_CURRENT'; requestId: RequestID }>;

/**
 * Worker → 主线程消息联合类型
 */
export type WorkerToMainMessage =
    | ViewToolInvokeResponse
    | InitResponse
    | LifecycleResponse
    | ErrorResponse
    | SnapshotPreparedPush
    | SnapshotPrepareFailedPush
    | ProjectionCurrentMessage
    | AppEventMessage;
