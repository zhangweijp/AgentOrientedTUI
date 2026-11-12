import { APP_LIFECYCLE_PROTOCOL, APP_LIFECYCLE_VERSION, STATE_SESSION_VERSION } from '../../spi/index.js';
import { SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY } from '../../spi/worker-protocol/types.js';
import { initializationError } from '../../adapters/initialization-error.js';
import { captureAppLifecycleAck, captureAppCleanupReport } from '../../adapters/app-lifecycle-protocol.js';
import { withExecutableTools } from '../../adapters/semantic-capability-policy.js';
import type { AppCleanupReport } from '../../spi/runtime/app-lifecycle.interface.js';
import type { LLMOutputEventMeta } from '../../spi/core/llm-output.js';
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

import type { InteractionMode } from '../../spi/worker-protocol/messages.js';
import { SEMANTIC_INTERACTION_MODES, appInteractionUnavailable, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import { projectCompleteViews } from '../../core/invocation/observation-registry.js';
import { captureInteractionModes } from './interaction-config.js';
import { compileOrdinaryProfile, ORDINARY_PARAMETER_MARKER } from '../../core/tool/ordinary-parameter-profile.js';
import { captureTypeParametersRequest } from '../../adapters/ordinary-invocation-v2.js';
import { VIEW_TYPE_PARAMETERS_MODE as PARAMETERS_MODE } from '../../core/tool/ordinary-parameter-contract.js';
import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { SemanticSnapshotReceiver, type SemanticSnapshotReport } from '../../adapters/snapshot/receiver.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, AppInteraction, InstanceInteraction, InteractionStats,
    InvocationContext, InvocationSource, Issue, ToolResultData, AppInteractionPolicy } from '../../core/invocation/app-interaction-types.js';
import type { JsonValue } from '../../core/snapshot/types.js';
import { captureSnapshotPrepareIssue } from '../../core/snapshot/snapshot-support.js';
import { captureTypeParametersTerminal, captureViewToolCapabilities } from '../../adapters/worker-message-capture.js';
import type { WorkerCapacity } from './worker-capacity.js';
import { closeError } from '../core/close-handle.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { AppID, DesktopID, ViewID } from '../../spi/index.js';
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
interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout?: ReturnType<typeof setTimeout>;
    init?: { worker: Worker; version: number; requested: readonly string[] };
    ref?: { worker: Worker; appId: string; instanceId: string; completion: Promise<ExecutionFact> };
    initialOpen?: true;
    persistence?: 'APP_SHUTDOWN' | 'APP_CLOSE';
    appCleanup?: 'APP_STOP' | 'APP_SHUTDOWN' | 'APP_CLOSE';
    projection?: { worker: Worker; version: number };
}

/**
 * AppWorkerHost 配置
 */
/**
 * AppWorkerHost 配置
 */
export interface AppWorkerHostConfig {
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
    config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig; // Configuration Injection
    runtimeConfig?: { worker: WorkerConfig }; // [RFC-005] Runtime Config
    interactionModes?: readonly InteractionMode[];
}

/**
 * Worker 状态
 */
export type WorkerStatus = 'starting' | 'ready' | 'running' | 'paused' | 'closing' | 'closed' | 'error';
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

/** AppWorkerHost - 主线程端 Worker 管理 */
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
    private readonly snapshotReceiver: SemanticSnapshotReceiver;
    private projectionRefresh?: { requestId: RequestID; promise: Promise<void> };
    private readonly requestParameters: boolean;
    private ordinaryParametersCapability: { worker: Worker; version: number } | null = null;
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
    private readonly persistenceHost: ReturnType<typeof createStateStorageHost>;
    private persistenceSupport: 'offered' | 'managed' | 'rejected' = 'offered';
    private persistenceUnsafe = false;
    private lastPersistence?: ManagedPersistenceReport;
    private appLifecycleSupport: 'offered' | 'managed' | 'rejected' = 'offered';
    private appStopRequested = false;
    private appStopPromise?: Promise<void>;
    private lastAppCleanup?: AppCleanupReport;

    getPersistenceReport() {
        return Object.freeze({ support: this.persistenceSupport, unsafe: this.persistenceUnsafe,
            ...this.persistenceHost.getStats(), ...(this.lastPersistence ? { lifecycle: this.lastPersistence } : {}) });
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
            storage.release?.status === 'released' && !storage.opening && storage.pending === 0 &&
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
                await this.persistenceHost.disconnect();
                await this.snapshotReceiver.close();
                this.resourceSettled = true;return this.getResourceReport();
            });
            void this.resourcePromise.catch(() => {});
        }
        return this.resourcePromise;
    }
    retryResourceRelease(): Promise<HostResourceReport> {
        const current = this.getResourceReport();
        if (current.state !== 'settled' || !current.storage.ownerRetained) return this.waitForResourceRelease();
        this.resourceSettled = false;
        return this.resourcePromise = this.persistenceHost.release().then(() => {
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
        this.revokeRefCapability();
    }

    private revokeRefCapability(): void {
        if (this.projectionRefresh) {
            const pending = this.pendingRequests.get(this.projectionRefresh.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(this.projectionRefresh.requestId);
                pending.reject(Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' }));
            }
            this.projectionRefresh = undefined;
        }
        this.ordinaryParametersCapability = null;
        this.interactionPolicy = undefined;
        if (this.interactionsClosed) void this.snapshotReceiver.close();
        else void this.snapshotReceiver.closeInteractions();
    }

    hasOrdinaryParametersCapability(): boolean {
        return !this.interactionsClosed && this.ordinaryParametersCapability?.worker === this.worker &&
            this.ordinaryParametersCapability?.version === this.lifecycleContextVersion;
    }

    private pendingTool() {
        for (const pending of this.pendingRequests.values()) if (pending.ref) return pending.ref;
    }

    private interactionAvailable(): boolean {
        return !this.interactionsClosed && !!this.snapshotReceiver && !!this.worker &&
            this.status === 'running' && !this.closePromise;
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
            this.instanceInteraction = this.snapshotReceiver.interaction(withExecutableTools(policy, execution), execution);
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
        adoptObservation: (id: string) => this.interactionAvailable() && this.instanceInteraction
            ? this.instanceInteraction.adoptObservation(id) : appInteractionUnavailable(),
        releaseObservation: (id: string) => { this.instanceInteraction?.releaseObservation(id); },
        invoke: (request: unknown, timeoutMs?: number) => this.interactionAvailable() && this.instanceInteraction
            ? this.instanceInteraction.invoke(request, timeoutMs ?? this.timeout)
            : Promise.resolve({ kind: 'refused' as const, ...appInteractionUnavailable().issue }),
        readReceipt: (request: unknown, timeoutMs?: number) => this.interactionAvailable() && this.instanceInteraction
            ? this.instanceInteraction.readReceipt(request, timeoutMs ?? this.timeout)
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
            const promise = this.sendRequest<void>({ type: 'FLUSH_PROJECTION', requestId });
            if (!this.pendingRequests.has(requestId)) return promise;
            this.projectionRefresh = { requestId, promise };
        }
        return this.projectionRefresh.promise;
    }

    getInteractionReport(): Readonly<{ mode: 'instance'; negotiatedModes: readonly InteractionMode[]; workerToolPending: boolean; core: InteractionStats }> | null {
        const core = this.snapshotReceiver?.getInteractionStats();
        return core ? Object.freeze({
            mode: 'instance' as const,
            negotiatedModes: this.hasOrdinaryParametersCapability() ? SEMANTIC_INTERACTION_MODES : Object.freeze([]),
            workerToolPending: !!this.pendingTool(), core,
        }) : null;
    }

    private readonly resolveInteractionSource = (source: InvocationSource): ExecutionBinding | null => {
        if (!this.interactionAvailable() || source.appId !== String(this.appId) || source.instanceId !== this.appInstanceId) return null;
        const existing = this.interactionBindings.get(source);
        if (existing) return existing;
        const marked = source.tool.inputSchema !== null && typeof source.tool.inputSchema === 'object' &&
            Object.hasOwn(source.tool.inputSchema, ORDINARY_PARAMETER_MARKER);
        const worker = this.worker!, version = this.lifecycleContextVersion;
        const live = (capability: () => boolean) => () => this.interactionAvailable() && this.worker === worker &&
            this.lifecycleContextVersion === version && capability();

        if (source.execution.kind === 'view-type') {
            if (!marked || !this.hasOrdinaryParametersCapability()) return null;
            const parameters = compileOrdinaryProfile(source.tool.inputSchema);
            if (!parameters || parameters.revision !== PARAMETERS_MODE) return null;
            const execution = source.execution;
            const isLive = live(() => this.hasOrdinaryParametersCapability());
            const binding: ExecutionBinding = Object.freeze({ identity: Object.freeze({}), mode: PARAMETERS_MODE,
                validateInput: (_source: InvocationSource, input: Readonly<Record<string, JsonValue>>) => {
                    const result = (parameters.validateResolvedInput ?? parameters.validate)(input);
                    return result.ok ? { ok: true as const, value: result.value } : { ok: false as const };
                },
                isLive: () => ({ ok: isLive() }),
                execute: (context: InvocationContext) => this.dispatchTool({ type: 'VIEW_TOOL_INVOKE_V4', requestId: generateRequestId(),
                    appId: source.appId as AppID, instanceId: source.instanceId, snapshotId: source.snapshotId,
                    tool: source.tool, argumentMode: PARAMETERS_MODE, execution, rawArgs: context.rawInput,
                    effectiveArgs: context.effectiveInput, refSources: context.refSources,
                }, { worker, version, signal: context.signal }),
            });
            this.interactionBindings.set(source, binding);
            return binding;
        }

        return null;
    };

    private dispatchTool(message: import('../../spi/worker-protocol/messages.js').ViewToolInvokeV4Message,
        expected: { worker: Worker; version: number; signal: CancellationSignal }): ExecutionFact | Promise<ExecutionFact> {
        const refused = (code: string, text: string): ExecutionFact => ({ kind: 'tool-result', phase: 'not-entered',
            result: { success: false, error: { code, message: text } } });
        const live = () => this.interactionAvailable() && this.hasOrdinaryParametersCapability() &&
            this.worker === expected.worker && this.lifecycleContextVersion === expected.version && !expected.signal.aborted;
        if (!live() || this.pendingTool()) return refused('TOOL_EXECUTION_UNAVAILABLE', 'Worker Tool execution is unavailable');
        try { message = captureTypeParametersRequest(message); }
        catch { return refused('REF_ARGUMENT_BUDGET_EXCEEDED', 'Complete Ref request exceeds the transport budget'); }
        if (!live() || this.pendingTool()) return refused('TOOL_EXECUTION_UNAVAILABLE', 'Worker Tool execution is unavailable');
        const { requestId, appId, instanceId } = message;
        let resolve!: (fact: ExecutionFact) => void;
        const completion = new Promise<ExecutionFact>(complete => { resolve = complete; });
        this.pendingRequests.set(requestId, { resolve, reject: () => {},
            ref: { worker: expected.worker, appId, instanceId, completion } });
        try { expected.worker.postMessage(message); }
        catch { /* Without a terminal or exit, this attempt cannot prove completion. */ }
        return completion;
    }

    private settleToolExit(worker: Worker): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.ref?.worker !== worker) continue;
            this.pendingRequests.delete(id);
            pending.resolve({ kind: 'unknown' } satisfies ExecutionFact);
        }
    }

    // Notify the Desktop when an App publication changes.
    onUpdateRequest?: () => void;
    constructor(config: AppWorkerHostConfig) {
        const modes = captureInteractionModes(config);
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.appModulePath = config.appModulePath;
        this.appInstanceId = randomUUID();
        this.requestParameters = modes === undefined || modes.length > 0;
        this.snapshotReceiver = new SemanticSnapshotReceiver(String(this.appId), this.appInstanceId);
        // [C1 Fix] Default to Runtime's built-in worker-runtime
        this.workerScriptPath = config.workerScriptPath ? resolve(config.workerScriptPath) : DEFAULT_WORKER_SCRIPT;

        // [RFC-005] Use Runtime Config
        const workerConfig = config.runtimeConfig?.worker ?? WORKER_DEFAULTS;
        this.timeout = config.timeout ?? workerConfig.timeoutMs;
        if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 300000) throw new Error('INVALID_INPUT: Worker timeout must be 1–300000 ms');
        this.persistenceHost = createStateStorageHost({ instanceId: this.appInstanceId, desktopId: String(this.desktopId),
            rootDirectory: resolveStateDirectory(config.config), backend: config.persistenceBackend,
            limits: { ...DEFAULT_STATE_TRANSPORT_LIMITS, timeoutMs: this.timeout } });

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
                appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, version: APP_LIFECYCLE_VERSION, instanceId: this.appInstanceId },
                requestedCapabilities: this.requestParameters ? [SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY] : [SNAPSHOT_CAPABILITY],
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
            if (pending.ref) continue;
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

    /** M2 diagnostic only. No snapshot data, Handler or live Ref is exposed. */
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
        if (failure) throw failure;
        if (this.persistenceSupport === 'managed' && (!this.lastPersistence?.ok || this.persistenceHost.getStats().uncertain ||
            this.persistenceHost.getStats().release?.status !== 'released')) {
            this.persistenceUnsafe = true;
            throw new Error('PERSISTENCE_CLOSE_FAILED: Managed persistence did not complete');
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
        meta?: Pick<LLMOutputEventMeta, 'model' | 'providerId' | 'modelId' | 'usage'>
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
            if (message.type !== 'INIT' || this.lifecycleContextVersion !== 0) this.revokeRefCapability();
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

    private sendRequest<T>(message: Exclude<MainToWorkerMessage, { type: 'VIEW_TOOL_INVOKE_V4' }>): Promise<T> {
        if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE'].includes(message.type)) this.lifecycleContextVersion++;
        if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE', 'APP_REINITIALIZE'].includes(message.type)) {
            this.revokeRefCapability();
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
            const timeout = setTimeout(() => {
                // A timed-out flush still owns its Worker wait. Keep the single
                // slot until the real reply or App close, rather than stacking retries.
                if (message.type !== 'FLUSH_PROJECTION') this.pendingRequests.delete(requestId);
                reject(Object.assign(new Error(`Request ${requestId} timed out after ${this.timeout}ms`),
                    message.type === 'FLUSH_PROJECTION' ? { code: 'PROJECTION_TIMEOUT' } : {}));
            }, this.timeout);
            this.pendingRequests.set(requestId, { resolve, reject, timeout,
                ...(message.type === 'FLUSH_PROJECTION' ? { projection: { worker, version: this.lifecycleContextVersion } } : {}),
                ...(message.type === 'APP_OPEN' ? { initialOpen: true as const } : {}),
                ...(this.appLifecycleSupport === 'managed' && (message.type === 'APP_STOP' || message.type === 'APP_SHUTDOWN' || message.type === 'APP_CLOSE') ? { appCleanup: message.type } : {}),
                ...(this.persistenceSupport === 'managed' && (message.type === 'APP_SHUTDOWN' || message.type === 'APP_CLOSE') ? { persistence: message.type } : {}),
                ...(message.type === 'INIT' ? { init: { worker, version: this.lifecycleContextVersion,
                    requested: Object.freeze([...message.requestedCapabilities]) } } : {}),
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
            if (this.persistenceSupport !== 'managed' || this.terminationRequested) return;
            const worker = this.worker, response = this.persistenceHost.accept(msg);
            if (response) void response.then(value => {
                if (!worker || worker !== this.worker || this.terminationRequested) return;
                try { worker.postMessage(value); }
                catch { this.persistenceUnsafe = true;this.persistenceHost.markTransportUncertain();this.terminate(); }
            });
            return;
        }
        // Routing reads only a data descriptor; terminal content is captured before validation.
        const id = Object.getOwnPropertyDescriptor(msg, 'requestId')?.value;
        const refPending = typeof id === 'string' ? this.pendingRequests.get(id) : undefined;
        if (refPending?.ref) {
            const { worker, appId, instanceId } = refPending.ref;
            if (worker !== this.worker || typeField.value !== 'VIEW_TOOL_INVOKE_V4_RESPONSE') return;
            const terminal = captureTypeParametersTerminal(msg, { requestId: id, appId, instanceId });
            if (!terminal) return;
            this.pendingRequests.delete(id);
            refPending.resolve(terminal.phase === 'finished-unknown' ? { kind: 'unknown' } : { kind: 'tool-result', phase: terminal.phase,
                result: terminal.result as unknown as ToolResultData,
                ...(terminal.phase === 'entered-returned' && terminal.failureEffects !== undefined ? { failureEffects: terminal.failureEffects } : {}) } satisfies ExecutionFact);
            return;
        }
        if ((msg.type === 'INIT_RESPONSE' || msg.type === 'LIFECYCLE_RESPONSE' || msg.type === 'ERROR_RESPONSE') &&
            typeof id === 'string' && 'success' in msg) {
            const pending = this.pendingRequests.get(id);
            if (pending) {
                if (pending.projection) {
                    clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                    if (this.projectionRefresh?.requestId === msg.requestId) this.projectionRefresh = undefined;
                    pending.reject(Object.assign(new Error('Worker did not return an accepted projection'), { code: 'OBSERVATION_REFRESH_FAILED' }));
                    return;
                }
                let appCleanupFailed = false;
                let appCleanupSucceeded = false;
                let persistenceFailed = false;
                let persistenceSucceeded = false;
                let lifecycleTerminalMismatch = false;
                if (pending.init) {
                    const rejectInitialization = (code: string, error?: Error) => {
                        this.ordinaryParametersCapability = null;
                        clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                        // A successful INIT may have left an App and persistence session
                        // alive in a Worker whose capabilities we cannot trust. Retire it.
                        this.terminate();
                        pending.reject(error ?? new Error(code));
                    };
                    if (msg.type === 'ERROR_RESPONSE' && msg.success === false) {
                        this.appLifecycleSupport = 'rejected'; this.persistenceSupport = 'rejected'; this.persistenceUnsafe = true;
                        const error = initializationError(Object.getOwnPropertyDescriptor(msg, 'error')?.value, String(this.appId), 'INIT');
                        rejectInitialization(error.code, error);
                        return;
                    }
                    if (msg.type !== 'INIT_RESPONSE') {
                        this.appLifecycleSupport = 'rejected'; this.persistenceSupport = 'rejected'; this.persistenceUnsafe = true;
                        clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                        pending.reject(new Error('APP_INIT_ACK_INVALID')); return;
                    }
                    const field = Object.getOwnPropertyDescriptor(msg, 'appLifecycle');
                    const appLifecycleAck = field && 'value' in field && msg.success
                        ? captureAppLifecycleAck(field.value, this.appInstanceId) : null;
                    this.appLifecycleSupport = appLifecycleAck ? 'managed' : 'rejected';
                    const ackField = Object.getOwnPropertyDescriptor(msg, 'persistence');
                    const persistenceAck = ackField && 'value' in ackField && msg.success
                        ? capturePersistenceAck(ackField.value, this.appInstanceId) : null;
                    this.persistenceSupport = persistenceAck ? 'managed' : 'rejected';
                    if (!persistenceAck) this.persistenceUnsafe = true;
                    if (!appLifecycleAck) {
                        clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                        pending.reject(new Error('APP_LIFECYCLE_NEGOTIATION_FAILED')); return;
                    }
                    if (this.appStopRequested) this.beginApplicationStop();
                    if (!persistenceAck) {
                        clearTimeout(pending.timeout);this.pendingRequests.delete(msg.requestId);
                        pending.reject(new Error('PERSISTENCE_NEGOTIATION_FAILED: Invalid persistence acknowledgment'));return;
                    }
                    const init = pending.init;
                    const capsField = Object.getOwnPropertyDescriptor(msg, 'acceptedCapabilities');
                    const caps = capsField && !('value' in capsField) ? null
                        : captureViewToolCapabilities(capsField?.value);
                    const instance = Object.getOwnPropertyDescriptor(msg, 'appInstanceId')?.value;
                    if (caps && !caps.ok) {
                        rejectInitialization(caps.code);
                        return;
                    }
                    const accepted = caps?.ok ? caps.capabilities : null;
                    if (accepted && accepted.some(capability => !init.requested.includes(capability))) {
                        rejectInitialization('WORKER_CAPABILITY_ACK_INVALID');
                        return;
                    }
                    if (!accepted?.includes(SNAPSHOT_CAPABILITY)) {
                        rejectInitialization('WORKER_SNAPSHOT_UNSUPPORTED');
                        return;
                    }
                    if (init.requested.some(capability => !accepted.includes(capability))) {
                        rejectInitialization('WORKER_CAPABILITY_UNAVAILABLE');
                        return;
                    }
                    if (msg.type === 'INIT_RESPONSE' && msg.success === true &&
                        !this.interactionsClosed &&
                        init.worker === this.worker && init.version === this.lifecycleContextVersion &&
                        this.status !== 'closing' && this.status !== 'closed' && !this.closePromise &&
                        instance === this.appInstanceId && accepted !== null) {
                        this.ordinaryParametersCapability = accepted.includes(PARAMETERS_V4_CAPABILITY) ? { worker: init.worker, version: init.version } : null;
                    }
                }
                if (pending.initialOpen && msg.success !== true) {
                    // APP_OPEN can fail after the Worker has initialized managed
                    // persistence and has already disposed that session. Preserve
                    // its terminal facts so the Host cannot hide the failed commit
                    // or treat the Worker as a clean persistence owner.
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
                    // APP_STOP has no persistence request whose result can explain a failed terminal.
                    // APP_SHUTDOWN/APP_CLOSE are evaluated with their persistence report below.
                    appCleanupFailed = !validPhase || !appCleanupSucceeded ||
                        pending.appCleanup === 'APP_STOP' && msg.success !== true;
                }
                if (pending.persistence) {
                    const report = msg.type === 'LIFECYCLE_RESPONSE'
                        ? captureManagedPersistenceReport(Object.getOwnPropertyDescriptor(msg, 'persistence')?.value, this.appInstanceId) : null;
                    if (report) this.lastPersistence = report;
                    persistenceSucceeded = !!report && (pending.persistence === 'APP_CLOSE' ? report.ok : report.flush?.ok === true);
                    persistenceFailed = !persistenceSucceeded;
                    if (persistenceFailed) this.persistenceUnsafe = true;

                    const expectedTerminalSuccess = pending.persistence === 'APP_CLOSE'
                        ? (!pending.appCleanup || appCleanupSucceeded) && persistenceSucceeded
                        : persistenceSucceeded;
                    lifecycleTerminalMismatch = msg.success !== expectedTerminalSuccess;
                    if (lifecycleTerminalMismatch) this.persistenceUnsafe = true;
                }

                // Validate the facts independently before using the combined terminal bit. In particular,
                // APP_CLOSE success includes both lifecycle cleanup and persistence completion.
                if (appCleanupFailed) {
                    clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                    pending.reject(new Error('APP_CLEANUP_FAILED')); return;
                }
                if (persistenceFailed || lifecycleTerminalMismatch) {
                    clearTimeout(pending.timeout);this.pendingRequests.delete(msg.requestId);
                    pending.reject(new Error('PERSISTENCE_CLOSE_FAILED: Managed persistence did not complete'));return;
                }
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(msg.requestId);

                if (msg.success) pending.resolve(undefined);
                else {
                    pending.reject(new Error((msg as any).error?.message || 'Unknown error'));
                }
            }
            return;
        }

        if (msg.type === 'SNAPSHOT_PREPARED' || msg.type === 'SNAPSHOT_PREPARE_FAILED') {
            const request = msg.requestId && this.pendingRequests.get(msg.requestId);
            const pending = request && request.projection ? request : undefined;
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
                if (pending && msg.requestId) {
                    clearTimeout(pending.timeout);
                    this.pendingRequests.delete(msg.requestId);
                    if (this.projectionRefresh?.requestId === msg.requestId) this.projectionRefresh = undefined;
                    if (pending.projection!.worker !== this.worker || pending.projection!.version !== this.lifecycleContextVersion)
                        pending.reject(Object.assign(new Error('Projection source replaced'), { code: 'PROJECTION_CLOSED' }));
                    else if (result.status === 'rejected') pending.reject(new ProjectionRefreshFailure(result.issue));
                    else pending.resolve(undefined);
                }
            } catch {
                this.handleError(new Error('Semantic snapshot reception failed'));
                notify = true;
            }
            if (!msg.suppressSignal && notify) this.onUpdateRequest?.();
            return;
        }



    }

    private handleError(error: Error): void {
        this.resourceIssues.add('WORKER_ERROR');
        this.beginInteractionClose();
        if (this.persistenceSupport === 'managed') this.persistenceUnsafe = true;
        this.lifecycleContextVersion++;
        if (this.requestParameters) console.error('[AppWorkerHost] Worker failed in Ref-capable execution');
        else console.error(`[AppWorkerHost] Worker ${this.appId} error:`, error);
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
