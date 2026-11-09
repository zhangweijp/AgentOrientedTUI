/**
 * AppManager - App 安装与生命周期管理
 * 
 * [Worker-Only] 重构为使用 WorkerSandbox 实现 App 隔离
 * 
 * 职责:
 * - App 安装 (Worker 模式)
 * - App 生命周期 (open/close/pause/resume)
 * - App 状态查询
 * - 管理 WorkerSandbox 集合
 * 
 * 设计说明:
 * - 每个 App 在独立的 Worker Thread 中运行
 * - 通过 mirrorDOM 实现主线程 DOM 同步
 * - AppManager 持有 Desktop 引用用于日志和信号
 */

import type { AppID, AppState, DesktopID, ReinitializeDesktopAppsOptions, ReinitializeDesktopAppsResult } from '../../spi/index.js';
import { createAppId } from '../../spi/index.js';
import type { SandboxCloseReport } from './worker-sandbox.js';
import type { AppManagerCloseReport, AppManagerCloseHandle } from '../../spi/runtime/close.interface.js';
import { closeError, createCloseHandle, newCloseState, mergeCloseReport, sandboxCloseReport, addCloseFailure, snapshotClose, freezeClose, type CloseState } from '../core/close-handle.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { WorkerPool } from './worker-pool.js';
import { RUNTIME_DEFAULTS } from '../../spi/config/index.js';
import type { AppInteractionOptions, AppScopeResult } from '../../spi/runtime/app-interaction.interface.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';
import { captureInteractionModes } from './interaction-config.js';

/**
 * 已安装的 App 信息
 */
export interface InstalledApp extends AppInteractionOptions {
    appId: AppID;
    name?: string;
    /** [RFC-013] App 描述 - 告诉 Agent 什么时候使用此 App */
    description?: string;
    /** App 是什么 (用于 Desktop State 展示) */
    whatItIs?: string;
    /** 什么时候用 (用于 Desktop State 展示) */
    whenToUse?: string;
    /**
     * [RFC-014] App 状态
     * - 'pending': 已注册但未启动 (懒加载)
     * - 'running': 正在运行
     * - 'paused': 已暂停
     * - 'closed': 已关闭
     * - 'collapsed': 已折叠
     */
    status: 'pending' | 'running' | 'paused' | 'closed' | 'collapsed';
    installedAt: number;

    /** [RFC-014] 懒加载: 模块路径 */
    modulePath?: string;
    /** [RFC-014] 懒加载: Worker 脚本路径 */
    workerScript?: string;

    /** [RFC-025] Reopen 时复用的启动配置 */
    config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;

    /** [RFC-005] Reopen 时复用的 Runtime 配置 */
    runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;

}

export interface AppManagerOptions {
    runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;
    workerPool?: WorkerPool;
    /** App 安装回调 */
    onAppInstalled?: (appId: AppID) => void;
    /** App 移除回调 */
    onAppRemoved?: (appId: AppID) => void;
}



/**
 * AppManager - 统一管理 App 安装与生命周期
 * 
 * [Worker-Only] 使用 WorkerSandbox 实现 App 隔离
 */
interface IDesktopInternal {
    readonly id: DesktopID;
    emitSignal(reason: string): void;
    logSystem(message: string, level?: 'info' | 'warn' | 'error'): void;
}

type InstallOptions = AppInteractionOptions & {
            workerScriptPath?: string;
            appId?: AppID;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            /** App 是什么 */
            whatItIs?: string;
            /** 什么时候用 */
            whenToUse?: string;
            config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;
            runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig; // [RFC-005] Runtime Config

            /** Internal: suppress install callbacks during reinitialize */
            notifyAppInstalled?: boolean;
            /** Internal: suppress lifecycle signal during reinitialize */
            emitLifecycleSignal?: boolean;
            /** Internal: override lifecycle log message */
            lifecycleMessage?: string;
            /** Internal: startup lifecycle metadata for runtime-only injection */
            lifecycle?: {
                startupKind: 'normal' | 'reinitialize';
                reason?: string;
            };
        };
type PendingOptions = AppInteractionOptions & {
        appId?: AppID;
        name?: string;
        description?: string;
        whatItIs?: string;
        whenToUse?: string;
        modulePath: string;
        workerScriptPath?: string;
        config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;
        runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;
    };
type AppCode = AppManagerCloseReport['failures'][number]['codes'][number];
interface OwnedSandbox { id: AppID; worker: WorkerSandbox; meta?: InstalledApp; codes: Set<AppCode>; stopReopen: boolean; cleanup?: Promise<SandboxCloseReport>; }
export class AppManager {
    private workers = new Map<AppID, WorkerSandbox>();
    private installedApps = new Map<AppID, InstalledApp>();
    private appIdCounter = 0;
    private idsExhausted = false;
    private readonly options: AppManagerOptions;
    private readonly desktop: IDesktopInternal;
    private readonly workerPool: WorkerPool;
    private readonly ownsWorkerPool: boolean;
    private readonly details = new WeakMap<WorkerSandbox, OwnedSandbox>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly appTasks = new Map<AppID, { kind: string; promise: Promise<unknown> }>();
    private closing?: AppManagerCloseHandle;
    private cleanupPromise?: Promise<AppManagerCloseReport>;
    private phase: 'active' | 'closing' | 'settled' = 'active';
    private intent: 'close' | 'delete' | null = null;
    private targets?: OwnedSandbox[];
    private folded?: CloseState;

    constructor(desktop: IDesktopInternal, options?: AppManagerOptions) {
        this.desktop = desktop;this.options = options ?? {};
        this.ownsWorkerPool = !options?.workerPool;
        this.workerPool = options?.workerPool ?? new WorkerPool({ ...(options?.runtimeConfig ?? RUNTIME_DEFAULTS).worker.pool });
    }
    private assertActive(): void { if (this.phase !== 'active') throw closeError('APP_MANAGER_CLOSED'); }
    private assertExpectedInstance(worker: WorkerSandbox | undefined, expectedInstanceId?: string): void {
        if (expectedInstanceId !== undefined && (!worker?.appInstanceId || worker.appInstanceId !== expectedInstanceId))
            throw closeError('APP_INSTANCE_CHANGED');
    }
    private capacity(): void { this.assertActive();if (this.inFlight.size >= 128) throw closeError('LIFECYCLE_CAPACITY_EXCEEDED'); }
    private allocateId(): AppID {
        while (!this.idsExhausted) {
            const id = createAppId(this.appIdCounter);
            if (this.appIdCounter === Number.MAX_SAFE_INTEGER) this.idsExhausted = true;else this.appIdCounter++;
            if (!this.installedApps.has(id) && !this.workers.has(id) && !this.appTasks.has(id)) return id;
        }
        throw closeError('LIFECYCLE_CAPACITY_EXCEEDED');
    }
    private owned(id: AppID, worker: WorkerSandbox): OwnedSandbox {
        let record = this.details.get(worker);
        if (!record) { record = { id, worker, meta: this.installedApps.get(id), codes: new Set(), stopReopen: false };this.details.set(worker, record); }
        return record;
    }
    private track<T>(id: AppID, kind: string, run: () => Promise<T>): Promise<T> {
        try {
            this.assertActive();const previous = this.appTasks.get(id);
            if (previous) return previous.kind === kind && kind !== 'install' ? previous.promise as Promise<T> : Promise.reject(closeError('APP_ALREADY_EXISTS'));
            this.capacity();
        } catch (error) { return Promise.reject(error); }
        let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });
        const token = { kind, promise };this.appTasks.set(id, token);this.inFlight.add(promise);
        const release = () => { this.inFlight.delete(promise);if (this.appTasks.get(id) === token) this.appTasks.delete(id); };
        try { void run().then(value => { release();resolve(value); }, error => { release();reject(error); }); }
        catch (error) { release();reject(error); }
        void promise.catch(() => {});return promise;
    }
    private current(meta: InstalledApp, worker?: WorkerSandbox): void {
        this.assertActive();
        if (this.installedApps.get(meta.appId) !== meta || worker && this.workers.get(meta.appId) !== worker) throw closeError('LIFECYCLE_CONFLICT');
    }
    private withLifecycleMetadata(
        config: import('../../spi/app/app-config.interface.js').AppLaunchConfig | undefined,
        lifecycle?: {
            startupKind: 'normal' | 'reinitialize';
            reason?: string;
        }
    ): import('../../spi/app/app-config.interface.js').AppLaunchConfig | undefined {
        const effectiveLifecycle = lifecycle ?? { startupKind: 'normal' as const };
        return {
            ...(config ?? {}),
            __aotuiLifecycle: {
                startupKind: effectiveLifecycle.startupKind,
                reason: effectiveLifecycle.reason,
            },
        };
    }

    install(appModulePath: string, options?: InstallOptions): Promise<AppID> {
        let id: AppID;
        try {
            const interactionModes = captureInteractionModes(options);
            options = { ...options, interactionModes };
            this.capacity();id = options?.appId ?? this.allocateId();
            if (this.installedApps.has(id) || this.workers.has(id) || this.appTasks.has(id)) throw closeError('APP_ALREADY_EXISTS');
        } catch (error) { return Promise.reject(error); }
        return this.track(id, 'install', async () => {
            const meta: InstalledApp = { appId: id, name: options?.name, description: options?.description, whatItIs: options?.whatItIs,
                whenToUse: options?.whenToUse, status: 'pending', installedAt: Date.now(), modulePath: appModulePath,
                workerScript: options?.workerScriptPath, config: options?.config, runtimeConfig: options?.runtimeConfig,
                interactionModes: options?.interactionModes };
            this.installedApps.set(id, meta);await this.installMeta(meta, options);return id;
        });
    }
    private async installMeta(meta: InstalledApp, options?: InstallOptions): Promise<void> {
        this.current(meta);let record: OwnedSandbox | undefined;
        try {
            const worker = new WorkerSandbox({ appId: meta.appId, desktopId: this.desktop.id, name: meta.name, appModulePath: meta.modulePath!,
                workerScriptPath: meta.workerScript, config: this.withLifecycleMetadata(meta.config, options?.lifecycle),
                runtimeConfig: meta.runtimeConfig ?? this.options.runtimeConfig, workerPool: this.workerPool,
                interactionModes: meta.interactionModes });
            record = this.owned(meta.appId, worker);record.meta = meta;this.workers.set(meta.appId, worker);
            worker.onUpdateRequest = () => { if (this.phase === 'active' && this.workers.get(meta.appId) === worker) this.desktop.emitSignal('manual_refresh'); };
            await worker.installDynamic();this.current(meta, worker);if (record.stopReopen) throw closeError('APP_MANAGER_CLOSED');
            if (options?.notifyAppInstalled !== false) await this.options.onAppInstalled?.(meta.appId);
            this.current(meta, worker);if (record.stopReopen) throw closeError('APP_MANAGER_CLOSED');meta.status = 'running';
            this.desktop.logSystem(options?.lifecycleMessage ?? `Installed app: ${meta.appId}`);
            if (options?.emitLifecycleSignal !== false) this.desktop.emitSignal('app_installed');
        } catch (error) {
            if (record) {
                record.codes.add('INSTALL_FAILED');const report = await this.clean(record, 'close', false);
                if (this.phase === 'active' && report.resourcesReleased) {
                    this.releaseRecord(record, true);
                    if (this.installedApps.get(meta.appId) === meta && !this.workers.has(meta.appId)) meta.status = 'closed';
                }
            } else if (this.installedApps.get(meta.appId) === meta) this.installedApps.delete(meta.appId);
            throw Object.defineProperty(closeError('INSTALL_FAILED'), 'cause', { value: error });
        }
    }
    registerPendingApp(options: PendingOptions): AppID {
        const interactionModes = captureInteractionModes(options);
        this.assertActive();const id = options.appId ?? this.allocateId();
        if (this.installedApps.has(id) || this.workers.has(id) || this.appTasks.has(id)) throw closeError('APP_ALREADY_EXISTS');
        this.installedApps.set(id, { appId: id, name: options.name, description: options.description, whatItIs: options.whatItIs, whenToUse: options.whenToUse,
            status: 'pending', installedAt: Date.now(), modulePath: options.modulePath, workerScript: options.workerScriptPath,
            config: options.config, runtimeConfig: options.runtimeConfig,
            interactionModes });
        this.desktop.logSystem(`Registered pending app: ${id} (${options.name ?? 'unnamed'})`);return id;
    }
    startPendingApp(id: AppID, options?: Pick<InstallOptions, 'notifyAppInstalled' | 'emitLifecycleSignal' | 'lifecycleMessage' | 'lifecycle'>): Promise<boolean> {
        try { this.assertActive(); } catch (error) { return Promise.reject(error); }
        const meta = this.installedApps.get(id);if (!meta || !meta.modulePath || meta.status !== 'pending' && meta.status !== 'closed') return Promise.resolve(false);
        return this.track(id, 'open', async () => { this.current(meta);if (this.workers.has(id)) throw closeError('APP_ALREADY_EXISTS');await this.installMeta(meta, options);return true; });
    }
    reinitializeApp(id: AppID, options?: ReinitializeDesktopAppsOptions): Promise<void> {
        try { this.assertActive(); } catch (error) { return Promise.reject(error); }
        const meta = this.installedApps.get(id);if (!meta) return Promise.reject(closeError('APP_CLOSE_FAILED'));
        if (meta.status === 'closed' || meta.status === 'pending') return Promise.resolve();
        const worker = this.workers.get(id);if (!worker) return Promise.reject(closeError('APP_CLOSE_FAILED'));const record = this.owned(id, worker);
        return this.track(id, 'reinitialize', async () => {
            try {
                this.current(meta, worker);await worker.reinitialize(options?.reason);this.current(meta, worker);
                const report = await this.clean(record, 'close', false);this.releaseRecord(record, this.phase === 'active');
                if (!report.resourcesReleased || report.issues.length || record.codes.size) throw closeError('APP_CLOSE_FAILED');
                this.current(meta);if (record.stopReopen || this.workers.has(id)) throw closeError('LIFECYCLE_CONFLICT');
                await this.installMeta(meta, { notifyAppInstalled: false, emitLifecycleSignal: false,
                    lifecycleMessage: `Reinitialized app: ${id}${options?.reason ? ` (${options.reason})` : ''}`,
                    lifecycle: { startupKind: 'reinitialize', reason: options?.reason } });
            } catch {
                record.codes.add('APP_CLOSE_FAILED');await this.clean(record, 'close', false);this.releaseRecord(record, this.phase === 'active');throw closeError('APP_CLOSE_FAILED');
            }
        });
    }
    async reinitializeAll(options?: ReinitializeDesktopAppsOptions): Promise<Omit<ReinitializeDesktopAppsResult, 'desktopId'>> {
        this.assertActive();const entries = [...this.installedApps.entries()];
        const results = await Promise.all(entries.map(async ([id, meta]) => {
            if (meta.status === 'closed' || meta.status === 'pending') return { id, state: 'skipped' };
            try { await this.reinitializeApp(id, options);return { id, state: 'done' }; } catch { return { id, state: 'failed' }; }
        }));
        return { reinitializedAppIds: results.filter(x => x.state === 'done').map(x => x.id),
            skippedAppIds: results.filter(x => x.state === 'skipped').map(x => x.id), failedAppIds: results.filter(x => x.state === 'failed').map(x => x.id) };
    }
    private clean(record: OwnedSandbox, intent: 'close' | 'delete', notify: boolean): Promise<SandboxCloseReport> {
        if (record.cleanup) return record.cleanup;
        let actual: Promise<SandboxCloseReport>;
        try {
            if (intent === 'delete') { const deleting = record.worker.delete();void deleting.catch(() => {}); }
            actual = record.worker.disposeAsync();
        } catch (error) { actual = Promise.reject(error); }
        record.cleanup = actual.then(async report => {
            if (notify && report.resourcesReleased) {
                try { await this.options.onAppRemoved?.(record.id); } catch { record.codes.add('APP_CLOSE_FAILED'); }
            }
            return report;
        }, error => { record.codes.add('APP_CLOSE_FAILED');throw error; });
        void record.cleanup.catch(() => {});return record.cleanup;
    }
    private releaseRecord(record: OwnedSandbox, markClosed: boolean): void {
        const report = record.worker.getCloseReport();
        if (!report.resourcesReleased) return;
        if (this.workers.get(record.id) === record.worker) this.workers.delete(record.id);
        if (markClosed && this.installedApps.get(record.id) === record.meta && !this.workers.has(record.id)) record.meta!.status = 'closed';
    }
    private contribution(record: OwnedSandbox): AppManagerCloseReport {
        const mapped = sandboxCloseReport(record.worker.getCloseReport(), String(this.desktop.id), String(record.id));
        const state = structuredClone(mapped) as CloseState;
        const present = new Set(mapped.failures.filter(x => x.stage === 'apps').flatMap(x => [...x.codes]));
        addCloseFailure(state, 'apps', [...record.codes].filter(code => !present.has(code)), { desktopId: String(this.desktop.id), appId: String(record.id) });
        return freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const });
    }
    private report(): AppManagerCloseReport {
        const state = this.folded ? structuredClone(this.folded) : newCloseState('app-manager', this.intent);
        state.state = this.phase;state.intent = this.intent;state.pendingTasks = this.inFlight.size;
        for (const record of this.targets ?? (this.folded ? [] : [...this.workers].map(([id, worker]) => this.owned(id, worker)))) mergeCloseReport(state, this.contribution(record));
        if (this.inFlight.size) state.resourcesReleased = false;
        if (this.ownsWorkerPool) {
            const pool = this.workerPool.getReport();state.pool = { ownership: 'owned', report: { ...pool, issues: [...pool.issues] } };
            if (pool.state !== 'closed') state.resourcesReleased = false;
            addCloseFailure(state, 'pool', pool.issues, { desktopId: String(this.desktop.id) });
        }
        return freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const });
    }
    getCloseReport(): AppManagerCloseReport { return this.closing ? this.closing.inspect() : this.report(); }
    beginClose(intent: 'close' | 'delete' = 'close'): AppManagerCloseHandle {
        if (this.closing) { if (this.intent === 'close' && intent === 'delete') throw closeError('LIFECYCLE_CONFLICT');return this.closing; }
        this.phase = 'closing';this.intent = intent;this.targets = [...this.workers].map(([id, worker]) => this.owned(id, worker));
        for (const record of this.targets) record.stopReopen = true;
        let complete!: (report: AppManagerCloseReport) => void;
        const completion = new Promise<AppManagerCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseHandle(() => this.report(), completion);
        const ownedPool = this.ownsWorkerPool ? this.workerPool.destroy() : undefined;
        const tasks = this.targets.map(record => this.clean(record, intent, true));
        void Promise.resolve().then(async () => {
            await Promise.allSettled([...tasks, ...this.inFlight]);
            if (ownedPool) await ownedPool;
            this.folded = newCloseState('app-manager', intent);
            for (const record of this.targets!) { mergeCloseReport(this.folded, this.contribution(record));this.releaseRecord(record, false); }
            this.targets = undefined;this.phase = 'settled';return this.report();
        }).then(complete, () => {
            const state = this.folded ?? newCloseState('app-manager', intent);
            state.state = 'settled';state.resourcesReleased = false;state.verification = this.ownsWorkerPool ? 'mixed' : 'unverified';
            state.unverifiedParticipants++;addCloseFailure(state, 'apps', ['MANAGER_CLEANUP_FAILED'], { desktopId: String(this.desktop.id) });
            this.folded = state;this.targets = undefined;this.phase = 'settled';
            complete(freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const }));
        });
        return this.closing;
    }
    cleanupAsync(): Promise<AppManagerCloseReport> {
        return this.cleanupPromise ??= this.beginClose().completion.then(report => {
            for (const [id] of this.installedApps) if (!this.workers.has(id)) this.installedApps.delete(id);
            return report;
        });
    }
    async openApp(id: AppID): Promise<void> {
        this.assertActive();const meta = this.installedApps.get(id);
        if (meta && (meta.status === 'pending' || meta.status === 'closed')) { await this.startPendingApp(id);return; }
        if (!this.workers.has(id)) { console.warn(`App ${id} not found.`);return; }
        if (meta) meta.status = 'running';this.desktop.logSystem(`Opened application: ${id}`);this.desktop.emitSignal('app_opened');
    }
    async closeApp(id: AppID, expectedInstanceId?: string): Promise<void> {
        this.assertActive();const worker = this.workers.get(id);this.assertExpectedInstance(worker, expectedInstanceId);if (!worker) return;const record = this.owned(id, worker);record.stopReopen = true;
        const accepted = this.appTasks.get(id)?.promise;const report = await this.clean(record, 'close', true);
        if (accepted) await accepted.catch(() => {});this.releaseRecord(record, true);
        const mapped = this.contribution(record);if (mapped.hasFailures || !report.resourcesReleased) throw closeError('APP_CLOSE_FAILED', mapped);
        this.desktop.logSystem(`Closed application: ${id}`);this.desktop.emitSignal('dom_mutation');
    }
    async pauseAll(): Promise<void> {
        this.assertActive();for (const [id, worker] of this.workers) if (worker.status === 'running') {
            const meta = this.installedApps.get(id);await worker.pause();this.assertActive();if (this.workers.get(id) === worker && this.installedApps.get(id) === meta && meta) meta.status = 'paused';
        }
    }
    async resumeAll(): Promise<void> {
        this.assertActive();for (const [id, worker] of this.workers) if (worker.status === 'paused') {
            const meta = this.installedApps.get(id);await worker.resume();this.assertActive();if (this.workers.get(id) === worker && this.installedApps.get(id) === meta && meta) meta.status = 'running';
        }
    }
    async collapseApp(id: AppID, expectedInstanceId?: string): Promise<void> { this.assertActive();const worker = this.workers.get(id);this.assertExpectedInstance(worker, expectedInstanceId);if (!worker) return;const meta = this.installedApps.get(id);if (meta) meta.status = 'collapsed';this.desktop.logSystem(`Collapsed application: ${id}`);this.desktop.emitSignal('dom_mutation'); }
    async showApp(id: AppID, expectedInstanceId?: string): Promise<void> { this.assertActive();const worker = this.workers.get(id);this.assertExpectedInstance(worker, expectedInstanceId);if (!worker) return;const meta = this.installedApps.get(id);if (meta) meta.status = 'running';this.desktop.logSystem(`Shown application: ${id}`);this.desktop.emitSignal('dom_mutation'); }
    getInstalledApps(): Array<InstalledApp & { readonly appInstanceId?: string }> {
        return [...this.installedApps.values()].map(app => {
            const appInstanceId = this.workers.get(app.appId)?.appInstanceId;
            return { ...app, ...(appInstanceId ? { appInstanceId } : {}) };
        });
    }
    getDynamicAppIds(): AppID[] { return [...this.workers.keys()]; }
    getAppStates(): AppState[] { return [...this.installedApps].map(([appId, app]) => ({ appId, name: app.name, status: app.status, installedAt: app.installedAt })); }
    getWorkerSandbox(id: AppID): WorkerSandbox | undefined { return this.workers.get(id); }
    createAppScope(appId: string, policy: ScopePolicy): AppScopeResult {
        const id = appId as AppID, meta = this.installedApps.get(id), worker = this.workers.get(id);
        const unavailable = (): AppScopeResult => Object.freeze({ status: 'rejected', issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' }) });
        const current = () => this.phase === 'active' && !!meta && !!worker && this.installedApps.get(id) === meta && this.workers.get(id) === worker &&
            (meta.status === 'running' || meta.status === 'collapsed') && worker.status === 'running' && !this.details.get(worker)?.stopReopen;
        if (!current()) return unavailable();
        const create = worker!.createAppScope;
        if (!current()) return unavailable();
        const result = create.call(worker, policy);
        if (!current()) { if (result.status === 'opened') result.client.close();return unavailable(); }
        return result;
    }
    isWorkerMode(id: AppID): boolean { return this.workers.has(id); }
    broadcastLLMOutput(payload: { reasoning?: string; content?: string }, type: 'complete', meta?: Parameters<WorkerSandbox['pushLLMOutput']>[2]): void {
        if (this.phase !== 'active') return;for (const worker of this.workers.values()) worker.pushLLMOutput(payload, type, meta);
    }
}
