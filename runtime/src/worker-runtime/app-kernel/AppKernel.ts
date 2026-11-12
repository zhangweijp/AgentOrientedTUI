import type { ToolResultData } from '../../spi/core/tool-result.js';
import { APP_LIFECYCLE_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL, captureAppMetadata } from '../../spi/index.js';
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
    IRefExporter, AppInstance, ExternalAppEvent, RuntimeContext, TUIAppFactory,
} from '../../spi/index.js';
import type { IRefBinding, RefValueCheck } from '../../spi/app/ref-exporter.interface.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';

import { SemanticProjectionCoordinator, type CompleteProjectionFrame } from '../../core/projection/coordinator.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { ToolDescriptorV3, ObservedToolExecutionV3 } from '../../core/snapshot/types.js';
import type { AppTypeToolDefinition, AppTypeToolRegistrationOptions } from '../../spi/runtime/app-type-tools.interface.js';
import { hasViewTypeToolAuthoringProtocol } from '../../spi/app/app-factory.interface.js';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
import { SnapshotDataError } from '../../core/snapshot/json.js';
import { randomUUID } from 'node:crypto';
import { closeError } from '../../engine/core/close-handle.js';
import { isTUIAppFactory } from '../../spi/app/app-factory.interface.js';
import type { LLMOutputEvent } from '../../spi/core/llm-output.js';

/**
 * App Kernel Implementation
 *
 * 运行在 Worker 内的 App 执行引擎。
 */
export class AppKernel implements IRefExporter {
    private _id: AppID = '' as AppID;
    readonly name: string;

    private readonly config: AppKernelConfig & { factory: Pick<TUIAppFactory, 'initialize'> };
    private instance?: AppInstance;
    private readViews?: Parameters<RuntimeContext['setViewReader']>[0];
    private context!: AppContext;

    private readonly projection = new SemanticProjectionCoordinator({
        identity: () => ({ appId: this.id, instanceId: this.appExecutionInstanceId }),
        readFrame: () => ({
            views: this.readViews?.(this.getViewOwnedViewInstances()) ?? [],
            tools: this.getToolDefinitions(),
        }),
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

    /** Detached V3 Tool metadata for the configured producers. */
    getToolDefinitions(): readonly ToolDescriptorV3[] {
        return this.viewOwnedTools?.listTools() ?? Object.freeze([]);
    }

    /**
     * Stage 6 preflight: checks LIVE Runtime-owned Tool binding without invoking
     * a Handler. A trusted Host must still independently authorize any I/O.
     */
    validateBoundTypeTool(source: ToolDescriptorV3, execution: ObservedToolExecutionV3): ToolResultData {
        if (this.closing) return this.closedToolResult();
        if (this.projection.failed) return this.failedProjectionResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'ViewType Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateTypeToolBinding(source, execution);
    }

    getBoundTypeToolContract(source: ToolDescriptorV3, execution: ObservedToolExecutionV3): OrdinaryParameterContract | undefined {
        return this.closing ? undefined : this.viewOwnedTools?.getTypeToolContract(source, execution);
    }

    invokeBoundTypeTool(source: ToolDescriptorV3, execution: ObservedToolExecutionV3,
        args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (this.projection.failed) return { phase: 'not-entered', result: this.failedProjectionResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'ViewType Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeTypeTool(source, execution, args);
    }

    isRefViewLive(viewId: string, viewInstanceId: string): boolean {
        return this.viewOwnedTools?.getView(viewId)?.viewInstanceId === viewInstanceId;
    }

    /** Stage 2 source inventory, captured alongside Tool bindings in Worker. */
    getViewOwnedViewInstances() {
        return this.viewOwnedTools?.listViews() ?? Object.freeze([]);
    }

    constructor(config: AppKernelConfig & { factory: Pick<TUIAppFactory, 'initialize'> }) {
        if (typeof config.factory?.initialize !== 'function') {
            throw new AOTUIError(
                'CONFIG_INVALID',
                { reason: 'App factory initialize(context) is required.' }
            );
        }
        if (!config.appName) {
            throw new AOTUIError('CONFIG_INVALID', {
                reason: 'AppKernelConfig.appName is required.'
            });
        }

        this.config = config;
        this.name = config.name;
        captureAppMetadata({ app_name: config.appName });

    }

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
        const revokeViews = () => {
            for (const view of this.viewOwnedTools?.listViews() ?? []) {
                try { this.viewOwnedTools!.unmount(view.viewInstanceId); } catch { failed = true; }
            }
        };
        revokeViews();
        this.closePromise = Promise.resolve().then(async () => {
            await Promise.allSettled([this.openPromise, this.deletePromise]);
            try { await this.instance?.close(); } catch { failed = true; }
            this.instance = undefined;
            this.readViews = undefined;
            try { await this.appLifecycle?.close(); } catch { failed = true; }
            revokeViews();
            for (const clear of [() => this.viewOwnedTools?.dispose(), () => this.projection.close()]) {
                try { clear(); } catch { failed = true; }
            }
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

    registerRef(viewId: string, refId: string, data: unknown, refType?: string): IRefBinding {
        this.assertActive();
        const owner = this.viewOwnedTools?.getView(viewId);
        if (!owner) throw Object.assign(new Error('Ref owner is not mounted: ' + viewId), { code: 'REF_VIEW_UNMOUNTED' });
        const binding = this.projection.registerRef(owner, refId, data, refType);
        return { update: next => { this.assertActive(); binding.update(next); }, release: binding.release };
    }

    getViewRefs() {
        return this.projection.getViewRefs();
    }

    // ─────────────────────────────────────────────────────────────
    //  Private: View Initialization
    // ─────────────────────────────────────────────────────────────

    dispatchExternalEvent(event: ExternalAppEvent): boolean {
        if (!this.instance || this.closing || this.projectionOwner.signal.aborted) return false;
        this.instance.onExternalEvent?.(event);
        return true;
    }

    dispatchLLMOutput(event: LLMOutputEvent): void {
        if (!this.closing && !this.projectionOwner.signal.aborted) this.instance?.onLLMOutput?.(event);
    }

    private async initializeInstance(): Promise<void> {
        const factory = this.config.factory;
        if (isTUIAppFactory(factory) && !hasViewTypeToolAuthoringProtocol(factory)) {
            throw new Error('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
        }
        const lifecycleMarker = Object.getOwnPropertyDescriptor(factory, 'appLifecycleSupport');
        if (lifecycleMarker) {
            if (!('value' in lifecycleMarker) || lifecycleMarker.value !== APP_LIFECYCLE_PROTOCOL)
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');
            if (!this.appLifecycle) this.enableAppLifecycle();
        }

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
            publishFrame: build => {
                this.assertActive();
                this.projection.beginCommit();
                let plan: ReturnType<typeof owned.prepareFrame>;
                let candidate: CompleteProjectionFrame;
                try {
                    const frame = build();
                    plan = owned.prepareFrame(frame.views, frame.tools);
                    const refs: (typeof candidate.refs)[number][] = [];
                    const views = frame.views.map(({ refs: viewRefs, ...view }, index) => {
                        const { viewId, viewInstanceId } = plan.instances[index]!;
                        for (const ref of viewRefs) refs.push({ ...ref, viewId, viewInstanceId });
                        return { ...view, viewInstanceId };
                    });
                    candidate = { views, refs, tools: plan.tools };
                } catch (error) {
                    this.projection.endCommit({ error });
                    throw error;
                }
                if (this.projection.endCommit(undefined, false, candidate) !== 'prepared') {
                    const failure = this.projection.failure!;
                    throw new SnapshotDataError(failure.code, failure.path ?? '$', failure.message);
                }
                // Apply the validated inventory before any publication subscriber runs.
                plan.accept();
            },
            persistence: this.persistence,
            appLifecycle: this.appLifecycle?.port,
            viewTools: {
                mount: (viewId: string, viewType: string) => {
                    this.assertActive();
                    this.projection.assertWritable();
                    return owned.mount(viewId, viewType).viewInstanceId;
                },
                unmount: (viewInstanceId: string) => {
                    this.projection.assertWritable();
                    owned.unmount(viewInstanceId);
                    this.projection.releaseView(viewInstanceId);
                },
            },
            appTypeTools: {
                protocol: VIEW_TYPE_TOOL_PROTOCOL,
                registerTypeTool: (definition: AppTypeToolDefinition, options: AppTypeToolRegistrationOptions) => {
                    this.assertActive();
                    this.projection.assertWritable();
                    // Core owns strict capture, compilation, callable qualification, and reentry checks.
                    // Pass the original values so custom prototypes/accessors cannot be laundered here.
                    const release = owned.registerTypeTool(definition, options);
                    if (this.closing) {
                        release();
                        throw closeError('APP_KERNEL_CLOSED');
                    }
                    return () => { this.projection.assertWritable(); release(); };
                },
            },
        };

        const instance = await factory.initialize(runtimeContext);
        if (!instance || typeof instance.close !== 'function') {
            throw Object.assign(new Error('App initialize must return an instance with close()'),
                { code: 'APP_INVALID_INSTANCE', path: 'initialize' });
        }
        this.instance = instance;
    }
}
