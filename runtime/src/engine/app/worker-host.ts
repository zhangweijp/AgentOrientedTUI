import { APP_LIFECYCLE_PROTOCOL } from '@aotui/core';
import { WORKER_PROTOCOL } from '../../spi/worker-protocol/types.js';
import { initializationError } from '../../adapters/initialization-error.js';
import { captureAppLifecycleAck, captureAppCleanupReport } from '../../adapters/app-lifecycle-protocol.js';
import type { AppCleanupReport } from '../../spi/runtime/app-lifecycle.interface.js';

import { appInteractionUnavailable, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import { checkWireJson, normalizeProjectionLimits } from '@aotui/core';
import { captureSnapshotDraftEnvelope, captureSnapshotPrepareIssue, projectCompleteViews,
    type Issue, type SnapshotDraftEnvelope } from '@aotui/core/host';
import type { AppPreviewResult, InstanceInteraction, PrepareObservationResult, ProjectionLimits, ViewIdentity } from '@aotui/core';
import type { AppWindows, ViewCloseResult } from '../../spi/runtime/windows.js';
import type { CapturedAppInteractionOptions } from './interaction-config.js';
import { TOOL_REQUEST_LIMITS } from '@aotui/core/producer';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SemanticSnapshotReceiver } from '../../adapters/snapshot/receiver.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, InteractionStats,
    InvocationContext, InvocationSource, AppInteractionPolicy } from '@aotui/core';
import { captureToolInvocationTerminal } from '../../adapters/worker-message-capture.js';
import type { WorkerCapacity } from './worker-capacity.js';
import { closeError } from '../core/close-handle.js';
import type { UpdateSignal } from '../../spi/core/signals.js';
import type { AppExecutionBackend, AppExecutionIssue } from '../../spi/runtime/execution-backend.js';
import { startExecutionBackend, type ExecutionConnection, type ExecutionTransport,
    type TransportEvents } from '../../adapters/execution-transport.js';
import { startNodeWorker } from '../../adapters/node-worker-transport.js';

import type { AppID, DesktopID } from '@aotui/core';
import { WORKER_DEFAULTS, type WorkerConfig } from '../../spi/config/index.js';

import {
    generateRequestId,
    type RequestID,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
} from '../../spi/worker-protocol/index.js';

/**
 * 待处理请求
 */
type WorkerLifecycle = { worker: ExecutionTransport; version: number };

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout?: ReturnType<typeof setTimeout>;
    init?: WorkerLifecycle & { handled?: true };
    tool?: { worker: ExecutionTransport; appId: string; instanceId: string; completion: Promise<ExecutionFact> };
    initialOpen?: true;
    appCleanup?: 'APP_STOP' | 'APP_CLOSE';
    projection?: WorkerLifecycle & { known?: SnapshotDraftEnvelope; timedOut?: true };
}

/**
 * AppWorkerHost 配置
 */
export interface AppWorkerHostConfig extends CapturedAppInteractionOptions {
    readonly policy?: AppInteractionPolicy;
    appId: AppID;
    desktopId: DesktopID;
    name?: string;  // App name for TUI output
    appModulePath?: string;
    readonly installationId?: string;
    readonly command?: readonly string[];
    readonly backend?: AppExecutionBackend;
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
    readonly interactions: { readonly closed: boolean; readonly retainedOperations: number };
    readonly closingInvocation?: NonNullable<InteractionStats['closingInvocation']>;
    readonly resourcesReleased: boolean;
    readonly issues: readonly ('WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED' | 'EXECUTION_CHANNEL_ENDED')[];
}


const DEFAULT_APP_INTERACTION_POLICY: AppInteractionPolicy = Object.freeze({
    project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true,
});
/** Owns one App's requests, observations and cleanup across execution transports. */
export class AppWorkerHost {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly name?: string;
    private readonly config?: import('@aotui/core').AppLaunchConfig;
    private readonly projectionLimits: ProjectionLimits;

    private worker: ExecutionTransport | null = null;
    private terminateExecution?: ExecutionConnection['terminate'];
    private channelFailure?: Error;
    private status: WorkerStatus = 'starting';
    private pendingRequests = new Map<RequestID, PendingRequest>();
    readonly timeout: number;
    private readonly startExecution: (emit: TransportEvents) => ExecutionConnection;
    private readonly appModulePath?: string;
    /** Assigned by the Runtime per logical App execution; distinct from Worker thread ID. */
    readonly appInstanceId: string;
    private readonly snapshotReceiver: SemanticSnapshotReceiver;
    private projectionRefresh?: { requestId: RequestID; promise: Promise<void> };
    private projectionBaseline?: WorkerLifecycle;
    private readonly toolsEnabled: boolean;
    private readyWorker: WorkerLifecycle | null = null;
    private interactionsClosed = false;
    private readonly interaction: InstanceInteraction;
    private observing = false;
    private readonly interactionBindings = new WeakMap<InvocationSource, ExecutionBinding>();
    private closePromise: Promise<void> | null = null;
    private readonly workerCapacity?: WorkerCapacity;
    private releaseCapacity?: () => void;
    private readonly lifecycleRequests = new Set<Promise<void>>();
    private lifecycleContextVersion = 0;
    private initAttempted = false;
    private appLifecycleSupport: 'offered' | 'managed' | 'rejected' = 'offered';
    private lastAppCleanup?: AppCleanupReport;

    private resourceWorkerState: HostResourceReport['worker'] = 'not-created';
    private actualExitResolve!: () => void;
    private readonly actualExit = new Promise<void>(resolve => { this.actualExitResolve = resolve; });
    private terminationRequested = false;
    private terminationAttempt?: Promise<void>;
    private resourceReleaseStarted = false;
    private resourceSettled = false;
    private resourcePromise?: Promise<HostResourceReport>;
    private readonly resourceIssues = new Set<HostResourceReport['issues'][number]>();

    getResourceReport(): HostResourceReport {
        const core = this.snapshotReceiver?.getInteractionStats();
        const interactions = Object.freeze({ closed: this.interactionsClosed, retainedOperations: core ? core.activeInvocations + core.activeReads + core.observations.observationSlots + core.borrowedSnapshots : 0 });
        const resourcesReleased = ['not-created', 'exited'].includes(this.resourceWorkerState) &&
            interactions.closed && interactions.retainedOperations === 0;
        return Object.freeze({ state: this.resourceSettled ? 'settled' : this.resourceReleaseStarted || this.closePromise ? 'closing' : 'active',
            appCleanup: Object.freeze({ support: this.appLifecycleSupport, ...(this.lastAppCleanup ? { report: this.lastAppCleanup } : {}) }),
            worker: this.resourceWorkerState, interactions, resourcesReleased,
            ...(core?.closingInvocation ? { closingInvocation: core.closingInvocation } : {}),
            issues: Object.freeze([...this.resourceIssues]) });
    }
    waitForResourceRelease(): Promise<HostResourceReport> {
        if (!this.resourceReleaseStarted) return Promise.reject(Object.assign(new Error('Resource release has not started'), { code: 'RESOURCE_RELEASE_NOT_STARTED' }));
        if (!this.resourcePromise || (this.resourceSettled && !this.getResourceReport().resourcesReleased)) {
            this.resourceSettled = false;
            this.resourcePromise = Promise.resolve().then(async () => {
                await this.waitForWorkerExit();
                await this.snapshotReceiver.close();
                this.resourceSettled = true;return this.getResourceReport();
            });
            void this.resourcePromise.catch(() => {});
        }
        return this.resourcePromise;
    }

    async waitForReleaseAttempt(): Promise<HostResourceReport> {
        await this.terminationAttempt;
        return this.worker ? this.getResourceReport() : this.waitForResourceRelease();
    }

    retryRelease(): void {
        this.requestTermination(true);
    }

    private beginResourceRelease(): void {
        if (this.resourceReleaseStarted) return;
        this.resourceReleaseStarted = true;
        void this.waitForResourceRelease().catch(() => {});
    }

    private waitForWorkerExit(): Promise<void> {
        return this.worker ? this.actualExit : Promise.resolve();
    }

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
        return this.toolsEnabled && !this.interactionsClosed && !this.channelFailure && this.readyWorker?.worker === this.worker &&
            this.readyWorker?.version === this.lifecycleContextVersion;
    }

    private pendingTool() {
        for (const pending of this.pendingRequests.values()) if (pending.tool) return pending.tool;
    }

    private interactionAvailable(): boolean {
        return !this.interactionsClosed && !this.channelFailure && !!this.snapshotReceiver && !!this.worker &&
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
        // A disconnected App can still be closed and its terminal receipts queried.
        if (!this.interactionAvailable() && (!this.channelFailure || this.interactionsClosed)) return appInteractionUnavailable();
        return Object.freeze({ status: 'ready', interaction: this.interaction });
    }

    async prepareObservation(prepare: (interaction: InstanceInteraction) => Promise<PrepareObservationResult>): Promise<PrepareObservationResult> {
        if (this.channelFailure && !this.interactionsClosed) return projectionRejection(this.channelFailure);
        if (!this.interactionAvailable()) return appInteractionUnavailable();
        if (this.observing) return { status: 'rejected', issue: { code: 'OBSERVATION_BUSY', message: 'An observation is already being prepared.' } };
        this.observing = true;
        try {
            await this.refreshProjection();
            if (!this.interactionAvailable()) return appInteractionUnavailable();
            return await prepare(this.interaction);
        } catch (error) { return projectionRejection(error); }
        finally { this.observing = false; }
    }

    async preview(): Promise<AppPreviewResult> {
        if (this.channelFailure && !this.interactionsClosed) return projectionRejection(this.channelFailure);
        if (!this.interactionAvailable()) return appInteractionUnavailable();
        try {
            await this.refreshProjection();
            return this.interactionAvailable() ? this.interaction.preview() : appInteractionUnavailable();
        } catch (error) { return projectionRejection(error); }
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
        expected: WorkerLifecycle & { signal: CancellationSignal }): ExecutionFact | Promise<ExecutionFact> {
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

    private dispatchViewOperation(message: Extract<MainToWorkerMessage, { type: 'VIEW_TOOL_INVOKE' | 'VIEW_CLOSE' }>, worker: ExecutionTransport): Promise<ExecutionFact> {
        const { requestId, appId, instanceId } = message;
        let resolve!: (fact: ExecutionFact) => void;
        const completion = new Promise<ExecutionFact>(complete => { resolve = complete; });
        this.pendingRequests.set(requestId, { resolve, reject: () => {},
            tool: { worker, appId, instanceId, completion } });
        try { worker.postMessage(message); }
        catch { /* Without a terminal or exit, this attempt cannot prove completion. */ }
        return completion;
    }

    private settleToolChannelEnd(worker: ExecutionTransport): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.tool?.worker !== worker) continue;
            this.pendingRequests.delete(id);
            pending.resolve({ kind: 'unknown' } satisfies ExecutionFact);
        }
    }

    // Notify the Desktop when an App publication changes.
    onUpdate?: (reason: UpdateSignal['reason']) => void;
    constructor(config: AppWorkerHostConfig) {
        const policy = config.policy ?? DEFAULT_APP_INTERACTION_POLICY;
        this.projectionLimits = config.projectionLimits;
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.appModulePath = config.appModulePath;
        this.appInstanceId = randomUUID();
        this.toolsEnabled = config.toolsEnabled;
        this.snapshotReceiver = new SemanticSnapshotReceiver(String(this.appId), this.appInstanceId);

        const workerConfig = config.runtimeConfig?.worker ?? WORKER_DEFAULTS;
        this.timeout = workerConfig.timeoutMs;

        this.config = config.config;
        this.workerCapacity = config.workerCapacity;
        if (config.backend) {
            const backend = config.backend;
            this.startExecution = emit => startExecutionBackend(backend, {
                appId: this.appId, desktopId: this.desktopId, instanceId: this.appInstanceId,
                installationId: config.installationId ?? this.appId, name: this.name ?? this.appId,
                ...(config.command === undefined ? {} : { command: config.command }),
                ...(this.appModulePath === undefined ? {} : { modulePath: this.appModulePath }),
                ...(this.config === undefined ? {} : { config: this.config }),
                projectionLimits: this.projectionLimits, toolsEnabled: this.toolsEnabled, timeoutMs: this.timeout,
            }, emit);
        } else {
            this.startExecution = emit => {
                if (!this.appModulePath) throw closeError('APP_MODULE_REQUIRED');
                return startNodeWorker(emit);
            };
        }
        this.interaction = this.snapshotReceiver.interaction(policy, { resolve: this.resolveInteractionSource }, {
            observationLimits: this.projectionLimits,
            refreshProjection: () => this.refreshAuthority(),
            canExposeTools: () => this.canExecuteTools(),
        });
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
            this.releaseCapacity = this.workerCapacity?.reserve();
            try {
                this.bindExecution(this.startExecution);
            } catch (error) {
                if (!this.worker) {
                    this.releaseCapacity?.();
                    this.releaseCapacity = undefined;
                }
                throw error;
            }
            await this.sendLifecycleRequest({
                type: 'INIT',
                requestId: generateRequestId(),
                appId: this.appId,
                desktopId: this.desktopId,
                appModulePath: this.appModulePath ?? '',
                ...(this.name === undefined ? {} : { appName: this.name }),
                config: this.config, // ✨ Send config to Worker
                appInstanceId: this.appInstanceId,
                projectionLimits: this.projectionLimits,
                appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, instanceId: this.appInstanceId },
                protocol: WORKER_PROTOCOL, toolsEnabled: this.toolsEnabled,
            }, 'ready');
        } catch (error) {
            if (!this.closePromise) this.terminate();
            throw error;
        }
    }

    private bindExecution(start: (emit: TransportEvents) => ExecutionConnection): void {
        // Capture events raised by start() before ownership of the fresh handle transfers.
        const initial: Parameters<TransportEvents>[0][] = [];
        let connection: ExecutionConnection | undefined;
        const receive: TransportEvents = event => {
            if (!connection) { initial.push(event); return; }
            const { transport } = connection;
            if (this.worker !== transport) return;
            switch (event.kind) {
                case 'message':
                    if (!this.channelFailure && (this.status !== 'error' || event.message.type === 'VIEW_TOOL_INVOKE_RESPONSE'))
                        this.handleMessage(event.message);
                    break;
                case 'error': this.handleError(event.error); break;
                case 'channelEnded': this.handleChannelEnd(transport, event.issue); break;
                case 'exited': this.handleExit(transport, event.issue); break;
            }
        };
        connection = start(receive);
        this.worker = connection.transport;
        this.terminateExecution = connection.terminate;
        this.resourceWorkerState = 'owned';
        for (const event of initial) receive(event);
        if (this.terminationRequested) this.requestTermination();
    }

    private cleanupPendingRequests(error = new Error('Execution released or terminated')): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.tool) continue;
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(id);
            pending.reject(error);
        }
    }

    /**
     * 获取 Worker 状态
     */
    getStatus(): WorkerStatus {
        return this.status;
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
        if (this.terminationRequested || !this.worker || this.channelFailure) {
            this.closePromise = Promise.resolve().then(() => this.terminationAttempt);
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
                await Promise.race([this.finishAppClose(lifecycle, stopped), deadline]);
            } finally {
                clearTimeout(timer);
                this.terminate();
                await this.terminationAttempt;
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
        this.cleanupPendingRequests();
        this.beginResourceRelease();
        this.requestTermination();
    }

    private requestTermination(retry = false): void {
        if (!this.worker || (!retry && this.resourceWorkerState === 'retiring')) return;
        this.resourceWorkerState = 'retiring';
        let fail!: () => void;
        const refusal = new Promise<void>(resolve => { fail = resolve; });
        this.terminationAttempt = Promise.race([this.actualExit, refusal]);
        const failed = () => { this.resourceIssues.add('WORKER_TERMINATION_FAILED'); fail(); };
        try { void Promise.resolve(this.terminateExecution?.()).catch(failed); }
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
            if (this.channelFailure) { reject(this.channelFailure); return; }
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
                const appUnmountFailed = msg.type === 'LIFECYCLE_RESPONSE' && pending.appCleanup === 'APP_CLOSE' &&
                    msg.error?.code === 'APP_UNMOUNT_FAILED';
                if (pending.init) {
                    void this.acceptInitialization(id, pending, msg);
                    return;
                }
                const error = msg.type === 'INIT_RESPONSE' ? undefined : msg.error;
                if (pending.initialOpen && msg.success !== true) {
                    const cleanup = msg.type === 'LIFECYCLE_RESPONSE'
                        ? captureAppCleanupReport(msg.appCleanup, this.appInstanceId) : null;
                    if (cleanup && cleanup.state !== 'active') this.lastAppCleanup = cleanup;
                    clearTimeout(pending.timeout); this.pendingRequests.delete(msg.requestId);
                    pending.reject(initializationError(error, String(this.appId), 'OPEN'));
                    return;
                }
                if (pending.appCleanup) {
                    const report = msg.type === 'LIFECYCLE_RESPONSE' ? captureAppCleanupReport(msg.appCleanup, this.appInstanceId) : null;
                    const closing = pending.appCleanup === 'APP_CLOSE';
                    const validPhase = report && (closing ? ['completed', 'failed'].includes(report.state) : report.state !== 'active');
                    if (validPhase) this.lastAppCleanup = report;
                    appCleanupFailed = !validPhase || report.issues.length > 0 || !closing && msg.success !== true;
                }

                clearTimeout(pending.timeout);
                this.pendingRequests.delete(msg.requestId);

                if (appCleanupFailed) pending.reject(closeError('APP_CLEANUP_FAILED'));
                else if (appUnmountFailed) pending.reject(closeError('APP_UNMOUNT_FAILED'));
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

    private invalidateExecutionProjection(): void {
        if (this.status === 'starting' || this.status === 'ready') this.beginInteractionClose();
        else this.snapshotReceiver.invalidatePublication();
    }

    private handleError(error: Error): void {
        this.resourceIssues.add('WORKER_ERROR');
        this.invalidateExecutionProjection();
        this.lifecycleContextVersion++;
        console.error('[AppWorkerHost] Worker failed for App', this.appId);
        if (!this.terminationRequested) this.status = 'error';
        this.cleanupPendingRequests(error);
    }

    private handleChannelEnd(worker: ExecutionTransport, issue?: AppExecutionIssue): void {
        if (this.channelFailure) return;
        this.channelFailure = issue ? Object.assign(new Error(issue.message), { code: issue.code, path: issue.path })
            : closeError('EXECUTION_CHANNEL_ENDED');
        this.lifecycleContextVersion++;
        this.readyWorker = null;
        this.invalidateExecutionProjection();
        this.settleToolChannelEnd(worker);
        this.cleanupPendingRequests(this.channelFailure);
        if (!this.terminationRequested && !this.closePromise) {
            const wasRunning = this.status === 'running';
            this.resourceIssues.add('EXECUTION_CHANNEL_ENDED');
            this.status = 'error';
            if (wasRunning) this.onUpdate?.('projection_failed');
        }
    }

    private handleExit(worker: ExecutionTransport, issue?: AppExecutionIssue): void {
        if (this.worker !== worker) return;
        this.handleChannelEnd(worker, issue);
        if (!this.terminationRequested && (!this.closePromise || this.lastAppCleanup?.state !== 'completed')) {
            this.resourceIssues.add('WORKER_EXITED_UNEXPECTEDLY');
            this.status = 'error';
        }
        this.worker = null;
        this.terminateExecution = undefined;
        this.resourceWorkerState = 'exited';
        this.releaseCapacity?.();
        this.releaseCapacity = undefined;
        this.actualExitResolve();
    }
}

/** Only a validated snapshot rejection can expose details through an observation. */
class ProjectionRefreshFailure extends Error {
    readonly issue: Issue;

    constructor({ code, message, path }: Issue) {
        super(message);
        this.issue = Object.freeze({ code, message, ...(path === undefined ? {} : { path }) });
    }
}

function projectionRejection(error: unknown): Extract<AppInteractionResult, { status: 'rejected' }> {
    if (error instanceof ProjectionRefreshFailure) return Object.freeze({ status: 'rejected', issue: error.issue });
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'OBSERVATION_REFRESH_FAILED';
    return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: 'Committed projection could not be observed' }) });
}
