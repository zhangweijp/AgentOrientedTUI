import type { WorkerPool } from '../app/worker-pool.js';
import type { IDesktop, DesktopID, AppID, ViewID, UpdateSignal, AppState, DesktopStatus, OperationPayload, IAppHostService, ISignalService, ILLMOutputChannelService, IRuntimeContext, ReinitializeDesktopAppsOptions, ReinitializeDesktopAppsResult } from '../../spi/index.js';
import { createDesktopId, createSnapshotId, createOperationId } from '../../spi/index.js';
import { AOTUIError, failedResult } from '../../spi/core/errors.js';
import { SignalBus, type SignalOutputStream, type SignalListener } from './signal-bus.js';
import type { LLMOutputListener } from '../../spi/core/llm-output.js';
import type { AppManagerCloseOperation, AppManagerCloseReport, DesktopCloseOptions, DesktopCloseOperation, DesktopCloseReport } from '../../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, closeTimeout, closeVoid, createCloseOperation, displayCloseId, freezeClose, mergeCloseReport, newCloseState, snapshotClose, type CloseState } from './close-operation.js';
import { DesktopLogger, type LogEntry } from './desktop-logger.js';
import { AppManager, type InstalledApp } from '../app/index.js';
import { ViewManager } from '../view/index.js';
import { SignalServiceImpl } from './signal-service.js';
import { LLMOutputChannelService } from './llm-output-channel.js';
import { RuntimeConfig, RUNTIME_DEFAULTS } from '../../spi/config/index.js';
import type { AppInteractionOptions, AppScopeResult } from '../../spi/runtime/app-interaction.interface.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction.js';
import { captureInteractionModes } from '../app/interaction-config.js';


// Re-export for backward compatibility
export { SignalOutputStream } from './signal-bus.js';
export { LogEntry } from './desktop-logger.js';
export { InstalledApp } from '../app/index.js';

/**
 * Desktop 构造参数
 * 
 * [Option B] 支持新的 Service 接口注入
 */
export interface DesktopOptions {
    workerPool?: WorkerPool;
    /** 使用外部 SignalBus (默认创建内部实例) - 向后兼容 */
    signalBus?: SignalBus;
    /** 使用外部 DesktopLogger (默认创建内部实例) */
    logger?: DesktopLogger;
    /** 使用外部 AppManager (默认创建内部实例) - 向后兼容 */
    appManager?: AppManager;
    /** 使用外部 ViewManager (默认创建内部实例) */
    viewManager?: ViewManager;

    // [Option B] 新 Service 接口
    /** [Option B] 使用外部 IAppHostService */
    appHostService?: IAppHostService;
    /** [Option B] 使用外部 ISignalService */
    signalService?: ISignalService;

    // [RFC-005] Runtime Config
    runtimeConfig?: RuntimeConfig;

    // [RFC-011] LLM Output Channel Service
    /** 使用外部 ILLMOutputChannelService */
    llmOutputChannelService?: ILLMOutputChannelService;

    // [RFC-026] Runtime Context Injection
    context?: IRuntimeContext;
}

// Desktop now explicitly implements IDesktopDOM for type safety
export class Desktop implements IDesktop {
    public readonly id: DesktopID;
    public readonly createdAt: number;

    // [RFC-026] Runtime Context
    public readonly context?: IRuntimeContext;

    private _status: DesktopStatus = 'active';
    private _disposed = false;
    private _isDraining = false;  // [RFC-014] Draining 状态标志
    private closeOperation?: DesktopCloseOperation;
    private closePromise?: Promise<void>;
    private drainPromise?: Promise<void>;
    private appClose?: AppManagerCloseOperation;
    private appReport?: AppManagerCloseReport;
    private closeState = newCloseState('desktop');
    private closeIntent: 'close' | 'delete' = 'close';
    private selectedBeforeClose?: WeakRef<() => Promise<void>>;
    private readonly subscriptions = new Map<SignalListener, () => void>();
    private readonly llmSubscriptions = new Map<LLMOutputListener, () => void>();
    private outputFacade?: SignalOutputStream;
    private llmFacade?: ILLMOutputChannelService;

    // Use injected SignalBus or create internal instance
    private signalBus: SignalBus;

    // Use injected DesktopLogger or create internal instance
    private logger: DesktopLogger;

    // Use injected AppManager or create internal instance
    private appManager: AppManager;

    // Use injected ViewManager or create internal instance
    private viewManager: ViewManager;

    // [Option B] New Service interfaces
    private appHostService: IAppHostService | null = null;
    private signalService: ISignalService | null = null;

    private config: RuntimeConfig;

    // [RFC-011] LLM Output Channel Service
    private llmOutputChannel: ILLMOutputChannelService;

    constructor(id?: DesktopID, options?: DesktopOptions) {
        this.id = id ?? createDesktopId();
        this.createdAt = Date.now();
        this.config = options?.runtimeConfig ?? RUNTIME_DEFAULTS;
        this.context = options?.context;

        // Desktop is Headless (No Mirror DOM)

        // [Option B] 新 Service 接口注入
        this.appHostService = options?.appHostService ?? null;
        this.signalService = options?.signalService ?? null;

        // 向后兼容: 使用 SignalBus 或从 SignalService 获取
        if (options?.signalBus) {
            this.signalBus = options.signalBus;
        } else if (this.signalService && (this.signalService as any).getBus) {
            this.signalBus = (this.signalService as SignalServiceImpl).getBus();
        } else {
            this.signalBus = new SignalBus();
        }

        this.logger = options?.logger || new DesktopLogger({
            maxSystemLogs: this.config.logger.maxSystemLogs,
            maxAppLogs: this.config.logger.maxAppLogs
        });

        this.appManager = options?.appManager || new AppManager(this, { workerPool: options?.workerPool, runtimeConfig: this.config });

        this.viewManager = options?.viewManager || new ViewManager();

        // [RFC-011] LLM Output Channel Service
        this.llmOutputChannel = options?.llmOutputChannelService ?? new LLMOutputChannelService();

        this.logSystem('Desktop initialized.');
        if (this.context) {
            this.logSystem(`Context injected: ${JSON.stringify(Object.keys(this.context.env))}`);
        }
    }

    get status(): DesktopStatus {
        return this._status;
    }
    /** Internal admission fact; status keeps its existing public domain. */
    get isClosing(): boolean { return this._isDraining || this._disposed; }



    // Delegate to SignalBus
    public get output(): SignalOutputStream {
        return this.outputFacade ??= Object.freeze({
            subscribe: (listener: SignalListener) => {
                this.assertActive();if (this.subscriptions.has(listener)) return;
                // Reserve before calling the provider: it may synchronously replay and close us.
                this.subscriptions.set(listener, () => {});
                let cancel: () => void;
                try { cancel = this.signalBus.subscribe(this.id, signal => { if (!this._isDraining) listener(signal); }); }
                catch (error) { this.subscriptions.delete(listener);throw error; }
                if (this._isDraining || !this.subscriptions.has(listener)) cancel();else this.subscriptions.set(listener, cancel);
            },
            unsubscribe: (listener: SignalListener) => { const cancel = this.subscriptions.get(listener);this.subscriptions.delete(listener);cancel?.(); }
        });
    }

    // [RFC-011] Expose LLM Output Channel for Bridge access
    public getLLMOutputChannel(): ILLMOutputChannelService {
        const scope = (id: DesktopID) => { if (id !== this.id) throw closeError('DESKTOP_SCOPE_MISMATCH'); };
        return this.llmFacade ??= Object.freeze({
            subscribe: (id: DesktopID, listener: LLMOutputListener) => {
                scope(id);this.assertActive();
                let cancel = this.llmSubscriptions.get(listener);
                if (!cancel) {
                    this.llmSubscriptions.set(listener, () => {});
                    try { cancel = this.llmOutputChannel.subscribe(this.id, event => { if (!this._isDraining) listener(event); }); }
                    catch (error) { this.llmSubscriptions.delete(listener);throw error; }
                    if (this._isDraining || !this.llmSubscriptions.has(listener)) cancel();else this.llmSubscriptions.set(listener, cancel);
                }
                // Capture this lifetime's cancellation, never look up a successor by ID.
                const captured = cancel;
                return () => { if (this.llmSubscriptions.get(listener) === captured) this.llmSubscriptions.delete(listener);captured?.(); };
            },
            push: (id: DesktopID, payload: Parameters<ILLMOutputChannelService['push']>[1], meta?: Parameters<ILLMOutputChannelService['push']>[2]) => { scope(id);this.assertActive();this.llmOutputChannel.push(this.id, payload, meta); },
            getHistory: (id: DesktopID) => { scope(id);return this._isDraining ? [] : [...this.llmOutputChannel.getHistory(this.id)]; },
            cleanup: (id: DesktopID) => { scope(id);this.assertActive();for (const cancel of this.llmSubscriptions.values()) cancel();this.llmSubscriptions.clear();this.llmOutputChannel.cleanup(this.id); }
        });
    }

    private assertActive(): void { if (this._isDraining || this._disposed) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: this.id }); }

    // [RFC-011] Broadcast LLM text to all Workers
    // [RFC-020] Now accepts structured payload
    public broadcastLLMOutput(
        payload: { reasoning?: string; content?: string },
        type: 'complete',
        meta?: {
            model?: string;
            providerId?: string;
            modelId?: string;
            usage?: {
                promptTokens: number;
                completionTokens: number;
                totalTokens: number;
            };
        }
    ): void {
        this.assertActive();
        this.appManager.broadcastLLMOutput(payload, type, meta);
    }

    // --- System Commands (App) ---

    async openApp(appId: AppID): Promise<void> {
        this.assertActive();
        return this.appManager.openApp(appId);
    }

    async closeApp(appId: AppID): Promise<void> {
        this.assertActive();
        return this.appManager.closeApp(appId);
    }

    async reinitializeApps(
        options?: ReinitializeDesktopAppsOptions
    ): Promise<ReinitializeDesktopAppsResult> {
        this.assertActive();
        const result = await this.appManager.reinitializeAll(options);
        const desktopResult: ReinitializeDesktopAppsResult = {
            desktopId: this.id,
            ...result,
        };

        this.logSystem(`Reinitialized desktop apps: ${desktopResult.reinitializedAppIds.length} restarted, ${desktopResult.skippedAppIds.length} skipped, ${desktopResult.failedAppIds.length} failed.`);
        this.emitSignal('manual_refresh');

        return desktopResult;
    }

    async collapseApp(appId: AppID): Promise<void> {
        this.assertActive();
        return this.appManager.collapseApp(appId);
    }

    async showApp(appId: AppID): Promise<void> {
        this.assertActive();
        return this.appManager.showApp(appId);
    }

    // --- System Commands (View) ---
    // Delegate to ViewManager



    async dismountView(appId: AppID, viewId: ViewID): Promise<void> {
        this.assertActive();
        // [Worker-Only] Use IPC for Worker Apps
        const sandbox = this.appManager.getWorkerSandbox(appId);
        if (sandbox) {
            await sandbox.dismountView(viewId);
        } else {
            await this.viewManager.dismount(appId, viewId);
        }
        this.emitSignal('dom_mutation');  // Notify after view state change
    }


    async hideView(appId: AppID, viewId: ViewID): Promise<void> {
        this.assertActive();
        await this.viewManager.hide(appId, viewId);
        this.emitSignal('dom_mutation');  // Notify after view state change
    }

    async showView(appId: AppID, viewId: ViewID): Promise<void> {
        this.assertActive();
        await this.viewManager.show(appId, viewId);
        this.emitSignal('dom_mutation');  // Notify after view state change
    }

    /**
     * [RFC-006] Mount view via ViewLink
     * 
     * Called when Agent uses V2 mount API: mount(parent_view, link_id)
     */
    async mountViewByLink(appId: AppID, parentViewId: ViewID, linkId: string): Promise<void> {
        this.assertActive();
        // [Worker-Only] Use IPC for Worker Apps
        const sandbox = this.appManager.getWorkerSandbox(appId);
        if (sandbox) {
            await sandbox.mountViewByLink(parentViewId, linkId);
        } else {
            // Non-worker apps: delegate to ViewManager (fallback)
            await this.viewManager.mountByLink(appId, parentViewId, linkId);
        }
        this.emitSignal('dom_mutation');  // Notify after view state change
    }

    /**
     * Get Window object (for ViewManager)
     */


    // --- Core Methods ---

    /**
     * [Worker-Only] Install Dynamic Worker App
     * 
     * App runs in a dedicated Worker Thread via IPC.
     */
    async installDynamicWorkerApp(
        appModulePath: string,
        options?: AppInteractionOptions & {
            workerScriptPath?: string;
            appId?: string;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            /** App 是什么 */
            whatItIs?: string;
            /** 什么时候用 */
            whenToUse?: string;
            config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;

            /** [RFC-014] App Role */
            promptRole?: 'user' | 'assistant';
        }
    ): Promise<string> {
        const experimentalInteractionModes = captureInteractionModes(options);
        this.assertActive();
        // [RFC-026] Merge Runtime Context into AppLaunchConfig
        // Priority: App Specific Config > Runtime Context
        // Note: We inject env vars from context into config.env if not present
        let mergedConfig = options?.config;
        if (this.context?.env) {
            mergedConfig = mergedConfig || {};
            // Inject all env vars from context
            for (const [key, value] of Object.entries(this.context.env)) {
                if (mergedConfig[key] === undefined) {
                    mergedConfig[key] = value;
                }
            }
        }

        return this.appManager.install(
            appModulePath,
            {
                workerScriptPath: options?.workerScriptPath,  // Now optional, AppManager/AppWorkerHost will use default
                appId: options?.appId as any,
                name: options?.name,
                description: options?.description,  // [RFC-013]
                whatItIs: options?.whatItIs,
                whenToUse: options?.whenToUse,
                config: mergedConfig, // [RFC-026] Injected Config
                runtimeConfig: this.config, // [RFC-005] Pass Runtime Config
                promptRole: options?.promptRole,
                experimentalInteractionModes
            }
        );
    }

    /**
     * [RFC-014] 注册待启动 App (懒加载)
     */
    async registerPendingApp(options: AppInteractionOptions & {
        appId?: string;
        name?: string;
        description?: string;
        whatItIs?: string;
        whenToUse?: string;
        modulePath: string;
        workerScriptPath?: string;
        config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;
        /** [RFC-014] App Role */
        promptRole?: 'user' | 'assistant';
    }): Promise<string> {
        const experimentalInteractionModes = captureInteractionModes(options);
        this.assertActive();
        return this.appManager.registerPendingApp({
            appId: options.appId as any,
            name: options.name,
            description: options.description,
            whatItIs: options.whatItIs,
            whenToUse: options.whenToUse,
            modulePath: options.modulePath,
            workerScriptPath: options.workerScriptPath,
            config: { ...this.context?.env, ...options.config },
            runtimeConfig: this.config,
            promptRole: options.promptRole,
            experimentalInteractionModes
        });
    }



    /**
     * Get Snapshot Fragments from all Apps
     * 
     * When Worker-Side Transformation is enabled, Worker executes Transformer directly.
     * This method aggregates cached Markdown + IndexMap + ViewTree from all workers.
     * 
     * [RFC-007] Added viewTree for Application View Tree section
     * 
     * @returns Snapshot Fragments from all apps, or empty array
     */
    getSnapshotFragments(): {
        appId: AppID;
        markup: string;
        indexMap: Record<string, unknown>;
        views?: Array<{
            viewId: ViewID;
            viewType: string;
            viewName?: string;
            markup: string;
            timestamp: number;
        }>;
        viewTree?: string;
        timestamp?: number;
    }[] {
        this.assertActive();

        const fragments: {
            appId: AppID;
            markup: string;
            indexMap: Record<string, unknown>;
            views?: Array<{
                viewId: ViewID;
                viewType: string;
                viewName?: string;
                markup: string;
                timestamp: number;
            }>;
            viewTree?: string;
            timestamp?: number;
        }[] = [];
        for (const [appId, worker] of this.appManager.getAllWorkers()) {
            const fragment = worker.getSnapshotFragment();
            if (fragment) {
                fragments.push({
                    appId,
                    markup: fragment.markup,
                    indexMap: fragment.indexMap,
                    views: fragment.views,
                    viewTree: fragment.viewTree,  // [RFC-007]
                    timestamp: fragment.timestamp,
                });
            }
        }

        return fragments;
    }

    /**
     * 获取 App 信息
     * @param appId - App ID
     * @returns App 信息 (name, etc.) 或 undefined
     */
    getAppInfo(appId: AppID): { name?: string } | undefined {
        if (this._disposed) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: this.id });

        const worker = this.appManager.getAllWorkers().get(appId);
        if (worker) {
            return { name: worker.name };
        }
        return undefined;
    }

    // --- Lifecycle Methods ---

    /**
     * 暂停 Desktop
     * 会调用所有动态 App 的 onPause()
     */
    async suspend(): Promise<void> {
        this.assertActive();
        this._status = 'suspended';
        this.signalBus.stopObserving(this.id);

        await this.appManager.pauseAll();
    }

    /**
     * 恢复 Desktop
     * 会调用所有动态 App 的 onResume()
     */
    async resume(): Promise<void> {
        this.assertActive();
        if (this._status === 'suspended') {
            this._status = 'active';
            await this.appManager.resumeAll();
        }
    }

    getAppStates(): AppState[] {
        return this.appManager.getAppStates();
    }

    /**
     * 获取已安装应用列表
     */
    getInstalledApps(): InstalledApp[] {
        return this.appManager.getInstalledApps();
    }

    experimentalCreateAppScope(appId: string, policy: ScopePolicy): AppScopeResult {
        const manager = this.appManager;
        const unavailable = (): AppScopeResult => Object.freeze({ status: 'rejected', issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' }) });
        const current = () => !this._isDraining && !this._disposed && this._status === 'active' && this.appManager === manager;
        if (!current()) return unavailable();
        const create = manager.experimentalCreateAppScope;
        if (typeof create !== 'function' || !current()) return unavailable();
        const result = create.call(manager, appId, policy);
        if (!current()) { if (result.status === 'opened') result.client.close();return unavailable(); }
        return result;
    }

    /**
     * Get System Logs (for <desktop> area)
     */
    getSystemLogs(): LogEntry[] {
        return this.logger.getSystemLogs(this.id);
    }

    /**
     * Get App Operation Logs (for <application> <info> area)
     */
    getAppOperationLogs(appId: AppID): LogEntry[] {
        return this.logger.getAppLogs(this.id, appId);
    }

    /**
     * Log System Message
     */
    logSystem(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        if (!this._isDraining) this.logger.logSystem(this.id, message, level);
    }

    /**
     * Log App Operation
     */
    logAppOperation(appId: AppID, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        if (!this._isDraining) this.logger.logApp(this.id, appId, message, level);
    }

    /**
     * 获取动态 App ID 列表（用于序列化恢复）
     */
    getDynamicAppIds(): AppID[] {
        return this.appManager.getDynamicAppIds();
    }

    /**
     * [RFC-014] 等待所有 App 关闭完成
     * 
     * 关闭所有 App 并等待 Worker 清理。
     * 调用后 Desktop 进入 draining 状态。
     */
    drain(): Promise<void> { return this.beginDrain('close'); }

    private beginDrain(intent: 'close' | 'delete'): Promise<void> {
        if (this.drainPromise) {
            if (this.closeIntent === 'close' && intent === 'delete') return Promise.reject(closeError('LIFECYCLE_CONFLICT'));
            return this.drainPromise;
        }
        this._isDraining = true;this.closeIntent = intent;this.closeState.intent = intent;
        let finish!: () => void;
        const completed = new Promise<void>(resolve => { finish = resolve; });
        // Install the shared promise before invoking any injected code.
        this.drainPromise = completed.then(() => { if (this.closeState.hasFailures || this.drainReport()?.hasFailures) throw closeError('DESKTOP_CLOSE_FAILED', this.report()); });
        void this.drainPromise.catch(() => {});
        const tasks: Promise<unknown>[] = [];
        if (typeof this.appManager.beginClose === 'function') {
            try {
                this.appClose = this.appManager.beginClose(intent);
                tasks.push(this.appClose.completion.then(report => { this.appReport = report;this.appClose = undefined; }));
            } catch { addCloseFailure(this.closeState, 'apps', ['APP_CLOSE_FAILED'], { desktopId: this.id });this.closeState.resourcesReleased = false; }
        } else {
            const legacy = newCloseState('app-manager', intent);legacy.verification = 'unverified';legacy.unverifiedParticipants = 1;legacy.resourcesReleased = false;legacy.interactions!.verified = false;
            this.appReport = freezeClose({ ...snapshotClose(legacy), scope: 'app-manager' as const });
            tasks.push((async () => {
                try { if (intent === 'delete' && typeof this.appManager.deleteAll === 'function') await this.appManager.deleteAll();else await this.appManager.closeAll(); }
                catch { addCloseFailure(legacy, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId: this.id }); }
                legacy.state = 'settled';this.appReport = freezeClose({ ...snapshotClose(legacy), scope: 'app-manager' as const });
            })());
        }
        if (this.appHostService) {
            this.closeState.verification = 'mixed';this.closeState.unverifiedParticipants++;this.closeState.resourcesReleased = false;this.closeState.interactions!.verified = false;
            tasks.push((async () => { try { await this.appHostService!.closeAll(this.id); }
                catch { addCloseFailure(this.closeState, 'legacy', ['LEGACY_CLOSE_FAILED'], { desktopId: this.id }); } })());
        }
        void Promise.allSettled(tasks).then(results => {
            if (results.some(result => result.status === 'rejected')) { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'apps', ['APP_CLOSE_FAILED'], { desktopId: this.id }); }
            finish();
        });
        return this.drainPromise;
    }

    private drainReport(): AppManagerCloseReport | undefined { return this.appClose?.inspect() ?? this.appReport; }

    private report(): DesktopCloseReport {
        const state = structuredClone(this.closeState);
        const child = this.drainReport();if (child) { mergeCloseReport(state, child);state.pool = { ownership: child.pool.ownership, report: child.pool.report ? { ...child.pool.report, issues: [...child.pool.report.issues] } : null }; }
        const released = state.resourcesReleased && this._disposed && !Object.values(state.cleanup).some(value => value === 'pending' || value === 'failed' || value === 'unverified');
        state.resourcesReleased = released;
        state.desktops = { accepted: 1, settled: state.state === 'settled' ? 1 : 0, pending: state.state === 'settled' ? 0 : 1, notVerifiedReleased: released ? 0 : 1 };
        return freezeClose({ ...snapshotClose(state), scope: 'desktop' as const, intent: this.closeIntent, desktopId: displayCloseId(this.id), found: true });
    }

    beginClose(options?: DesktopCloseOptions): DesktopCloseOperation {
        const timeout = closeTimeout(options), intent = options?.intent ?? 'close', callback = options?.beforeClose;
        if (intent !== 'close' && intent !== 'delete' || callback !== undefined && typeof callback !== 'function') throw closeError('CLOSE_OPTIONS_INVALID');
        if (this.closeOperation) {
            if (this.closeIntent === 'close' && intent === 'delete' || callback && callback !== this.selectedBeforeClose?.deref()) throw closeError('LIFECYCLE_CONFLICT');
            return this.closeOperation;
        }
        if (this._isDraining && this.closeIntent === 'close' && intent === 'delete') throw closeError('LIFECYCLE_CONFLICT');
        this.selectedBeforeClose = callback ? new WeakRef(callback) : undefined;this.closeState.beforeClose = callback ? 'pending' : 'not-provided';
        let complete!: (report: DesktopCloseReport) => void;
        const completion = new Promise<DesktopCloseReport>(resolve => { complete = resolve; });
        this.closeOperation = createCloseOperation(() => this.report(), completion);
        // The eligibility deadline belongs to this full close, independently of observers.
        const deadline = performance.now() + timeout;
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined = callback ? setTimeout(() => { expired = true;timer = undefined; }, timeout) : undefined;
        const clearEligibility = () => { if (timer !== undefined) clearTimeout(timer);timer = undefined; };
        const drain = this.beginDrain(intent);
        void (async () => {
            try { await drain; } catch { /* The drain report preserves known failures; cleanup still runs. */ }
            if (callback) {
                if (this.closeState.hasFailures || this.drainReport()?.hasFailures) this.closeState.beforeClose = 'skipped-drain-failed';
                else if (expired || performance.now() >= deadline) this.closeState.beforeClose = 'skipped-deadline';
                else {
                    this.closeState.beforeClose = 'running';clearEligibility();
                    try { await callback();this.closeState.beforeClose = 'done'; }
                    catch { this.closeState.beforeClose = 'failed'; }
                }
                clearEligibility();
                if (this.closeState.beforeClose === 'failed') addCloseFailure(this.closeState, 'before-close', ['BEFORE_CLOSE_FAILED'], { desktopId: this.id });
                else if (this.closeState.beforeClose !== 'done') addCloseFailure(this.closeState, 'before-close', ['BEFORE_CLOSE_SKIPPED'], { desktopId: this.id });
            }
            const cleanup = async (key: 'signalBus' | 'signalService' | 'llmOutput' | 'logger', action: () => unknown, stage: 'signals' | 'llm-output' | 'logger') => {
                this.closeState.cleanup[key] = 'pending';
                try { await action();this.closeState.cleanup[key] = 'done'; }
                catch { this.closeState.cleanup[key] = 'failed';this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, stage, ['DESKTOP_CLEANUP_FAILED'], { desktopId: this.id }); }
            };
            // Invoke every independent branch before awaiting any one branch.
            const cleanups = [
                cleanup('signalBus', async () => {
                    const cancellations = [...this.subscriptions.values()];this.subscriptions.clear();
                    const results = await Promise.allSettled(cancellations.map(async cancel => { cancel(); }));
                    try { await this.signalBus.cleanup(this.id); } catch { throw closeError('DESKTOP_CLEANUP_FAILED'); }
                    if (results.some(result => result.status === 'rejected')) throw closeError('DESKTOP_CLEANUP_FAILED');
                }, 'signals'),
                cleanup('llmOutput', async () => {
                    const cancellations = [...this.llmSubscriptions.values()];this.llmSubscriptions.clear();
                    const results = await Promise.allSettled(cancellations.map(async cancel => { cancel(); }));
                    try { await this.llmOutputChannel.cleanup(this.id); } catch { throw closeError('DESKTOP_CLEANUP_FAILED'); }
                    if (results.some(result => result.status === 'rejected')) throw closeError('DESKTOP_CLEANUP_FAILED');
                }, 'llm-output'),
                cleanup('logger', () => this.logger.cleanup(this.id), 'logger'),
                (async () => {
                    try { if (typeof this.appManager.cleanupAsync === 'function') await this.appManager.cleanupAsync();else if (typeof this.appManager.cleanup === 'function') await this.appManager.cleanup(); }
                    catch { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'apps', ['APP_CLOSE_FAILED'], { desktopId: this.id }); }
                })()
            ];
            if (this.signalService) {
                let sameBus = false;
                try { sameBus = typeof (this.signalService as SignalServiceImpl).getBus === 'function' && (this.signalService as SignalServiceImpl).getBus() === this.signalBus; } catch { /* Separate cleanup still has to be attempted. */ }
                if (!sameBus) cleanups.push(cleanup('signalService', () => this.signalService!.cleanup(this.id), 'signals'));
            }
            await Promise.allSettled(cleanups);this._disposed = true;this.closeState.state = 'settled';clearEligibility();complete(this.report());
        })();
        return this.closeOperation;
    }

    delete(): Promise<void> {
        try { const operation = this.beginClose({ intent: 'delete' });return this.closePromise ??= closeVoid(operation.completion, 'DESKTOP_CLOSE_FAILED'); }
        catch (error) { return Promise.reject(error); }
    }
    dispose(): Promise<void> { return this.closePromise ??= closeVoid(this.beginClose().completion, 'DESKTOP_CLOSE_FAILED'); }

    // --- Internals ---

    /**
     * Dispatch Operation to App Container
     * 
     * Desktop is responsible for converting Operation Payload to DOM Events (or IPC messages)
     * and sending them to the App.
     * 
     * [Worker-Only] For WorkerSandbox, use IPC instead of CustomEvent
     * [P0-1 FIX] Now returns the actual OperationResult from the Worker
     */
    async dispatchOperation(appId: AppID, payload: OperationPayload): Promise<import('../../spi/index.js').OperationResult> {
        this.assertActive();
        const sandbox = this.appManager.getWorkerSandbox(appId);
        if (!sandbox) {
            return failedResult('APP_NOT_FOUND', { appId, desktopId: this.id });
        }

        // WorkerSandbox Mode: Dispatch operation via IPC
        // [P0-1 FIX] Return the actual result from executeOperation
        return await sandbox.executeOperation(
            createOperationId(payload.operation),
            payload.args || {},
            createSnapshotId(payload.context.snapshotId || ''),
            payload.context.viewId
        );
    }



    // Delegate to SignalBus
    public emitSignal(reason: UpdateSignal['reason']) {
        if (!this._isDraining) this.signalBus.emitSignal(this.id, reason);
    }

    // [RFC-001 Phase 2] DOM Observers Removed

}
