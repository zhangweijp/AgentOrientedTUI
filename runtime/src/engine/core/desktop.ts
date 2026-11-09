import type { WorkerPool } from '../app/worker-pool.js';
import type { IDesktop, DesktopID, AppID, UpdateSignal, AppState, DesktopStatus, ILLMOutputChannelService, IRuntimeContext, ReinitializeDesktopAppsOptions, ReinitializeDesktopAppsResult } from '../../spi/index.js';
import { createDesktopId } from '../../spi/index.js';
import { AOTUIError } from '../../spi/core/errors.js';
import { SignalBus, type SignalListener } from './signal-bus.js';
import type { LLMOutputListener } from '../../spi/core/llm-output.js';
import type { AppManagerCloseHandle, AppManagerCloseReport, DesktopCloseOptions, DesktopCloseHandle, DesktopCloseReport } from '../../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, closeTimeout, closeVoid, createCloseHandle, displayCloseId, freezeClose, mergeCloseReport, newCloseState, snapshotClose } from './close-handle.js';
import { DesktopLogger, type LogEntry } from './desktop-logger.js';
import { AppManager } from '../app/manager.js';
import { LLMOutputChannelService } from './llm-output-channel.js';
import { RuntimeConfig, RUNTIME_DEFAULTS } from '../../spi/config/index.js';
import type { AppInteractionOptions, AppScopeResult } from '../../spi/runtime/app-interaction.interface.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';
import { captureInteractionModes } from '../app/interaction-config.js';


/**
 * Desktop 构造参数
 * 
 * [Option B] 支持新的 Service 接口注入
 */
export interface DesktopOptions {
    workerPool?: WorkerPool;
    /** 使用外部 SignalBus (默认创建内部实例) */
    signalBus?: SignalBus;
    /** 使用外部 DesktopLogger (默认创建内部实例) */
    logger?: DesktopLogger;
    /** 使用外部 AppManager (默认创建内部实例) */
    appManager?: AppManager;
    // [RFC-005] Runtime Config
    runtimeConfig?: RuntimeConfig;

    // [RFC-011] LLM Output Channel Service
    /** 使用外部 ILLMOutputChannelService */
    llmOutputChannelService?: ILLMOutputChannelService;

    // [RFC-026] Runtime Context Injection
    context?: IRuntimeContext;
}

export class Desktop implements IDesktop {
    public readonly id: DesktopID;
    public readonly createdAt: number;

    // [RFC-026] Runtime Context
    public readonly context?: IRuntimeContext;

    private _status: DesktopStatus = 'active';
    private _disposed = false;
    private _isDraining = false;  // [RFC-014] Draining 状态标志
    private closeHandle?: DesktopCloseHandle;
    private closePromise?: Promise<void>;
    private drainPromise?: Promise<void>;
    private appClose?: AppManagerCloseHandle;
    private appReport?: AppManagerCloseReport;
    private closeState = newCloseState('desktop');
    private closeIntent: 'close' | 'delete' = 'close';
    private selectedBeforeClose?: WeakRef<() => Promise<void>>;
    private readonly subscriptions = new Map<SignalListener, () => void>();
    private readonly llmSubscriptions = new Map<LLMOutputListener, () => void>();
    private outputFacade?: IDesktop['output'];
    private llmFacade?: ILLMOutputChannelService;

    // Use injected SignalBus or create internal instance
    private signalBus: SignalBus;

    // Use injected DesktopLogger or create internal instance
    private logger: DesktopLogger;

    // Use injected AppManager or create internal instance
    private appManager: AppManager;

    private config: RuntimeConfig;

    // [RFC-011] LLM Output Channel Service
    private llmOutputChannel: ILLMOutputChannelService;

    constructor(id?: DesktopID, options?: DesktopOptions) {
        this.id = id ?? createDesktopId();
        this.createdAt = Date.now();
        this.config = options?.runtimeConfig ?? RUNTIME_DEFAULTS;
        this.context = options?.context;

        // Desktop is Headless (No Mirror DOM)

        this.signalBus = options?.signalBus ?? new SignalBus();

        this.logger = options?.logger || new DesktopLogger({
            maxSystemLogs: this.config.logger.maxSystemLogs
        });

        this.appManager = options?.appManager || new AppManager(this, { workerPool: options?.workerPool, runtimeConfig: this.config });

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
    public get output(): IDesktop['output'] {
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

    async closeApp(appId: AppID, expectedInstanceId?: string): Promise<void> {
        this.assertActive();
        return this.appManager.closeApp(appId, expectedInstanceId);
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

    async collapseApp(appId: AppID, expectedInstanceId?: string): Promise<void> {
        this.assertActive();
        return this.appManager.collapseApp(appId, expectedInstanceId);
    }

    async showApp(appId: AppID, expectedInstanceId?: string): Promise<void> {
        this.assertActive();
        return this.appManager.showApp(appId, expectedInstanceId);
    }

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

        }
    ): Promise<string> {
        const interactionModes = captureInteractionModes(options);
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
                interactionModes
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
    }): Promise<string> {
        const interactionModes = captureInteractionModes(options);
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
            interactionModes
        });
    }
    // --- Lifecycle Methods ---

    /**
     * 暂停 Desktop
     * 会调用所有动态 App 的 onPause()
     */
    async suspend(): Promise<void> {
        this.assertActive();
        this._status = 'suspended';

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
    getInstalledApps(): ReturnType<AppManager['getInstalledApps']> {
        return this.appManager.getInstalledApps();
    }

    createAppScope(appId: string, policy: ScopePolicy): AppScopeResult {
        const manager = this.appManager;
        const unavailable = (): AppScopeResult => Object.freeze({ status: 'rejected', issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' }) });
        const current = () => !this._isDraining && !this._disposed && this._status === 'active' && this.appManager === manager;
        if (!current()) return unavailable();
        const create = manager.createAppScope;
        if (!current()) return unavailable();
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
     * Log System Message
     */
    logSystem(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        if (!this._isDraining) this.logger.logSystem(this.id, message, level);
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
        try {
            this.appClose = this.appManager.beginClose(intent);
            tasks.push(this.appClose.completion.then(report => { this.appReport = report;this.appClose = undefined; }));
        } catch { addCloseFailure(this.closeState, 'apps', ['APP_CLOSE_FAILED'], { desktopId: this.id });this.closeState.resourcesReleased = false; }
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

    beginClose(options?: DesktopCloseOptions): DesktopCloseHandle {
        const timeout = closeTimeout(options), intent = options?.intent ?? 'close', callback = options?.beforeClose;
        if (intent !== 'close' && intent !== 'delete' || callback !== undefined && typeof callback !== 'function') throw closeError('CLOSE_OPTIONS_INVALID');
        if (this.closeHandle) {
            if (this.closeIntent === 'close' && intent === 'delete' || callback && callback !== this.selectedBeforeClose?.deref()) throw closeError('LIFECYCLE_CONFLICT');
            return this.closeHandle;
        }
        if (this._isDraining && this.closeIntent === 'close' && intent === 'delete') throw closeError('LIFECYCLE_CONFLICT');
        this.selectedBeforeClose = callback ? new WeakRef(callback) : undefined;this.closeState.beforeClose = callback ? 'pending' : 'not-provided';
        let complete!: (report: DesktopCloseReport) => void;
        const completion = new Promise<DesktopCloseReport>(resolve => { complete = resolve; });
        this.closeHandle = createCloseHandle(() => this.report(), completion);
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
            const cleanup = async (key: 'signalBus' | 'llmOutput' | 'logger', action: () => unknown, stage: 'signals' | 'llm-output' | 'logger') => {
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
                    try { await this.appManager.cleanupAsync(); }
                    catch { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'apps', ['APP_CLOSE_FAILED'], { desktopId: this.id }); }
                })()
            ];
            await Promise.allSettled(cleanups);this._disposed = true;this.closeState.state = 'settled';clearEligibility();complete(this.report());
        })();
        return this.closeHandle;
    }

    delete(): Promise<void> {
        try { const handle = this.beginClose({ intent: 'delete' });return this.closePromise ??= closeVoid(handle.completion, 'DESKTOP_CLOSE_FAILED'); }
        catch (error) { return Promise.reject(error); }
    }
    dispose(): Promise<void> { return this.closePromise ??= closeVoid(this.beginClose().completion, 'DESKTOP_CLOSE_FAILED'); }

    // --- Internals ---

    // Delegate to SignalBus
    public emitSignal(reason: UpdateSignal['reason']) {
        if (!this._isDraining) this.signalBus.emitSignal(this.id, reason);
    }

    // [RFC-001 Phase 2] DOM Observers Removed

}
