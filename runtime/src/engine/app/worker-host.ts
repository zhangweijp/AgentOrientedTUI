import { APP_LIFECYCLE_PROTOCOL } from '@aotui/core';
import { executionStartupError } from '../../adapters/initialization-error.js';
import { captureAppCleanupReport } from '../../adapters/app-lifecycle-protocol.js';
import type { AppCleanupReport } from '../../spi/runtime/app-lifecycle.interface.js';

import { appInteractionUnavailable, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import { checkWireJson, copyWireJson } from '@aotui/core';
import { captureSnapshotDraftEnvelope, captureSnapshotPrepareIssue, projectCompleteViews,
    type Issue, type SnapshotDraftEnvelope } from '@aotui/core/host';
import type { AppPreviewResult, InstanceInteraction, PrepareObservationResult, ProjectionLimits } from '@aotui/core';
import type { AppWindows } from '../../spi/runtime/windows.js';
import type { CapturedAppInteractionOptions } from './interaction-config.js';
import { TOOL_REQUEST_LIMITS } from '@aotui/core/producer';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SemanticSnapshotReceiver } from '../../adapters/snapshot/receiver.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, InteractionStats,
    InvocationContext, InvocationSource, AppInteractionPolicy } from '@aotui/core';
import { captureExecutionTerminal } from '../../adapters/worker-message-capture.js';
import type { WorkerCapacity } from './worker-capacity.js';
import { closeError } from '../core/close-handle.js';
import type { UpdateSignal } from '../../spi/core/signals.js';
import type { AppExecutionBackend, AppExecutionIssue, AppExecutionRequest, AppExecutionAcceptance } from '../../spi/runtime/execution-backend.js';
import { startExecutionBackend, type ExecutionConnection, type ExecutionTransport,
    type TransportEvents, type TransportEvent, type ExecutionOptions, type AcceptFrame } from '../../adapters/execution-transport.js';
import type { AppRunFacts } from '../../spi/runtime/kernel.interface.js';
import { startNodeWorker } from '../../adapters/node-worker-transport.js';

import type { AppID, DesktopID } from '@aotui/core';
import { WORKER_DEFAULTS, type WorkerConfig } from '../../spi/config/index.js';

type RequestID = string;
type WorkerLifecycle = { worker: ExecutionTransport; version: number };
type BusinessRequest = Extract<AppExecutionRequest, { kind: 'invoke' | 'closeView' }>;
type ControlRequest = Exclude<AppExecutionRequest, BusinessRequest>;
type ControlPending = WorkerLifecycle & {
    request: ControlRequest;
    actual: Promise<void>;
    complete: (error?: Error) => void;
    wait: Promise<void>;
    rejectWait: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    sample?: SnapshotDraftEnvelope;
    issue?: Issue;
};
type BusinessPending = WorkerLifecycle & {
    request: BusinessRequest;
    tool: { completion: Promise<ExecutionFact>; resolve: (fact: ExecutionFact) => void };
};
type PendingRequest = ControlPending | BusinessPending;

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
    project: ({source}: Parameters<AppInteractionPolicy['project']>[0]) => ({ ...projectCompleteViews({source}),
        closeViews: source.views.filter(view => view.closeActivationId).map(view => ({viewId:view.id,viewInstanceId:view.viewInstanceId})) }), authorize: () => true, canReadReceipt: () => true,
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
    private readonly externalExecution: boolean;
    /** Assigned by the Runtime per logical App execution; distinct from Worker thread ID. */
    readonly appInstanceId: string;
    private readonly snapshotReceiver: SemanticSnapshotReceiver;
    private projectionRefresh?: ControlPending;
    private readonly toolsEnabled: boolean;
    private readyWorker: WorkerLifecycle | null = null;
    private interactionsClosed = false;
    private readonly interaction: InstanceInteraction;
    private observing = false;
    private readonly interactionBindings = new WeakMap<InvocationSource, ExecutionBinding>();
    private closePromise: Promise<void> | null = null;
    private readonly workerCapacity?: WorkerCapacity;
    private releaseCapacity?: () => void;
    private readonly executionOptions: ExecutionOptions;
    private startupControl?: ExecutionConnection['startup'];
    private initializeSent = false;
    private openSent = false;
    private opened = false;
    private transferring?: Promise<void>;
    private executionIssue?: Issue;
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

    /** A later nonterminal report cannot erase an already confirmed cleanup terminal. */
    private rememberAppCleanup(report: AppCleanupReport): boolean {
        const last = this.lastAppCleanup;
        if (last?.state === 'completed' || last?.state === 'failed') {
            if (report.state === 'completed' || report.state === 'failed') {
                return isDeepStrictEqual(last, report);
            }
            return true;
        }
        this.lastAppCleanup = report;
        return true;
    }

    private hasCleanupContract(): boolean {
        return this.appLifecycleSupport === 'managed' ||
            (this.externalExecution && (this.startupControl?.cleanupRequired ?? this.initializeSent));
    }

    getResourceReport(): HostResourceReport {
        const core = this.snapshotReceiver?.getInteractionStats();
        const interactions = Object.freeze({ closed: this.interactionsClosed, retainedOperations: core ? core.activeInvocations + core.activeReads + core.observations.observationSlots + core.borrowedSnapshots : 0 });
        const resourcesReleased = ['not-created', 'exited'].includes(this.resourceWorkerState) &&
            interactions.closed && interactions.retainedOperations === 0 && !this.transferring && this.resourceSettled;
        return Object.freeze({ state: this.resourceSettled ? 'settled' : this.resourceReleaseStarted || this.closePromise ? 'closing' : 'active',
            appCleanup: Object.freeze({ support: this.hasCleanupContract() ? 'managed' : this.appLifecycleSupport, ...(this.lastAppCleanup ? { report: this.lastAppCleanup } : {}) }),
            worker: this.resourceWorkerState, interactions, resourcesReleased,
            ...(core?.closingInvocation ? { closingInvocation: core.closingInvocation } : {}),
            issues: Object.freeze([...this.resourceIssues]) });
    }
    waitForResourceRelease(): Promise<HostResourceReport> {
        if (!this.resourceReleaseStarted) return Promise.reject(Object.assign(new Error('Resource release has not started'), { code: 'RESOURCE_RELEASE_NOT_STARTED' }));
        if (!this.resourcePromise || (this.resourceSettled && !this.getResourceReport().resourcesReleased)) {
            this.resourceSettled = false;
            this.resourcePromise = Promise.resolve().then(async () => {
                await this.transferring;
                await this.waitForWorkerExit();
                await this.snapshotReceiver.close();
                this.resourceSettled = true;
                this.onUpdate?.('app_runtime_changed');
                return this.getResourceReport();
            });
            void this.resourcePromise.catch(() => {});
        }
        return this.resourcePromise;
    }

    async waitForReleaseAttempt(): Promise<HostResourceReport> {
        await this.transferring;
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
        for (const pending of this.pendingRequests.values()) {
            if (!('tool' in pending) && pending.request.kind === 'observe') {
                clearTimeout(pending.timer);
                pending.rejectWait(closeError('PROJECTION_CLOSED'));
            }
        }
    }

    private revokeInteraction(): void {
        this.readyWorker = null;
        if (this.interactionsClosed) void this.snapshotReceiver.close();
        else void this.snapshotReceiver.closeInteractions();
    }

    readRunFacts(): AppRunFacts {
        const resource = this.getResourceReport();
        const projection = this.snapshotReceiver.readHealth();
        const execution = Object.freeze({
            resource: resource.worker,
            channel: this.channelFailure ? 'ended' as const : this.worker ? 'open' as const : 'not-established' as const,
            ...(this.executionIssue ? { issue: this.executionIssue } : {}),
        });
        const unavailable = this.interactionsClosed ? { code: 'APP_STOPPED', message: 'App is closing' }
            : this.executionIssue ?? (projection.health === 'degraded' ? projection.issue : undefined)
                ?? { code: 'SNAPSHOT_UNREADY', message: 'App has no current usable projection' };
        const availability = this.interactionAvailable() && projection.health === 'ready'
            ? Object.freeze({ status: 'ready' as const })
            : Object.freeze({ status: 'unavailable' as const, issue: Object.freeze(unavailable) });
        return Object.freeze({
            phase: this.closePromise || this.terminationRequested ? 'closing' : this.opened ? 'opened' : 'starting',
            execution, projection, availability, toolsEnabled: this.toolsEnabled, resourcesReleased: resource.resourcesReleased,
        });
    }

    canExecuteTools(): boolean {
        return this.toolsEnabled && !this.interactionsClosed && !this.channelFailure && this.readyWorker?.worker === this.worker &&
            this.readyWorker?.version === this.lifecycleContextVersion;
    }

    private pendingTool() {
        for (const pending of this.pendingRequests.values()) if ('tool' in pending) return pending.tool;
    }

    private interactionAvailable(): boolean {
        return !this.interactionsClosed && !this.channelFailure && !!this.snapshotReceiver && !!this.worker &&
            this.status === 'running' && this.resourceWorkerState === 'owned' && !this.closePromise;
    }

    getWindows(): AppWindows {
        return {
            appId: this.appId, instanceId: this.appInstanceId,
            views: this.snapshotReceiver.currentViews().map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId,
                name: view.name, type: view.type, region: view.region, canClose: !!view.closeActivationId && !!this.snapshotReceiver.currentPublication() && this.canExecuteTools() })),
        };
    }

    getAppInteraction(): AppInteractionResult {
        // A disconnected App can still be closed and its terminal receipts queried.
        if (!this.opened || this.interactionsClosed) return appInteractionUnavailable();
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
        if (!this.interactionAvailable()) return Promise.reject(closeError('PROJECTION_CLOSED'));
        try {
            const known = this.snapshotReceiver.currentPublication();
            const pending = this.projectionRefresh ?? this.registerRequest({ kind: 'observe', id: randomUUID(), ...(known ? { known } : {}) });
            return pending.wait.then(() => {
                if (!this.interactionAvailable()) throw closeError('PROJECTION_CLOSED');
                if (!pending.sample || !this.currentSample(pending.sample))
                    throw new ProjectionRefreshFailure(this.snapshotReceiver.currentFailure()
                        ?? { code: 'SNAPSHOT_UNAVAILABLE', message: 'The original observation sample is no longer current' });
            });
        } catch (error) { return Promise.reject(error); }
    }

    private async refreshAuthority(): Promise<void> {
        // An earlier caller may already have sampled. Retain the actual slot
        // across waiter timeout, and confirm again only after actual settlement.
        const prior = this.projectionRefresh;
        if (prior) await prior.wait.catch(() => {});
        return this.refreshProjection();
    }

    private readonly resolveInteractionSource = (source: InvocationSource): ExecutionBinding | null => {
        if (!this.interactionAvailable() || source.appId !== String(this.appId) || source.instanceId !== this.appInstanceId) return null;
        const existing = this.interactionBindings.get(source);
        if (existing) return existing;
        if (!this.canExecuteTools()) return null;
        const worker = this.worker!, version = this.lifecycleContextVersion;
        const binding: ExecutionBinding = Object.freeze({ identity: Object.freeze({}),
            isLive: () => this.interactionAvailable() && this.worker === worker &&
                this.lifecycleContextVersion === version && this.canExecuteTools(),
            execute: (context: InvocationContext) => {
                const common = { id: randomUUID() };
                const message = source.kind === 'closeView'
                    ? { ...common, kind: 'closeView' as const, ...source.receiver }
                    : { ...common, kind: 'invoke' as const,
                        tool: { name: source.tool.name, viewType: source.tool.viewType },
                        receiver: source.receiver, input: context.effectiveInput,
                        localRefs: context.refSources.filter(ref => ref.appId === source.appId && ref.instanceId === source.instanceId)
                            .map(({param,index,viewId,viewInstanceId,refId,since}) =>
                                ({param, ...(index === undefined ? {} : {index}), viewId, viewInstanceId, refId, since})) };
                return this.dispatchTool(message, { worker, version, signal: context.signal });
            },
        });
        this.interactionBindings.set(source, binding);
        return binding;
    };

    private dispatchTool(message: BusinessRequest,
        expected: WorkerLifecycle & { signal: CancellationSignal }): ExecutionFact | Promise<ExecutionFact> {
        const refused = (code: string, text: string): ExecutionFact => ({ kind: 'tool-result', phase: 'not-entered',
            result: { success: false, error: { code, message: text } } });
        const live = () => this.interactionAvailable() && this.canExecuteTools() &&
            this.worker === expected.worker && this.lifecycleContextVersion === expected.version && !expected.signal.aborted;
        if (!live() || this.pendingTool()) return refused('TOOL_EXECUTION_UNAVAILABLE', 'Worker Tool execution is unavailable');
        try { checkWireJson({ ...message, appId: this.appId, instanceId: this.appInstanceId }, TOOL_REQUEST_LIMITS); }
        catch { return refused('REF_ARGUMENT_BUDGET_EXCEEDED', 'Complete Ref request exceeds the transport budget'); }
        if (!live() || this.pendingTool()) return refused('TOOL_EXECUTION_UNAVAILABLE', 'Worker Tool execution is unavailable');
        return this.dispatchViewOperation(message, expected.worker);
    }

    private dispatchViewOperation(request: BusinessRequest, worker: ExecutionTransport): Promise<ExecutionFact> {
        const { promise: completion, resolve } = deferred<ExecutionFact>();
        this.pendingRequests.set(request.id, { request, worker, version: this.lifecycleContextVersion, tool: { completion, resolve } });
        try { worker.send(request); }
        catch { /* A thrown send cannot prove that the business operation did not enter. */ }
        return completion;
    }

    private settleToolChannelEnd(worker: ExecutionTransport): void {
        for (const [id, pending] of this.pendingRequests) {
            if (!('tool' in pending) || pending.worker !== worker) continue;
            this.pendingRequests.delete(id);
            pending.tool.resolve({ kind: 'unknown' });
        }
    }

    // Notify the Desktop when an App publication changes.
    onUpdate?: (reason: UpdateSignal['reason']) => void;
    constructor(config: AppWorkerHostConfig) {
        this.externalExecution = !!config.backend;
        const policy = config.policy ?? DEFAULT_APP_INTERACTION_POLICY;
        this.projectionLimits = config.projectionLimits;
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.appModulePath = config.appModulePath;
        this.appInstanceId = randomUUID();
        this.toolsEnabled = config.toolsEnabled;
        this.snapshotReceiver = new SemanticSnapshotReceiver(String(this.appId), this.appInstanceId, undefined, this.projectionLimits);

        const workerConfig = config.runtimeConfig?.worker ?? WORKER_DEFAULTS;
        this.timeout = workerConfig.timeoutMs;

        this.config = config.config;
        this.workerCapacity = config.workerCapacity;
        this.executionOptions = Object.freeze({
            appId: this.appId, desktopId: this.desktopId, instanceId: this.appInstanceId,
            installationId: config.installationId ?? this.appId, name: this.name ?? this.appId,
            ...(config.command === undefined ? {} : { command: config.command }),
            ...(this.appModulePath === undefined ? {} : { modulePath: this.appModulePath }),
            ...(this.config === undefined ? {} : { config: this.config }),
            projectionLimits: this.projectionLimits, toolsEnabled: this.toolsEnabled, timeoutMs: this.timeout,
        });
        if (config.backend) {
            const backend = config.backend;
            this.startExecution = emit => startExecutionBackend(backend, this.executionOptions, emit, this.acceptFrame);
        } else {
            this.startExecution = emit => {
                if (!this.appModulePath) throw closeError('APP_MODULE_REQUIRED');
                return startNodeWorker(this.executionOptions, emit, this.acceptFrame, this.kindOf, this.name);
            };
        }
        this.interaction = this.snapshotReceiver.interaction(policy, { resolve: this.resolveInteractionSource }, {
            observationLimits: this.projectionLimits,
            limits: config.interactionLimits,
            refreshProjection: () => this.refreshAuthority(),
            canExposeTools: () => this.canExecuteTools(),
        });
    }

    private readonly kindOf = (id: string) => this.pendingRequests.get(id)?.request.kind;

    private readonly acceptFrame: AcceptFrame = (intake, mode, requestId) => {
        if (!this.worker || this.interactionsClosed || this.channelFailure || this.terminationRequested ||
            !this.initializeSent || this.status === 'error')
            return { status: 'rejected', issue: { code: 'APP_STOPPED', message: 'Execution cannot publish' } };
        const pending = requestId === undefined ? undefined : this.pendingRequests.get(requestId);
        const sampled = pending && !('tool' in pending) && pending.worker === this.worker &&
            pending.version === this.lifecycleContextVersion &&
            (pending.request.kind === 'open' || pending.request.kind === 'observe') ? pending : undefined;
        let result: ReturnType<SemanticSnapshotReceiver['acceptPrepared']>;
        try {
            result = 'draft' in intake ? this.snapshotReceiver.acceptPrepared(intake.draft, mode, intake.viewTypes)
                : this.snapshotReceiver.rejectPrepared(intake.envelope, intake.rejected, mode);
        } catch (error) {
            this.beginInteractionClose();
            this.handleError(error instanceof Error ? error : closeError('SNAPSHOT_INVALID'));
            return { status: 'rejected', issue: { code: 'SNAPSHOT_INVALID', message: 'Receiver could not accept the publication' } };
        }
        let acceptance: AppExecutionAcceptance;
        if (result.status === 'rejected') {
            if (sampled) { sampled.issue = result.issue; delete sampled.sample; }
            acceptance = { status: 'rejected', issue: result.issue };
        } else {
            const publication = this.snapshotReceiver.currentPublication()!;
            if (sampled) { sampled.sample = publication; delete sampled.issue; }
            acceptance = { status: 'accepted', publication };
        }
        if (result.healthChanged) {
            this.onUpdate?.('app_runtime_changed');
            if (result.status === 'rejected') this.onUpdate?.('projection_failed');
        }
        return acceptance;
    };

    async start(): Promise<void> {
        if (this.initAttempted || this.closePromise || this.status !== 'starting') throw closeError('APP_INSTANCE_REUSE_UNSUPPORTED');
        this.initAttempted = true;
        this.lifecycleContextVersion++;
        const transfer = deferred<void>();
        this.transferring = transfer.promise;
        try {
            this.releaseCapacity = this.workerCapacity?.reserve();
            this.bindExecution(this.startExecution);
        } catch (error) {
            if (!this.worker) { this.releaseCapacity?.(); this.releaseCapacity = undefined; }
            throw error;
        } finally {
            this.transferring = undefined;
            transfer.resolve();
        }
        if (this.closePromise || this.interactionsClosed || !this.worker || this.channelFailure) throw this.channelFailure ?? closeError('APP_STOPPED');
        const owner = this.worker;
        const version = this.lifecycleContextVersion;
        try { await this.sendRequest({ kind: 'initialize', id: randomUUID() }); }
        catch (error) {
            // Record the caller failure now; Manager will attach the same actual
            // cleanup owner to INSTALL_FAILED without replacing its original cause.
            this.executionIssue ??= boundedIssue(error instanceof Error ? { code: 'code' in error ? error.code : 'E_INIT_FAILED', message: error.message } : undefined,
                'E_INIT_FAILED', 'App initialization failed');
            if (!this.externalExecution && this.appLifecycleSupport === 'rejected') this.terminate();
            else void this.close().catch(() => {});
            throw error;
        }
        if (this.worker !== owner || this.lifecycleContextVersion !== version || this.closePromise || this.interactionsClosed)
            throw closeError('APP_STOPPED');
        this.status = 'ready';
        this.readyWorker = { worker: owner, version };
    }

    private bindExecution(start: (emit: TransportEvents) => ExecutionConnection): void {
        // The actual handle may be returned after a reentrant close. Preserve
        // ownership even then; early events belong only to this connection.
        const initial: TransportEvent[] = [];
        let connection: ExecutionConnection | undefined;
        const receive: TransportEvents = event => {
            if (!connection) {
                // Before ownership transfer only physical failure/exit facts are
                // relevant; retain at most one of each, in original arrival order.
                if (['channelEnded', 'exited', 'error'].includes(event.kind) && !initial.some(old => old.kind === event.kind))
                    initial.push(event);
                return;
            }
            const { transport } = connection;
            if (this.worker !== transport) return;
            if (event.kind === 'channelEnded') this.handleChannelEnd(transport, event.issue);
            else if (event.kind === 'exited') this.handleExit(transport, event.issue);
            else if (event.kind === 'error') this.handleError(event.error);
            else if (!this.channelFailure) this.handleEvent(event);
        };
        connection = start(receive);
        this.worker = connection.transport;
        this.terminateExecution = connection.terminate;
        this.startupControl = connection.startup;
        this.resourceWorkerState = 'owned';
        for (const event of initial) receive(event);
        this.onUpdate?.('app_runtime_changed');
        if (this.terminationRequested) this.requestTermination();
    }

    getStatus(): WorkerStatus { return this.status; }

    async open(): Promise<void> {
        if (this.status !== 'ready' || this.openSent || this.closePromise || !this.worker) throw closeError('APP_STOPPED');
        const worker = this.worker;
        const version = this.lifecycleContextVersion;
        const id = randomUUID();
        let pending: ControlPending;
        try {
            pending = this.registerRequest({ kind: 'open', id });
            await pending.wait;
            if (this.worker !== worker || version !== this.lifecycleContextVersion || this.interactionsClosed || this.channelFailure)
                throw closeError('APP_STOPPED');
            if (!pending.sample || !this.currentSample(pending.sample)) throw new ProjectionRefreshFailure(this.snapshotReceiver.currentFailure()
                ?? { code: 'SNAPSHOT_UNAVAILABLE', message: 'OPEN projection is not healthy' });
        } catch (error) {
            this.executionIssue ??= boundedIssue(error instanceof ProjectionRefreshFailure ? error.issue : error instanceof Error ? { code: 'code' in error ? error.code : 'E_OPEN_FAILED', message: error.message } : undefined,
                'E_OPEN_FAILED', 'App opening failed');
            // A terminal event or reentrant close may have already invalidated this
            // continuation. Do not replace its status or cleanup ownership.
            if (this.worker === worker && version === this.lifecycleContextVersion && !this.terminationRequested && !this.closePromise)
                void this.close().catch(() => {});
            throw error;
        }
        this.status = 'running';
        this.opened = true;
        this.onUpdate?.('app_runtime_changed');
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        const graceEndsAt = performance.now() + this.timeout;
        const lifecycle = [...this.pendingRequests.values()].filter((record): record is ControlPending => !('tool' in record))
            .map(record => record.actual);
        this.status = 'closing';
        this.lifecycleContextVersion++;
        let stopped: Promise<void> | undefined;
        let cleanupRequired = this.hasCleanupContract();
        const startupSeal = this.startupControl?.sealStartup();
        const sealAndStop = () => {
            if (!this.worker || this.channelFailure || this.terminationRequested) return;
            const raw = startupSeal ?? this.startupControl?.sealStartup();
            if (raw === 'not-dispatched') {
                // This is actual adapter knowledge, not an absent ready reply.
                for (const pending of this.pendingRequests.values())
                    if (!('tool' in pending) && pending.request.kind === 'initialize')
                        this.finishRequest(pending, closeError('APP_STOPPED'));
                return;
            }
            cleanupRequired = raw === 'cleanup-required' || this.externalExecution && this.initializeSent ||
                this.appLifecycleSupport === 'managed' || this.openSent;
            if (cleanupRequired) this.appLifecycleSupport = 'managed';
            // For Node, STOP also invalidates an outstanding module load, even
            // when no author initialization has yet been handed off.
            if (cleanupRequired || !this.externalExecution && this.initializeSent) {
                const stop = this.registerRequest({ kind: 'stop', id: randomUUID() });
                stopped = stop.actual;
            }
        };
        this.closePromise = Promise.resolve().then(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const remaining = graceEndsAt - performance.now();
                if (remaining <= 0) throw closeError('APP_CLOSE_DEADLINE_EXCEEDED');
                const deadline = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(closeError('APP_CLOSE_DEADLINE_EXCEEDED')), remaining);
                });
                const finish = async () => {
                    if (this.transferring) { await this.transferring; sealAndStop(); }
                    await Promise.allSettled([...lifecycle, stopped]);
                    await this.pendingTool()?.completion;
                    if (!this.worker || this.channelFailure || this.terminationRequested) {
                        if (cleanupRequired && this.lastAppCleanup?.state !== 'completed') throw closeError('APP_CLOSE_FAILED');
                        return;
                    }
                    if (!cleanupRequired && this.appLifecycleSupport !== 'managed') return;
                    let failure: unknown;
                    try { await stopped; } catch (error) { failure = error; }
                    if (!this.terminationRequested && this.worker && !this.channelFailure) {
                        if (performance.now() >= graceEndsAt) throw closeError('APP_CLOSE_DEADLINE_EXCEEDED');
                        try { await this.registerRequest({ kind: 'close', id: randomUUID() }).actual; }
                        catch (error) { failure ??= error; }
                    }
                    if (failure) throw failure;
                };
                await Promise.race([finish(), deadline]);
            } finally {
                clearTimeout(timer);
                this.terminate();
                await this.terminationAttempt;
            }
        });
        this.beginInteractionClose();
        // Do not await or expose author callbacks before the raw startup gate is sealed.
        if (!this.transferring) sealAndStop();
        this.onUpdate?.('app_runtime_changed');
        void this.closePromise.catch(() => {});
        return this.closePromise;
    }

    terminate(): void {
        if (this.terminationRequested) return;
        this.terminationRequested = true;
        this.lifecycleContextVersion++;
        if (this.status !== 'error') this.status = 'closed';
        this.startupControl?.sealStartup();
        this.beginInteractionClose();
        // Irreversible termination boundary: unconfirmed control tasks cannot
        // be awaited forever. Business facts still await terminal or channel end.
        this.cleanupPendingRequests(closeError('APP_STOPPED'));
        this.beginResourceRelease();
        this.requestTermination();
    }

    private requestTermination(retry = false): void {
        if (!this.worker || (!retry && this.resourceWorkerState === 'retiring')) return;
        this.resourceWorkerState = 'retiring';
        const refusal = deferred<void>();
        this.terminationAttempt = Promise.race([this.actualExit, refusal.promise]);
        const failed = () => {
            this.resourceIssues.add('WORKER_TERMINATION_FAILED');
            this.executionIssue ??= Object.freeze({ code: 'WORKER_TERMINATION_FAILED', message: 'Execution termination failed' });
            this.onUpdate?.('app_runtime_changed');
            refusal.resolve();
        };
        try { void Promise.resolve(this.terminateExecution?.()).catch(failed); }
        catch { failed(); }
        this.onUpdate?.('app_runtime_changed');
    }

    private sendRequest(request: ControlRequest): Promise<void> {
        try { return this.registerRequest(request).wait; }
        catch (error) { return Promise.reject(error); }
    }

    /** One record owns both the actual request and its independently bounded waiter. */
    private registerRequest(request: ControlRequest): ControlPending {
        const cleanup = request.kind === 'stop' || request.kind === 'close';
        const worker = this.worker;
        if (!worker || this.channelFailure || this.terminationRequested ||
            !cleanup && (this.interactionsClosed || this.closePromise)) throw this.channelFailure ?? closeError('APP_STOPPED');
        const actual = deferred<void>(), waiter = deferred<void>();
        void actual.promise.catch(() => {});
        void waiter.promise.catch(() => {});
        const timer = setTimeout(() => waiter.reject(closeError(request.kind === 'observe' ? 'PROJECTION_TIMEOUT'
            : request.kind === 'initialize' ? 'E_INIT_TIMEOUT' : request.kind === 'open' ? 'E_OPEN_TIMEOUT' : 'APP_CLOSE_DEADLINE_EXCEEDED')), this.timeout);
        const pending: ControlPending = { request, worker, version: this.lifecycleContextVersion, actual: actual.promise,
            complete: error => { if (error) { actual.reject(error); waiter.reject(error); } else { actual.resolve(); waiter.resolve(); } },
            wait: waiter.promise, rejectWait: error => waiter.reject(error), timer };
        this.pendingRequests.set(request.id, pending);
        if (request.kind === 'observe') this.projectionRefresh = pending;
        if (request.kind === 'initialize') this.initializeSent = true;
        if (request.kind === 'open') this.openSent = true;
        try { worker.send(request); }
        catch (error) {
            // A synchronous reply may already have completed this very record.
            if (this.pendingRequests.get(request.id) === pending) {
                clearTimeout(timer);
                pending.rejectWait(error instanceof Error ? error : closeError('EXECUTION_SEND_FAILED'));
            }
        }
        return pending;
    }

    private finishRequest(pending: ControlPending, error?: Error): void {
        if (this.pendingRequests.get(pending.request.id) !== pending) return;
        this.pendingRequests.delete(pending.request.id);
        clearTimeout(pending.timer);
        if (this.projectionRefresh === pending) this.projectionRefresh = undefined;
        pending.complete(error);
    }

    private cleanupPendingRequests(error: Error): void {
        for (const pending of this.pendingRequests.values()) if (!('tool' in pending)) this.finishRequest(pending, error);
    }

    private currentSample(publication: unknown, expected?: SnapshotDraftEnvelope): SnapshotDraftEnvelope | undefined {
        try {
            const captured = copyWireJson(publication, { maxDepth: 1, maxNodes: 5, maxCanonicalBytes: 2048 });
            if (!captured || typeof captured !== 'object' || Array.isArray(captured) || Object.keys(captured).length !== 4) return;
            const stamp = captureSnapshotDraftEnvelope(captured);
            if (stamp && stamp.appId === this.appId && stamp.instanceId === this.appInstanceId &&
                (!expected || isDeepStrictEqual(stamp, expected)) && isDeepStrictEqual(stamp, this.snapshotReceiver.currentPublication())) return stamp;
        } catch { /* No current accepted sample. */ }
    }

    private handleEvent(event: Exclude<TransportEvent, { kind: 'channelEnded' | 'exited' | 'error' }>): void {
        if (!event || typeof event !== 'object') return;
        if (event.kind === 'update') {
            if (this.interactionAvailable() && ['view_updated', 'projection_recovered', 'attention_requested'].includes(event.reason))
                this.onUpdate?.(event.reason);
            return;
        }
        const id = 'id' in event && typeof event.id === 'string' ? event.id : undefined;
        const pending = id === undefined ? undefined : this.pendingRequests.get(id);
        if (event.kind === 'projectionFailed') {
            if (this.interactionsClosed || this.terminationRequested) return;
            const result = this.snapshotReceiver.acceptPrepareFailure({ appId: this.appId, instanceId: this.appInstanceId,
                producerSeq: event.producerSeq, sourceEpoch: event.sourceEpoch, issue: captureSnapshotPrepareIssue(event.issue) });
            if (pending && !('tool' in pending) && (pending.request.kind === 'open' || pending.request.kind === 'observe') && result.status === 'rejected') {
                pending.issue = result.issue; delete pending.sample;
            }
            if (result.healthChanged) { this.onUpdate?.('app_runtime_changed'); this.onUpdate?.('projection_failed'); }
            return;
        }
        if (!pending || pending.worker !== this.worker) return;
        if ('tool' in pending) {
            if (event.kind !== 'reply' || event.status !== 'tool') return;
            const terminal = captureExecutionTerminal(event.terminal);
            if (!terminal) return;
            this.pendingRequests.delete(pending.request.id);
            pending.tool.resolve(terminal.phase === 'finished-unknown' ? { kind: 'unknown' } : { kind: 'tool-result', ...terminal });
            return;
        }
        const kind = pending.request.kind;
        const current = pending.version === this.lifecycleContextVersion && !this.interactionsClosed && !this.terminationRequested;
        const sampleError = () => {
            const issue = pending.issue ?? this.snapshotReceiver.currentFailure()
                ?? { code: 'SNAPSHOT_UNAVAILABLE', message: 'Request has no current accepted Frame' };
            return kind === 'open' ? executionStartupError(issue, this.appId, 'OPEN') : new ProjectionRefreshFailure(issue);
        };
        if (event.kind === 'projectionCurrent') {
            if (kind === 'observe') {
                const known = pending.request.kind === 'observe' ? pending.request.known : undefined;
                const sample = current && known && !pending.issue && this.currentSample(event.publication, known);
                if (sample) pending.sample = sample;
                this.finishRequest(pending, sample ? undefined : current ? closeError('OBSERVATION_REFRESH_FAILED') : closeError('PROJECTION_CLOSED'));
            } else if (kind === 'open' && current && !pending.issue) {
                const sample = this.currentSample(event.publication);
                if (sample) pending.sample = sample;
            }
            return;
        }
        if (event.kind === 'waitFailed') {
            clearTimeout(pending.timer);
            pending.rejectWait(event.error);
            return;
        }
        if (event.kind !== 'reply' && event.kind !== 'requestFailed') return;
        const captureCleanup = () => {
            if (event.kind === 'requestFailed') return event.cleanup && captureAppCleanupReport(event.cleanup, this.appInstanceId);
            if (!('cleanup' in event) || !event.cleanup) return undefined;
            try {
                const raw = copyWireJson(event.cleanup, { maxDepth: 2, maxNodes: 8, maxCanonicalBytes: 2048 });
                if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2) return undefined;
                return captureAppCleanupReport({ ...raw, protocol: APP_LIFECYCLE_PROTOCOL, instanceId: this.appInstanceId }, this.appInstanceId);
            } catch { return undefined; }
        };
        if (event.kind === 'requestFailed' || event.status === 'failed') {
            if (kind === 'initialize' && !this.hasCleanupContract()) this.appLifecycleSupport = 'rejected';
            if (kind === 'open' || kind === 'stop' || kind === 'close') {
                const report = captureCleanup();
                if (report && report.state !== 'active') this.rememberAppCleanup(report);
            }
            const cleanupFailed = (kind === 'stop' || kind === 'close') && (!this.lastAppCleanup || this.lastAppCleanup.issues.length > 0 || this.lastAppCleanup.state === 'failed');
            const error = cleanupFailed ? closeError('APP_CLEANUP_FAILED') : event.kind === 'requestFailed' ? event.error : kind === 'initialize' || kind === 'open'
                ? executionStartupError(pending.issue ?? event.issue, this.appId, kind === 'initialize' ? 'INIT' : 'OPEN')
                : kind === 'observe' ? new ProjectionRefreshFailure(pending.issue ?? this.snapshotReceiver.currentFailure() ?? event.issue)
                : closeError('APP_CLOSE_FAILED');
            this.finishRequest(pending, error);
            this.onUpdate?.('app_runtime_changed');
            return;
        }
        if (kind === 'initialize') {
            if (event.status !== 'ready') { pending.rejectWait(closeError('APP_INIT_ACK_INVALID')); return; }
            this.appLifecycleSupport = 'managed';
            this.finishRequest(pending, current ? undefined : closeError('APP_STOPPED'));
            return;
        }
        if (event.status !== 'done') {
            pending.rejectWait(closeError(kind === 'observe' ? 'OBSERVATION_REFRESH_FAILED' : 'APP_LIFECYCLE_REPLY_INVALID'));
            return;
        }
        if (kind === 'open' || kind === 'observe') {
            const sample = current && !pending.issue && pending.sample && this.currentSample(event.publication, pending.sample);
            this.finishRequest(pending, sample ? undefined : current ? sampleError() : closeError('APP_STOPPED'));
            return;
        }
        const report = captureCleanup();
        const valid = report && (kind === 'close' ? report.state === 'completed' || report.state === 'failed'
            : report.state === 'stopped' || report.state === 'pending' || report.state === 'failed' || report.state === 'completed');
        const ok = valid && this.rememberAppCleanup(report) && report.issues.length === 0;
        const noOwner = !this.externalExecution && this.appLifecycleSupport !== 'managed' && !this.openSent && kind === 'stop' && !report;
        this.finishRequest(pending, ok || noOwner ? undefined : closeError('APP_CLEANUP_FAILED'));
        this.onUpdate?.('app_runtime_changed');
    }

    private invalidateExecutionProjection(): void {
        if (!this.opened) this.beginInteractionClose();
        else this.snapshotReceiver.invalidatePublication();
    }

    private handleError(error: Error): void {
        this.resourceIssues.add('WORKER_ERROR');
        this.executionIssue ??= Object.freeze({ code: 'WORKER_ERROR', message: 'Execution reported an error' });
        this.invalidateExecutionProjection();
        this.lifecycleContextVersion++;
        if (!this.closePromise && !this.terminationRequested) this.status = 'error';
        // Error alone does not prove a drained result channel.
        for (const pending of this.pendingRequests.values()) if (!('tool' in pending)) pending.rejectWait(error);
        this.onUpdate?.('app_runtime_changed');
    }

    private handleChannelEnd(worker: ExecutionTransport, issue?: AppExecutionIssue): void {
        if (this.channelFailure) return;
        this.executionIssue = boundedIssue(issue, 'EXECUTION_CHANNEL_ENDED', 'The execution channel ended');
        this.channelFailure = Object.assign(new Error(this.executionIssue.message), this.executionIssue);
        this.lifecycleContextVersion++;
        this.readyWorker = null;
        this.snapshotReceiver.blockDispatch({ code: 'EXECUTION_CHANNEL_ENDED', message: 'The execution channel ended before dispatch.' });
        this.invalidateExecutionProjection();
        this.settleToolChannelEnd(worker);
        this.cleanupPendingRequests(this.channelFailure);
        if (!this.terminationRequested && !this.closePromise) {
            this.resourceIssues.add('EXECUTION_CHANNEL_ENDED');
            this.status = 'error';
            if (this.opened) this.onUpdate?.('projection_failed');
        }
        this.onUpdate?.('app_runtime_changed');
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
        if (this.hasCleanupContract()) this.appLifecycleSupport = 'managed';
        this.startupControl = undefined;
        this.resourceWorkerState = 'exited';
        this.releaseCapacity?.();
        this.releaseCapacity = undefined;
        this.actualExitResolve();
        this.onUpdate?.('app_runtime_changed');
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

function boundedIssue(input: unknown, code: string, message: string): Issue {
    try {
        const value = copyWireJson(input, { maxDepth: 1, maxNodes: 4, maxCanonicalBytes: 8192 });
        if (value && typeof value === 'object' && !Array.isArray(value) && 'code' in value && 'message' in value &&
            typeof value.code === 'string' && value.code.length > 0 && value.code.length <= 128 &&
            typeof value.message === 'string' && value.message.length <= 2048) {
            return Object.freeze({ code: value.code, message: value.message,
                ...('path' in value && typeof value.path === 'string' && value.path.length <= 512 ? { path: value.path } : {}) });
        }
    } catch { /* A bounded issue is optional; channelEnded itself is the fact. */ }
    return Object.freeze({ code, message });
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
