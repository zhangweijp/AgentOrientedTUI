// [DIP FIX] Kernel now depends ONLY on interfaces from SPI, not concrete Engine classes
import type {
    IKernel,
    DesktopID,
    IDesktop,
    DesktopState,
    IDesktopManager,
    IRuntimeContext, // New
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
} from '../spi/index.js';

import { AOTUIError } from '../spi/core/errors.js';
import type { DesktopCloseOptions, DesktopCloseHandle, RuntimeCloseHandle, RuntimeCloseReport, ShutdownOptions } from '../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, closeTimeout, closeVoid, createCloseHandle, freezeClose, mergeCloseReport, newCloseState, snapshotClose } from '../engine/core/close-handle.js';
import { captureInteractionModes } from '../engine/app/interaction-config.js';
import type { AppScopeResult } from '../spi/runtime/app-interaction.interface.js';
import type { ScopePolicy } from '../core/invocation/scoped-interaction-types.js';

/**
 * Kernel - The core orchestrator of the AOTUI Runtime.
 * 
 * Responsibilities:
 * - Creates and manages Desktop instances (via IDesktopManager)
 * - Exposes Semantic App Scope creation
 * - Manages Desktop lifecycle (suspend, resume, serialize, restore)
 * 
 */
export class Kernel implements IKernel {
    private shutdownReason?: string;
    private shutdownPromise: Promise<void> | null = null;
    private isShutdownComplete = false;
    private closing?: RuntimeCloseHandle;
    private readonly inFlight = new Set<Promise<unknown>>();
    private managerClose?: RuntimeCloseHandle;
    private managerReport?: RuntimeCloseReport;
    private readonly lateDesktopCloses = new Set<DesktopCloseHandle>();
    private shutdownDesktopIds?: Set<DesktopID>;
    private readonly closingDesktops = new WeakSet<IDesktop>();
    private closeState = newCloseState('runtime');

    constructor(private desktopManager: IDesktopManager) { }

    private assertRuntimeAvailable(): void {
        if (!this.closing && !this.isShutdownComplete) {
            return;
        }
        throw new AOTUIError('RUNTIME_SHUTDOWN', {
            reason: this.shutdownReason,
        });
    }

    private business<T>(run: () => Promise<T>): Promise<T> {
        try { this.assertRuntimeAvailable();if (this.inFlight.size >= 128) throw closeError('LIFECYCLE_CAPACITY_EXCEEDED'); }
        catch (error) { return Promise.reject(error); }
        let resolve!: (value: T) => void, reject!: (error: unknown) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });this.inFlight.add(promise);
        const release = () => this.inFlight.delete(promise);
        try { void run().then(value => { release();resolve(value); }, error => { release();reject(error); }); }
        catch (error) { release();reject(error); }
        void promise.catch(() => {});return promise;
    }
    private isDesktopClosing(desktop: IDesktop): boolean {
        return this.closingDesktops.has(desktop) || (desktop as IDesktop & { readonly isClosing?: boolean }).isClosing === true;
    }
    private assertDesktopAvailable(desktop: IDesktop): void {
        if (this.isDesktopClosing(desktop))
            throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: desktop.id });
    }
    private acceptsDesktopDiagnostics(desktop: IDesktop, desktopId: DesktopID): boolean {
        return !this.closing && !this.isShutdownComplete && this.desktopManager.get(desktopId) === desktop && !this.isDesktopClosing(desktop);
    }

    /**
     * Creates a new Desktop instance with a clean state.
     * The Desktop is immediately registered and ready for app installation.
     * 
     * App installation is the responsibility of Product Layer (e.g., DesktopManager).
     * This follows the microkernel principle: Kernel handles scheduling,
     * Product Layer handles app discovery and installation.
     * 
     * @param desktopId - Optional: specify a custom Desktop ID (for historical topics)
     * @param context - Optional: Runtime Context to inject into the Desktop
     * @returns The unique identifier of the created Desktop
     */
    createDesktop(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID> { return this.business(() => this.createDesktopAccepted(desktopId, context)); }
    private async createDesktopAccepted(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID> {
        this.assertRuntimeAvailable();
        const id = await this.desktopManager.create(desktopId, context);
        if (this.closing) {
            const handle = this.beginDesktopShutdown(id);
            if (!this.shutdownDesktopIds?.has(id)) this.lateDesktopCloses.add(handle);
            await handle.completion;throw new AOTUIError('RUNTIME_SHUTDOWN');
        }
        return id;
    }

    /**
     * Destroys a Desktop and releases all associated resources.
     * This method is idempotent - calling with non-existent ID is safe.
     * 
     * @param desktopId - The ID of the Desktop to destroy
     */
    destroyDesktop(desktopId: DesktopID): Promise<void> {
        try { return closeVoid(this.beginDesktopShutdown(desktopId).completion, 'DESKTOP_CLOSE_FAILED'); }
        catch (error) { return Promise.reject(error); }
    }

    /**
     * Gets a Desktop instance for direct lifecycle and output access.
     * @throws {Error} E_NOT_FOUND if Desktop doesn't exist
     */
    getDesktop(desktopId: DesktopID): IDesktop {
        const desktop = this.desktopManager.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        return desktop;
    }

    createAppScope(desktopId: DesktopID, appId: string, policy: ScopePolicy): AppScopeResult {
        const desktop = this.desktopManager.get(desktopId);
        const unavailable = (): AppScopeResult => Object.freeze({ status: 'rejected', issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' }) });
        const current = () => !!desktop && this.acceptsDesktopDiagnostics(desktop, desktopId);
        if (!current()) return unavailable();
        const create = desktop!.createAppScope;
        if (!current()) return unavailable();
        const result = create.call(desktop, appId, policy);
        if (!current()) { if (result.status === 'opened') result.client.close();return unavailable(); }
        return result;
    }

    /**
     * [Worker-Only] 安装 App
     * 
     * [C1 Fix] workerScriptPath 现在是可选的，默认使用 Runtime 内置的 worker-runtime
     */
    installDynamicWorkerApp(desktopId: DesktopID, appModulePath: string, options?: Parameters<IKernel['installDynamicWorkerApp']>[2]): Promise<string> {
        try {
            const interactionModes = captureInteractionModes(options);
            const captured = { ...options, interactionModes };
            return this.business(() => this.installDynamicWorkerAppAccepted(desktopId, appModulePath, captured));
        } catch (error) { return Promise.reject(error); }
    }
    private async installDynamicWorkerAppAccepted(
        desktopId: DesktopID,
        appModulePath: string,
        options?: Parameters<IKernel['installDynamicWorkerApp']>[2]
    ): Promise<string> {
        this.assertRuntimeAvailable();
        const desktop = this.desktopManager.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        this.assertDesktopAvailable(desktop);
        return desktop.installDynamicWorkerApp(appModulePath, options);
    }

    reinitializeDesktopApps(desktopId: DesktopID, options?: ReinitializeDesktopAppsOptions): Promise<ReinitializeDesktopAppsResult> { return this.business(() => this.reinitializeDesktopAppsAccepted(desktopId, options)); }
    private async reinitializeDesktopAppsAccepted(
        desktopId: DesktopID,
        options?: ReinitializeDesktopAppsOptions
    ): Promise<ReinitializeDesktopAppsResult> {
        this.assertRuntimeAvailable();
        const desktop = this.desktopManager.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }

        this.assertDesktopAvailable(desktop);return desktop.reinitializeApps(options);
    }

    /**
     * [C1 FIX] Now type-safe via IDesktopManager
     */
    suspend(desktopId: DesktopID): Promise<void> { return this.business(() => this.suspendAccepted(desktopId)); }
    private async suspendAccepted(desktopId: DesktopID): Promise<void> {
        this.assertRuntimeAvailable();
        const desktop = this.desktopManager.get(desktopId);if (desktop) this.assertDesktopAvailable(desktop);
        await this.desktopManager.suspend(desktopId);
    }

    /**
     * [C1 FIX] Now type-safe via IDesktopManager
     */
    resume(desktopId: DesktopID): Promise<void> { return this.business(() => this.resumeAccepted(desktopId)); }
    private async resumeAccepted(desktopId: DesktopID): Promise<void> {
        this.assertRuntimeAvailable();
        const desktop = this.desktopManager.get(desktopId);if (desktop) this.assertDesktopAvailable(desktop);
        await this.desktopManager.resume(desktopId);
    }

    serialize(desktopId: DesktopID): DesktopState {
        const info = this.desktopManager.getDesktopInfo(desktopId);
        if (!info) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }

        return {
            id: desktopId,
            status: info.status,
            createdAt: info.createdAt,
            serializedAt: Date.now(),
            apps: this.desktopManager.getAppStates(desktopId)
        };
    }

    /**
     * [RFC-014] 优雅关闭 Desktop
     * 
     * 1. 等待 Desktop 及其 App 清理完成
     * 2. 执行 beforeClose 回调（如持久化）
     * 3. 销毁 Desktop
     * 
     * @param desktopId - Desktop ID
     * @param options - 关闭选项
     */
    async gracefulShutdown(desktopId: DesktopID, options?: ShutdownOptions): Promise<void> {
        const handle = this.beginDesktopShutdown(desktopId, options);
        const result = await handle.wait(options);
        if (result.status === 'deadline') throw closeError('CLOSE_DEADLINE_EXCEEDED', result.report);
        if (result.report.hasFailures) throw closeError('DESKTOP_CLOSE_FAILED', result.report);
    }

    deleteDesktop(desktopId: DesktopID): Promise<void> {
        try { return closeVoid(this.beginDesktopClose(desktopId, { intent: 'delete' }).completion, 'DESKTOP_CLOSE_FAILED'); }
        catch (error) { return Promise.reject(error); }
    }

    beginDesktopShutdown(desktopId: DesktopID, options?: ShutdownOptions): DesktopCloseHandle { return this.beginDesktopClose(desktopId, options); }

    private beginDesktopClose(desktopId: DesktopID, options?: DesktopCloseOptions): DesktopCloseHandle {
        closeTimeout(options);const callback = options?.beforeClose, intent = options?.intent ?? 'close';
        if (intent !== 'close' && intent !== 'delete' || callback !== undefined && typeof callback !== 'function') throw closeError('CLOSE_OPTIONS_INVALID');
        const captured = this.desktopManager.get(desktopId);if (captured) this.closingDesktops.add(captured);
        return this.desktopManager.beginDesktopShutdown(desktopId, options);
    }

    private report(): RuntimeCloseReport {
        const state = structuredClone(this.closeState), manager = this.managerClose?.inspect() ?? this.managerReport;
        if (manager) { mergeCloseReport(state, manager);state.pool = { ownership: manager.pool.ownership, report: manager.pool.report ? { ...manager.pool.report, issues: [...manager.pool.report.issues] } : null }; }
        for (const handle of this.lateDesktopCloses) mergeCloseReport(state, handle.inspect());
        state.pendingTasks = this.inFlight.size;
        if (state.pendingTasks) state.resourcesReleased = false;
        return freezeClose({ ...snapshotClose(state), scope: 'runtime' as const, intent: 'close' as const });
    }

    beginShutdown(_reason?: string): RuntimeCloseHandle {
        if (this.closing) return this.closing;
        this.shutdownDesktopIds = new Set(this.desktopManager.listDesktopIds());
        let complete!: (value: RuntimeCloseReport) => void;
        const completion = new Promise<RuntimeCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseHandle(() => this.report(), completion);
        // Snapshot accepted calls after synchronously stopping admission.
        const accepted = [...this.inFlight];
        const managerTask = (async () => {
            try { this.managerClose = this.desktopManager.beginShutdown();this.managerReport = await this.managerClose.completion;this.managerClose = undefined; }
            catch { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'manager', ['MANAGER_CLEANUP_FAILED']); }
        })();
        void Promise.allSettled([managerTask, ...accepted]).then(results => {
            if (results[0]?.status === 'rejected') { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'manager', ['MANAGER_CLEANUP_FAILED']); }
            this.closeState.state = 'settled';this.isShutdownComplete = true;complete(this.report());
        });
        return this.closing;
    }

    shutdown(reason?: string): Promise<void> { return this.shutdownPromise ??= closeVoid(this.beginShutdown(reason).completion, 'RUNTIME_CLOSE_FAILED'); }
}
