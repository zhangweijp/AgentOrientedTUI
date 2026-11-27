import type { ToolResultData } from '@aotui/core';
import type { AppContext, AppLaunchConfig, RuntimeContext, TUIAppFactory } from '@aotui/core';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';

import { commitAppFrame, createViewOwnedTools, SemanticProjectionCoordinator, hostedObservationCapacityIssue } from '@aotui/core/producer';
import type { ProjectionLimits, ToolRoute, ViewToolReceiver } from '@aotui/core';
import { createAppLifecycle } from '../app-lifecycle.js';
import { SnapshotDataError } from '@aotui/core';
import { closeError } from '../../engine/core/close-handle.js';
import { captureLaunchConfig } from '../../engine/app/launch-config.js';

/**
 * App Kernel Implementation
 *
 * 运行在 Worker 内的 App 执行引擎。
 */
export class AppKernel {
    private readonly context: AppContext;
    private readonly projection: SemanticProjectionCoordinator;
    private readonly viewOwnedTools: ReturnType<typeof createViewOwnedTools>;
    private readonly appLifecycle: ReturnType<typeof createAppLifecycle>;

    getAppCleanupReport() { return this.appLifecycle.getReport(); }
    private readonly projectionOwner = new AbortController();
    stopApplication(): void { this.projectionOwner.abort(); this.appLifecycle.stop(); }

    private closing = false;
    private openPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private activeBusiness: Promise<void> | undefined;
    private get stopped(): boolean { return this.closing || this.projectionOwner.signal.aborted; }
    private assertActive(): void { if (this.stopped) throw closeError('APP_KERNEL_CLOSED'); }
    private closedToolResult(): ToolResultData { return { success: false, error: { code: 'TOOL_UNAVAILABLE', message: 'App lifecycle is closing' } }; }
    private failedProjectionResult(): ToolResultData {
        return { success: false, error: { code: 'SNAPSHOT_UNREADY', message: 'App projection requires a successful commit' } };
    }

    getViewTypes() { return this.viewOwnedTools.viewTypes(); }

    getProjectionCoordinator(): SemanticProjectionCoordinator {
        return this.projection;
    }

    /** Check the current execution binding without invoking its handler. */
    validateBoundTypeTool(source: ToolRoute, receiver: ViewToolReceiver): ToolResultData {
        if (this.stopped) return this.closedToolResult();
        if (!this.projection.healthy) return this.failedProjectionResult();
        return this.viewOwnedTools.validateTypeToolBinding(source, receiver);
    }

    // Own the actual callback AND its terminal capture, not a Host wait or IPC acknowledgement.
    private runBusiness<T>(run: () => ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal>,
        capture: (terminal: ViewToolInvocationTerminal) => T, busyCode: string): T | Promise<T> {
        const refused: ToolResultData | undefined = this.stopped ? this.closedToolResult()
            : !this.projection.healthy ? this.failedProjectionResult()
            : this.activeBusiness ? { success: false, error: { code: busyCode, message: 'Another business callback is still completing' } }
            : undefined;
        if (refused) return capture({ phase: 'not-entered', result: refused });
        let complete!: () => void;
        const completion = new Promise<void>(resolve => { complete = resolve; });
        this.activeBusiness = completion;
        return (async () => {
            try { return capture(await run()); }
            finally {
                this.activeBusiness = undefined;
                complete();
            }
        })();
    }

    invokeBoundTypeTool<T>(source: ToolRoute, receiver: ViewToolReceiver,
        args: Readonly<Record<string, unknown>>, capture: (terminal: ViewToolInvocationTerminal) => T): T | Promise<T> {
        return this.runBusiness(() => this.viewOwnedTools.invokeTypeTool(source, receiver, args),
            capture, 'TOOL_EXECUTION_UNAVAILABLE');
    }

    isRefViewLive(viewId: string, viewInstanceId: string): boolean {
        return !this.stopped && this.projection.healthy &&
            this.viewOwnedTools.getView(viewId)?.viewInstanceId === viewInstanceId;
    }

    closeView<T>(viewId: string, viewInstanceId: string, closeActivationId: string, capture: (terminal: ViewToolInvocationTerminal) => T): T | Promise<T> {
        return this.runBusiness(() => this.viewOwnedTools.closeView(viewId, viewInstanceId, closeActivationId), capture, 'VIEW_CLOSE_UNAVAILABLE');
    }

    refDescriptor(viewId: string, viewInstanceId: string, refId: string) {
        return this.stopped || !this.projection.healthy ? undefined : this.projection.refDescriptor(viewId, viewInstanceId, refId);
    }

    constructor(private readonly config: AppContext & {
        instanceId: string;
        factory: Pick<TUIAppFactory, 'initialize'>;
        launchConfig?: AppLaunchConfig | undefined;
        projectionLimits: ProjectionLimits;
        requestAttention?: () => void;
    }) {
        const { appId, desktopId, instanceId, projectionLimits } = config;
        if (!desktopId?.trim())
            throw new Error('Invalid App execution identity');
        this.context = Object.freeze({ appId, desktopId });
        this.viewOwnedTools = createViewOwnedTools(appId, instanceId);
        this.appLifecycle = createAppLifecycle(instanceId);
        this.projection = new SemanticProjectionCoordinator({
            identity: () => ({ appId, instanceId }),
            checkCapacity: draft => hostedObservationCapacityIssue(draft, projectionLimits),
            isStopped: () => this.stopped,
        });
    }

    onOpen(): Promise<void> {
        if (this.stopped) return Promise.reject(closeError('APP_KERNEL_CLOSED'));
        if (this.openPromise) return this.openPromise;
        this.openPromise = Promise.resolve().then(async () => {
            this.assertActive();
            await this.initializeInstance();
            this.assertActive();
            const issue = this.projection.failure;
            if (!this.projection.healthy) throw new SnapshotDataError(issue?.code ?? 'SNAPSHOT_INVALID', issue?.path ?? '$', issue?.message ?? 'App initialization did not commit a healthy Frame');
        });
        void this.openPromise.catch(() => {});return this.openPromise;
    }

    onClose(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = Promise.resolve().then(async () => {
            await this.openPromise?.catch(() => {});
            await this.activeBusiness;
            let failed = false;
            try { await this.appLifecycle.close(); } catch { failed = true; }
            try { this.viewOwnedTools.dispose(); } catch { failed = true; }
            try { this.projection.close(); } catch { failed = true; }
            if (failed) throw closeError('APP_UNMOUNT_FAILED');
        });
        void this.closePromise.catch(() => {});
        this.stopApplication();
        return this.closePromise;
    }

    // ─────────────────────────────────────────────────────────────
    //  Private: View Initialization
    // ─────────────────────────────────────────────────────────────

    private async initializeInstance(): Promise<void> {
        const { projectionLimits } = this.config;
        const launchConfig = captureLaunchConfig(this.config.launchConfig, 'launchConfig');
        const runtimeContext: RuntimeContext = {
            ...this.context,
            ...(launchConfig === undefined ? {} : { launchConfig }),
            projectionLimits,
            signal: this.projectionOwner.signal,
            requestAttention: () => { if (!this.projectionOwner.signal.aborted) this.config.requestAttention?.(); },
            defineViewTypes: definitions => {
                this.assertActive();
                this.projection.assertWritable();
                this.viewOwnedTools.defineViewTypes(definitions);
            },
            publishFrame: (build, options) => {
                return commitAppFrame(this.projection, this.viewOwnedTools, build, options);
            },
            readViewId: owner => this.projectionOwner.signal.aborted ? undefined
                : this.projection.readViewId(owner, this.viewOwnedTools),
            appLifecycle: this.appLifecycle.port,
        };

        const result = await this.config.factory.initialize(runtimeContext);
        if (result !== undefined) {
            throw Object.assign(new Error('App initialize must return void; register resources before acquisition'),
                { code: 'APP_INVALID_INSTANCE', path: 'initialize' });
        }
    }
}
