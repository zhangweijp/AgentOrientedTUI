import type { ToolResultData } from '../../core/tool/tool-result.js';
import type {
    AppContext,
    AppKernelConfig,
    AppLaunchConfig,
    AppInstance, RuntimeContext, TUIAppFactory,
} from '../../spi/index.js';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';

import { SemanticProjectionCoordinator, type AppProjectionFrame, type CompleteProjectionFrame } from '../../core/projection/coordinator.js';
import { hostedObservationCapacityIssue } from '../../core/invocation/observation-registry.js';
import type { ProjectionLimits } from '../../core/invocation/observation-types.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import type { ToolParameterContract } from '../../core/tool/tool-parameters.js';
import type { ToolInvocationDescriptor, ViewToolReceiver } from '../../core/snapshot/types.js';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
import { SnapshotDataError } from '../../core/snapshot/json.js';
import { closeError } from '../../engine/core/close-handle.js';
import type { LLMUsageEvent } from '../../spi/core/llm-usage.js';

/**
 * App Kernel Implementation
 *
 * 运行在 Worker 内的 App 执行引擎。
 */
export class AppKernel {
    private instance?: AppInstance;
    private readonly context: AppContext;
    private readonly projection: SemanticProjectionCoordinator;
    private readonly viewOwnedTools: ReturnType<typeof createViewOwnedTools>;
    private readonly appLifecycle: ReturnType<typeof createAppLifecycle>;

    getAppCleanupReport() { return this.appLifecycle.getReport(); }
    private readonly projectionOwner = new AbortController();
    beginShutdown(): void { this.closing = true; this.projectionOwner.abort(); this.appLifecycle.stop(); }
    stopApplication(): void { this.projectionOwner.abort(); this.appLifecycle.stop(); }

    async whenProjectionCommitted(): Promise<void> {
        this.assertActive();
        await this.instance?.whenCommitted?.(this.projectionOwner.signal);
        this.assertActive();
        if (this.projectionOwner.signal.aborted) throw closeError('PROJECTION_CLOSED');
    }

    private closing = false;
    private openPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private deletePromise?: Promise<void>;
    private assertActive(): void { if (this.closing) throw closeError('APP_KERNEL_CLOSED'); }
    private closedToolResult(): ToolResultData { return { success: false, error: { code: 'TOOL_UNAVAILABLE', message: 'App lifecycle is closing' } }; }
    private failedProjectionResult(): ToolResultData {
        return { success: false, error: { code: 'SNAPSHOT_UNREADY', message: 'App projection requires a successful commit' } };
    }

    getProjectionCoordinator(): SemanticProjectionCoordinator {
        return this.projection;
    }

    /** Check the current execution binding without invoking its handler. */
    validateBoundTypeTool(source: ToolInvocationDescriptor, receiver: ViewToolReceiver): ToolResultData {
        if (this.closing) return this.closedToolResult();
        if (this.projection.failed) return this.failedProjectionResult();
        return this.viewOwnedTools.validateTypeToolBinding(source, receiver);
    }

    getBoundTypeToolContract(source: ToolInvocationDescriptor, receiver: ViewToolReceiver): ToolParameterContract | undefined {
        return this.closing ? undefined : this.viewOwnedTools.getTypeToolContract(source, receiver);
    }

    invokeBoundTypeTool(source: ToolInvocationDescriptor, receiver: ViewToolReceiver,
        args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (this.projection.failed) return { phase: 'not-entered', result: this.failedProjectionResult() };
        return this.viewOwnedTools.invokeTypeTool(source, receiver, args);
    }

    isRefViewLive(viewId: string, viewInstanceId: string): boolean {
        return this.viewOwnedTools.getView(viewId)?.viewInstanceId === viewInstanceId;
    }

    getViewOwnedViewInstances() {
        return this.viewOwnedTools.listViews();
    }

    constructor(private readonly config: AppKernelConfig & AppContext & {
        instanceId: string;
        factory: Pick<TUIAppFactory, 'initialize'>;
        launchConfig?: AppLaunchConfig | undefined;
        projectionLimits: ProjectionLimits;
        persistence?: AppStatePersistence;
    }) {
        const { appId, desktopId, instanceId, projectionLimits, persistence } = config;
        if (!desktopId?.trim() || persistence && persistence.instanceId !== instanceId)
            throw new Error('Invalid App execution identity');
        this.context = Object.freeze({ appId, desktopId });
        this.viewOwnedTools = createViewOwnedTools(appId, instanceId);
        this.appLifecycle = createAppLifecycle(instanceId);
        this.projection = new SemanticProjectionCoordinator({
            identity: () => ({ appId, instanceId }),
            checkCapacity: draft => hostedObservationCapacityIssue(draft, projectionLimits),
        });
    }

    onOpen(): Promise<void> {
        if (this.closing) return Promise.reject(closeError('APP_KERNEL_CLOSED'));
        if (this.openPromise) return this.openPromise;
        this.openPromise = Promise.resolve().then(async () => {
            this.assertActive();
            await this.initializeInstance();
            this.assertActive();
            const issue = this.projection.failure;
            if (issue?.code === 'OBSERVATION_CAPACITY') throw new SnapshotDataError(issue.code, issue.path ?? '$', issue.message);
        });
        void this.openPromise.catch(() => {});return this.openPromise;
    }

    onClose(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.beginShutdown();
        let failed = false;
        this.viewOwnedTools.dispose();
        this.closePromise = Promise.resolve().then(async () => {
            await Promise.allSettled([this.openPromise, this.deletePromise]);
            try { await this.instance?.close(); } catch { failed = true; }
            this.instance = undefined;
            try { await this.appLifecycle.close(); } catch { failed = true; }
            try { this.projection.close(); } catch { failed = true; }
            if (failed) throw closeError('APP_UNMOUNT_FAILED');
        });
        void this.closePromise.catch(() => {});return this.closePromise;
    }

    async onReinitialize(reason?: string): Promise<void> {
        this.assertActive();
        if (this.config.onReinitialize) {
            await this.config.onReinitialize({
                ...this.context,
                reason: reason ?? (this.config.launchConfig as { __aotuiLifecycle?: { reason?: string } } | undefined)
                    ?.__aotuiLifecycle?.reason,
            });
        }
    }

    onDelete(): Promise<void> {
        if (this.deletePromise) return this.deletePromise;
        if (this.closing) return Promise.reject(closeError('LIFECYCLE_CONFLICT'));
        this.beginShutdown();
        this.deletePromise = Promise.resolve().then(async () => {
            if (this.openPromise) await this.openPromise.catch(() => {});
            try { await this.config.onDelete?.(this.context); } catch { throw closeError('APP_DELETE_FAILED'); }
        });
        void this.deletePromise.catch(() => {});return this.deletePromise;
    }

    getViewRefs() {
        return this.projection.getViewRefs();
    }

    // ─────────────────────────────────────────────────────────────
    //  Private: View Initialization
    // ─────────────────────────────────────────────────────────────

    dispatchLLMUsage(event: LLMUsageEvent): void {
        if (!this.closing && !this.projectionOwner.signal.aborted) this.instance?.onLLMUsage?.(event);
    }

    private prepareFrame(frame: AppProjectionFrame): CompleteProjectionFrame {
        this.assertActive();
        if (!frame || Object.keys(frame).length !== 1 || !Array.isArray(frame.views))
            throw new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Expected a complete View frame');
        const views: AppProjectionFrame['views'] = frame.views;
        const plan = this.viewOwnedTools.prepareFrame(views);
        return {
            views: views.map(({ id, type, name, kind, content }, index) => {
                const { viewInstanceId, toolBindings } = plan.instances[index]!;
                return { id, type, name, kind, content, viewInstanceId, toolBindings };
            }),
            refs: views.flatMap(({ id, refs }, index) => refs.map(ref => ({
                ...ref, viewId: id, viewInstanceId: plan.instances[index]!.viewInstanceId,
            }))),
            tools: plan.tools,
            accept: plan.accept,
        };
    }

    private async initializeInstance(): Promise<void> {
        const { launchConfig, projectionLimits, persistence } = this.config;
        const runtimeContext: RuntimeContext = {
            ...this.context,
            launchConfig,
            projectionLimits,
            signal: this.projectionOwner.signal,
            defineTools: definitions => {
                this.assertActive();
                this.projection.assertWritable();
                this.viewOwnedTools.defineTools(definitions);
            },
            publishFrame: (build, options) => {
                this.assertActive();
                return this.projection.commit(() => this.prepareFrame(build()), options);
            },
            ...(persistence === undefined ? {} : { persistence }),
            appLifecycle: this.appLifecycle.port,
        };

        const instance = await this.config.factory.initialize(runtimeContext);
        if (!instance || typeof instance.close !== 'function') {
            throw Object.assign(new Error('App initialize must return an instance with close()'),
                { code: 'APP_INVALID_INSTANCE', path: 'initialize' });
        }
        this.instance = instance;
    }
}
