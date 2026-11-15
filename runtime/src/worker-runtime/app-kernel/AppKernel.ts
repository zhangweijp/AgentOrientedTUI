import type { ToolResultData } from '../../spi/core/tool-result.js';
/**
 * AOTUI Runtime - App Kernel
 *
 * [方案 B] 从 @aotui/sdk 迁移到 @aotui/runtime/worker-runtime。
 *
 * Worker 内的 App 执行引擎，负责：
 * - App 生命周期管理 (onOpen, onClose...)
 * - Component View mount and owned Tool lifecycle
 * - source-bound View Tool lifecycle and invocation
 * - Semantic projection and Ref export
 *
 * @module @aotui/runtime/worker-runtime/app-kernel
 */

import type {
    AppID,
    AppContext,
    AppKernelConfig,
    AppLaunchConfig,
    IRefExporter, AppFrameView, AppInstance, RuntimeContext, TUIAppFactory,
} from '../../spi/index.js';
import type { RefValueCheck } from '../../spi/app/ref-exporter.interface.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';

import { SemanticProjectionCoordinator, type CompleteProjectionFrame } from '../../core/projection/coordinator.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { ToolDescriptorV4, ViewToolReceiver } from '../../core/snapshot/types.js';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
import { SnapshotDataError } from '../../core/snapshot/json.js';
import { randomUUID } from 'node:crypto';
import { closeError } from '../../engine/core/close-handle.js';
import type { LLMUsageEvent } from '../../spi/core/llm-usage.js';

/**
 * App Kernel Implementation
 *
 * 运行在 Worker 内的 App 执行引擎。
 */
export class AppKernel implements IRefExporter {
    private _id: AppID = '' as AppID;
    private instance?: AppInstance;
    private readViews?: Parameters<RuntimeContext['setViewReader']>[0];
    private context!: AppContext;

    private readonly projection = new SemanticProjectionCoordinator({
        identity: () => ({ appId: this.id, instanceId: this.appExecutionInstanceId }),
        readFrame: () => this.readViews ? this.prepareFrame(this.readViews()) : { views: [], tools: [] },
    });
    private appExecutionInstanceId: string = randomUUID();
    private viewOwnedTools?: ReturnType<typeof createViewOwnedTools>;

    private persistence?: AppStatePersistence;
    private appLifecycle?: ReturnType<typeof createAppLifecycle>;
    enableAppLifecycle(): void {
        this.assertActive();
        if (this.appLifecycle) throw new Error('APP_LIFECYCLE_ALREADY_ENABLED');
        this.appLifecycle = createAppLifecycle(this.appExecutionInstanceId);
    }
    getAppCleanupReport() { return this.appLifecycle?.getReport(); }
    private readonly projectionOwner = new AbortController();
    beginShutdown(): void { this.closing = true; this.projectionOwner.abort(); this.appLifecycle?.stop(); }
    stopApplication(): void { this.projectionOwner.abort(); this.appLifecycle?.stop(); }

    async whenProjectionCommitted(): Promise<void> {
        this.assertActive();
        await this.instance?.whenCommitted?.(this.projectionOwner.signal);
        await this.projection.whenCommitted(this.projectionOwner.signal);
        this.assertActive();
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

    setPersistence(port: AppStatePersistence): void {
        this.assertActive();
        if (this.instance || port.instanceId !== this.appExecutionInstanceId || this.persistence) throw new Error('Invalid persistence instance');
        this.persistence = port;
    }

    getProjectionCoordinator(): SemanticProjectionCoordinator {
        return this.projection;
    }

    setAppExecutionInstanceId(instanceId: string): void {
        this.assertActive();
        if (!instanceId.trim() || this.viewOwnedTools) {
            throw new Error('App execution identity must be assigned before View initialization');
        }
        this.appExecutionInstanceId = instanceId;
    }

    /**
     * Stage 6 preflight: checks LIVE Runtime-owned Tool binding without invoking
     * a Handler. A trusted Host must still independently authorize any I/O.
     */
    validateBoundTypeTool(source: ToolDescriptorV4, receiver: ViewToolReceiver): ToolResultData {
        if (this.closing) return this.closedToolResult();
        if (this.projection.failed) return this.failedProjectionResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'ViewType Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateTypeToolBinding(source, receiver);
    }

    getBoundTypeToolContract(source: ToolDescriptorV4, receiver: ViewToolReceiver): OrdinaryParameterContract | undefined {
        return this.closing ? undefined : this.viewOwnedTools?.getTypeToolContract(source, receiver);
    }

    invokeBoundTypeTool(source: ToolDescriptorV4, receiver: ViewToolReceiver,
        args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (this.projection.failed) return { phase: 'not-entered', result: this.failedProjectionResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'ViewType Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeTypeTool(source, receiver, args);
    }

    isRefViewLive(viewId: string, viewInstanceId: string): boolean {
        return this.viewOwnedTools?.getView(viewId)?.viewInstanceId === viewInstanceId;
    }

    /** Stage 2 source inventory, captured alongside Tool bindings in Worker. */
    getViewOwnedViewInstances() {
        return this.viewOwnedTools?.listViews() ?? Object.freeze([]);
    }

    constructor(private readonly config: AppKernelConfig & {
        factory: Pick<TUIAppFactory, 'initialize'>;
        launchConfig?: AppLaunchConfig | undefined;
    }) {}

    get id(): AppID {
        return this._id;
    }

    setId(id: AppID): void {
        this.assertActive();
        if (!id || this._id && this._id !== id) throw new AOTUIError('APP_IDENTITY_MISMATCH', { expected: this._id || 'Runtime-assigned App ID', actual: id, path: 'AppKernel.id' });
        this._id = id;
    }

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    onOpen(context: AppContext): Promise<void> {
        if (this.closing) return Promise.reject(closeError('APP_KERNEL_CLOSED'));
        if (this.openPromise) return this.openPromise;
        this.openPromise = Promise.resolve().then(async () => {
            this.assertActive();this.setId(context.appId);this.context = context;
            await this.initializeInstance();
            this.assertActive();
        });
        void this.openPromise.catch(() => {});return this.openPromise;
    }

    onClose(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.beginShutdown();
        let failed = false;
        this.viewOwnedTools?.dispose();
        this.closePromise = Promise.resolve().then(async () => {
            await Promise.allSettled([this.openPromise, this.deletePromise]);
            try { await this.instance?.close(); } catch { failed = true; }
            this.instance = undefined;
            this.readViews = undefined;
            try { await this.appLifecycle?.close(); } catch { failed = true; }
            try { this.projection.close(); } catch { failed = true; }
            if (failed) throw closeError('APP_UNMOUNT_FAILED');
        });
        void this.closePromise.catch(() => {});return this.closePromise;
    }

    async onReinitialize(context?: import('../../spi/index.js').AppReinitializeContext): Promise<void> {
        this.assertActive();
        if (this.config.onReinitialize) {
            await this.config.onReinitialize({
                ...this.context,
                reason: context?.reason ?? (this.config.launchConfig as { __aotuiLifecycle?: { reason?: string } } | undefined)
                    ?.__aotuiLifecycle?.reason,
            });
        }
    }

    /**
     * [RFC-015] App Delete Lifecycle
     */
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

    captureRef(data: unknown, check?: RefValueCheck): object {
        return this.projection.captureRef(data, check);
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

    private prepareFrame(views: readonly AppFrameView[]) {
        this.assertActive();
        const plan = this.viewOwnedTools!.prepareFrame(views);
        return {
            views: views.map(({ id, type, name, kind, content }, index) => {
                const { viewInstanceId, toolBindings } = plan.instances[index]!;
                return { id, type, name, kind, content, viewInstanceId, toolBindings };
            }),
            tools: plan.tools,
            accept: plan.accept,
        };
    }

    private async initializeInstance(): Promise<void> {
        // M4 Stage 1: the Core registry is scoped to the trusted App execution.
        const owned = this.viewOwnedTools ??= createViewOwnedTools(
            String(this._id), this.appExecutionInstanceId,
        );

        const runtimeContext: RuntimeContext = {
            appId: this._id,
            desktopId: this.context.desktopId,
            launchConfig: this.config.launchConfig,
            refExporter: this,
            projection: this.projection,
            signal: this.projectionOwner.signal,
            setViewReader: read => {
                if (this.readViews) throw new Error('App view reader already installed');
                this.readViews = read;
            },
            defineTools: definitions => {
                this.assertActive();
                this.projection.assertWritable();
                owned.defineTools(definitions);
            },
            mountView: (id, type) => {
                this.assertActive();
                this.projection.assertWritable();
                const mount = owned.prepareMount(id, type);
                let released = false;
                return {
                    owner: mount.owner,
                    registerRef: (refId, data, refType) => {
                        this.assertActive();
                        if (released) throw new Error('View Ref owner was detached');
                        return this.projection.registerRef(mount.view, refId, data, refType);
                    },
                    release: () => {
                        if (released) return;
                        this.projection.releaseView(mount.view.viewInstanceId);
                        mount.release();
                        released = true;
                    },
                };
            },
            publishFrame: build => {
                this.assertActive();
                this.projection.beginCommit();
                let candidate: CompleteProjectionFrame;
                try {
                    const frame = build();
                    if (!frame || Object.keys(frame).length !== 1 || !Array.isArray(frame.views))
                        throw new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Expected a complete View frame');
                    const prepared = this.prepareFrame(frame.views);
                    const refs: CompleteProjectionFrame['refs'][number][] = [];
                    for (const [index, view] of frame.views.entries()) {
                        const { viewInstanceId } = prepared.views[index]!;
                        for (const ref of view.refs) refs.push({ ...ref, viewId: view.id, viewInstanceId });
                    }
                    candidate = { ...prepared, refs };
                } catch (error) {
                    this.projection.endCommit({ error });
                    throw error;
                }
                if (this.projection.endCommit(undefined, false, candidate) !== 'prepared') {
                    const failure = this.projection.failure!;
                    throw new SnapshotDataError(failure.code, failure.path ?? '$', failure.message);
                }
                return Object.freeze({ status: 'prepared', sourceEpoch: this.projection.token().epoch });
            },
            persistence: this.persistence,
            appLifecycle: this.appLifecycle?.port,
        };

        const instance = await this.config.factory.initialize(runtimeContext);
        if (!instance || typeof instance.close !== 'function') {
            throw Object.assign(new Error('App initialize must return an instance with close()'),
                { code: 'APP_INVALID_INSTANCE', path: 'initialize' });
        }
        this.instance = instance;
    }
}
