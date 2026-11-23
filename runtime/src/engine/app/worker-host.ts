import { APP_LIFECYCLE_PROTOCOL } from '@aotui/core';
import { APP_LIFECYCLE_VERSION } from '../../spi/runtime/app-lifecycle.interface.js';
import { STATE_SESSION_VERSION } from '../../adapters/storage/state-storage-protocol.js';
import { WORKER_PROTOCOL } from '../../spi/worker-protocol/types.js';
import { initializationError } from '../../adapters/initialization-error.js';
import { captureAppLifecycleAck, captureAppCleanupReport } from '../../adapters/app-lifecycle-protocol.js';
import { withToolAuthorization } from '../../adapters/tool-execution-policy.js';
import type { AppCleanupReport } from '../../spi/runtime/app-lifecycle.interface.js';
import { createStateStorageHost, resolveStateDirectory, type StateStorageBackend } from './state-storage-host.js';
import { capturePersistenceAck, captureManagedPersistenceReport, DEFAULT_STATE_SESSION_LIMITS, DEFAULT_STATE_TRANSPORT_LIMITS, STATE_SESSION_PROTOCOL } from '../../adapters/storage/state-storage-protocol.js';
import type { ManagedPersistenceReport } from '../../worker-runtime/state-persistence.js';
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

import { appInteractionUnavailable, type AppInteractionOptions, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import { normalizeProjectionLimits, projectCompleteViews } from '@aotui/core/internal';
import type { ObservationWindowSelection, ProjectionLimits, ViewIdentity, ViewWindowAccess } from '@aotui/core';
import type { AppWindows, ViewCloseResult } from '../../spi/runtime/windows.js';
import { captureProjectionLimits, captureToolsEnabled } from './interaction-config.js';
import { captureToolInvocation } from '../../adapters/tool-invocation.js';
import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SemanticSnapshotReceiver, type SemanticSnapshotReport } from '../../adapters/snapshot/receiver.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, AppInteraction, InstanceInteraction, InteractionStats,
    InvocationContext, InvocationSource, Issue, AppInteractionPolicy, ReceiptQuery, RequestSources } from '@aotui/core/internal';
import { forwardRequestSource } from '@aotui/core/internal';
import { captureSnapshotDraftEnvelope, captureSnapshotPrepareIssue, type SnapshotDraftEnvelope } from '@aotui/core/internal';
import { captureToolInvocationTerminal } from '../../adapters/worker-message-capture.js';
import type { WorkerCapacity } from './worker-capacity.js';
import { closeError } from '../core/close-handle.js';
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
    init?: { worker: Worker; version: number };
    tool?: { worker: Worker; appId: string; instanceId: string; completion: Promise<ExecutionFact> };
    initialOpen?: true;
    persistence?: true;
    appCleanup?: 'APP_STOP' | 'APP_SHUTDOWN' | 'APP_CLOSE';
    projection?: WorkerLifecycle & { known?: SnapshotDraftEnvelope; timedOut?: true };
}

/**
 * AppWorkerHost 配置
 */
/**
 * AppWorkerHost 配置
 */
export interface AppWorkerHostConfig extends AppInteractionOptions {
    persistenceBackend?: StateStorageBackend;
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
    readonly storage: ReturnType<AppWorkerHost['getPersistenceReport']>;
    readonly interactions: { readonly closed: boolean; readonly retainedOperations: number; readonly retainedBytes: number };
    readonly resourcesReleased: boolean;
    readonly issues: readonly ('WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED')[];
}


/** Only a validated snapshot rejection can expose details through an observation. */
class ProjectionRefreshFailure extends Error {
    readonly issue: Issue;

    constructor({ code, message, path }: Issue) {
        super(message);
        this.issue = Object.freeze({ code, message, ...(path === undefined ? {} : { path }) });
    }
}

const DEFAULT_APP_INTERACTION_POLICY: AppInteractionPolicy = Object.freeze({
    project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true,
});
const unusedStorageStats: ReturnType<ReturnType<typeof createStateStorageHost>['getStats']> = Object.freeze({
    highWater: 0, closing: false, opening: false, pending: 0, actualIO: 0, bufferedBytes: 0, ownerRetained: false, uncertain: false,
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
    private windowRevision = 0;
    private appWindowEpoch = 0;
    private appNote: string | undefined;
    private readonly viewWindows = new Map<string, { epoch: number; note?: string }>();
    private projectionRefresh?: { requestId: RequestID; promise: Promise<void> };
    private projectionBaseline?: WorkerLifecycle;
    private readonly toolsEnabled: boolean;
    private readyWorker: { worker: Worker; version: number } | null = null;
    private interactionsClosed = false;
    private instanceInteraction?: InstanceInteraction;
    private interactionPolicy?: AppInteractionPolicy;
    private observing = false;
    private readonly interactionBindings = new WeakMap<InvocationSource, ExecutionBinding>();
    private closePromise: Promise<void> | null = null;
    private readonly workerCapacity?: WorkerCapacity;
    private releaseCapacity?: () => void;
    private readonly lifecycleRequests = new Set<Promise<void>>();
    private lifecycleContextVersion = 0;
    private initAttempted = false;
    private readonly openPersistenceHost: () => ReturnType<typeof createStateStorageHost>;
    private persistenceHost?: ReturnType<typeof createStateStorageHost>;
    private persistenceSupport: 'offered' | 'managed' | 'rejected' | 'not-used' = 'offered';
    private persistenceUnsafe = false;
    private lastPersistence?: ManagedPersistenceReport;
    private appLifecycleSupport: 'offered' | 'managed' | 'rejected' = 'offered';
    private appStopRequested = false;
    private appStopPromise?: Promise<void>;
    private lastAppCleanup?: AppCleanupReport;

    getPersistenceReport() {
        return Object.freeze({ support: this.persistenceSupport, unsafe: this.persistenceUnsafe,
            ...(this.persistenceHost?.getStats() ?? unusedStorageStats), ...(this.lastPersistence ? { lifecycle: this.lastPersistence } : {}) });
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
        const interactions = Object.freeze({ closed: this.interactionsClosed, retainedOperations: core ? core.activeInvocations + core.activeReads + core.observations.reservations : 0, retainedBytes: core?.combinedBytes ?? 0 });
        const resourcesReleased = ['not-created', 'exited'].includes(this.resourceWorkerState) &&
            (!this.persistenceHost || storage.release?.status === 'released') && !storage.opening && storage.pending === 0 &&
            interactions.closed && interactions.retainedOperations === 0 && interactions.retainedBytes === 0;
        return Object.freeze({ state: this.resourceSettled ? 'settled' : this.resourceReleaseStarted || this.closePromise ? 'closing' : 'active',
            appCleanup: Object.freeze({ support: this.appLifecycleSupport, ...(this.lastAppCleanup ? { report: this.lastAppCleanup } : {}) }),
            worker: this.resourceWorkerState, storage, interactions, resourcesReleased,
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
        if (!storage || current.state !== 'settled' || !current.storage.ownerRetained) return this.waitForResourceRelease();
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
        this.appNote = undefined;
        this.viewWindows.clear();
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
        this.interactionPolicy = undefined;
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

    get collapseNote(): string | undefined { return this.appNote; }

    getWindows(): AppWindows {
        return {
            appId: this.appId, instanceId: this.appInstanceId, revision: this.windowRevision,
            ...(this.appNote === undefined ? {} : { note: this.appNote }),
            views: this.snapshotReceiver.currentViews().map(view => {
                const note = this.viewWindows.get(view.viewInstanceId)?.note;
                return { viewId: view.id, viewInstanceId: view.viewInstanceId, name: view.name,
                    type: view.type, region: view.region, canClose: !!view.canClose && this.canExecuteTools(),
                    ...(note === undefined ? {} : { note }) };
            }),
        };
    }

    private readonly windowAccess: ViewWindowAccess = ({ viewInstanceId }) => {
        const window = this.viewWindows.get(viewInstanceId);
        return { epoch: Math.max(this.appWindowEpoch, window?.epoch ?? 0),
            expanded: this.appNote === undefined && window?.note === undefined };
    };

    setAppWindow(note: string | undefined): void {
        if (note !== undefined && typeof note !== 'string') throw closeError('WINDOW_NOTE_INVALID');
        if (note === this.appNote) return;
        this.windowRevision++;
        if (note !== undefined) this.appWindowEpoch = this.windowRevision;
        this.appNote = note;
    }

    setViewWindow(target: ViewIdentity, note: string | undefined): void {
        if (!this.snapshotReceiver.currentViews().some(view =>
            view.id === target.viewId && view.viewInstanceId === target.viewInstanceId)) throw closeError('VIEW_INSTANCE_REVOKED');
        if (note !== undefined && typeof note !== 'string') throw closeError('WINDOW_NOTE_INVALID');
        const previous = this.viewWindows.get(target.viewInstanceId);
        if (previous?.note === note) return;
        this.windowRevision++;
        this.viewWindows.set(target.viewInstanceId, note === undefined ? { epoch: previous!.epoch }
            : { epoch: this.windowRevision, note });
    }

    async closeView(target: ViewIdentity): Promise<ViewCloseResult> {
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
            const stillMounted = this.snapshotReceiver.currentViews().some(current => current.viewInstanceId === target.viewInstanceId);
            return { status: !this.interactionAvailable() || stillMounted ? 'accepted' : 'closed', result: fact.result };
        } finally { clearTimeout(timer); }
    }

    getAppInteraction(policy?: AppInteractionPolicy): AppInteractionResult {
        if (!this.interactionAvailable()) return appInteractionUnavailable();
        if (policy !== undefined) {
            if (this.interactionPolicy && this.interactionPolicy !== policy) {
                return { status: 'rejected', issue: { code: 'APP_INTERACTION_POLICY_CONFLICT',
                    message: 'This instance already uses an interaction policy.' } };
            }
            try { this.attachInteraction(policy); }
            catch { return { status: 'rejected', issue: { code: 'APP_INTERACTION_POLICY_INVALID',
                message: 'Expected trusted projection, execution and receipt authorization callbacks.' } }; }
            if (!this.interactionAvailable()) return appInteractionUnavailable();
        }
        return Object.freeze({ status: 'ready', interaction: this.interaction });
    }

    private attachInteraction(policy = DEFAULT_APP_INTERACTION_POLICY): InstanceInteraction {
        if (!this.instanceInteraction) {
            const execution = { resolve: this.resolveInteractionSource };
            this.instanceInteraction = this.snapshotReceiver.interaction(
                withToolAuthorization(policy, () => this.canExecuteTools()), execution, this.projectionLimits, this.windowAccess);
            forwardRequestSource(this.interaction, this.instanceInteraction);
            this.interactionPolicy = policy;
        }
        return this.instanceInteraction;
    }

    private readonly interaction: AppInteraction = Object.freeze({
        observe: async (selection: unknown) => {
            if (!this.interactionAvailable()) return appInteractionUnavailable();
            if (this.observing) return { status: 'rejected' as const, issue: { code: 'OBSERVATION_BUSY', message: 'An observation is already being prepared.' } };
            this.observing = true;
            try {
                await this.refreshProjection();
                if (!this.interactionAvailable()) return appInteractionUnavailable();
                return await this.attachInteraction().observe(selection);
            } catch (error) { return this.projectionRejection(error); }
            finally { this.observing = false; }
        },
        preview: async () => {
            if (!this.interactionAvailable()) return appInteractionUnavailable();
            try {
                await this.refreshProjection();
                return this.interactionAvailable() ? this.snapshotReceiver.preview() : appInteractionUnavailable();
            } catch (error) { return this.projectionRejection(error); }
        },
        adoptObservation: (id: string, selection?: ObservationWindowSelection) => this.interactionAvailable() && this.instanceInteraction
            ? this.instanceInteraction.adoptObservation(id, selection) : appInteractionUnavailable(),
        releaseObservation: (id: string) => { this.instanceInteraction?.releaseObservation(id); },
        invoke: (request: unknown, timeoutMs?: number, sources?: RequestSources, signal?: CancellationSignal) => this.interactionAvailable() && this.instanceInteraction
            ? this.instanceInteraction.invoke(request, timeoutMs ?? this.timeout, sources, signal)
            : Promise.resolve({ kind: 'refused' as const, ...appInteractionUnavailable().issue }),
        readReceipt: (query: ReceiptQuery, timeoutMs?: number) => this.interactionAvailable() && this.instanceInteraction
            ? this.instanceInteraction.readReceipt(query, timeoutMs ?? this.timeout)
            : Promise.resolve({ kind: 'unavailable' as const, ...appInteractionUnavailable().issue }),
    });

    private projectionRejection(error: unknown): Extract<AppInteractionResult, { status: 'rejected' }> {
        if (error instanceof ProjectionRefreshFailure) return Object.freeze({ status: 'rejected', issue: error.issue });
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'OBSERVATION_REFRESH_FAILED';
        return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: 'Committed projection could not be observed' }) });
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

    getInteractionReport(): Readonly<{ toolsEnabled: boolean; workerToolPending: boolean; core: InteractionStats }> | null {
        const core = this.snapshotReceiver?.getInteractionStats();
        return core ? Object.freeze({
            toolsEnabled: this.canExecuteTools(),
            workerToolPending: !!this.pendingTool(), core,
        }) : null;
    }

    private readonly resolveInteractionSource = (source: InvocationSource): ExecutionBinding | null => {
        if (!this.interactionAvailable() || source.appId !== String(this.appId) || source.instanceId !== this.appInstanceId) return null;
        const existing = this.interactionBindings.get(source);
        if (existing) return existing;
        if (!this.canExecuteTools()) return null;
        const { nameSharedAcrossViewTypes: _sharedName, ...tool } = source.tool;
        const worker = this.worker!, version = this.lifecycleContextVersion;
        const binding: ExecutionBinding = Object.freeze({ identity: Object.freeze({}),
            isLive: () => ({ ok: this.interactionAvailable() && this.worker === worker &&
                this.lifecycleContextVersion === version && this.canExecuteTools() }),
            execute: (context: InvocationContext) => this.dispatchTool({ type: 'VIEW_TOOL_INVOKE', requestId: generateRequestId(),
                appId: source.appId as AppID, instanceId: source.instanceId, snapshotId: source.snapshotId,
                observationId: context.observationId, tool, receiver: source.receiver, rawArgs: context.rawInput,
                refSources: context.refSources,
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
        try { message = captureToolInvocation(message); }
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
    onUpdateRequest?: () => void;
    constructor(config: AppWorkerHostConfig, cwd = process.cwd()) {
        const toolsEnabled = captureToolsEnabled(config);
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
        const backend = config.persistenceBackend;
        let rootDirectory: string | undefined;
        let directoryError: unknown;
        try { rootDirectory = resolveStateDirectory(config.config, cwd); }
        catch (error) { directoryError = error; }
        this.openPersistenceHost = () => {
            if (rootDirectory === undefined) throw directoryError;
            return createStateStorageHost({ instanceId: this.appInstanceId, desktopId: String(this.desktopId),
                rootDirectory, backend, limits: { ...DEFAULT_STATE_TRANSPORT_LIMITS, timeoutMs: this.timeout } });
        };

        this.config = config.config;
        this.workerCapacity = config.workerCapacity;
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
                persistence: { protocol: STATE_SESSION_PROTOCOL, version: STATE_SESSION_VERSION, instanceId: this.appInstanceId,
                    limits: DEFAULT_STATE_SESSION_LIMITS, transport: { ...DEFAULT_STATE_TRANSPORT_LIMITS, timeoutMs: this.timeout } },
                appInstanceId: this.appInstanceId,
                projectionLimits: this.projectionLimits,
                appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, version: APP_LIFECYCLE_VERSION, instanceId: this.appInstanceId },
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

    async reinitialize(reason?: string): Promise<void> {
        this.beginInteractionClose();
        if (this.status === 'closing' || this.status === 'closed') {
            throw new Error('Cannot reinitialize an App while shutdown is pending');
        }
        const tool = this.pendingTool();
        if (tool) {
            this.beginApplicationStop();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([tool.completion, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(closeError('APP_CLOSE_DEADLINE_EXCEEDED')), this.timeout);
                })]);
            } catch (error) {
                if (!this.closePromise) this.terminate();
                throw error;
            } finally { clearTimeout(timer); }
        }
        await this.sendLifecycleRequest({
            type: 'APP_REINITIALIZE',
            requestId: generateRequestId(),
            reason,
        });
    }

    beginApplicationStop(): Promise<void> | undefined {
        this.beginInteractionClose(); this.appStopRequested = true;
        if (this.appLifecycleSupport !== 'managed' || !this.worker) return undefined;
        if (!this.appStopPromise) {
            this.appStopPromise = this.sendRequest<void>({ type: 'APP_STOP', requestId: generateRequestId() });
            void this.appStopPromise.catch(() => {});
        }
        return this.appStopPromise;
    }

    close(intent: 'close' | 'delete' = 'close'): Promise<void> {
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
                await Promise.race([this.finishAppClose(intent, lifecycle, stopped), deadline, this.actualExit.then(() => {
                    throw closeError('WORKER_EXITED_UNEXPECTEDLY');
                })]);
            } finally {
                clearTimeout(timer);
                this.terminate();
                await this.waitForWorkerExit();
            }
        });
        stopped = this.beginApplicationStop();
        void this.closePromise.catch(() => {});
        return this.closePromise;
    }

    private async finishAppClose(intent: 'close' | 'delete', lifecycle: Promise<void>[], stopped?: Promise<void>): Promise<void> {
        await Promise.allSettled([...lifecycle, stopped]);
        await this.pendingTool()?.completion;
        if (this.terminationRequested || !this.worker) throw closeError('APP_CLOSE_FAILED');
        let failure: unknown;
        try { await this.beginApplicationStop(); } catch (error) { failure = error; }
        if (intent === 'delete') {
            try { await this.sendRequest<void>({ type: 'APP_DELETE', requestId: generateRequestId() }); }
            catch { failure ??= closeError('APP_DELETE_FAILED'); }
        }
        try { await this.sendRequest<void>({ type: 'APP_SHUTDOWN', requestId: generateRequestId() }); }
        catch (error) { failure ??= error; }
        try { await this.sendRequest<void>({ type: 'APP_CLOSE', requestId: generateRequestId() }); }
        catch (error) { failure ??= error; }
        const storage = this.persistenceHost;
        // An idle session never contacted storage, so the Host stops its own admission here.
        if (storage?.getStats().highWater === 0 && this.lastPersistence?.ok) await storage.disconnect();
        if (this.persistenceSupport === 'managed' && (!this.lastPersistence?.ok || storage?.getStats().uncertain ||
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
        if (this.persistenceSupport === 'managed' && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
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
        if (message.type === 'INIT' || message.type === 'APP_REINITIALIZE') {
            // A fresh Host cannot have a negotiated interaction before its first INIT.
            if (message.type !== 'INIT' || this.lifecycleContextVersion !== 0) this.revokeInteraction();
            this.lifecycleContextVersion++;
        }
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
        if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE'].includes(message.type)) this.lifecycleContextVersion++;
        if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE', 'APP_REINITIALIZE'].includes(message.type)) {
            this.revokeInteraction();
        }
        return new Promise((resolve, reject) => {
            if (this.terminationRequested || (this.status === 'closing' || this.status === 'closed') && !['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE'].includes(message.type)) {
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
                ...(this.appLifecycleSupport === 'managed' && (message.type === 'APP_STOP' || message.type === 'APP_SHUTDOWN' || message.type === 'APP_CLOSE') ? { appCleanup: message.type } : {}),
                ...(this.persistenceSupport === 'managed' && message.type === 'APP_CLOSE' ? { persistence: true as const } : {}),
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

    private handleMessage(msg: WorkerToMainMessage): void {
        if (!msg || typeof msg !== 'object') return;
        const typeField = Object.getOwnPropertyDescriptor(msg, 'type');
        if (!typeField || !('value' in typeField)) return;
        if (typeField.value === 'STATE_STORAGE_REQUEST') {
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
        // Routing reads only a data descriptor; terminal content is captured before validation.
        const id = Object.getOwnPropertyDescriptor(msg, 'requestId')?.value;
        const pending = typeof id === 'string' ? this.pendingRequests.get(id) : undefined;
        if (pending?.tool) {
            const { worker, appId, instanceId } = pending.tool;
            if (worker !== this.worker || typeField.value !== 'VIEW_TOOL_INVOKE_RESPONSE') return;
            const terminal = captureToolInvocationTerminal(msg, { requestId: id, appId, instanceId });
            if (!terminal) return;
            this.pendingRequests.delete(id);
            pending.resolve(terminal.phase === 'finished-unknown' ? { kind: 'unknown' } : { kind: 'tool-result', ...terminal } satisfies ExecutionFact);
            return;
        }
        if (typeField.value === 'PROJECTION_CURRENT') {
            if (!pending?.projection) return;
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
                let appUnmountFailed = false;
                let persistenceFailed = false;
                let lifecycleTerminalMismatch = false;
                if (pending.init) {
                    const rejectInitialization = (code: string, error?: Error, storageUnverified = true) => {
                        this.readyWorker = null;
                        this.persistenceSupport = 'rejected';
                        this.persistenceUnsafe = storageUnverified;
                        clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                        // A successful INIT may have left an App and persistence session
                        // alive in a Worker whose initialization cannot be used.
                        this.terminate();
                        pending.reject(error ?? closeError(code));
                    };
                    if (msg.type === 'ERROR_RESPONSE' && msg.success === false) {
                        this.appLifecycleSupport = 'rejected';
                        const error = initializationError(Object.getOwnPropertyDescriptor(msg, 'error')?.value, String(this.appId), 'INIT');
                        // A verified App initialization error precedes storage negotiation.
                        rejectInitialization(error.code, error, error.code !== 'E_INIT_FAILED' || error.cause === undefined);
                        return;
                    }
                    if (msg.type !== 'INIT_RESPONSE' || Object.getOwnPropertyDescriptor(msg, 'success')?.value !== true) {
                        this.appLifecycleSupport = 'rejected';
                        rejectInitialization('APP_INIT_ACK_INVALID'); return;
                    }
                    const protocol = Object.getOwnPropertyDescriptor(msg, 'protocol');
                    if (!protocol?.enumerable || protocol.value !== WORKER_PROTOCOL) {
                        rejectInitialization('WORKER_PROTOCOL_UNSUPPORTED'); return;
                    }
                    const field = Object.getOwnPropertyDescriptor(msg, 'appLifecycle');
                    const appLifecycleAck = field?.enumerable && 'value' in field
                        ? captureAppLifecycleAck(field.value, this.appInstanceId) : null;
                    this.appLifecycleSupport = appLifecycleAck ? 'managed' : 'rejected';
                    const ackField = Object.getOwnPropertyDescriptor(msg, 'persistence');
                    const persistenceAck = ackField?.enumerable && 'value' in ackField
                        ? capturePersistenceAck(ackField.value, this.appInstanceId) : null;
                    if (!appLifecycleAck) {
                        rejectInitialization('APP_LIFECYCLE_NEGOTIATION_FAILED'); return;
                    }
                    if (ackField && !persistenceAck) {
                        rejectInitialization('PERSISTENCE_UNAVAILABLE'); return;
                    }
                    const init = pending.init;
                    const tools = Object.getOwnPropertyDescriptor(msg, 'toolsEnabled');
                    if (!tools?.enumerable || tools.value !== this.toolsEnabled) {
                        rejectInitialization('APP_INIT_ACK_INVALID'); return;
                    }
                    const instance = Object.getOwnPropertyDescriptor(msg, 'appInstanceId')?.value;
                    const path = 'INIT_RESPONSE.projectionLimits';
                    try {
                        const field = Object.getOwnPropertyDescriptor(msg, 'projectionLimits');
                        const limits = normalizeProjectionLimits(field?.enumerable ? field.value : undefined, path, true);
                        if (!isDeepStrictEqual(this.projectionLimits, limits)) throw new Error('Must match the effective limits sent in INIT');
                    } catch (error) {
                        const code = 'APP_INIT_ACK_INVALID';
                        rejectInitialization(code, Object.assign(new Error(`${code}: ${path} must match INIT`), {
                            code, path: (error as { path?: string })?.path ?? path,
                        }));
                        return;
                    }
                    if (instance !== this.appInstanceId) {
                        rejectInitialization('APP_INIT_ACK_INVALID'); return;
                    }
                    if (!ackField) this.persistenceSupport = 'not-used';
                    if (!this.interactionsClosed &&
                        init.worker === this.worker && init.version === this.lifecycleContextVersion &&
                        this.status !== 'closing' && this.status !== 'closed' && !this.closePromise) {
                        if (persistenceAck) {
                            try { this.persistenceHost = this.openPersistenceHost(); }
                            catch (error) {
                                rejectInitialization('INVALID_INPUT', error instanceof Error ? error : undefined); return;
                            }
                            this.persistenceSupport = 'managed';
                        }
                        this.readyWorker = { worker: init.worker, version: init.version };
                    }
                    if (this.appStopRequested) this.beginApplicationStop();
                }
                if (pending.initialOpen && msg.success !== true) {
                    // A failed APP_OPEN can already have closed its storage session.
                    // Keep its storage receipt and reject with the original App error.
                    const persistence = msg.type === 'LIFECYCLE_RESPONSE'
                        ? captureManagedPersistenceReport(Object.getOwnPropertyDescriptor(msg, 'persistence')?.value, this.appInstanceId) : null;
                    if (persistence) this.lastPersistence = persistence;
                    if (this.persistenceSupport === 'managed' && (!persistence || !persistence.ok)) this.persistenceUnsafe = true;

                    const cleanup = msg.type === 'LIFECYCLE_RESPONSE'
                        ? captureAppCleanupReport(Object.getOwnPropertyDescriptor(msg, 'appCleanup')?.value, this.appInstanceId) : null;
                    if (cleanup && cleanup.state !== 'active') this.lastAppCleanup = cleanup;
                    clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                    pending.reject(initializationError(Object.getOwnPropertyDescriptor(msg, 'error')?.value, String(this.appId), 'OPEN'));
                    return;
                }
                if (pending.appCleanup) {
                    const report = captureAppCleanupReport(Object.getOwnPropertyDescriptor(msg, 'appCleanup')?.value, this.appInstanceId);
                    const validPhase = report && msg.type === 'LIFECYCLE_RESPONSE' && report.state !== 'active' &&
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
                        ? captureManagedPersistenceReport(Object.getOwnPropertyDescriptor(msg, 'persistence')?.value, this.appInstanceId) : null;
                    if (report) this.lastPersistence = report;
                    appUnmountFailed = report?.unmount === 'failed';
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
                else if (msg.success) pending.resolve(undefined);
                else {
                    pending.reject(new Error((msg as any).error?.message || 'Unknown error'));
                }
            }
            return;
        }

        if (msg.type === 'SNAPSHOT_PREPARED' || msg.type === 'SNAPSHOT_PREPARE_FAILED') {
            const projection = pending?.projection;
            if (projection && !this.ownsProjection(projection)) {
                this.finishProjection(id, pending!, closeError('PROJECTION_CLOSED'));
                return;
            }
            let notify = false;
            try {
                const result = msg.type === 'SNAPSHOT_PREPARED'
                    ? this.snapshotReceiver.acceptPrepared(msg.draft)
                    : this.snapshotReceiver.acceptPrepareFailure({
                        appId: msg.appId, instanceId: msg.instanceId,
                        producerSeq: msg.producerSeq, sourceEpoch: msg.sourceEpoch,
                        issue: captureSnapshotPrepareIssue(msg.error),
                    });
                notify = result.status === 'published' || result.healthChanged;
                if (result.status === 'published' && this.viewWindows.size) {
                    const live = new Set(result.snapshot.views.map(view => view.viewInstanceId));
                    for (const mount of this.viewWindows.keys()) if (!live.has(mount)) this.viewWindows.delete(mount);
                }
                if (projection) {
                    if (!projection.timedOut) this.projectionBaseline = result.status === 'rejected' ? undefined
                        : { worker: projection.worker, version: projection.version };
                    this.finishProjection(id, pending!, result.status === 'rejected' ? new ProjectionRefreshFailure(result.issue) : undefined);
                }
            } catch {
                this.handleError(new Error('Semantic snapshot reception failed'));
                notify = true;
            }
            if (!msg.suppressSignal && notify) this.onUpdateRequest?.();
            return;
        }



    }

    private handleError(_error: Error): void {
        this.resourceIssues.add('WORKER_ERROR');
        this.beginInteractionClose();
        if (this.persistenceSupport === 'managed' && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
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
        if (this.persistenceSupport === 'managed' && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
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
