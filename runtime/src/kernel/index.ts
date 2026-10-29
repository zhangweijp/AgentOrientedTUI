// [DIP FIX] Kernel now depends ONLY on interfaces from SPI, not concrete Engine classes
import type {
    IKernel,
    Operation,
    OperationResult,
    DesktopID,
    SnapshotID,
    CachedSnapshot,
    IDesktop,
    IRegistry,
    AppID,
    DesktopState,
    ISystemOperationRegistry,
    IDesktopForOperation,
    SystemOperationContext,
    IDesktopManager,
    IDispatcher,
    OperationLogScope,
    IRuntimeContext, // New
    ReinitializeDesktopAppsOptions,
    ReinitializeDesktopAppsResult,
} from '../spi/index.js';

import { AOTUIError } from '../spi/core/errors.js';
import { createOperationId } from '../spi/core/id-factory.js';
import { buildOperationLogEntry } from '../engine/core/operation-log-formatter.js';
import type { Tool } from '../spi/core/tool-call.js';
import type { DesktopCloseOptions, DesktopCloseOperation, DesktopCloseReport, RuntimeCloseOperation, RuntimeCloseReport, ShutdownOptions } from '../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, closeTimeout, closeVoid, createCloseOperation, displayCloseId, freezeClose, mergeCloseReport, newCloseState, snapshotClose } from '../engine/core/close-operation.js';
import { captureInteractionModes } from '../engine/app/interaction-config.js';
import type { AppScopeResult } from '../spi/runtime/app-interaction.interface.js';
import type { ScopePolicy } from '../core/invocation/scoped-interaction.js';

/**
 * Kernel - The core orchestrator of the AOTUI Runtime.
 * 
 * Responsibilities:
 * - Creates and manages Desktop instances (via IDesktopManager)
 * - Handles concurrency via lock mechanism (delegated to IDesktopManager)
 * - Generates and manages Snapshots for Agent consumption
 * - Dispatches operations to Apps via IDispatcher
 * - Manages Desktop lifecycle (suspend, resume, serialize, restore)
 * 
 * [DIP] Kernel depends on IDesktopManager, IRegistry and IDispatcher interfaces.
 * Concrete implementations are injected via constructor (Inversion of Control).
 * 
 * @example
 * ```typescript
 * // Use createKernel factory to get a properly configured Kernel
 * import { createKernel } from '@aotui/runtime';
 * const kernel = createKernel(desktopManager, registry, systemOps);
 * ```
 */
export class Kernel implements IKernel {
    private static readonly EXTERNAL_SYSTEM_TOOL_NAMES = new Set([
        'system-open_app',
        'system-close_app',
    ]);
    private shutdownReason?: string;
    private shutdownPromise: Promise<void> | null = null;
    private isShutdownComplete = false;
    private closing?: RuntimeCloseOperation;
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly legacyDesktops = new WeakMap<IDesktop, DesktopCloseOperation>();
    private readonly legacyCallbacks = new WeakMap<IDesktop, WeakRef<() => Promise<void>>>();
    private managerClose?: RuntimeCloseOperation;
    private managerReport?: RuntimeCloseReport;
    private readonly lateDesktopCloses = new Set<DesktopCloseOperation>();
    private readonly closingDesktops = new WeakSet<IDesktop>();
    private closeState = newCloseState('runtime');

    constructor(
        private desktopManager: IDesktopManager,
        private snapshotRegistry: IRegistry,
        private dispatcher: IDispatcher,
        private systemOps: ISystemOperationRegistry
    ) { }

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

    getSystemToolDefinitions() {
        return this.systemOps.getToolDefinitions().filter((tool) => {
            const name = (tool as Tool).function?.name;
            return !!name && Kernel.EXTERNAL_SYSTEM_TOOL_NAMES.has(name);
        });
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
            const operation = this.beginDesktopShutdown(id);
            if (!this.desktopManager.beginShutdown) this.lateDesktopCloses.add(operation);
            await operation.completion;throw new AOTUIError('RUNTIME_SHUTDOWN');
        }
        return id;
    }

    /**
     * Destroys a Desktop and releases all associated resources.
     * This operation is idempotent - calling with non-existent ID is safe.
     * 
     * @param desktopId - The ID of the Desktop to destroy
     */
    destroyDesktop(desktopId: DesktopID): Promise<void> {
        try {
            // Preserve the old DI delegation even when that provider exposes no Desktop object.
            if (!this.desktopManager.beginDesktopShutdown && !this.desktopManager.get(desktopId)) {
                return Promise.resolve().then(() => this.desktopManager.destroy(desktopId)).catch(() => {
                    const state = newCloseState('desktop');state.state = 'settled';state.resourcesReleased = false;state.verification = 'unverified';state.unverifiedParticipants = 1;
                    addCloseFailure(state, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId });
                    throw closeError('DESKTOP_CLOSE_FAILED', freezeClose({ ...snapshotClose(state), scope: 'desktop' as const, intent: 'close' as const, desktopId: displayCloseId(desktopId), found: false }));
                });
            }
            return closeVoid(this.beginDesktopShutdown(desktopId).completion, 'DESKTOP_CLOSE_FAILED');
        }
        catch (error) { return Promise.reject(error); }
    }

    /**
     * 获取 Desktop 实例 (供 ToolCallAdapter 使用)
     * @throws {Error} E_NOT_FOUND if Desktop doesn't exist
     */
    getDesktop(desktopId: DesktopID): IDesktop {
        const desktop = this.desktopManager.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        return desktop;
    }

    experimentalCreateAppScope(desktopId: DesktopID, appId: string, policy: ScopePolicy): AppScopeResult {
        const desktop = this.desktopManager.get(desktopId);
        const unavailable = (): AppScopeResult => Object.freeze({ status: 'rejected', issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' }) });
        const current = () => !!desktop && this.acceptsDesktopDiagnostics(desktop, desktopId);
        if (!current()) return unavailable();
        const create = desktop!.experimentalCreateAppScope;
        if (typeof create !== 'function' || !current()) return unavailable();
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
            const experimentalInteractionModes = captureInteractionModes(options);
            const captured = { ...options, experimentalInteractionModes };
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

    /**
     * [C1 FIX] Lock management delegated to IDesktopManager
     */
    acquireLock(desktopId: DesktopID, ownerId: string): void {
        this.assertRuntimeAvailable();
        const desktop = this.desktopManager.get(desktopId);if (desktop) this.assertDesktopAvailable(desktop);
        this.desktopManager.acquireLock(desktopId, ownerId);
    }

    releaseLock(desktopId: DesktopID, ownerId: string): void {
        this.desktopManager.releaseLock(desktopId, ownerId);
    }

    acquireSnapshot(desktopId: DesktopID, ttl?: number): Promise<CachedSnapshot> { return this.business(() => this.acquireSnapshotAccepted(desktopId, ttl)); }
    private async acquireSnapshotAccepted(desktopId: DesktopID, ttl?: number): Promise<CachedSnapshot> {
        this.assertRuntimeAvailable();
        const desktop = this.desktopManager.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        this.assertDesktopAvailable(desktop);

        // [RFC-001] Get Worker-pushed SnapshotFragments
        const fragments = desktop.getSnapshotFragments();

        // [RFC-007] Use SnapshotFormatter for complete TUI output
        // [RFC-014] SnapshotFormatter now returns structured output
        const { SnapshotFormatter } = await import('../engine/view/snapshot/index.js');
        this.assertRuntimeAvailable();
        if (this.desktopManager.get(desktopId) !== desktop) throw closeError('LIFECYCLE_CONFLICT');
        this.assertDesktopAvailable(desktop);
        const formatter = new SnapshotFormatter();

        // Desktop implements IDesktopMetadata (getInstalledApps, getSystemLogs, etc.)
        const result = formatter.format(fragments, desktop as any);

        this.assertRuntimeAvailable();
        if (this.desktopManager.get(desktopId) !== desktop) throw closeError('LIFECYCLE_CONFLICT');
        this.assertDesktopAvailable(desktop);
        // [RFC-014] Pass structured output to Registry
        return this.snapshotRegistry.create(
            result.indexMap as any,
            result.markup,
            ttl,
            result.structured
        );
    }

    releaseSnapshot(snapshotId: SnapshotID): void {
        this.snapshotRegistry.release(snapshotId);
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

    execute(desktopId: DesktopID, operation: Operation, ownerId: string): Promise<OperationResult> { return this.business(() => this.executeAccepted(desktopId, operation, ownerId)); }
    private async executeAccepted(desktopId: DesktopID, operation: Operation, ownerId: string): Promise<OperationResult> {
        this.assertRuntimeAvailable();
        const startTime = Date.now();
        let capturedDesktop: IDesktop | undefined;
        try {
            // 1. Verify Desktop
            const desktop = this.desktopManager.get(desktopId);capturedDesktop = desktop;
            if (!desktop) throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
            this.assertDesktopAvailable(desktop);

            // 2. Verify Lock (delegated to desktopManager)
            if (!this.desktopManager.verifyLock(desktopId, ownerId)) {
                const lockInfo = this.desktopManager.getLockInfo(desktopId);
                throw new AOTUIError('DESKTOP_LOCKED', {
                    desktopId,
                    ownerId: lockInfo?.ownerId ?? 'none',
                    claimant: ownerId,
                });
            }

            // Refresh timestamp on successful lock verification
            this.desktopManager.refreshLock(desktopId, ownerId);

            const { context, name: operationName, args } = operation;

            // 3. System Operation Dispatch (via Registry - replaces switch statement)
            if (this.systemOps.has(operationName)) {
                const systemCtx: SystemOperationContext = {
                    desktopId,
                    args: { ...args, appId: context.appId }  // Inject appId for view operations
                };
                const result = await this.systemOps.execute(operationName, systemCtx, desktop as IDesktopForOperation);
                if (result.success && this.acceptsDesktopDiagnostics(desktop, desktopId) && 'emitSignal' in desktop) {
                    (desktop as { emitSignal: (reason: string) => void }).emitSignal('manual_refresh');
                }
                return this.enrichResult(result, operationName, startTime, desktop, desktopId, context.appId, args || {});
            }

            // 4. App Operation Dispatch
            // [Worker-Only] 所有 App 操作通过 Dispatcher 路由到 Worker
            if (!context.appId) {
                throw new AOTUIError('OPERATION_REQUIRES_CONTEXT', { operationName });
            }

            // Pass Operation directly to Dispatcher (handles Worker IPC routing)
            const dispatchOp: Operation = {
                context,
                name: operationName,
                args
            };
            // [P0-1 FIX] Now returns the actual OperationResult from the App
            const result = await this.dispatcher.dispatch(desktop, dispatchOp, this.snapshotRegistry);
            return this.enrichResult(result, operationName, startTime, desktop, desktopId, context.appId, args || {});

        } catch (e: unknown) {
            // If already AOTUIError, preserve it. Otherwise wrap.
            const aotuiError = AOTUIError.is(e) ? e : AOTUIError.fromError(e, 'EXECUTION_FAILED');
            const durationMs = Date.now() - startTime;

            // [RFC-008] Log failed operation
            const desktop = capturedDesktop;
            if (desktop) {
                this.logOperationExecution(
                    desktop,
                    desktopId,
                    operation.context.appId,
                    operation.name,
                    operation.args || {},
                    false,
                    durationMs,
                    'agent',  // Default actor for now - could be passed in
                    aotuiError.message
                );
            }

            return {
                success: false,
                error: aotuiError.toOperationError(),
                data: { durationMs }
            };
        }
    }

    /**
     * Enrich OperationResult with execution metadata
     * 
     * @param result - Original operation result
     * @param operationName - Name of the executed operation
     * @param startTime - Execution start timestamp
     * @returns Result with added durationMs
     */
    private enrichResult(
        result: OperationResult,
        operationName: string,
        startTime: number,
        desktop: IDesktop,
        desktopId: DesktopID,
        appId: AppID | undefined,
        args: Record<string, unknown>
    ): OperationResult {
        const durationMs = Date.now() - startTime;

        // [RFC-008] Log successful operation
        this.logOperationExecution(
            desktop,
            desktopId,
            appId,
            operationName,
            args,
            result.success,
            durationMs,
            'agent'  // Default actor for now
        );

        return {
            ...result,
            data: {
                ...result.data,
                durationMs,
                operationName
            }
        };
    }

    /**
     * [RFC-008] Log operation execution with semantic format
     * 
     * Generates WHO/WHEN/WHERE/WHAT log entries:
     * - WHO: The actor (agent name)
     * - WHEN: Timestamp and duration
     * - WHERE: Desktop > App > View
     * - WHAT: Operation name and result
     */
    private logOperationExecution(
        desktop: IDesktop,
        desktopId: DesktopID,
        appId: AppID | undefined,
        operationName: string,
        args: Record<string, unknown>,
        success: boolean,
        durationMs: number,
        actor: string,
        errorMessage?: string
    ): void {
        if (!this.acceptsDesktopDiagnostics(desktop, desktopId)) return;
        const scope: OperationLogScope = this.systemOps.has(operationName) ? 'system' : 'app';

        // Get app name for semantic description (getAppInfo is optional on IDesktop)
        let appName: string | undefined;
        if (appId && desktop.getAppInfo) {
            try { appName = desktop.getAppInfo(appId)?.name; } catch { /* A late diagnostic cannot change an accepted operation's outcome. */ }
        }

        const entry = buildOperationLogEntry({
            actor,
            desktopId,
            scope,
            operationName: createOperationId(operationName),
            args,
            success,
            durationMs,
            appId,
            appName,
            errorMessage
        });

        // Log using Desktop's existing logger (duck typing for concrete Desktop methods)
        // These methods exist on concrete Desktop but not on IDesktop interface
        const desktopWithLogger = desktop as unknown as {
            logSystem?: (msg: string, level: 'info' | 'warn' | 'error') => void;
            logAppOperation?: (appId: AppID, msg: string, level: 'info' | 'warn' | 'error') => void;
        };

        if (scope === 'system' && desktopWithLogger.logSystem) {
            desktopWithLogger.logSystem(entry.semanticDescription, success ? 'info' : 'error');
        } else if (appId && desktopWithLogger.logAppOperation) {
            desktopWithLogger.logAppOperation(appId, entry.semanticDescription, success ? 'info' : 'error');
        }
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
     * 1. 调用 Desktop.drain() 等待 App 清理
     * 2. 执行 beforeClose 回调（如持久化）
     * 3. 销毁 Desktop
     * 
     * @param desktopId - Desktop ID
     * @param options - 关闭选项
     */
    async gracefulShutdown(desktopId: DesktopID, options?: ShutdownOptions): Promise<void> {
        const operation = this.beginDesktopShutdown(desktopId, options);
        const result = await operation.wait(options);
        if (result.status === 'deadline') throw closeError('CLOSE_DEADLINE_EXCEEDED', result.report);
        if (result.report.hasFailures) throw closeError('DESKTOP_CLOSE_FAILED', result.report);
    }

    deleteDesktop(desktopId: DesktopID): Promise<void> {
        try { return closeVoid(this.beginDesktopClose(desktopId, { intent: 'delete' }).completion, 'DESKTOP_CLOSE_FAILED'); }
        catch (error) { return Promise.reject(error); }
    }

    beginDesktopShutdown(desktopId: DesktopID, options?: ShutdownOptions): DesktopCloseOperation { return this.beginDesktopClose(desktopId, options); }

    private beginDesktopClose(desktopId: DesktopID, options?: DesktopCloseOptions): DesktopCloseOperation {
        const timeout = closeTimeout(options), callback = options?.beforeClose, intent = options?.intent ?? 'close';
        if (intent !== 'close' && intent !== 'delete' || callback !== undefined && typeof callback !== 'function') throw closeError('CLOSE_OPTIONS_INVALID');
        const captured = this.desktopManager.get(desktopId);if (captured) this.closingDesktops.add(captured);
        if (this.desktopManager.beginDesktopShutdown) return this.desktopManager.beginDesktopShutdown(desktopId, options);
        const desktop = this.desktopManager.get(desktopId);
        if (!desktop) {
            const state = newCloseState('desktop', intent);state.state = 'settled';
            const report: DesktopCloseReport = freezeClose({ ...snapshotClose(state), scope: 'desktop', intent, desktopId: displayCloseId(desktopId), found: false });
            return createCloseOperation(() => report, Promise.resolve(report));
        }
        if (desktop.beginClose) {
            const child = desktop.beginClose(options), previous = this.legacyDesktops.get(desktop);
            if (previous) return previous;
            const state = newCloseState('desktop', intent);
            const report = (): DesktopCloseReport => {
                const copy = structuredClone(state), current = child.inspect();mergeCloseReport(copy, current);
                copy.beforeClose = current.beforeClose;copy.pool = { ownership: current.pool.ownership, report: current.pool.report ? { ...current.pool.report, issues: [...current.pool.report.issues] } : null };
                return freezeClose({ ...snapshotClose(copy), scope: 'desktop', intent: current.intent, desktopId: displayCloseId(desktopId), found: true });
            };
            let complete!: (value: DesktopCloseReport) => void;
            const completion = new Promise<DesktopCloseReport>(resolve => { complete = resolve; });
            const operation = createCloseOperation(report, completion);this.legacyDesktops.set(desktop, operation);
            void (async () => {
                const closed = await child.completion;
                try { if (closed.resourcesReleased && this.desktopManager.get(desktopId) === desktop) await this.desktopManager.destroy(desktopId); }
                catch { state.resourcesReleased = false;addCloseFailure(state, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId }); }
                state.state = 'settled';complete(report());
            })();
            return operation;
        }
        const previous = this.legacyDesktops.get(desktop);
        if (previous) {
            if (intent === 'delete' && previous.inspect().intent === 'close' || callback && callback !== this.legacyCallbacks.get(desktop)?.deref()) throw closeError('LIFECYCLE_CONFLICT');
            return previous;
        }
        const state = newCloseState('desktop', intent);state.verification = 'unverified';state.unverifiedParticipants = 1;state.resourcesReleased = false;state.interactions!.verified = false;
        state.beforeClose = callback ? 'pending' : 'not-provided';
        const report = (): DesktopCloseReport => freezeClose({ ...snapshotClose(state), scope: 'desktop', intent, desktopId: displayCloseId(desktopId), found: true });
        let complete!: (value: DesktopCloseReport) => void;
        const completion = new Promise<DesktopCloseReport>(resolve => { complete = resolve; });
        const operation = createCloseOperation(report, completion);this.legacyDesktops.set(desktop, operation);
        if (callback) this.legacyCallbacks.set(desktop, new WeakRef(callback));
        const deadline = performance.now() + timeout;let timer: ReturnType<typeof setTimeout> | undefined;
        let expired = false;if (callback) timer = setTimeout(() => { expired = true;timer = undefined; }, timeout);
        void (async () => {
            try { if (intent === 'delete') await desktop.delete();else await desktop.drain(); }
            catch { addCloseFailure(state, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId }); }
            if (callback) {
                if (state.hasFailures) state.beforeClose = 'skipped-drain-failed';
                else if (expired || performance.now() >= deadline) state.beforeClose = 'skipped-deadline';
                else { if (timer !== undefined) clearTimeout(timer);timer = undefined;state.beforeClose = 'running';
                    try { await callback();state.beforeClose = 'done'; } catch { state.beforeClose = 'failed'; } }
                if (state.beforeClose === 'failed') addCloseFailure(state, 'before-close', ['BEFORE_CLOSE_FAILED'], { desktopId });
                else if (state.beforeClose !== 'done') addCloseFailure(state, 'before-close', ['BEFORE_CLOSE_SKIPPED'], { desktopId });
            }
            if (timer !== undefined) clearTimeout(timer);
            try { if (this.desktopManager.get(desktopId) === desktop) await this.desktopManager.destroy(desktopId); }
            catch { addCloseFailure(state, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId }); }
            state.state = 'settled';state.desktops = { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 1 };complete(report());
        })();
        state.desktops = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };return operation;
    }

    private report(): RuntimeCloseReport {
        const state = structuredClone(this.closeState), manager = this.managerClose?.inspect() ?? this.managerReport;
        if (manager) { mergeCloseReport(state, manager);state.pool = { ownership: manager.pool.ownership, report: manager.pool.report ? { ...manager.pool.report, issues: [...manager.pool.report.issues] } : null };state.cleanup.locks = manager.cleanup.locks; }
        state.pendingOperations = this.inFlight.size;
        if (state.pendingOperations || state.cleanup.registry !== 'done') state.resourcesReleased = false;
        return freezeClose({ ...snapshotClose(state), scope: 'runtime' as const, intent: 'close' as const });
    }

    beginShutdown(_reason?: string): RuntimeCloseOperation {
        if (this.closing) return this.closing;
        this.closeState.cleanup.registry = 'pending';
        let complete!: (value: RuntimeCloseReport) => void;
        const completion = new Promise<RuntimeCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseOperation(() => this.report(), completion);
        // Snapshot accepted calls after synchronously stopping admission.
        const accepted = [...this.inFlight];
        const managerTask = (async () => {
            if (this.desktopManager.beginShutdown) {
                try { this.managerClose = this.desktopManager.beginShutdown();this.managerReport = await this.managerClose.completion;this.managerClose = undefined; }
                catch { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'legacy', ['MANAGER_CLEANUP_FAILED']); }
            } else {
                const legacy = newCloseState('runtime');legacy.verification = 'unverified';legacy.unverifiedParticipants = 1;legacy.resourcesReleased = false;legacy.interactions!.verified = false;legacy.pool.ownership = 'unverified';
                const operations: DesktopCloseOperation[] = [];
                for (const id of this.desktopManager.listDesktopIds()) {
                    try { operations.push(this.beginDesktopShutdown(id)); }
                    catch { addCloseFailure(legacy, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId: id }); }
                }
                await Promise.allSettled([...operations.map(operation => operation.completion), ...accepted]);
                for (const operation of new Set([...operations, ...this.lateDesktopCloses])) mergeCloseReport(legacy, operation.inspect());
                this.lateDesktopCloses.clear();
                try { await this.desktopManager.shutdown?.(); }
                catch { addCloseFailure(legacy, 'legacy', ['MANAGER_CLEANUP_FAILED']); }
                legacy.state = 'settled';this.managerReport = freezeClose({ ...snapshotClose(legacy), scope: 'runtime' as const, intent: 'close' as const });
            }
        })();
        const registryTask = (async () => {
            await Promise.allSettled(accepted);
            if (typeof this.snapshotRegistry.shutdown !== 'function') {
                this.closeState.cleanup.registry = 'unverified';this.closeState.unverifiedParticipants++;this.closeState.verification = 'mixed';this.closeState.resourcesReleased = false;return;
            }
            try { await this.snapshotRegistry.shutdown();this.closeState.cleanup.registry = 'done'; }
            catch { this.closeState.cleanup.registry = 'failed';this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'registry', ['REGISTRY_CLEANUP_FAILED']); }
        })();
        void Promise.allSettled([managerTask, registryTask, ...accepted]).then(results => {
            if (results.slice(0, 2).some(result => result.status === 'rejected')) { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'legacy', ['MANAGER_CLEANUP_FAILED']); }
            this.closeState.state = 'settled';this.isShutdownComplete = true;complete(this.report());
        });
        return this.closing;
    }

    shutdown(reason?: string): Promise<void> { return this.shutdownPromise ??= closeVoid(this.beginShutdown(reason).completion, 'RUNTIME_CLOSE_FAILED'); }
}
