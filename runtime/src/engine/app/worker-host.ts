import { APP_LIFECYCLE_PROTOCOL, STATE_SESSION_PROTOCOL } from '@aotui/core';
import { WORKER_PROTOCOL } from '../../spi/worker-protocol/types.js';
import { initializationError } from '../../adapters/initialization-error.js';
import { captureAppLifecycleAck, captureAppCleanupReport } from '../../adapters/app-lifecycle-protocol.js';
import type { AppCleanupReport } from '../../spi/runtime/app-lifecycle.interface.js';
import type { createStateStorageHost } from './state-storage-host.js';
import type { StateStorageBackend } from '@aotui/core/persistence';
import type { ManagedPersistenceReport } from '../../adapters/storage/state-storage-protocol.js';
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

import { appInteractionUnavailable, type AppInteractionOptions, type AppInteractionResult, type WorkerInteraction } from '../../spi/runtime/app-interaction.interface.js';
import { checkWireJson, normalizeProjectionLimits } from '@aotui/core';
import { captureSnapshotDraftEnvelope, captureSnapshotPrepareIssue, projectCompleteViews,
    type SnapshotDraftEnvelope } from '@aotui/core/host';
import type { ProjectionLimits, ViewIdentity } from '@aotui/core';
import type { AppWindows, ViewCloseResult } from '../../spi/runtime/windows.js';
import { capturePolicy, captureProjectionLimits, captureToolsEnabled } from './interaction-config.js';
import { TOOL_REQUEST_LIMITS } from '@aotui/core/producer';
import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SemanticSnapshotReceiver, type SemanticSnapshotReport } from '../../adapters/snapshot/receiver.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, InteractionStats,
    InvocationContext, InvocationSource, AppInteractionPolicy } from '@aotui/core';
import { captureToolInvocationTerminal } from '../../adapters/worker-message-capture.js';
import type { WorkerCapacity } from './worker-capacity.js';
import { closeError } from '../core/close-handle.js';
import { createWorkerInteraction, ProjectionRefreshFailure } from './worker-interaction.js';
import type { UpdateSignal } from '../../spi/core/signals.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { AppID, DesktopID } from '@aotui/core';
import { WORKER_DEFAULTS, type WorkerConfig } from '../../spi/config/index.js';

import {
    generateRequestId,
    type RequestID,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
} from '../../spi/worker-protocol/index.js';

// Compute default worker script path relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_WORKER_SCRIPT = resolve(__dirname, '../../worker-runtime/index.js');
const claimedWorkers = new WeakSet<Worker>();

/**
 * 待处理请求
 */
type WorkerLifecycle = { worker: Worker; version: number };

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout?: ReturnType<typeof setTimeout>;
    init?: { worker: Worker; version: number; handled?: true };
    tool?: { worker: Worker; appId: string; instanceId: string; completion: Promise<ExecutionFact> };
    initialOpen?: true;
    persistence?: true;
    appCleanup?: 'APP_STOP' | 'APP_CLOSE';
    projection?: WorkerLifecycle & { known?: SnapshotDraftEnvelope; timedOut?: true };
}

/**
 * AppWorkerHost 配置
 */
/**
 * AppWorkerHost 配置
 */
export interface AppWorkerHostConfig extends AppInteractionOptions {
    readonly policy?: AppInteractionPolicy;
    persistenceBackend?: StateStorageBackend;
    manifestPersistence?: typeof STATE_SESSION_PROTOCOL | null;
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
    /** A fresh dedicated Worker, for adapters that supply the thread themselves. */
    existingWorker?: Worker;
    workerCapacity?: WorkerCapacity;
    config?: import('@aotui/core').AppLaunchConfig; // Configuration Injection
    runtimeConfig?: { worker: WorkerConfig };
}

/**
 * Worker 状态
 */
export type WorkerStatus = 'starting' | 'ready' | 'running' | 'closing' | 'closed' | 'error';
export interface HostResourceReport {
    readonly state: 'active' | 'closing' | 'settled';
    readonly worker: 'not-created' | 'owned' | 'retiring' | 'exited';
    readonly appCleanup?: Readonly<{ support: 'offered' | 'managed' | 'rejected'; report?: AppCleanupReport }>;
    readonly storage?: NonNullable<ReturnType<AppWorkerHost['getPersistenceReport']>>;
    readonly interactions: { readonly closed: boolean; readonly retainedOperations: number };
    readonly closingInvocation?: NonNullable<InteractionStats['closingInvocation']>;
    readonly resourcesReleased: boolean;
    readonly issues: readonly ('WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED')[];
}


const DEFAULT_APP_INTERACTION_POLICY: AppInteractionPolicy = Object.freeze({
    project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true,
});
/** AppWorkerHost - 主线程端 Worker 管理 */
export class AppWorkerHost {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly name?: string;
    private readonly config?: import('@aotui/core').AppLaunchConfig;
    private readonly projectionLimits: ProjectionLimits;

    private worker: Worker | null = null;
    private status: WorkerStatus = 'starting';
    private pendingRequests = new Map<RequestID, PendingRequest>();
    private readonly timeout: number;
    private readonly appModulePath: string;
    private readonly workerScriptPath: string;
    /** Assigned by the Runtime per logical App execution; distinct from Worker thread ID. */
    readonly appInstanceId: string;
    private readonly snapshotReceiver: SemanticSnapshotReceiver;
    private projectionRefresh?: { requestId: RequestID; promise: Promise<void> };
    private projectionBaseline?: WorkerLifecycle;
    private readonly toolsEnabled: boolean;
    private readyWorker: { worker: Worker; version: number } | null = null;
    private interactionsClosed = false;
    private readonly interaction: WorkerInteraction;
    private readonly interactionBindings = new WeakMap<InvocationSource, ExecutionBinding>();
    private closePromise: Promise<void> | null = null;
    private readonly workerCapacity?: WorkerCapacity;
    private releaseCapacity?: () => void;
    private readonly lifecycleRequests = new Set<Promise<void>>();
    private lifecycleContextVersion = 0;
    private initAttempted = false;
    private readonly manifestPersistence: AppWorkerHostConfig['manifestPersistence'];
    private readonly openPersistenceHost: (ack: unknown) => Promise<ReturnType<typeof createStateStorageHost>>;
    private persistenceHost?: ReturnType<typeof createStateStorageHost>;
    private persistenceUnsafe = false;
    private lastPersistence?: ManagedPersistenceReport;
    private appLifecycleSupport: 'offered' | 'managed' | 'rejected' = 'offered';
    private lastAppCleanup?: AppCleanupReport;

    getPersistenceReport() {
        if (!this.persistenceHost) return;
        return Object.freeze({ unsafe: this.persistenceUnsafe, ...this.persistenceHost.getStats(),
            ...(this.lastPersistence ? { lifecycle: this.lastPersistence } : {}) });
    }
    private resourceWorkerState: HostResourceReport['worker'] = 'not-created';
    private actualExitResolve!: () => void;
    private readonly actualExit = new Promise<void>(resolve => { this.actualExitResolve = resolve; });
    private terminationRequested = false;
    private resourceReleaseStarted = false;
    private resourceSettled = false;
    private resourcePromise?: Promise<HostResourceReport>;
    private readonly resourceIssues = new Set<HostResourceReport['issues'][number]>();

    getResourceReport(): HostResourceReport {
        const storage = this.getPersistenceReport();
        const core = this.snapshotReceiver?.getInteractionStats();
        const interactions = Object.freeze({ closed: this.interactionsClosed, retainedOperations: core ? core.activeInvocations + core.activeReads + core.observations.observationSlots + core.borrowedSnapshots : 0 });
        const resourcesReleased = ['not-created', 'exited'].includes(this.resourceWorkerState) &&
            (!storage || storage.release?.status === 'released' && storage.pending === 0) &&
            interactions.closed && interactions.retainedOperations === 0;
        return Object.freeze({ state: this.resourceSettled ? 'settled' : this.resourceReleaseStarted || this.closePromise ? 'closing' : 'active',
            appCleanup: Object.freeze({ support: this.appLifecycleSupport, ...(this.lastAppCleanup ? { report: this.lastAppCleanup } : {}) }),
            worker: this.resourceWorkerState, ...(storage ? { storage } : {}), interactions, resourcesReleased,
            ...(core?.closingInvocation ? { closingInvocation: core.closingInvocation } : {}),
            issues: Object.freeze([...this.resourceIssues]) });
    }
    waitForResourceRelease(): Promise<HostResourceReport> {
        if (!this.resourceReleaseStarted) return Promise.reject(Object.assign(new Error('Resource release has not started'), { code: 'RESOURCE_RELEASE_NOT_STARTED' }));
        if (!this.resourcePromise) {
            this.resourcePromise = Promise.resolve().then(async () => {
                await this.waitForWorkerExit();
                await this.persistenceHost?.disconnect();
                await this.snapshotReceiver.close();
                this.resourceSettled = true;return this.getResourceReport();
            });
            void this.resourcePromise.catch(() => {});
        }
        return this.resourcePromise;
    }
    retryResourceRelease(): Promise<HostResourceReport> {
        const current = this.getResourceReport();
        const storage = this.persistenceHost;
        if (!storage || current.state !== 'settled' || !current.storage?.ownerRetained) return this.waitForResourceRelease();
        this.resourceSettled = false;
        return this.resourcePromise = storage.release().then(() => {
            this.resourceSettled = true;
            return this.getResourceReport();
        });
    }

    private beginResourceRelease(): void {
        if (this.resourceReleaseStarted) return;
        this.resourceReleaseStarted = true;
        void this.waitForResourceRelease().catch(() => {});
    }

    private waitForWorkerExit(): Promise<void> {
        return this.worker ? this.actualExit : Promise.resolve();
    }

    private workerMessageListener!: (message: WorkerToMainMessage) => void;
    private workerErrorListener!: (error: Error) => void;
    private workerExitListener!: (code: number) => void;

    beginInteractionClose(): void {
        if (this.interactionsClosed) return;
        this.interactionsClosed = true;
        this.revokeInteraction();
    }

    private revokeInteraction(): void {
        this.projectionBaseline = undefined;
        if (this.projectionRefresh) {
            const { requestId } = this.projectionRefresh;
            const pending = this.pendingRequests.get(requestId);
            if (pending) this.finishProjection(requestId, pending, closeError('PROJECTION_CLOSED'));
            this.projectionRefresh = undefined;
        }
        this.readyWorker = null;
        if (this.interactionsClosed) void this.snapshotReceiver.close();
        else void this.snapshotReceiver.closeInteractions();
    }

    canExecuteTools(): boolean {
        return this.toolsEnabled && !this.interactionsClosed && this.readyWorker?.worker === this.worker &&
            this.readyWorker?.version === this.lifecycleContextVersion;
    }

    private pendingTool() {
        for (const pending of this.pendingRequests.values()) if (pending.tool) return pending.tool;
    }

    private interactionAvailable(): boolean {
        return !this.interactionsClosed && !!this.snapshotReceiver && !!this.worker &&
            this.status === 'running' && !this.closePromise;
    }

    getWindows(): AppWindows {
        return {
            appId: this.appId, instanceId: this.appInstanceId,
            views: this.snapshotReceiver.currentViews().map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId,
                name: view.name, type: view.type, region: view.region, canClose: !!view.canClose && this.canExecuteTools() })),
        };
    }

    async closeView(target: ViewIdentity, confirmTurn?: () => void): Promise<ViewCloseResult> {
        try { await this.refreshAuthority(); }
        catch { return { status: 'rejected', issue: { code: 'VIEW_CLOSE_UNAVAILABLE', message: 'The current View could not be confirmed.' } }; }
        confirmTurn?.();
        const view = this.snapshotReceiver.currentViews().find(view => view.id === target.viewId && view.viewInstanceId === target.viewInstanceId);
        if (!view) return { status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED', message: 'The selected View closed or was replaced.' } };
        if (!view.canClose || !this.canExecuteTools() || !this.interactionAvailable() || this.pendingTool())
            return { status: 'rejected', issue: { code: 'VIEW_CLOSE_UNAVAILABLE', message: 'This View has no available close action.' } };
        const dispatched = this.dispatchViewOperation({ type: 'VIEW_CLOSE', requestId: generateRequestId(), appId: this.appId,
            instanceId: this.appInstanceId, viewId: target.viewId, viewInstanceId: target.viewInstanceId }, this.worker!);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const fact = await Promise.race([dispatched, new Promise<ExecutionFact>(resolve => {
                timer = setTimeout(() => resolve({ kind: 'unknown' }), this.timeout);
            })]);
            if (fact.kind !== 'tool-result')
                return { status: 'unknown', issue: { code: 'VIEW_CLOSE_RESULT_UNKNOWN', message: 'The close result is still unconfirmed. Check the current window before retrying.' } };
            if (!fact.result.success) return { status: 'rejected', issue: fact.result.error, result: fact.result };
            try { await this.refreshAuthority(); }
            catch { return { status: 'accepted', result: fact.result }; }
            const stillMounted = this.snapshotReceiver.currentViews().some(current => current.viewInstanceId === target.viewInstanceId);
            return { status: !this.interactionAvailable() || stillMounted ? 'accepted' : 'closed', result: fact.result };
        } finally { clearTimeout(timer); }
    }

    getAppInteraction(): AppInteractionResult {
        if (!this.interactionAvailable()) return appInteractionUnavailable();
        return Object.freeze({ status: 'ready', interaction: this.interaction });
    }

    private refreshProjection(): Promise<void> {
        if (!this.interactionAvailable()) return Promise.reject(Object.assign(new Error('Projection source unavailable'), { code: 'PROJECTION_CLOSED' }));
        if (!this.projectionRefresh) {
            const requestId = generateRequestId();
            const known = this.ownsProjection(this.projectionBaseline) ? this.snapshotReceiver.currentPublication() : undefined;
            const promise = this.sendRequest<void>({ type: 'FLUSH_PROJECTION', requestId, ...(known ? { known } : {}) });
            if (!this.pendingRequests.has(requestId)) return promise;
            this.projectionRefresh = { requestId, promise };
        }
        return this.projectionRefresh.promise;
    }

    private async refreshAuthority(): Promise<void> {
        // An earlier read can already have sampled the Worker. Confirm again for the current operation.
        await this.projectionRefresh?.promise.catch(() => {});
        return this.refreshProjection();
    }

    private ownsProjection(owner?: WorkerLifecycle): boolean {
        return !!owner && owner.worker === this.worker && owner.version === this.lifecycleContextVersion;
    }

    private finishProjection(requestId: RequestID, pending: PendingRequest, error?: Error): void {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        if (this.projectionRefresh?.requestId === requestId) this.projectionRefresh = undefined;
        if (error) pending.reject(error);
        else pending.resolve(undefined);
    }

    private readonly resolveInteractionSource = (source: InvocationSource): ExecutionBinding | null => {
        if (!this.interactionAvailable() || source.appId !== String(this.appId) || source.instanceId !== this.appInstanceId) return null;
        const existing = this.interactionBindings.get(source);
        if (existing) return existing;
        if (!this.canExecuteTools()) return null;
        const { id, name, viewType } = source.tool;
        const tool = Object.freeze({ id, name, viewType });
        const worker = this.worker!, version = this.lifecycleContextVersion;
        const binding: ExecutionBinding = Object.freeze({ identity: Object.freeze({}),
            isLive: () => this.interactionAvailable() && this.worker === worker &&
                this.lifecycleContextVersion === version && this.canExecuteTools(),
            execute: (context: InvocationContext) => this.dispatchTool({ type: 'VIEW_TOOL_INVOKE', requestId: generateRequestId(),
                appId: source.appId as AppID, instanceId: source.instanceId, tool, receiver: source.receiver,
                effectiveArgs: context.effectiveInput,
                localRefs: context.refSources.filter(ref => ref.appId === source.appId && ref.instanceId === source.instanceId)
                    .map(({ param, index, viewId, viewInstanceId, refId }) =>
                        ({ param, ...(index === undefined ? {} : { index }), viewId, viewInstanceId, refId })),
            }, { worker, version, signal: context.signal }),
        });
        this.interactionBindings.set(source, binding);
        return binding;
    };

    private dispatchTool(message: import('../../spi/worker-protocol/messages.js').ViewToolInvokeMessage,
        expected: { worker: Worker; version: number; signal: CancellationSignal }): ExecutionFact | Promise<ExecutionFact> {
        const refused = (code: string, text: string): ExecutionFact => ({ kind: 'tool-result', phase: 'not-entered',
            result: { success: false, error: { code, message: text } } });
        const live = () => this.interactionAvailable() && this.canExecuteTools() &&
            this.worker === expected.worker && this.lifecycleContextVersion === expected.version && !expected.signal.aborted;
        if (!live() || this.pendingTool()) return refused('TOOL_EXECUTION_UNAVAILABLE', 'Worker Tool execution is unavailable');
        try { checkWireJson(message, TOOL_REQUEST_LIMITS); }
        catch { return refused('REF_ARGUMENT_BUDGET_EXCEEDED', 'Complete Ref request exceeds the transport budget'); }
        if (!live() || this.pendingTool()) return refused('TOOL_EXECUTION_UNAVAILABLE', 'Worker Tool execution is unavailable');
        return this.dispatchViewOperation(message, expected.worker);
    }

    private dispatchViewOperation(message: Extract<MainToWorkerMessage, { type: 'VIEW_TOOL_INVOKE' | 'VIEW_CLOSE' }>, worker: Worker): Promise<ExecutionFact> {
        const { requestId, appId, instanceId } = message;
        let resolve!: (fact: ExecutionFact) => void;
        const completion = new Promise<ExecutionFact>(complete => { resolve = complete; });
        this.pendingRequests.set(requestId, { resolve, reject: () => {},
            tool: { worker, appId, instanceId, completion } });
        try { worker.postMessage(message); }
        catch { /* Without a terminal or exit, this attempt cannot prove completion. */ }
        return completion;
    }

    private settleToolExit(worker: Worker): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.tool?.worker !== worker) continue;
            this.pendingRequests.delete(id);
            pending.resolve({ kind: 'unknown' } satisfies ExecutionFact);
        }
    }

    // Notify the Desktop when an App publication changes.
    onUpdate?: (reason: UpdateSignal['reason']) => void;
    constructor(config: AppWorkerHostConfig, cwd = process.cwd()) {
        const toolsEnabled = captureToolsEnabled(config);
        const policy = capturePolicy(config.policy) ?? DEFAULT_APP_INTERACTION_POLICY;
        this.projectionLimits = captureProjectionLimits(config);
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.appModulePath = config.appModulePath;
        this.appInstanceId = randomUUID();
        this.toolsEnabled = toolsEnabled !== false;
        this.snapshotReceiver = new SemanticSnapshotReceiver(String(this.appId), this.appInstanceId);
        // [C1 Fix] Default to Runtime's built-in worker-runtime
        this.workerScriptPath = config.workerScriptPath ? resolve(config.workerScriptPath) : DEFAULT_WORKER_SCRIPT;

        const workerConfig = config.runtimeConfig?.worker ?? WORKER_DEFAULTS;
        this.timeout = config.timeout ?? workerConfig.timeoutMs;
        if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 300000) throw new Error('INVALID_INPUT: Worker timeout must be 1–300000 ms');
        const backend = config.persistenceBackend, dataDirectory = config.config?.AOTUI_DATA_DIR;
        this.manifestPersistence = config.manifestPersistence;
        this.openPersistenceHost = async ack => {
            const { capturePersistenceAck, DEFAULT_STATE_TRANSPORT_LIMITS } = await import('../../adapters/storage/state-storage-protocol.js');
            if (!capturePersistenceAck(ack, this.appInstanceId)) throw closeError('PERSISTENCE_UNAVAILABLE');
            const { createStateStorageHost, resolveStateDirectory } = await import('./state-storage-host.js');
            return createStateStorageHost({ instanceId: this.appInstanceId, desktopId: String(this.desktopId),
                rootDirectory: resolveStateDirectory(dataDirectory, cwd), backend,
                limits: { ...DEFAULT_STATE_TRANSPORT_LIMITS, timeoutMs: this.timeout } });
        };

        this.config = config.config;
        this.workerCapacity = config.workerCapacity;
        this.interaction = createWorkerInteraction({ receiver: this.snapshotReceiver,
            available: () => this.interactionAvailable(), refresh: () => this.refreshProjection(), refreshAuthority: () => this.refreshAuthority(),
            canExecuteTools: () => this.canExecuteTools(), resolve: this.resolveInteractionSource,
            policy, limits: this.projectionLimits, timeoutMs: this.timeout });
        if (config.existingWorker) {
            this.releaseCapacity = this.workerCapacity?.reserve();
            try { this.bindWorker(config.existingWorker); }
            catch (error) { this.releaseCapacity?.();throw error; }
        }
    }

    /**
     * 启动 Worker 并初始化 App
     */
    async start(): Promise<void> {
        if (this.initAttempted || this.status === 'closed' || this.status === 'error') throw new Error('APP_INSTANCE_REUSE_UNSUPPORTED: Create a new Host for another initialization');
        this.initAttempted = true;
        if (this.status === 'closing' || this.closePromise) {
            throw new Error('Cannot start an App while shutdown is pending');
        }
        try {
            if (!this.worker) {
                this.releaseCapacity = this.workerCapacity?.reserve();
                try {
                    this.bindWorker(new Worker(this.workerScriptPath, { workerData: {
                        appId: this.appId, desktopId: this.desktopId, appModulePath: this.appModulePath,
                    } }));
                } catch (error) {
                    this.releaseCapacity?.();
                    this.releaseCapacity = undefined;
                    throw error;
                }
            }
            await this.sendLifecycleRequest({
                type: 'INIT',
                requestId: generateRequestId(),
                appId: this.appId,
                desktopId: this.desktopId,
                appModulePath: this.appModulePath,
                ...(this.name === undefined ? {} : { appName: this.name }),
                config: this.config, // ✨ Send config to Worker
                ...(this.manifestPersistence === undefined ? {} : { manifestPersistence: this.manifestPersistence }),
                timeoutMs: this.timeout,
                appInstanceId: this.appInstanceId,
                projectionLimits: this.projectionLimits,
                appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, instanceId: this.appInstanceId },
                protocol: WORKER_PROTOCOL, toolsEnabled: this.toolsEnabled,
            }, 'ready');
        } catch (error) {
            if (!this.closePromise) {
                this.terminate();
                await this.waitForWorkerExit();
            }
            throw error;
        }
    }

    private bindWorker(worker: Worker): void {
        if (claimedWorkers.has(worker)) throw closeError('APP_INSTANCE_REUSE_UNSUPPORTED');
        claimedWorkers.add(worker);
        this.worker = worker;
        this.resourceWorkerState = 'owned';
        this.workerMessageListener = msg => { if (this.worker === worker) this.handleMessage(msg); };
        this.workerErrorListener = error => { if (this.worker === worker) this.handleError(error); };
        this.workerExitListener = code => this.handleExit(worker, code);
        worker.on('message', this.workerMessageListener);
        worker.on('error', this.workerErrorListener);
        worker.once('exit', this.workerExitListener);
        if (worker.threadId < 0) this.handleExit(worker);
    }

    private cleanupPendingRequests(): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.tool) continue;
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(id);
            pending.reject(new Error('Worker released/terminated'));
        }
    }

    /**
     * 获取 Worker 状态
     */
    getStatus(): WorkerStatus {
        return this.status;
    }

    /** Report projection health and source metadata. */
    getSemanticSnapshotReport(): SemanticSnapshotReport | null {
        return this.snapshotReceiver?.report() ?? null;
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

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        if (this.terminationRequested || !this.worker) {
            this.closePromise = this.waitForWorkerExit();
            this.terminate();
            return this.closePromise;
        }
        this.status = 'closing';
        const graceEndsAt = performance.now() + this.timeout;
        const lifecycle = [...this.lifecycleRequests];
        let stopped: Promise<void> | undefined;
        this.closePromise = Promise.resolve().then(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const remaining = graceEndsAt - performance.now();
                if (remaining <= 0) throw closeError('APP_CLOSE_DEADLINE_EXCEEDED');
                const deadline = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(closeError('APP_CLOSE_DEADLINE_EXCEEDED')), remaining);
                });
                await Promise.race([this.finishAppClose(lifecycle, stopped), deadline, this.actualExit.then(() => {
                    throw closeError('WORKER_EXITED_UNEXPECTEDLY');
                })]);
            } finally {
                clearTimeout(timer);
                this.terminate();
                await this.waitForWorkerExit();
            }
        });
        this.beginInteractionClose();
        stopped = this.sendRequest<void>({ type: 'APP_STOP', requestId: generateRequestId() });
        void stopped.catch(() => {});
        void this.closePromise.catch(() => {});
        return this.closePromise;
    }

    private async finishAppClose(lifecycle: Promise<void>[], stopped?: Promise<void>): Promise<void> {
        await Promise.allSettled([...lifecycle, stopped]);
        await this.pendingTool()?.completion;
        if (this.terminationRequested || !this.worker) throw closeError('APP_CLOSE_FAILED');
        // An interrupted INIT with no accepted App has only a thread to release.
        if (this.appLifecycleSupport !== 'managed') return;
        let failure: unknown;
        try { await stopped; } catch (error) { failure = error; }
        try { await this.sendRequest<void>({ type: 'APP_CLOSE', requestId: generateRequestId() }); }
        catch (error) { failure ??= error; }
        const storage = this.persistenceHost;
        // An idle session never contacted storage, so the Host stops its own admission here.
        if (storage?.getStats().highWater === 0 && this.lastPersistence?.ok) await storage.disconnect();
        if (this.persistenceHost && (!this.lastPersistence?.ok || storage?.getStats().uncertain ||
            storage?.getStats().release?.status !== 'released')) {
            this.persistenceUnsafe = true;
            failure ??= closeError('PERSISTENCE_CLOSE_FAILED');
        }
        if (failure) throw failure;
    }

    // ════════════════════════════════════════════════════════════════
    //  Terminate
    // ════════════════════════════════════════════════════════════════

    terminate(): void {
        if (this.terminationRequested) return;
        this.terminationRequested = true;
        this.lifecycleContextVersion++;
        if (this.status !== 'error') this.status = 'closed';
        this.beginInteractionClose();
        if (this.persistenceHost && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
        this.cleanupPendingRequests();
        this.beginResourceRelease();
        const worker = this.worker;
        if (!worker) return;
        this.resourceWorkerState = 'retiring';
        const failed = () => { this.resourceIssues.add('WORKER_TERMINATION_FAILED'); };
        try { void Promise.resolve(worker.terminate()).then(code => this.handleExit(worker, code), failed); }
        catch { failed(); }
    }

    // ════════════════════════════════════════════════════════════════
    //  Internal
    // ════════════════════════════════════════════════════════════════

    private async sendLifecycleRequest(
        message: import('../../spi/worker-protocol/messages.js').InitMessage | import('../../spi/worker-protocol/messages.js').AppLifecycleMessage,
        nextStatus?: WorkerStatus,
    ): Promise<void> {
        if (this.status === 'closing' || this.status === 'closed' || this.closePromise) {
            throw new Error('Cannot change App lifecycle while shutdown is pending');
        }
        if (message.type === 'INIT') this.lifecycleContextVersion++;
        const worker = this.worker;
        const contextVersion = this.lifecycleContextVersion;
        const pending = this.sendRequest<void>(message);
        this.lifecycleRequests.add(pending);
        try {
            await pending;
            if (this.worker !== worker || this.lifecycleContextVersion !== contextVersion) {
                throw new Error('App lifecycle request was invalidated by a Worker or execution context change');
            }
            if (this.getStatus() === 'closing' || this.closePromise) {
                throw new Error('App shutdown is pending; lifecycle response cannot reopen it');
            }
            if (nextStatus) this.status = nextStatus;
        } finally {
            this.lifecycleRequests.delete(pending);
        }
    }

    private sendRequest<T>(message: Exclude<MainToWorkerMessage, { type: 'VIEW_TOOL_INVOKE' | 'VIEW_CLOSE' }>): Promise<T> {
        const appCleanup = message.type === 'APP_STOP' || message.type === 'APP_CLOSE' ? message.type : undefined;
        if (appCleanup) {
            this.lifecycleContextVersion++;
            this.revokeInteraction();
        }
        return new Promise((resolve, reject) => {
            if (this.terminationRequested || (this.status === 'closing' || this.status === 'closed') && !appCleanup) {
                reject(new Error('Cannot send a new request while App shutdown is pending'));
                return;
            }
            const worker = this.worker;
            if (!worker) { reject(new Error('Worker not started')); return; }
            const requestId = 'requestId' in message ? message.requestId : undefined;
            if (!requestId) { reject(new Error('Message missing requestId')); return; }
            const projection: PendingRequest['projection'] = message.type === 'FLUSH_PROJECTION'
                ? { worker, version: this.lifecycleContextVersion, ...(message.known ? { known: message.known } : {}) } : undefined;
            const timeout = setTimeout(() => {
                // A timed-out flush still owns its Worker wait. Keep the single
                // slot until the real reply or App close, rather than stacking retries.
                if (projection) projection.timedOut = true;
                else this.pendingRequests.delete(requestId);
                reject(Object.assign(new Error(`Request ${requestId} timed out after ${this.timeout}ms`),
                    projection ? { code: 'PROJECTION_TIMEOUT' } : {}));
            }, this.timeout);
            this.pendingRequests.set(requestId, { resolve, reject, timeout,
                ...(projection ? { projection } : {}),
                ...(message.type === 'APP_OPEN' ? { initialOpen: true as const } : {}),
                ...(this.appLifecycleSupport === 'managed' && appCleanup ? { appCleanup } : {}),
                ...(this.persistenceHost && message.type === 'APP_CLOSE' ? { persistence: true as const } : {}),
                ...(message.type === 'INIT' ? { init: { worker, version: this.lifecycleContextVersion } } : {}),
            });
            try { worker.postMessage(message); }
            catch {
                clearTimeout(timeout);
                this.pendingRequests.delete(requestId);
                reject(new Error('Worker request could not be sent'));
            }
        });
    }

    private async acceptInitialization(id: RequestID, pending: PendingRequest,
        msg: Extract<WorkerToMainMessage, { type: 'INIT_RESPONSE' | 'LIFECYCLE_RESPONSE' | 'ERROR_RESPONSE' }>): Promise<void> {
        const init = pending.init!;
        if (init.handled) return;
        init.handled = true;
        const current = () => this.pendingRequests.get(id) === pending && this.worker === init.worker;
        let error: unknown;
        try {
            if (msg.type === 'ERROR_RESPONSE' && msg.success === false)
                throw initializationError(msg.error, String(this.appId), 'INIT');
            if (msg.type !== 'INIT_RESPONSE' || msg.success !== true)
                throw closeError('APP_INIT_ACK_INVALID');
            if (msg.protocol !== WORKER_PROTOCOL) throw closeError('WORKER_PROTOCOL_UNSUPPORTED');
            if (!captureAppLifecycleAck(msg.appLifecycle, this.appInstanceId))
                throw closeError('APP_LIFECYCLE_NEGOTIATION_FAILED');
            if (msg.toolsEnabled !== this.toolsEnabled || msg.appInstanceId !== this.appInstanceId)
                throw closeError('APP_INIT_ACK_INVALID');
            const path = 'INIT_RESPONSE.projectionLimits';
            try {
                const limits = normalizeProjectionLimits(msg.projectionLimits, path, true);
                if (!isDeepStrictEqual(this.projectionLimits, limits)) throw new Error('Must match the effective limits sent in INIT');
            } catch (cause) {
                throw Object.assign(closeError('APP_INIT_ACK_INVALID'), { path: (cause as { path?: string })?.path ?? path });
            }
            const hasPersistence = Object.hasOwn(msg, 'persistence');
            if (this.manifestPersistence !== undefined && hasPersistence !== (this.manifestPersistence === STATE_SESSION_PROTOCOL))
                throw closeError('PERSISTENCE_UNAVAILABLE');
            if (hasPersistence) {
                const host = await this.openPersistenceHost(msg.persistence);
                if (!current()) return;
                this.persistenceHost = host;
            }
            this.appLifecycleSupport = 'managed';
            if (!this.interactionsClosed && init.version === this.lifecycleContextVersion) this.readyWorker = init;
        } catch (cause) {
            this.appLifecycleSupport = 'rejected';
            error = cause;
        }
        if (!current()) return;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        if (error) pending.reject(error instanceof Error ? error : closeError('APP_INIT_ACK_INVALID'));
        else pending.resolve(undefined);
    }

    private handleMessage(msg: WorkerToMainMessage): void {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'APP_EVENT') {
            if (this.interactionAvailable() && msg.appId === this.appId && msg.instanceId === this.appInstanceId &&
                (msg.reason === 'view_updated' || msg.reason === 'projection_recovered' || msg.reason === 'attention_requested'))
                this.onUpdate?.(msg.reason);
            return;
        }
        if (msg.type === 'STATE_STORAGE_REQUEST') {
            const storage = this.persistenceHost;
            if (!storage || this.terminationRequested) return;
            const worker = this.worker, response = storage.accept(msg);
            if (response) void response.then(value => {
                if (!worker || worker !== this.worker || this.terminationRequested) return;
                try { worker.postMessage(value); }
                catch { this.persistenceUnsafe = true;storage.markTransportUncertain();this.terminate(); }
            });
            return;
        }
        const id = 'requestId' in msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
        const pending = id === undefined ? undefined : this.pendingRequests.get(id);
        if (id !== undefined && pending?.tool) {
            const { worker, appId, instanceId } = pending.tool;
            if (worker !== this.worker || msg.type !== 'VIEW_TOOL_INVOKE_RESPONSE') return;
            const terminal = captureToolInvocationTerminal(msg, { requestId: id, appId, instanceId });
            if (!terminal) return;
            this.pendingRequests.delete(id);
            pending.resolve(terminal.phase === 'finished-unknown' ? { kind: 'unknown' } : { kind: 'tool-result', ...terminal } satisfies ExecutionFact);
            return;
        }
        if (msg.type === 'PROJECTION_CURRENT') {
            if (id === undefined || !pending?.projection) return;
            const projection = pending.projection;
            if (!this.ownsProjection(projection)) {
                this.finishProjection(id, pending, closeError('PROJECTION_CLOSED'));
            } else if (projection.timedOut) {
                this.finishProjection(id, pending);
            } else if (projection.known && Reflect.ownKeys(msg).length === 6 &&
                isDeepStrictEqual(captureSnapshotDraftEnvelope(msg), projection.known) &&
                isDeepStrictEqual(this.snapshotReceiver.currentPublication(), projection.known)) {
                this.finishProjection(id, pending);
            } else {
                this.projectionBaseline = undefined;
                this.finishProjection(id, pending, closeError('OBSERVATION_REFRESH_FAILED'));
            }
            return;
        }
        if ((msg.type === 'INIT_RESPONSE' || msg.type === 'LIFECYCLE_RESPONSE' || msg.type === 'ERROR_RESPONSE') &&
            typeof id === 'string' && 'success' in msg) {
            if (pending) {
                if (pending.projection) {
                    const current = this.ownsProjection(pending.projection);
                    if (current && !pending.projection.timedOut) this.projectionBaseline = undefined;
                    this.finishProjection(id, pending, closeError(current ? 'OBSERVATION_REFRESH_FAILED' : 'PROJECTION_CLOSED'));
                    return;
                }
                let appCleanupFailed = false;
                let appCleanupSucceeded = false;
                let appUnmountFailed = msg.type === 'LIFECYCLE_RESPONSE' && pending.appCleanup === 'APP_CLOSE' &&
                    msg.error?.code === 'APP_UNMOUNT_FAILED';
                let persistenceFailed = false;
                let lifecycleTerminalMismatch = false;
                if (pending.init) {
                    void this.acceptInitialization(id, pending, msg);
                    return;
                }
                const error = msg.type === 'INIT_RESPONSE' ? undefined : msg.error;
                if (pending.initialOpen && msg.success !== true) {
                    // A failed APP_OPEN can already have closed its storage session.
                    // Keep its storage receipt and reject with the original App error.
                    const persistence = msg.type === 'LIFECYCLE_RESPONSE'
                        ? this.persistenceHost?.captureReport(msg.persistence) : undefined;
                    if (persistence) this.lastPersistence = persistence;
                    if (this.persistenceHost && !persistence?.ok &&
                        !(this.closePromise && msg.type === 'ERROR_RESPONSE' && error?.code === 'E_OPEN_INVALIDATED'))
                        this.persistenceUnsafe = true;

                    const cleanup = msg.type === 'LIFECYCLE_RESPONSE'
                        ? captureAppCleanupReport(msg.appCleanup, this.appInstanceId) : null;
                    if (cleanup && cleanup.state !== 'active') this.lastAppCleanup = cleanup;
                    clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                    pending.reject(initializationError(error, String(this.appId), 'OPEN'));
                    return;
                }
                if (pending.appCleanup) {
                    const report = msg.type === 'LIFECYCLE_RESPONSE' ? captureAppCleanupReport(msg.appCleanup, this.appInstanceId) : null;
                    const validPhase = report && report.state !== 'active' &&
                        (pending.appCleanup === 'APP_CLOSE' ? ['completed', 'failed'].includes(report.state) : ['stopped', 'failed'].includes(report.state));
                    if (validPhase) this.lastAppCleanup = report;
                    appCleanupSucceeded = !!validPhase && report.issues.length === 0 &&
                        (pending.appCleanup === 'APP_CLOSE' ? report.state === 'completed' : report.state === 'stopped');
                    // Only APP_CLOSE combines application and storage terminal facts.
                    appCleanupFailed = !validPhase || !appCleanupSucceeded ||
                        pending.appCleanup !== 'APP_CLOSE' && msg.success !== true;
                }
                if (pending.persistence) {
                    const report = msg.type === 'LIFECYCLE_RESPONSE'
                        ? this.persistenceHost?.captureReport(msg.persistence) : undefined;
                    if (report) this.lastPersistence = report;
                    appUnmountFailed ||= report?.unmount === 'failed';
                    persistenceFailed = report?.ok !== true;
                    if (persistenceFailed) this.persistenceUnsafe = true;

                    const expectedTerminalSuccess = (!pending.appCleanup || appCleanupSucceeded) && !appUnmountFailed && !persistenceFailed;
                    lifecycleTerminalMismatch = msg.success !== expectedTerminalSuccess;
                    if (lifecycleTerminalMismatch) this.persistenceUnsafe = true;
                }

                // Validate the facts independently before using the combined terminal bit. In particular,
                // APP_CLOSE success includes both lifecycle cleanup and persistence completion.
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(msg.requestId);

                if (appCleanupFailed) pending.reject(closeError('APP_CLEANUP_FAILED'));
                else if (appUnmountFailed) pending.reject(closeError('APP_UNMOUNT_FAILED'));
                else if (persistenceFailed || lifecycleTerminalMismatch) pending.reject(closeError('PERSISTENCE_CLOSE_FAILED'));
                else if (msg.success === true) pending.resolve(undefined);
                else {
                    pending.reject(new Error(typeof error?.message === 'string' ? error.message : 'Unknown error'));
                }
            }
            return;
        }

        if (msg.type === 'SNAPSHOT_PREPARED' || msg.type === 'SNAPSHOT_PREPARE_FAILED') {
            const projection = pending?.projection;
            if (id !== undefined && projection && !this.ownsProjection(projection)) {
                this.finishProjection(id, pending!, closeError('PROJECTION_CLOSED'));
                return;
            }
            try {
                const result = msg.type === 'SNAPSHOT_PREPARED'
                    ? this.snapshotReceiver.acceptPrepared(msg.draft)
                    : this.snapshotReceiver.acceptPrepareFailure({
                        appId: msg.appId, instanceId: msg.instanceId,
                        producerSeq: msg.producerSeq, sourceEpoch: msg.sourceEpoch,
                        issue: captureSnapshotPrepareIssue(msg.error),
                    });
                if (id !== undefined && projection) {
                    if (!projection.timedOut) this.projectionBaseline = result.status === 'rejected' ? undefined
                        : { worker: projection.worker, version: projection.version };
                    this.finishProjection(id, pending!, result.status === 'rejected' ? new ProjectionRefreshFailure(result.issue) : undefined);
                } else if (id === undefined && this.worker && result.status !== 'rejected' && !this.interactionsClosed) {
                    this.projectionBaseline = { worker: this.worker, version: this.lifecycleContextVersion };
                }
                if (result.status === 'rejected' && result.healthChanged) this.onUpdate?.('projection_failed');
            } catch {
                this.handleError(new Error('Semantic snapshot reception failed'));
            }
            return;
        }



    }

    private handleError(_error: Error): void {
        this.resourceIssues.add('WORKER_ERROR');
        this.beginInteractionClose();
        if (this.persistenceHost && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
        this.lifecycleContextVersion++;
        console.error('[AppWorkerHost] Worker failed for App', this.appId);
        if (!this.terminationRequested) this.status = 'error';
        this.cleanupPendingRequests();
    }

    private handleExit(worker: Worker, code?: number): void {
        if (this.worker !== worker) return;
        if (!this.terminationRequested) {
            this.resourceIssues.add('WORKER_EXITED_UNEXPECTEDLY');
            this.status = 'error';
            if (code) console.error(`[AppWorkerHost] Worker ${this.appId} exited with code ${code}`);
        }
        if (this.persistenceHost && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
        this.lifecycleContextVersion++;
        worker.off('message', this.workerMessageListener);
        worker.off('error', this.workerErrorListener);
        worker.off('exit', this.workerExitListener);
        this.worker = null;
        this.resourceWorkerState = 'exited';
        this.settleToolExit(worker);
        this.releaseCapacity?.();
        this.releaseCapacity = undefined;
        this.actualExitResolve();
        this.beginInteractionClose();
        this.cleanupPendingRequests();
        this.beginResourceRelease();
    }
}
