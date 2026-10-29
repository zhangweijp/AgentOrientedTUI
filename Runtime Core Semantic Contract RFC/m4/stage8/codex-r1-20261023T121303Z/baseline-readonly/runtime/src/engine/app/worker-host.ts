/**
 * AppWorkerHost - 主线程端 Worker 管理器
 * 
 * 管理一个 App 的 Worker Thread，处理：
 * - Worker 启动/终止
 * - 消息发送/接收
 * - 请求-响应匹配
 * 
 * @module @aotui/runtime/engine/app-worker
 */

import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { SnapshotShadowReceiver, type SnapshotShadowReport } from '../../adapters/snapshot/shadow-receiver.js';
import { copyJson } from '../../core/snapshot/json.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { AppID, DesktopID, ViewID, OperationID, OperationResult, SnapshotID } from '../../spi/index.js';
import { WORKER_DEFAULTS, type WorkerConfig } from '../../spi/config/index.js';

import {
    generateRequestId,
    type RequestID,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
    type SnapshotFragmentPush,
    type DataPayload,
    isResponse,
    isRequest,
    isSnapshotFragment,
} from '../../spi/worker-protocol/index.js';

// Compute default worker script path relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_WORKER_SCRIPT = resolve(__dirname, '../../worker-runtime/index.js');

/**
 * 待处理请求
 */
interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

/**
 * AppWorkerHost 配置
 */
/**
 * AppWorkerHost 配置
 */
export interface AppWorkerHostConfig {
    appId: AppID;
    desktopId: DesktopID;
    name?: string;  // App name for TUI output
    appModulePath: string;
    /** 
     * Worker 脚本路径 (可选，默认使用 Runtime 内置 worker-runtime)
     * [C1 Fix] 不再强制要求传入 SDK 内部路径
     */
    workerScriptPath?: string;
    timeout?: number;  // 请求超时 (ms)
    existingWorker?: Worker; // [WorkerPool] 复用的 Worker 实例
    config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig; // Configuration Injection
    runtimeConfig?: { worker: WorkerConfig }; // [RFC-005] Runtime Config
    /** M2: opt-in observational Core Snapshot path. Off by default. */
    snapshotShadow?: boolean;
    /** Only development/explicit opt-in: allows source-checked read-only View Tools. */
    experimentalReadOnlyViewTools?: boolean;
    /** Separate experimental opt-in: versioned File resource mutation with trusted policy/adapter. */
    experimentalVersionedMutations?: boolean;
}

/**
 * Worker 状态
 */
export type WorkerStatus = 'starting' | 'ready' | 'running' | 'paused' | 'closing' | 'closed' | 'error';

/**
 * AppWorkerHost - 主线程端 Worker 管理
 */
export class AppWorkerHost {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly name?: string;
    private readonly config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;

    private worker: Worker | null = null;
    private status: WorkerStatus = 'starting';
    private pendingRequests = new Map<RequestID, PendingRequest>();
    private readonly timeout: number;
    private readonly appModulePath: string;
    private readonly workerScriptPath: string;
    /** Assigned by the Runtime per logical App execution; distinct from Worker thread ID. */
    readonly appInstanceId: string;
    private readonly shadowReceiver?: SnapshotShadowReceiver;
    private readonly enableReadOnlyViewTools: boolean;
    private readonly enableVersionedMutations: boolean;
    /** Fail closed after an experimental write until V2 observes its resulting version. */
    private readonly unobservedFileVersions = new Map<string, string>();
    private activeFileReplacements = 0;
    private readonly fileReplacementWaiters: Array<() => void> = [];
    private terminateAfterFileReplacement = false;
    private closePromise: Promise<void> | null = null;
    private releasePromise: Promise<Worker | null> | null = null;
    private readonly lifecycleRequests = new Set<Promise<void>>();
    private readonly workerMessageListener = this.handleMessage.bind(this);
    private readonly workerErrorListener = this.handleError.bind(this);
    private readonly workerExitListener = this.handleExit.bind(this);

    private waitForFileReplacements(): Promise<void> {
        if (this.activeFileReplacements === 0) return Promise.resolve();
        return new Promise(resolve => this.fileReplacementWaiters.push(resolve));
    }

    // 回调: Worker 请求 notifyUpdate
    onUpdateRequest?: () => void;
    // 回调: Worker 请求 mount 子 View
    onMountChildRequest?: (viewId: ViewID) => Promise<void>;
    // 回调: Worker 请求 dismount 子 View
    onDismountChildRequest?: (viewId: ViewID) => Promise<void>;

    private lastLegacyCaptureSeq = 0;

    // [RFC-001] Snapshot Fragment Cache
    // [RFC-007] Added viewTree field
    private snapshotFragment: {
        markup: string;
        indexMap: Record<string, DataPayload>;
        views?: Array<{
            viewId: ViewID;
            viewType: string;
            viewName?: string;
            markup: string;
            timestamp: number;
        }>;
        viewTree?: string;  // [RFC-007]
        timestamp: number;
    } | null = null;

    constructor(config: AppWorkerHostConfig) {
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.appModulePath = config.appModulePath;
        this.appInstanceId = randomUUID();
        this.enableReadOnlyViewTools = config.experimentalReadOnlyViewTools === true && config.snapshotShadow === true;
        this.enableVersionedMutations = config.experimentalVersionedMutations === true && config.snapshotShadow === true;
        if (config.snapshotShadow === true) {
            this.shadowReceiver = new SnapshotShadowReceiver(String(this.appId), this.appInstanceId);
        }
        // [C1 Fix] Default to Runtime's built-in worker-runtime
        this.workerScriptPath = config.workerScriptPath ?? DEFAULT_WORKER_SCRIPT;

        // [RFC-005] Use Runtime Config
        const workerConfig = config.runtimeConfig?.worker ?? WORKER_DEFAULTS;
        this.timeout = config.timeout ?? workerConfig.timeoutMs;

        this.config = config.config; // ✨ Store config

        if (config.existingWorker) {
            this.worker = config.existingWorker;
            // 重新绑定 listeners (因为 Pool 可能移除过)
            this.bindWorkerListeners();
        }
    }

    /**
     * 启动 Worker 并初始化 App
     */
    async start(): Promise<void> {
        if (this.status === 'closing' || this.closePromise || this.releasePromise) {
            throw new Error('Cannot start an App while shutdown is pending');
        }
        if (!this.worker) {
            // 创建新 Worker
            this.worker = new Worker(this.workerScriptPath, {
                workerData: {
                    appId: this.appId,
                    desktopId: this.desktopId,
                    appModulePath: this.appModulePath,
                },
            });
            this.bindWorkerListeners();
        }

        // 发送初始化消息
        // 注意: 即使是复用的 Worker，也需要发送 INIT 消息来加载 App 模块
        await this.sendLifecycleRequest({
            type: 'INIT',
            requestId: generateRequestId(),
            appId: this.appId,
            desktopId: this.desktopId,
            appModulePath: this.appModulePath,
            config: this.config, // ✨ Send config to Worker
            appInstanceId: this.appInstanceId, // Runtime-owned even when Shadow is off.
            ...(this.shadowReceiver ? { snapshotShadow: true } : {}),
            ...(this.enableReadOnlyViewTools ? { experimentalReadOnlyViewTools: true } : {}),
            ...(this.enableVersionedMutations ? { experimentalVersionedMutations: true } : {}),
        }, 'ready');
    }

    private bindWorkerListeners(): void {
        if (!this.worker) return;
        // 先移除旧的 (防止重复绑定)
        this.worker.removeAllListeners('message');
        this.worker.removeAllListeners('error');
        this.worker.removeAllListeners('exit');

        this.worker.on('message', this.workerMessageListener);
        this.worker.on('error', this.workerErrorListener);
        this.worker.on('exit', this.workerExitListener);
    }

    /**
     * 释放 Worker (用于归还给 Pool)
     * 
     * 会先发送 RESET 消息，成功后解绑监听器并返回 Worker 实例。
     */
    releaseWorker(): Promise<Worker | null> {
        // Only one caller receives ownership of the pooled Worker. Other
        // release callers still wait for RESET, but must not pool it twice.
        if (this.releasePromise) return this.releasePromise.then(() => null);
        if (!this.worker) return Promise.resolve(null);
        const closing = this.closePromise;
        const lifecycle = Promise.all([...this.lifecycleRequests]);
        this.status = 'closing';
        const release = async (): Promise<Worker | null> => {
            try {
                await Promise.all([closing, lifecycle, this.waitForFileReplacements()]);
                if (!this.worker || this.terminateAfterFileReplacement) return null;
                this.status = 'closing';
                // 1. 发送 RESET
                await this.sendRequest<void>({
                    type: 'RESET',
                    requestId: generateRequestId(),
                });

                const worker = this.worker;

                // 2. 解绑监听器
                worker.removeAllListeners('message');
                worker.removeAllListeners('error');
                worker.removeAllListeners('exit');

                this.worker = null;
                this.status = 'closed'; // Host 标记为关闭，但 Worker 存活
                this.shadowReceiver?.close();

                // 清理待处理请求
                this.cleanupPendingRequests();

                return worker;
            } catch (error) {
                console.error(`[AppWorkerHost] Failed to reset worker:`, error);
                // 如果重置失败，直接终止
                await this.waitForFileReplacements();
                this.terminate();
                return null;
            }
        };
        this.releasePromise = release().finally(() => { this.releasePromise = null; });
        return this.releasePromise;
    }

    private cleanupPendingRequests(): void {
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Worker released/terminated'));
        }
        this.pendingRequests.clear();
    }

    /**
     * 获取 Worker 状态
     */
    getStatus(): WorkerStatus {
        return this.status;
    }

    /** M2 diagnostic only. No snapshot data, Handler or live Ref is exposed. */
    getSnapshotShadowReport(): SnapshotShadowReport | null {
        return this.shadowReceiver?.report() ?? null;
    }


    /**
     * [RFC-001] 获取缓存的 Snapshot Fragment
     * 
     * 返回 Worker 最新推送的 Markdown + IndexMap + ViewTree，
     * 供 Desktop 聚合为 Desktop-level Snapshot。
     * 
     * [RFC-007] Added viewTree for Application View Tree section
     */
    getSnapshotFragment(): {
        markup: string;
        indexMap: Record<string, DataPayload>;
        views?: Array<{
            viewId: ViewID;
            viewType: string;
            viewName?: string;
            markup: string;
            timestamp: number;
        }>;
        viewTree?: string;
        timestamp?: number;
    } | null {
        if (!this.snapshotFragment) return null;
        return {
            markup: this.snapshotFragment.markup,
            indexMap: this.snapshotFragment.indexMap,
            views: this.snapshotFragment.views,
            viewTree: this.snapshotFragment.viewTree,  // [RFC-007]
            timestamp: (this.snapshotFragment as any).timestamp, // propagate fragment recency
        };
    }

    // ════════════════════════════════════════════════════════════════
    //  App 生命周期
    // ════════════════════════════════════════════════════════════════

    async open(): Promise<void> {
        if (this.status === 'closing') {
            throw new Error('Cannot reopen an App while shutdown is pending');
        }
        await this.sendLifecycleRequest({
            type: 'APP_OPEN',
            requestId: generateRequestId(),
        }, 'running');
    }

    async pause(): Promise<void> {
        if (this.status === 'closing' || this.status === 'closed') {
            throw new Error('Cannot pause an App while shutdown is pending');
        }
        await this.sendLifecycleRequest({
            type: 'APP_PAUSE',
            requestId: generateRequestId(),
        }, 'paused');
    }

    async resume(): Promise<void> {
        if (this.status === 'closing') {
            throw new Error('Cannot resume an App while shutdown is pending');
        }
        await this.sendLifecycleRequest({
            type: 'APP_RESUME',
            requestId: generateRequestId(),
        }, 'running');
    }

    async reinitialize(reason?: string): Promise<void> {
        if (this.status === 'closing' || this.status === 'closed') {
            throw new Error('Cannot reinitialize an App while shutdown is pending');
        }
        await this.sendLifecycleRequest({
            type: 'APP_REINITIALIZE',
            requestId: generateRequestId(),
            reason,
        });
    }

    close(): Promise<void> {
        // Multiple callers must share one shutdown, not send duplicate
        // APP_SHUTDOWN/APP_CLOSE requests to the same Worker.
        if (this.closePromise) return this.closePromise;
        if (this.releasePromise) return this.releasePromise.then(() => undefined);
        if (this.status === 'closed') return Promise.resolve();
        if (this.terminateAfterFileReplacement) return this.waitForFileReplacements();
        const lifecycle = Promise.all([...this.lifecycleRequests]);
        this.status = 'closing';
        const finish = async () => {
            try {
                await Promise.all([lifecycle, this.waitForFileReplacements()]);
                if (this.terminateAfterFileReplacement || !this.worker) {
                    this.terminate();
                    return;
                }
                await this.sendRequest<void>({
                    type: 'APP_SHUTDOWN',
                    requestId: generateRequestId(),
                });
                await this.sendRequest<void>({
                    type: 'APP_CLOSE',
                    requestId: generateRequestId(),
                });
                this.status = 'closed';
                this.shadowReceiver?.close();
            } catch (error) {
                await this.waitForFileReplacements();
                this.terminate();
                throw error;
            }
        };
        this.closePromise = finish().finally(() => { this.closePromise = null; });
        return this.closePromise;
    }

    /**
     * [RFC-015] Delete App (Data Cleanup)
     * 
     * Triggers app.onDelete() in worker to clean up persisted data.
     * Note: This does NOT close the worker, you must call close() after delete().
     */
    async delete(): Promise<void> {
        await this.sendRequest<void>({
            type: 'APP_DELETE',
            requestId: generateRequestId(),
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  View 生命周期
    // ════════════════════════════════════════════════════════════════

    async dismountView(viewId: ViewID): Promise<void> {
        await this.sendRequest<void>({
            type: 'VIEW_DISMOUNT',
            requestId: generateRequestId(),
            viewId,
        });
    }



    /**
     * [RFC-006] Mount view via ViewLink
     */
    async mountViewByLink(parentViewId: ViewID, linkId: string): Promise<void> {
        await this.sendRequest<void>({
            type: 'VIEW_MOUNT_BY_LINK',
            requestId: generateRequestId(),
            parentViewId,
            linkId,
        } as MainToWorkerMessage);
    }

    // ════════════════════════════════════════════════════════════════
    //  Operation
    // ════════════════════════════════════════════════════════════════

    async executeOperation(
        operation: OperationID,
        args: Record<string, unknown>,
        snapshotId: SnapshotID,
        viewId?: ViewID
    ): Promise<OperationResult> {
        return this.sendRequest<OperationResult>({
            type: viewId ? 'VIEW_OPERATION' : 'APP_OPERATION',
            requestId: generateRequestId(),
            viewId,
            operation,
            args,
            snapshotId,
        });
    }

    /**
     * M4 experimental: a source-bound, read-only View Tool invocation.
     * Requires explicit Host opt-in AND a caller-provided trusted policy.
     * Never used by the default Agent Tool router. Mutating Tools fail closed.
     */
    async executeReadOnlyViewTool(
        request: {
            snapshotId: string;
            toolId: string;
            viewId: string;
            args: Record<string, unknown>;
        },
        authorize: (context: {
            appId: string; snapshotId: string; toolId: string;
            viewId: string; viewInstanceId: string;
            args: Readonly<Record<string, unknown>>;
        }) => boolean | Promise<boolean>,
    ): Promise<OperationResult> {
        const reject = (code: string, message: string): OperationResult =>
            ({ success: false, error: { code, message } });
        if (!this.enableReadOnlyViewTools || !this.shadowReceiver || this.status !== 'running') {
            return reject('TOOL_UNAVAILABLE', 'Experimental View Tool execution is disabled');
        }
        const selection = this.shadowReceiver.selectToolSource({
            snapshotId: request.snapshotId,
            appId: String(this.appId),
            instanceId: this.appInstanceId,
            toolId: request.toolId,
            viewId: request.viewId,
        });
        if (selection.status !== 'found') {
            return reject(selection.issue.code, selection.issue.message);
        }
        try {
            if (selection.tool.isMutating) {
                return reject('TOOL_PERMISSION_DENIED', 'Mutating View Tools are not permitted');
            }
            let args: Record<string, unknown>;
            try {
                const copied = copyJson(request.args, {
                    maxDepth: 24, maxNodes: 10_000, maxApproxBytes: 128 * 1024,
                });
                if (!copied || Array.isArray(copied) || typeof copied !== 'object') {
                    return reject('OPERATION_INVALID_ARGS', 'Tool arguments must be an object');
                }
                args = copied as Record<string, unknown>;
            } catch {
                return reject('OPERATION_INVALID_ARGS', 'Tool arguments are not safe JSON data');
            }
            if (typeof authorize !== 'function' || !await authorize({
                appId: String(this.appId),
                snapshotId: selection.snapshotId,
                toolId: selection.tool.id,
                viewId: selection.target.viewId,
                viewInstanceId: selection.target.viewInstanceId,
                args,
            })) {
                return reject('TOOL_PERMISSION_DENIED', 'Tool authorization was not granted');
            }
            if (this.status !== 'running') {
                return reject('APP_STOPPED', 'App is no longer running');
            }
            // Authorization may await external state. Re-check Store and TTL
            // after it resolves, before handing the source to the Worker.
            const stillCurrent = this.shadowReceiver.selectToolSource({
                snapshotId: request.snapshotId,
                appId: String(this.appId),
                instanceId: this.appInstanceId,
                toolId: request.toolId,
                viewId: request.viewId,
            });
            if (stillCurrent.status !== 'found') {
                return reject(stillCurrent.issue.code, stillCurrent.issue.message);
            }
            stillCurrent.release();
            return await this.sendRequest<OperationResult>({
                type: 'VIEW_TOOL_INVOKE',
                requestId: generateRequestId(),
                appId: this.appId,
                instanceId: this.appInstanceId,
                tool: selection.tool,
                target: selection.target,
                args,
            });
        } catch (error) {
            return reject('VIEW_TOOL_DISPATCH_FAILED',
                error instanceof Error ? error.message : 'View Tool dispatch failed');
        } finally {
            selection.release();
        }
    }

    /**
     * M4 Stage 6 experimental File mutation. NOT the default Agent Tool path.
     * A trusted Controller supplies both the policy and an actual version-CAS
     * resource adapter. The Worker validates its LIVE Tool binding but never
     * runs a mutating SDK Handler; Core never imports filesystem dependencies.
     *
     * Cross-process noncooperating writes and async View teardown can still
     * race a committed filesystem operation. This is NOT a Strict grant.
     */
    async executeVersionedFileReplace(
        request: {
            snapshotId: string; toolId: string; viewId: string; refId: string;
            newContent: string;
        },
        authorize: (scope: Readonly<{
            appId: string; appInstanceId: string; snapshotId: string; toolId: string;
            viewId: string; viewInstanceId: string;
            filePath: string; expectedVersion: string; newContent: string;
        }>) => boolean | Promise<boolean>,
        replace: (source: Readonly<{
            filePath: string; expectedVersion: string; newContent: string;
        }>) => Promise<
            | { status: 'written'; version: string; cleanupWarning?: string }
            | { status: 'conflict'; currentVersion: string }
        >,
    ): Promise<OperationResult> {
        const denied = (code: string, message: string): OperationResult =>
            ({ success: false, error: { code, message } });
        if (!this.enableVersionedMutations || !this.shadowReceiver || this.status !== 'running') {
            return denied('TOOL_UNAVAILABLE', 'Versioned mutations are disabled');
        }
        // Treat the caller's JS object like untrusted data. Freeze a single
        // checked request BEFORE any async policy/Worker round trip; otherwise
        // accessors or mutations could change the target/content mid-flight.
        let stableRequest: Readonly<typeof request>;
        try {
            const copied = copyJson(request, {
                maxDepth: 2, maxNodes: 12, maxApproxBytes: 4 * 1024 * 1024 + 8192,
            });
            if (!copied || typeof copied !== 'object' || Array.isArray(copied)) {
                throw new Error('Expected a request object');
            }
            const fields = Object.keys(copied);
            const values = copied as Readonly<Record<string, unknown>>;
            const required = ['snapshotId', 'toolId', 'viewId', 'refId', 'newContent'];
            if (fields.length !== required.length || required.some(field =>
                typeof values[field] !== 'string' ||
                (field !== 'newContent' && !(values[field] as string).trim()))) {
                throw new Error('Invalid request field');
            }
            stableRequest = copied as unknown as typeof request;
            if (Buffer.byteLength(stableRequest.newContent, 'utf8') > 4 * 1024 * 1024) {
                throw new Error('File content exceeds size limit');
            }
        } catch {
            return denied('OPERATION_INVALID_ARGS',
                'Expected a plain, getter-free request with UTF-8 text no larger than 4 MiB');
        }
        const sourceRequest = {
            snapshotId: stableRequest.snapshotId,
            appId: String(this.appId),
            instanceId: this.appInstanceId,
            toolId: stableRequest.toolId,
            viewId: stableRequest.viewId,
            refId: stableRequest.refId,
        };
        let selection: ReturnType<SnapshotShadowReceiver['selectVersionedEntitySource']>;
        try {
            selection = this.shadowReceiver.selectVersionedEntitySource(sourceRequest);
        } catch {
            return denied('RESOURCE_MUTATION_FAILED', 'Versioned source acquisition failed');
        }
        if (selection.status !== 'found') {
            return denied(selection.issue.code, selection.issue.message);
        }
        try {
            if (selection.resource.entityType !== 'File' ||
                !/^sha256:[0-9a-f]{64}$/.test(selection.resource.entityVersion)) {
                return denied('RESOURCE_VERSION_REQUIRED', 'Expected a versioned File entity');
            }
            if (selection.tool.name !== 'replace_file') {
                return denied('TOOL_PERMISSION_DENIED',
                    'File replacement requires an explicitly declared replace_file Tool');
            }
            if (typeof authorize !== 'function' || typeof replace !== 'function') {
                return denied('TOOL_PERMISSION_DENIED', 'Trusted policy and file adapter required');
            }
            const unobserved = () => {
                const changed = this.unobservedFileVersions.get(selection.resource.entityId);
                return changed !== undefined && changed !== selection.resource.entityVersion;
            };
            if (unobserved()) {
                return denied('SNAPSHOT_SOURCE_CONFLICT',
                    'File mutation has not yet been reflected in the V2 Snapshot');
            }
            const write = Object.freeze({
                filePath: selection.resource.entityId,
                expectedVersion: selection.resource.entityVersion,
                newContent: stableRequest.newContent,
            });
            const scope = Object.freeze({
                appId: String(this.appId), appInstanceId: this.appInstanceId,
                snapshotId: selection.snapshotId, toolId: selection.tool.id,
                viewId: selection.target.viewId, viewInstanceId: selection.target.viewInstanceId,
                ...write,
            });
            if (await authorize(scope) !== true) {
                return denied('TOOL_PERMISSION_DENIED', 'File mutation policy denied this request');
            }
            if (this.status !== 'running') {
                return denied('APP_STOPPED', 'App closed before file mutation');
            }
            // An async policy may finish after a View/tool/ref or File version
            // changed. Re-acquire the current Store source after every await.
            const fresh = this.shadowReceiver.selectVersionedEntitySource(sourceRequest);
            if (fresh.status !== 'found') return denied(fresh.issue.code, fresh.issue.message);
            fresh.release();
            if (unobserved()) return denied('SNAPSHOT_SOURCE_CONFLICT',
                'Another File mutation completed during authorization');

            const verified = await this.sendRequest<OperationResult>({
                type: 'VIEW_TOOL_VALIDATE',
                requestId: generateRequestId(),
                appId: this.appId,
                instanceId: this.appInstanceId,
                tool: selection.tool,
                target: selection.target,
            });
            if (!verified.success) return verified;
            if (this.status !== 'running') return denied('APP_STOPPED', 'App closed before file mutation');

            // A Worker round-trip can also race a Source revision.
            const last = this.shadowReceiver.selectVersionedEntitySource(sourceRequest);
            if (last.status !== 'found') return denied(last.issue.code, last.issue.message);
            last.release();
            if (unobserved()) return denied('SNAPSHOT_SOURCE_CONFLICT',
                'Another File mutation completed before the write');
            // The CAS adapter is trusted, but an exception can occur AFTER a
            // successful rename. Do not falsely claim the disk write failed.
            // Reserve synchronously before awaiting the adapter. Even identical
            // content may replace the inode, so a concurrent source cannot replay.
            this.unobservedFileVersions.set(write.filePath, 'outcome-pending');
            this.activeFileReplacements++;
            try {
                let result: Awaited<ReturnType<typeof replace>>;
                try {
                    const copied = copyJson(await replace(write), {
                        maxDepth: 2, maxNodes: 8, maxApproxBytes: 8192,
                    });
                    if (!copied || typeof copied !== 'object' || Array.isArray(copied)) {
                        throw new Error('Invalid adapter result');
                    }
                    const fields = Object.keys(copied);
                    const value = copied as Readonly<Record<string, unknown>>;
                    const conflict = value.status === 'conflict';
                    const allowed = conflict ? ['status', 'currentVersion'] : ['status', 'version', 'cleanupWarning'];
                    const version = conflict ? value.currentVersion : value.version;
                    if ((!conflict && value.status !== 'written') ||
                        fields.some(field => !allowed.includes(field)) ||
                        typeof version !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(version) ||
                        ('cleanupWarning' in value && typeof value.cleanupWarning !== 'string')) {
                        throw new Error('Invalid adapter result');
                    }
                    result = copied as unknown as Awaited<ReturnType<typeof replace>>;
                } catch {
                    this.unobservedFileVersions.set(write.filePath, 'outcome-unknown');
                    return denied('RESOURCE_OUTCOME_UNKNOWN',
                        'File adapter outcome unknown; inspect disk and refresh the App before retrying');
                }
                if (result.status === 'conflict') {
                    this.unobservedFileVersions.delete(write.filePath);
                    return denied('RESOURCE_VERSION_STALE', 'File changed since the source Snapshot');
                }
                // Same-content writes and unknown outcomes cannot be proved
                // fresh by a content hash; retain their fail-closed fence.
                this.unobservedFileVersions.set(write.filePath,
                    result.version === write.expectedVersion ? 'version-unchanged' : result.version);
                return { success: true, data: {
                    filePath: write.filePath, version: result.version,
                    ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}),
                } };
            } finally {
                this.activeFileReplacements--;
                if (this.activeFileReplacements === 0) {
                    for (const resume of this.fileReplacementWaiters.splice(0)) resume();
                }
            }
        } catch {
            // Thrown JS values can also contain accessors or Proxy traps.
            return denied('RESOURCE_MUTATION_FAILED', 'Versioned file validation or authorization failed');
        } finally {
            selection.release();
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  External Event
    // ════════════════════════════════════════════════════════════════

    async sendExternalEvent(
        viewId: ViewID,
        eventType: string,
        data: Record<string, unknown>
    ): Promise<void> {
        await this.sendRequest<void>({
            type: 'EXTERNAL_EVENT',
            requestId: generateRequestId(),
            viewId,
            eventType,
            data,
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  Render
    // ════════════════════════════════════════════════════════════════


    // ════════════════════════════════════════════════════════════════
    //  [RFC-011] LLM Output Channel
    // ════════════════════════════════════════════════════════════════

    /**
     * [RFC-011] Push LLM text to Worker for SDK's useLLMOutputChannel
     * [RFC-020] Now accepts structured payload { reasoning?, content? }
     * 
     * Fire-and-forget: no response expected from Worker
     */
    pushLLMOutput(
        payload: { reasoning?: string; content?: string },
        type: 'complete',
        meta?: {
            model?: string;
            usage?: {
                promptTokens: number;
                completionTokens: number;
                totalTokens: number;
            };
        }
    ): void {
        if (this.status === 'closing' || this.status === 'closed') return;
        if (!this.worker) {
            console.warn('[AppWorkerHost] Cannot push LLM text: Worker not started');
            return;
        }

        const totalLength = (payload.reasoning?.length ?? 0) + (payload.content?.length ?? 0);
        console.log(`[AppWorkerHost] Pushing LLM text to Worker ${this.appId}, total length: ${totalLength}`);

        this.worker.postMessage({
            type: 'LLM_OUTPUT_PUSH',
            reasoning: payload.reasoning,
            content: payload.content,
            eventType: type,
            timestamp: Date.now(),
            meta,
        } as MainToWorkerMessage);
    }


    // ════════════════════════════════════════════════════════════════
    //  Terminate
    // ════════════════════════════════════════════════════════════════

    terminate(): void {
        if (this.activeFileReplacements > 0) {
            this.status = 'closing';
            if (!this.terminateAfterFileReplacement) {
                this.terminateAfterFileReplacement = true;
                void this.waitForFileReplacements().then(() => this.terminate());
            }
            return;
        }
        this.terminateAfterFileReplacement = false;
        if (this.worker) {
            const worker = this.worker;
            this.worker = null;
            worker.off('message', this.workerMessageListener);
            worker.off('error', this.workerErrorListener);
            worker.off('exit', this.workerExitListener);
            try {
                worker.postMessage({ type: 'TERMINATE' } as MainToWorkerMessage);
            } catch {
                // A broken channel must not prevent the native teardown.
            }
            void Promise.resolve(worker.terminate()).catch(() => undefined);
        }
        this.status = 'closed';
        this.shadowReceiver?.close();

        // 清理所有待处理请求
        this.cleanupPendingRequests();


    }

    // ════════════════════════════════════════════════════════════════
    //  Internal
    // ════════════════════════════════════════════════════════════════

    private async sendLifecycleRequest(
        message: MainToWorkerMessage, nextStatus?: WorkerStatus,
    ): Promise<void> {
        if (this.status === 'closing' || this.closePromise || this.releasePromise) {
            throw new Error('Cannot change App lifecycle while shutdown is pending');
        }
        const pending = this.sendRequest<void>(message);
        this.lifecycleRequests.add(pending);
        try {
            await pending;
            if (this.getStatus() === 'closing' || this.closePromise || this.releasePromise) {
                throw new Error('App shutdown is pending; lifecycle response cannot reopen it');
            }
            if (nextStatus) this.status = nextStatus;
        } finally {
            this.lifecycleRequests.delete(pending);
        }
    }

    private sendRequest<T>(message: MainToWorkerMessage): Promise<T> {
        return new Promise((resolve, reject) => {
            if (this.status === 'closing' &&
                !['APP_SHUTDOWN', 'APP_CLOSE', 'RESET'].includes(message.type)) {
                reject(new Error('Cannot send a new request while App shutdown is pending'));
                return;
            }
            if (!this.worker) {
                reject(new Error('Worker not started'));
                return;
            }

            const requestId = (message as any).requestId;
            if (!requestId) {
                reject(new Error('Message missing requestId'));
                return;
            }

            // 设置超时
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request ${requestId} timed out after ${this.timeout}ms`));
            }, this.timeout);

            // 注册待处理请求
            this.pendingRequests.set(requestId, { resolve, reject, timeout });

            // 发送消息
            this.worker.postMessage(message);
        });
    }

    private handleMessage(msg: WorkerToMainMessage): void {
        // 处理响应消息
        if (isResponse(msg)) {
            const pending = this.pendingRequests.get(msg.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(msg.requestId);

                if (msg.success) {
                    // 根据响应类型提取结果
                    if (msg.type === 'OPERATION_RESPONSE') {
                        pending.resolve((msg as any).result);
                    } else {
                        pending.resolve(undefined);
                    }
                } else {
                    pending.reject(new Error((msg as any).error?.message || 'Unknown error'));
                }
            }
            return;
        }

        // 处理 Worker 主动请求
        if (isRequest(msg)) {
            switch (msg.type) {
                case 'REQUEST_UPDATE':
                    this.onUpdateRequest?.();
                    break;
                case 'REQUEST_MOUNT_CHILD':
                    this.onMountChildRequest?.((msg as any).viewId);
                    break;
                case 'REQUEST_DISMOUNT_CHILD':
                    this.onDismountChildRequest?.((msg as any).viewId);
                    break;
            }
            return;
        }

        // M2: Shadow is an optional, read-only side channel. Never emit a legacy
        // update, dispatch a Tool, or replace the legacy Snapshot from these messages.
        if (msg.type === 'SNAPSHOT_PREPARED') {
            try {
                this.shadowReceiver?.acceptPrepared(msg.draft);
            } catch {
                // Shadow diagnostic failures must not affect the existing App path.
            }
            return;
        }
        if (msg.type === 'SNAPSHOT_PREPARE_FAILED') {
            try {
                this.shadowReceiver?.acceptPrepareFailure({
                    appId: msg.appId,
                    instanceId: msg.instanceId,
                    producerSeq: msg.producerSeq,
                    sourceEpoch: msg.sourceEpoch,
                    issue: {
                        code: msg.error?.code === 'SNAPSHOT_SERIALIZATION_ERROR'
                            ? 'SNAPSHOT_SERIALIZATION_ERROR' : 'SNAPSHOT_INVALID',
                        message: typeof msg.error?.message === 'string'
                            ? msg.error.message.slice(0, 160) : 'Shadow producer failed',
                    },
                });
            } catch {
                // Same isolation policy as SNAPSHOT_PREPARED.
            }
            return;
        }

        // [RFC-001] 处理 Snapshot Fragment 推送 (legacy execution path)
        if (isSnapshotFragment(msg)) {
            const fragment = msg as SnapshotFragmentPush;
            // console.log(`[AppWorkerHost] Received SNAPSHOT_FRAGMENT, markup length: ${fragment.markup?.length || 0}`);
            // The physical Worker message channel is ordered. A millisecond
            // timestamp is NOT a generation ID: distinct updates may share it.
            // Reject a different App/instance, never silently drop a valid frame.
            if (fragment.appId !== this.appId ||
                (fragment.appInstanceId && fragment.appInstanceId !== this.appInstanceId) ||
                (fragment.shadowInstanceId && fragment.shadowInstanceId !== this.appInstanceId)) {
                return;
            }
            if (fragment.shadowCaptureSeq !== undefined) {
                if (!Number.isSafeInteger(fragment.shadowCaptureSeq) ||
                    fragment.shadowCaptureSeq <= this.lastLegacyCaptureSeq) return;
                this.lastLegacyCaptureSeq = fragment.shadowCaptureSeq;
            }
            this.snapshotFragment = {
                markup: fragment.markup,
                indexMap: fragment.indexMap,
                views: fragment.views,
                viewTree: fragment.viewTree,
                timestamp: fragment.timestamp,
            };
            this.shadowReceiver?.observeLegacy(fragment);
            if (!fragment.suppressSignal) this.onUpdateRequest?.();
            return;
        }


    }

    private handleError(error: Error): void {
        this.shadowReceiver?.close();
        console.error(`[AppWorkerHost] Worker ${this.appId} error:`, error);
        this.status = 'error';
        this.cleanupPendingRequests();
    }

    private handleExit(code: number): void {
        this.shadowReceiver?.close();
        if (code !== 0) {
            console.error(`[AppWorkerHost] Worker ${this.appId} exited with code ${code}`);
        }
        this.worker = null;
        if (this.status !== 'closed') {
            this.status = 'error';
        }
        this.cleanupPendingRequests();
    }
}
