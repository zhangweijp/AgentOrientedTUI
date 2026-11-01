import { captureAppLifecycleAck, captureAppCleanupReport } from '../../adapters/app-lifecycle-protocol.js';
import { withExecutableTools } from '../../adapters/semantic-capability-policy.js';
import type { AppCleanupReport } from '../../spi/runtime/app-lifecycle.interface.js';
import type { LLMOutputEventMeta } from '../../spi/core/llm-output.js';
import { createStateStorageHost, resolveStateDirectory, type StateStorageBackend } from './state-storage-host.js';
import { capturePersistenceAck, captureManagedPersistenceReport, DEFAULT_STATE_SESSION_LIMITS, DEFAULT_STATE_TRANSPORT_LIMITS } from '../../adapters/storage/state-storage-protocol.js';
import type { ManagedPersistenceReport } from '../../worker-runtime/state-persistence.js';
import { compileSnapshotValueProfile } from '../../core/tool/snapshot-value-parameter-contract.js';
import { captureRefV2Request, captureRefV2Terminal, REF_V2_CAPABILITY, REF_V2_MODE } from '../../adapters/ref-invocation-v2.js';
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
import { SEMANTIC_INTERACTION_MODES } from '../../spi/runtime/app-interaction.interface.js';
import { captureInteractionModes } from './interaction-config.js';
import { compileOrdinaryProfile, ORDINARY_PARAMETER_MARKER } from '../../core/tool/ordinary-parameter-profile.js';
import { captureOrdinaryV2Request, captureOrdinaryV2Terminal, ORDINARY_V2_CAPABILITY, ORDINARY_V2_MODE } from '../../adapters/ordinary-invocation-v2.js';
import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { SemanticSnapshotReceiver, type SemanticSnapshotReport } from '../../adapters/snapshot/receiver.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, InteractionAuthority, InteractionStats,
    InvocationSource, OperationResultData, ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';
import { captureWorkerCapabilities } from '../../adapters/worker-message-capture.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { AppID, DesktopID, ViewID, OperationResult } from '../../spi/index.js';
import { WORKER_DEFAULTS, type WorkerConfig } from '../../spi/config/index.js';

import {
    generateRequestId,
    type RequestID,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
    isResponse,
    isRequest,
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
    init?: { worker: Worker; version: number; requested: readonly string[] };
    ref?: { worker: Worker; version: number; scoped?: boolean; mode: InteractionMode };
    initialOpen?: true;
    persistence?: 'APP_SHUTDOWN' | 'APP_CLOSE';
    appCleanup?: 'APP_STOP' | 'APP_SHUTDOWN' | 'APP_CLOSE';
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
    existingWorker?: Worker; // [WorkerPool] 复用的 Worker 实例
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
    readonly worker: 'not-created' | 'owned' | 'retiring' | 'exited' | 'transferred';
    readonly appCleanup?: Readonly<{ support: 'offered' | 'managed' | 'rejected'; report?: AppCleanupReport }>;
    readonly storage: ReturnType<AppWorkerHost['getPersistenceReport']>;
    readonly interactions: { readonly closed: boolean; readonly retainedScopes: number; readonly retainedBytes: number };
    readonly resourcesReleased: boolean;
    readonly issues: readonly ('WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED' | 'RESET_FAILED')[];
}


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
    private readonly snapshotReceiver: SemanticSnapshotReceiver;
    private readonly interactionModes: readonly InteractionMode[];
    private ordinaryParametersCapability: { worker: Worker; version: number } | null = null;
    private snapshotValueParametersCapability: { worker: Worker; version: number } | null = null;
    private interactionTransportUncertain = false;
    private interactionsClosed = false;
    private readonly interactionBindings = new WeakMap<InvocationSource, ExecutionBinding>();
    private closePromise: Promise<void> | null = null;
    private releasePromise: Promise<Worker | null> | null = null;
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
    private resourceWorker: Worker | null = null;
    private resourceWorkerState: HostResourceReport['worker'] = 'not-created';
    private resourceExitListener?: () => void;
    private resourceErrorListener?: () => void;
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
        const interactions = Object.freeze({ closed: this.interactionsClosed, retainedScopes: core?.scopes ?? 0, retainedBytes: core?.combinedBytes ?? 0 });
        const resourcesReleased = ['not-created', 'exited', 'transferred'].includes(this.resourceWorkerState) &&
            storage.release?.status === 'released' && !storage.opening && storage.pending === 0 &&
            interactions.closed && interactions.retainedScopes === 0 && interactions.retainedBytes === 0;
        return Object.freeze({ state: this.resourceSettled ? 'settled' : this.resourceReleaseStarted || this.closePromise ? 'closing' : 'active',
            appCleanup: Object.freeze({ support: this.appLifecycleSupport, ...(this.lastAppCleanup ? { report: this.lastAppCleanup } : {}) }),
            worker: this.resourceWorkerState, storage, interactions, resourcesReleased,
            issues: Object.freeze([...this.resourceIssues]) });
    }
    waitForResourceRelease(): Promise<HostResourceReport> {
        if (!this.resourceReleaseStarted) return Promise.reject(Object.assign(new Error('Resource release has not started'), { code: 'RESOURCE_RELEASE_NOT_STARTED' }));
        if (!this.resourcePromise) {
            this.resourcePromise = Promise.resolve().then(async () => {
                await Promise.allSettled([this.closePromise, this.releasePromise]);
                // Do not close admission while the managed close attempt may still flush.
                await this.persistenceHost.release();
                if (this.resourceWorkerState === 'owned' || this.resourceWorkerState === 'retiring') await this.actualExit;
                await this.snapshotReceiver?.closeInteractions();
                this.resourceSettled = true;return this.getResourceReport();
            });
            void this.resourcePromise.catch(() => {});
        }
        return this.resourcePromise;
    }
    private beginResourceRelease(): void {
        this.resourceReleaseStarted = true;
        // Defer reading releasePromise until the releasing caller has installed it.
        void Promise.resolve().then(() => this.waitForResourceRelease()).catch(() => {});
    }
    private detachResourceListeners(worker: Worker): void {
        if (this.resourceExitListener) worker.off('exit', this.resourceExitListener);
        if (this.resourceErrorListener) worker.off('error', this.resourceErrorListener);
    }
    private workerMessageListener = this.handleMessage.bind(this);
    private workerErrorListener = this.handleError.bind(this);
    private workerExitListener = this.handleExit.bind(this);

    beginInteractionClose(): void {
        this.interactionsClosed = true;
        this.revokeRefCapability();
    }

    private revokeRefCapability(): void {
        this.snapshotReceiver?.closeInteractions();
        this.snapshotValueParametersCapability = null;
        this.ordinaryParametersCapability = null;
        for (const [id, pending] of this.pendingRequests) {
            if (!pending.ref) continue;
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(id);
            if (pending.ref) pending.resolve(this.unknownRef(pending.ref.scoped === true));
        }
    }

    hasOrdinaryParametersCapability(): boolean {
        return !this.interactionsClosed && this.interactionModes.includes('ordinary-v2') && this.ordinaryParametersCapability?.worker === this.worker &&
            this.ordinaryParametersCapability?.version === this.lifecycleContextVersion;
    }

    hasSnapshotValueParametersCapability(): boolean {
        return !this.interactionsClosed && this.interactionModes.includes('snapshot-value-v2') && this.snapshotValueParametersCapability?.worker === this.worker &&
            this.snapshotValueParametersCapability?.version === this.lifecycleContextVersion;
    }

    private unknownRef(scoped: boolean): ExecutionFact | OperationResult {
        this.interactionTransportUncertain = true;
        if (!scoped) return { success: false, error: { code: 'OUTCOME_UNKNOWN', message: 'The Worker outcome is unknown' } };
        return Object.freeze({ kind: 'unknown' });
    }

    private interactionFailure(code: string, message: string): OperationResult {
        return { success: false, error: { code, message } };
    }

    private interactionAvailable(): boolean {
        return !this.interactionsClosed && !!this.snapshotReceiver && !!this.worker &&
            this.status === 'running' && !this.interactionTransportUncertain && !this.closePromise && !this.releasePromise;
    }

    createInteractionScope(policy: ScopePolicy): ReturnType<InteractionAuthority['createScope']> {
        if (!this.interactionAvailable()) return Object.freeze({ status: 'rejected', issue: Object.freeze({
            code: 'REF_EXECUTION_UNAVAILABLE', message: 'Scoped Ref interaction is unavailable' }) });
        const execution = { resolve: this.resolveInteractionSource };
        return this.snapshotReceiver!.createInteractionScope(withExecutableTools(policy, execution), execution);
    }

    getInteractionReport(): Readonly<{ mode: 'scoped'; negotiatedModes: readonly InteractionMode[]; transportUncertain: boolean; core: InteractionStats }> | null {
        const core = this.snapshotReceiver?.getInteractionStats();
        return core ? Object.freeze({
            mode: 'scoped' as const,
            negotiatedModes: Object.freeze(this.interactionModes.filter(mode => mode === 'ordinary-v2' ? this.hasOrdinaryParametersCapability() : this.hasSnapshotValueParametersCapability())),
            transportUncertain: this.interactionTransportUncertain, core,
        }) : null;
    }

    private readonly resolveInteractionSource = (source: InvocationSource): ExecutionBinding | null => {
        if (!this.interactionAvailable() || source.appId !== String(this.appId) || source.instanceId !== this.appInstanceId) return null;
        const existing = this.interactionBindings.get(source);
        if (existing) return existing;
        const marked = source.tool.inputSchema !== null && typeof source.tool.inputSchema === 'object' &&
            Object.hasOwn(source.tool.inputSchema, ORDINARY_PARAMETER_MARKER);
        const parameters = marked ? compileOrdinaryProfile(source.tool.inputSchema) : null;
        const snapshotCompiled = marked ? compileSnapshotValueProfile(source.tool.inputSchema) : null;
        const snapshotParameters = snapshotCompiled?.ok ? snapshotCompiled.contract : null;
        if (marked && ((!parameters && !snapshotParameters) || snapshotParameters && source.tool.isMutating ||
            !(snapshotParameters ? this.hasSnapshotValueParametersCapability() : this.hasOrdinaryParametersCapability()))) return null;
        if (!parameters && !snapshotParameters) return null;
        if (snapshotParameters ? !this.hasSnapshotValueParametersCapability() : !this.hasOrdinaryParametersCapability()) return null;
        const worker = this.worker!, version = this.lifecycleContextVersion;
        const current = () => this.interactionAvailable() && this.worker === worker && this.lifecycleContextVersion === version && (!parameters || this.hasOrdinaryParametersCapability()) && (!snapshotParameters || this.hasSnapshotValueParametersCapability());
        const binding: ExecutionBinding = Object.freeze({ identity: Object.freeze({}), mode: snapshotParameters ? 'snapshot-value-v2' : 'ordinary-v2',
            validateInput: (_source, input) => {
                if (snapshotParameters) { const result = snapshotParameters.validateEffective(input); return result.ok ? {ok:true as const,value:result.value} : {ok:false as const}; }
                const result = parameters!.validate(input); return result.ok ? {ok:true as const,value:result.value} : {ok:false as const};
            },
            isLive: () => ({ ok: current() }),
            execute: context => snapshotParameters ? this.sendRequest<ExecutionFact>({ type: 'VIEW_TOOL_INVOKE_REF_V2', requestId: generateRequestId(),
                appId: context.source.appId as AppID, instanceId: context.source.instanceId, argumentMode: REF_V2_MODE,
                snapshotId: context.source.snapshotId, tool: context.source.tool, target: context.source.target, rawArgs: context.rawInput,
                effectiveArgs: context.effectiveInput, refSources: context.refSources }, { worker, version, signal: context.signal }) : this.sendRequest<ExecutionFact>({ type:'VIEW_TOOL_INVOKE_ORDINARY_V2',requestId:generateRequestId(),
                appId:context.source.appId as AppID,instanceId:context.source.instanceId,argumentMode:ORDINARY_V2_MODE,
                snapshotId:context.source.snapshotId,tool:context.source.tool,target:context.source.target,args:context.effectiveInput,
            },{worker,version,signal:context.signal}),
        } satisfies ExecutionBinding);
        this.interactionBindings.set(source, binding);
        return binding;
    };

    // 回调: Worker 请求 notifyUpdate
    onUpdateRequest?: () => void;
    constructor(config: AppWorkerHostConfig) {
        const modes = captureInteractionModes(config);
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.appModulePath = config.appModulePath;
        this.appInstanceId = randomUUID();
        this.interactionModes = modes ?? SEMANTIC_INTERACTION_MODES;
        this.snapshotReceiver = new SemanticSnapshotReceiver(String(this.appId), this.appInstanceId);
        // [C1 Fix] Default to Runtime's built-in worker-runtime
        this.workerScriptPath = config.workerScriptPath ?? DEFAULT_WORKER_SCRIPT;

        // [RFC-005] Use Runtime Config
        const workerConfig = config.runtimeConfig?.worker ?? WORKER_DEFAULTS;
        this.timeout = config.timeout ?? workerConfig.timeoutMs;
        if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 300000) throw new Error('INVALID_INPUT: Worker timeout must be 1–300000 ms');
        this.persistenceHost = createStateStorageHost({ instanceId: this.appInstanceId, desktopId: String(this.desktopId),
            rootDirectory: resolveStateDirectory(config.config), backend: config.persistenceBackend,
            limits: { ...DEFAULT_STATE_TRANSPORT_LIMITS, timeoutMs: this.timeout } });

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
        if (this.initAttempted || this.status === 'closed' || this.status === 'error') throw new Error('APP_INSTANCE_REUSE_UNSUPPORTED: Create a new Host for another initialization');
        this.initAttempted = true;
        if (this.status === 'closing' || this.closePromise || this.releasePromise) {
            throw new Error('Cannot start an App while shutdown is pending');
        }
        try {
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
                persistence: { protocol: 'state-session-v1', version: 1, instanceId: this.appInstanceId,
                    limits: DEFAULT_STATE_SESSION_LIMITS, transport: { ...DEFAULT_STATE_TRANSPORT_LIMITS, timeoutMs: this.timeout } },
                appInstanceId: this.appInstanceId,
                appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: this.appInstanceId },
                requestedCapabilities: this.interactionModes.map(mode => mode === 'ordinary-v2' ? ORDINARY_V2_CAPABILITY : REF_V2_CAPABILITY),
            }, 'ready');
        } catch (error) {
            if (this.snapshotReceiver) {
                this.revokeRefCapability();
                this.snapshotReceiver.close();
            }
            throw error;
        }
    }

    private bindWorkerListeners(): void {
        if (!this.worker) return;
        const worker = this.worker;
        this.workerMessageListener = msg => { if (this.worker === worker) this.handleMessage(msg); };
        this.workerErrorListener = error => { if (this.worker === worker) this.handleError(error); };
        this.workerExitListener = code => { if (this.worker === worker) this.handleExit(code); };
        this.resourceWorker = worker;this.resourceWorkerState = 'owned';
        this.resourceErrorListener = () => { if (this.resourceWorker === worker) { this.beginInteractionClose();this.resourceIssues.add('WORKER_ERROR'); } };
        this.resourceExitListener = () => {
            if (this.resourceWorker !== worker || this.resourceWorkerState === 'transferred') return;
            this.beginInteractionClose();
            if (!this.terminationRequested) this.resourceIssues.add('WORKER_EXITED_UNEXPECTEDLY');
            this.resourceWorkerState = 'exited';this.resourceWorker = null;
            this.detachResourceListeners(worker);this.actualExitResolve();this.beginResourceRelease();
        };
        worker.on('error', this.resourceErrorListener);worker.once('exit', this.resourceExitListener);
        if (worker.threadId < 0) this.resourceExitListener();

        this.worker.on('message', this.workerMessageListener);
        this.worker.on('error', this.workerErrorListener);
        this.worker.on('exit', this.workerExitListener);
    }

    /**
     * 释放 Worker (用于归还给 Pool)
     * 
     * 会先发送 RESET 消息，成功后解绑监听器并返回 Worker 实例。
     * When the Worker is not transferable, `retireLease` lets the owning pool
     * mark the expected exit before its existing release(false) path terminates it.
     */
    releaseWorker(retireLease?: () => Promise<unknown>): Promise<Worker | null> {
        this.beginInteractionClose();
        this.beginResourceRelease();
        // Only one caller receives ownership of the pooled Worker. Other
        // release callers still wait for RESET, but must not pool it twice.
        if (this.releasePromise) return this.releasePromise.then(() => null);
        if (!this.worker) {
            this.snapshotReceiver?.close();
            this.status = 'closed';
            return Promise.resolve(null);
        }
        const closing = this.closePromise ?? (this.persistenceSupport === 'managed' || this.appLifecycleSupport === 'managed' ? this.close() : null);
        const lifecycle = Promise.all([...this.lifecycleRequests]);
        this.status = 'closing';
        const release = async (): Promise<Worker | null> => {
            let resetting = false;
            const retire = async () => {
                if (!retireLease) { this.terminate();return; }
                // Let the owning pool mark its lease as intentionally retiring
                // before its release(false) path starts the asynchronous exit.
                // Host bookkeeping is set first so both owners agree the exit
                // was requested, while a standalone Host still terminates itself.
                this.terminationRequested = true;
                if (this.resourceWorkerState === 'owned') this.resourceWorkerState = 'retiring';
                try { await retireLease(); }
                finally { if (this.worker) this.terminate(); }
            };
            try {
                await Promise.all([closing, lifecycle]);
                if (!this.worker) return null;
                if (this.appLifecycleSupport === 'rejected' || this.appLifecycleSupport === 'managed' && this.lastAppCleanup?.state !== 'completed' || this.interactionTransportUncertain || this.persistenceUnsafe || this.persistenceHost.getStats().uncertain ||
                    this.persistenceSupport === 'managed' && this.lastPersistence?.ok !== true) { await retire(); return null; }
                this.status = 'closing';
                // 1. 发送 RESET
                resetting = true;
                await this.sendRequest<void>({
                    type: 'RESET',
                    requestId: generateRequestId(),
                });

                const worker = this.worker;
                if (!worker || this.terminationRequested || this.resourceWorkerState === 'exited') return null;
                this.detachWorkerListeners(worker);this.detachResourceListeners(worker);
                this.resourceWorkerState = 'transferred';this.resourceWorker = null;
                this.worker = null;
                this.status = 'closed'; // Host 标记为关闭，但 Worker 存活
                this.snapshotReceiver?.close();

                // 清理待处理请求
                this.cleanupPendingRequests();

                return worker;
            } catch (error) {
                if (resetting) this.resourceIssues.add('RESET_FAILED');
                // 如果重置失败，直接终止
                try { await retire(); } catch { this.terminate(); }
                return null;
            }
        };
        this.releasePromise = release().finally(() => { this.releasePromise = null; });
        return this.releasePromise;
    }

    private cleanupPendingRequests(): void {
        this.revokeRefCapability();
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

    close(): Promise<void> {
        this.beginInteractionClose();
        // Multiple callers must share one shutdown, not send duplicate
        // APP_SHUTDOWN/APP_CLOSE requests to the same Worker.
        if (this.closePromise) return this.closePromise;
        if (this.releasePromise) return this.releasePromise.then(() => undefined);
        if (this.status === 'closed') return Promise.resolve();
        const lifecycle = Promise.all([...this.lifecycleRequests]);
        this.status = 'closing';
        const stopped = this.beginApplicationStop();
        void stopped?.catch(() => {});
        const finish = async () => {
            try {
                let stopError: unknown;
                await Promise.allSettled([lifecycle, stopped]);
                try { await this.beginApplicationStop(); } catch (error) { stopError = error; }
                if (!this.worker) {
                    this.terminate();
                    return;
                }
                let shutdownError: unknown = stopError;
                try { await this.sendRequest<void>({ type: 'APP_SHUTDOWN', requestId: generateRequestId() }); }
                catch (error) { shutdownError = error; }
                // A failed flush must still reach unmount/dispose and supervised release.
                try { await this.sendRequest<void>({ type: 'APP_CLOSE', requestId: generateRequestId() }); }
                catch (error) { shutdownError ??= error; }
                if (shutdownError) throw shutdownError;
                if (this.persistenceSupport === 'managed' && (!this.lastPersistence?.ok || this.persistenceHost.getStats().uncertain ||
                    this.persistenceHost.getStats().release?.status !== 'released')) {
                    this.persistenceUnsafe = true;throw new Error('PERSISTENCE_CLOSE_FAILED: Managed persistence did not complete');
                }
                this.status = 'closed';
                this.snapshotReceiver?.close();
            } catch (error) {
                this.terminate();
                throw error;
            }
        };
        this.closePromise = finish();
        return this.closePromise;
    }

    /**
     * [RFC-015] Delete App (Data Cleanup)
     * 
     * Triggers app.onDelete() in worker to clean up persisted data.
     * Note: This does NOT close the worker, you must call close() after delete().
     */
    async delete(): Promise<void> {
        this.beginInteractionClose();
        await this.sendRequest<void>({
            type: 'APP_DELETE',
            requestId: generateRequestId(),
        });
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
        this.beginInteractionClose();
        this.terminationRequested = true;this.beginResourceRelease();
        if (this.resourceWorkerState === 'owned') this.resourceWorkerState = 'retiring';
        if (this.persistenceSupport === 'managed' && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
        if (this.worker) {
            const worker = this.worker;
            this.worker = null;
            this.detachWorkerListeners(worker);
            try {
                worker.postMessage({ type: 'TERMINATE' } as MainToWorkerMessage);
            } catch {
                // A broken channel must not prevent the native teardown.
            }
            try { void Promise.resolve(worker.terminate()).catch(() => { this.resourceIssues.add('WORKER_TERMINATION_FAILED'); }); }
            catch { this.resourceIssues.add('WORKER_TERMINATION_FAILED'); }
        }
        this.status = 'closed';
        this.snapshotReceiver?.close();

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
        if (message.type === 'INIT' || message.type === 'APP_REINITIALIZE') {
            // A fresh Host cannot have a negotiated Scope before its first INIT.
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
            if (this.getStatus() === 'closing' || this.closePromise || this.releasePromise) {
                throw new Error('App shutdown is pending; lifecycle response cannot reopen it');
            }
            if (nextStatus) this.status = nextStatus;
        } finally {
            this.lifecycleRequests.delete(pending);
        }
    }

    private sendRequest<T>(message: MainToWorkerMessage, scoped?: { worker: Worker; version: number; signal: CancellationSignal }): Promise<T> {
        if (['RESET', 'APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE'].includes(message.type)) this.lifecycleContextVersion++;
        if (['RESET', 'APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE', 'APP_REINITIALIZE'].includes(message.type)) {
            this.revokeRefCapability();
        }
        const snapshotParameters = message.type === 'VIEW_TOOL_INVOKE_REF_V2';
        const parameters = message.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2';
        const ref = snapshotParameters || parameters;
        return new Promise((resolve, reject) => {
            const refused = (code: string, text: string) => scoped ? { kind: 'operation-result', phase: 'not-entered',
                result: { success: false, error: { code, message: text } } } : this.interactionFailure(code, text);
            const stale = () => scoped && (!this.interactionAvailable() || scoped.worker !== this.worker ||
                scoped.version !== this.lifecycleContextVersion || scoped.signal.aborted);
            if (ref && (this.interactionTransportUncertain || !(snapshotParameters ? this.hasSnapshotValueParametersCapability() : this.hasOrdinaryParametersCapability()) || this.status !== 'running' || stale())) {
                resolve(refused('REF_EXECUTION_UNAVAILABLE', 'Current Worker has no negotiated Ref capability') as T);
                return;
            }
            if ((this.status === 'closing' || this.status === 'closed') && !['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'RESET'].includes(message.type)) {
                reject(new Error('Cannot send a new request while App shutdown is pending'));
                return;
            }
            const worker = this.worker;
            if (!worker) { reject(new Error('Worker not started')); return; }
            const requestId = 'requestId' in message ? message.requestId : undefined;
            if (!requestId) { reject(new Error('Message missing requestId')); return; }
            if (ref) {
                try { message = snapshotParameters ? captureRefV2Request(message) : captureOrdinaryV2Request(message); }
                catch {
                    resolve(refused('REF_ARGUMENT_BUDGET_EXCEEDED', 'Complete Ref request exceeds the transport budget') as T);
                    return;
                }
            }
            if (stale()) { resolve(refused('REF_EXECUTION_UNAVAILABLE', 'Scoped Ref interaction is unavailable') as T); return; }
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                if (ref) resolve(this.unknownRef(!!scoped) as T);
                else reject(new Error(`Request ${requestId} timed out after ${this.timeout}ms`));
            }, this.timeout);
            this.pendingRequests.set(requestId, { resolve, reject, timeout,
                ...(message.type === 'APP_OPEN' ? { initialOpen: true as const } : {}),
                ...(this.appLifecycleSupport === 'managed' && (message.type === 'APP_STOP' || message.type === 'APP_SHUTDOWN' || message.type === 'APP_CLOSE') ? { appCleanup: message.type } : {}),
                ...(this.persistenceSupport === 'managed' && (message.type === 'APP_SHUTDOWN' || message.type === 'APP_CLOSE') ? { persistence: message.type } : {}),
                ...(ref ? { ref: { worker, version: this.lifecycleContextVersion, mode: snapshotParameters ? REF_V2_MODE : ORDINARY_V2_MODE, ...(scoped ? { scoped: true } : {}) } } : {}),
                ...(message.type === 'INIT' ? { init: { worker, version: this.lifecycleContextVersion,
                    requested: captureWorkerCapabilities(message.requestedCapabilities) ?? [] } } : {}),
            });
            try { worker.postMessage(message); }
            catch {
                clearTimeout(timeout);
                this.pendingRequests.delete(requestId);
                if (ref) resolve(this.unknownRef(!!scoped) as T);
                else reject(new Error('Worker request could not be sent'));
            }
        });
    }

    private handleMessage(msg: WorkerToMainMessage): void {
        if (!msg || typeof msg !== 'object') return;
        const typeField = Object.getOwnPropertyDescriptor(msg, 'type');
        if (!typeField || !('value' in typeField)) return;
        if (typeField.value === 'STATE_STORAGE_REQUEST') {
            if (this.persistenceSupport !== 'managed') return;
            const worker = this.worker, response = this.persistenceHost.accept(msg);
            if (response) void response.then(value => {
                if (!worker || worker !== this.worker) return;
                try { worker.postMessage(value); } catch { this.persistenceUnsafe = true;this.persistenceHost.markTransportUncertain();void this.persistenceHost.disconnect(); }
            });
            return;
        }
        // Routing reads only a data descriptor; terminal content is captured before validation.
        const id = msg && typeof msg === 'object' ? Object.getOwnPropertyDescriptor(msg, 'requestId')?.value : undefined;
        const refPending = typeof id === 'string' ? this.pendingRequests.get(id) : undefined;
        if (refPending?.ref) {
            const terminal = refPending.ref.worker === this.worker && refPending.ref.version === this.lifecycleContextVersion
                ? (refPending.ref.mode === REF_V2_MODE ? captureRefV2Terminal : captureOrdinaryV2Terminal)(msg, { requestId: id, appId: String(this.appId), instanceId: this.appInstanceId }) : null;
            clearTimeout(refPending.timeout);
            this.pendingRequests.delete(id);
            refPending.resolve(refPending.ref.scoped ? terminal ? { kind: 'operation-result', phase: terminal.phase,
                result: terminal.result as unknown as OperationResultData,
                ...(terminal.phase === 'entered-returned' && terminal.failureEffects !== undefined ? { failureEffects: terminal.failureEffects } : {}) } : this.unknownRef(true) : terminal?.result ?? this.unknownRef(false));
            return;
        }
        if (msg?.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' || msg?.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE') return;

        // 处理响应消息
        if (isResponse(msg)) {
            const pending = this.pendingRequests.get(msg.requestId);
            if (pending) {
                let appCleanupFailed = false;
                let appCleanupSucceeded = false;
                let persistenceFailed = false;
                let persistenceSucceeded = false;
                let lifecycleTerminalMismatch = false;
                if (pending.init) {
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
                    const caps = capsField && !('value' in capsField) ? null : captureWorkerCapabilities(capsField?.value);
                    const instance = Object.getOwnPropertyDescriptor(msg, 'appInstanceId')?.value;
                    if (msg.type === 'INIT_RESPONSE' && msg.success === true &&
                        !this.interactionsClosed &&
                        init.worker === this.worker && init.version === this.lifecycleContextVersion &&
                        this.status !== 'closing' && this.status !== 'closed' && !this.closePromise && !this.releasePromise &&
                        instance === this.appInstanceId && caps !== null && caps.length <= 2 &&
                        caps.every(c => (c === ORDINARY_V2_CAPABILITY || c === REF_V2_CAPABILITY) && init.requested.includes(c))) {
                        this.snapshotValueParametersCapability = caps.includes(REF_V2_CAPABILITY) ? { worker: init.worker, version: init.version } : null;
                        this.ordinaryParametersCapability = caps.includes(ORDINARY_V2_CAPABILITY) ? { worker: init.worker, version: init.version } : null;
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
                }
                if (pending.appCleanup) {
                    const report = captureAppCleanupReport(Object.getOwnPropertyDescriptor(msg, 'appCleanup')?.value, this.appInstanceId);
                    const validPhase = report && msg.type === 'LIFECYCLE_RESPONSE' && report.state !== 'active' &&
                        (pending.appCleanup === 'APP_CLOSE' ? ['completed', 'failed'].includes(report.state) : ['stopped', 'failed'].includes(report.state));
                    if (validPhase) this.lastAppCleanup = report;
                    appCleanupSucceeded = !!validPhase && report.issues.length === 0 &&
                        (pending.appCleanup === 'APP_CLOSE' ? report.state === 'completed' : report.state === 'stopped');
                    // APP_STOP has no persistence operation whose result can explain a failed terminal.
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

        // 处理 Worker 主动请求
        if (isRequest(msg)) {
            switch (msg.type) {
                case 'REQUEST_UPDATE':
                    this.onUpdateRequest?.();
                    break;
            }
            return;
        }

        if (msg.type === 'SNAPSHOT_PREPARED' || msg.type === 'SNAPSHOT_PREPARE_FAILED') {
            let notify = false;
            try {
                const result = msg.type === 'SNAPSHOT_PREPARED'
                    ? this.snapshotReceiver.acceptPrepared(msg.draft)
                    : this.snapshotReceiver.acceptPrepareFailure({
                        appId: msg.appId, instanceId: msg.instanceId,
                        producerSeq: msg.producerSeq, sourceEpoch: msg.sourceEpoch,
                        issue: { code: msg.error?.code === 'SNAPSHOT_SERIALIZATION_ERROR'
                            ? 'SNAPSHOT_SERIALIZATION_ERROR' : 'SNAPSHOT_INVALID',
                            message: typeof msg.error?.message === 'string'
                                ? msg.error.message.slice(0, 160) : 'Semantic producer failed' },
                    });
                notify = result.status === 'published' || result.healthChanged;
            } catch {
                this.handleError(new Error('Semantic snapshot reception failed'));
                notify = true;
            }
            if (!msg.suppressSignal && notify) this.onUpdateRequest?.();
            return;
        }



    }

    private handleError(error: Error): void {
        this.beginInteractionClose();
        if (this.persistenceSupport === 'managed') this.persistenceUnsafe = true;
        this.lifecycleContextVersion++;
        this.snapshotReceiver?.close();
        if (this.interactionModes.length > 0) console.error('[AppWorkerHost] Worker failed in Ref-capable execution');
        else console.error(`[AppWorkerHost] Worker ${this.appId} error:`, error);
        this.status = 'error';
        this.cleanupPendingRequests();
    }

    private detachWorkerListeners(worker = this.worker): void {
        worker?.off('message', this.workerMessageListener);
        worker?.off('error', this.workerErrorListener);
        worker?.off('exit', this.workerExitListener);
    }

    private handleExit(code: number): void {
        this.beginInteractionClose();
        if (this.persistenceSupport === 'managed' && !this.lastPersistence?.ok) this.persistenceUnsafe = true;
        this.lifecycleContextVersion++;
        this.snapshotReceiver?.close();
        if (code !== 0) {
            console.error(`[AppWorkerHost] Worker ${this.appId} exited with code ${code}`);
        }
        this.detachWorkerListeners();
        this.worker = null;
        if (this.status !== 'closed') {
            this.status = 'error';
        }
        this.cleanupPendingRequests();
    }
}
