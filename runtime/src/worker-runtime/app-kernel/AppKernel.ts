import type { ToolResultData } from '@aotui/core';
import type { AppContext, AppKernelConfig, AppLaunchConfig, AppInstance, RuntimeContext, TUIAppFactory } from '@aotui/core';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';

import { commitAppFrame, SemanticProjectionCoordinator } from '@aotui/core/internal';
import { hostedObservationCapacityIssue } from '@aotui/core/internal';
import type { ProjectionLimits } from '@aotui/core';
import { createViewOwnedTools } from '@aotui/core';
import type { ToolParameterContract } from '@aotui/core';
import type { ToolInvocationDescriptor, ViewToolReceiver } from '@aotui/core/internal';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '@aotui/core';
import { SnapshotDataError } from '@aotui/core';
import { closeError } from '../../engine/core/close-handle.js';

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

    closeView(viewId: string, viewInstanceId: string): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing || this.projectionOwner.signal.aborted)
            return { phase: 'not-entered', result: this.closedToolResult() };
        return this.viewOwnedTools.closeView(viewId, viewInstanceId);
    }

    refScope(viewId: string, viewInstanceId: string, refId: string) {
        return this.projection.refScope(viewId, viewInstanceId, refId);
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
        await this.config.onReinitialize?.({ ...this.context, reason });
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

    // ─────────────────────────────────────────────────────────────
    //  Private: View Initialization
    // ─────────────────────────────────────────────────────────────

    private async initializeInstance(): Promise<void> {
        const { launchConfig, projectionLimits, persistence } = this.config;
        const runtimeContext: RuntimeContext = {
            ...this.context,
            launchConfig,
            projectionLimits,
            signal: this.projectionOwner.signal,
            defineViewTypes: definitions => {
                this.assertActive();
                this.projection.assertWritable();
                this.viewOwnedTools.defineViewTypes(definitions);
            },
            publishFrame: (build, options) => {
                this.assertActive();
                return commitAppFrame(this.projection, this.viewOwnedTools, () => {
                    const frame = build();
                    this.assertActive();
                    return frame;
                }, options);
            },
            readPreparedProjection: () => {
                if (this.projectionOwner.signal.aborted) throw closeError('PROJECTION_CLOSED');
                return this.projection.readPreparedProjection();
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
