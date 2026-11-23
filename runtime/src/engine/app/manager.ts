import type { StateStorageBackend } from './state-storage-host.js';
/**
 * AppManager - App 安装与生命周期管理
 * 
 * [Worker-Only] 重构为使用 WorkerSandbox 实现 App 隔离
 * 
 * 职责:
 * - App 安装 (Worker 模式)
 * - App 生命周期 (open/close)
 * - App 状态查询
 * - 管理 WorkerSandbox 集合
 * 
 * 设计说明:
 * - 每个 App 在独立的 Worker Thread 中运行
 * - 通过 Worker 传递已提交的应用投影
 * - AppManager 持有 Desktop 引用用于日志和信号
 */

import type { AppID, DesktopID } from '@aotui/core';
import type { AppDiscoveryInfo, ReinitializeDesktopAppsOptions, ReinitializeDesktopAppsResult } from '../../spi/runtime/kernel.interface.js';
import { createAppId } from '../../spi/core/id-factory.js';
import type { SandboxCloseReport } from './worker-sandbox.js';
import type { AppManagerCloseReport, AppManagerCloseHandle } from '../../spi/runtime/close.interface.js';
import { closeError, createCloseHandle, newCloseState, mergeCloseReport, sandboxCloseReport, addCloseFailure, snapshotClose, freezeClose, type CloseState } from '../core/close-handle.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { WorkerCapacity } from './worker-capacity.js';
import { RUNTIME_DEFAULTS } from '../../spi/config/index.js';
import { appInteractionUnavailable, type AppInteractionOptions, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import type { AppWindows, ViewCloseResult, ViewWindowTarget } from '../../spi/runtime/windows.js';
import type { AppInteractionPolicy } from '@aotui/core';
import { appInstallFields, captureOptions, captureProjectionLimits, captureToolsEnabled } from './interaction-config.js';
import type { ProjectionLimits } from '@aotui/core';
import { resolveAppModule } from './manifest.js';

/**
 * 已安装的 App 信息
 */
interface InstalledApp extends AppInteractionOptions {
    readonly projectionLimits: ProjectionLimits;
    readonly installationId: string;
    appId?: AppID;
    name: string;
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
     * - 'closed': 已关闭
     * - 'collapsed': 已折叠
     */
    status: 'pending' | 'running' | 'closed' | 'collapsed';

    /** [RFC-014] 懒加载: 模块路径 */
    modulePath?: string;

    /** [RFC-025] Reopen 时复用的启动配置 */
    config?: import('@aotui/core').AppLaunchConfig;

    /** [RFC-005] Reopen 时复用的 Runtime 配置 */
    runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;

}

export interface AppManagerOptions {
    runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;
    workerCapacity?: WorkerCapacity;
    storageBackend?: StateStorageBackend;
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

type InstallOptions = Omit<PendingOptions, 'modulePath' | 'name'> & { name?: string };
const installFields = { ...appInstallFields, runtimeConfig: 'object' } as const;
type PendingOptions = AppInteractionOptions & {
        installationId?: string;
        name: string;
        description?: string;
        whatItIs?: string;
        whenToUse?: string;
        modulePath: string;
        config?: import('@aotui/core').AppLaunchConfig;
        runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;
    };
type AppCode = AppManagerCloseReport['failures'][number]['codes'][number];
interface OwnedSandbox { id: AppID; worker: WorkerSandbox; meta?: InstalledApp; codes: Set<AppCode>; stopReopen: boolean; cleanup?: Promise<SandboxCloseReport>; releaseRetry?: Promise<SandboxCloseReport>; }
export class AppManager {
    private workers = new Map<AppID, WorkerSandbox>();
    private installedApps = new Map<string, InstalledApp>();
    private runs = new Map<AppID, InstalledApp>();
    private nextSequence = new Map<string, number>();
    private installationIdCounter = 0;
    private readonly options: AppManagerOptions;
    private readonly desktop: IDesktopInternal;
    private readonly workerCapacity: WorkerCapacity;
    private readonly ownsWorkerCapacity: boolean;
    private readonly details = new WeakMap<WorkerSandbox, OwnedSandbox>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly appTasks = new Map<string, { kind: string; promise: Promise<unknown> }>();
    private closing?: AppManagerCloseHandle;
    private cleanupPromise?: Promise<AppManagerCloseReport>;
    private phase: 'active' | 'closing' | 'settled' = 'active';
    private intent: 'close' | 'delete' | null = null;
    private targets?: OwnedSandbox[];
    private folded?: CloseState;

    constructor(desktop: IDesktopInternal, options?: AppManagerOptions) {
        this.desktop = desktop;this.options = options ?? {};
        this.ownsWorkerCapacity = !options?.workerCapacity;
        this.workerCapacity = options?.workerCapacity ?? new WorkerCapacity((options?.runtimeConfig ?? RUNTIME_DEFAULTS).worker.maxWorkers);
    }
    private assertActive(): void { if (this.phase !== 'active') throw closeError('APP_MANAGER_CLOSED'); }
    private assertExpectedInstance(worker: WorkerSandbox | undefined, expectedInstanceId?: string): void {
        if (expectedInstanceId !== undefined && (!worker?.appInstanceId || worker.appInstanceId !== expectedInstanceId))
            throw closeError('APP_INSTANCE_CHANGED');
    }
    private capacity(): void { this.assertActive();if (this.inFlight.size >= 128) throw closeError('LIFECYCLE_CAPACITY_EXCEEDED'); }
    private allocateInstallationId(): string {
        while (Number.isSafeInteger(this.installationIdCounter)) {
            const id = 'app_' + this.installationIdCounter++;
            if (!this.installedApps.has(id)) return id;
        }
        throw closeError('LIFECYCLE_CAPACITY_EXCEEDED');
    }
    private reserveRun(meta: InstalledApp): AppID {
        let sequence = this.nextSequence.get(meta.name) ?? 0;
        while (Number.isSafeInteger(sequence)) {
            const id = createAppId(sequence === 0 ? meta.name : meta.name + '_' + sequence);
            this.nextSequence.set(meta.name, ++sequence);
            if (this.runs.has(id)) continue;
            this.runs.set(id, meta);
            meta.appId = id;
            return id;
        }
        throw closeError('LIFECYCLE_CAPACITY_EXCEEDED');
    }
    private releaseRun(meta: InstalledApp, id: AppID): void {
        if (this.runs.get(id) !== meta || this.workers.has(id)) return;
        this.runs.delete(id);
        delete meta.appId;
        if (![...this.runs.values()].some(run => run.name === meta.name)) this.nextSequence.delete(meta.name);
        meta.status = 'closed';
    }
    private owned(id: AppID, worker: WorkerSandbox): OwnedSandbox {
        let record = this.details.get(worker);
        if (!record) { record = { id, worker, meta: this.runs.get(id), codes: new Set(), stopReopen: false };this.details.set(worker, record); }
        return record;
    }
    private track<T>(id: string, kind: string, run: () => Promise<T>): Promise<T> {
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
        if (this.installedApps.get(meta.installationId) !== meta || worker && (!meta.appId || this.workers.get(meta.appId) !== worker))
            throw closeError('LIFECYCLE_CONFLICT');
    }
    install(appModulePath: string, options?: InstallOptions): Promise<AppID> {
        let meta: InstalledApp;
        try {
            this.capacity();
            const captured = captureOptions(options, installFields);
            const { metadata, modulePath } = resolveAppModule(appModulePath, captured?.name);
            meta = this.registration({ ...captured, name: metadata.app_name, modulePath,
                description: captured?.description ?? metadata.description,
                whatItIs: captured?.whatItIs ?? metadata.whatItIs, whenToUse: captured?.whenToUse ?? metadata.whenToUse });
        } catch (error) { return Promise.reject(error); }
        return this.track(meta.installationId, 'install', async () => {
            this.installedApps.set(meta.installationId, meta);
            try { return await this.installMeta(meta); }
            catch (error) {
                if (!meta.appId && this.installedApps.get(meta.installationId) === meta)
                    this.installedApps.delete(meta.installationId);
                throw error;
            }
        });
    }
    private async installMeta(meta: InstalledApp, reinitialize?: ReinitializeDesktopAppsOptions): Promise<AppID> {
        this.current(meta);let record: OwnedSandbox | undefined;
        const id = meta.appId ?? this.reserveRun(meta);
        try {
            const config = {
                ...meta.config,
                AOTUI_APP_KEY: meta.config?.AOTUI_APP_KEY ?? meta.installationId,
            };
            const worker = new WorkerSandbox({ appId: id, desktopId: this.desktop.id, name: meta.name, appModulePath: meta.modulePath!,
                config,
                runtimeConfig: meta.runtimeConfig ?? this.options.runtimeConfig, workerCapacity: this.workerCapacity,
                toolsEnabled: meta.toolsEnabled, projectionLimits: meta.projectionLimits, persistenceBackend: this.options.storageBackend });
            record = this.owned(id, worker);record.meta = meta;this.workers.set(id, worker);
            worker.onUpdateRequest = () => { if (this.phase === 'active' && this.workers.get(id) === worker) this.desktop.emitSignal('manual_refresh'); };
            await worker.installDynamic();
            this.current(meta, worker);if (record.stopReopen) throw closeError('APP_MANAGER_CLOSED');meta.status = 'running';
            if (reinitialize) {
                const reason = reinitialize.reason;
                this.desktop.logSystem(`Reinitialized app: ${id}${reason ? ` (${reason})` : ''}`);
            } else {
                this.desktop.logSystem(`Started app: ${id}`);
                this.desktop.emitSignal('app_installed');
            }
            return id;
        } catch (error) {
            if (record) {
                record.codes.add('INSTALL_FAILED');const report = await this.clean(record, 'close');
                if (report.resourcesReleased) this.releaseRecord(record);
            } else this.releaseRun(meta, id);
            throw Object.defineProperty(closeError('INSTALL_FAILED'), 'cause', { value: error });
        }
    }
    private registration(options: PendingOptions): InstalledApp {
        const toolsEnabled = captureToolsEnabled(options);
        const projectionLimits = captureProjectionLimits(options);
        const name = options.name;
        const installationId = options.installationId ?? this.allocateInstallationId();
        if (!installationId.length || installationId !== installationId.trim()) throw closeError('INSTALL_FAILED');
        if (this.installedApps.has(installationId) || this.appTasks.has(installationId)) throw closeError('APP_ALREADY_EXISTS');
        return { installationId, name, description: options.description, whatItIs: options.whatItIs, whenToUse: options.whenToUse,
            status: 'pending', modulePath: options.modulePath,
            config: options.config, runtimeConfig: options.runtimeConfig,
            toolsEnabled, projectionLimits };
    }
    registerPendingApp(options: PendingOptions): string {
        this.assertActive();
        const meta = this.registration(options);
        this.installedApps.set(meta.installationId, meta);
        this.desktop.logSystem(`Registered application installation: ${meta.installationId} (${meta.name})`);
        return meta.installationId;
    }
    openApp(installationId: string): Promise<AppID> {
        try { this.assertActive(); } catch (error) { return Promise.reject(error); }
        const meta = this.installedApps.get(installationId);
        if (!meta || !meta.modulePath || (meta.status !== 'pending' && meta.status !== 'closed'))
            return Promise.reject(closeError('LIFECYCLE_CONFLICT'));
        return this.track(installationId, 'open', async () => {
            this.current(meta);
            if (meta.appId) throw closeError('APP_ALREADY_EXISTS');
            return this.installMeta(meta);
        });
    }
    reinitializeApp(id: AppID, options?: ReinitializeDesktopAppsOptions): Promise<void> {
        try { this.assertActive(); } catch (error) { return Promise.reject(error); }
        const meta = this.runs.get(id);if (!meta) return Promise.reject(closeError('APP_CLOSE_FAILED'));
        if (meta.status === 'closed' || meta.status === 'pending') return Promise.resolve();
        const worker = this.workers.get(id);if (!worker) return Promise.reject(closeError('APP_CLOSE_FAILED'));const record = this.owned(id, worker);
        return this.track(meta.installationId, 'reinitialize', async () => {
            try {
                this.current(meta, worker);await worker.reinitialize(options?.reason);this.current(meta, worker);
                const report = await this.clean(record, 'close');this.releaseRecord(record, this.phase === 'active');
                if (!report.resourcesReleased || report.issues.length || record.codes.size) throw closeError('APP_CLOSE_FAILED');
                this.current(meta);if (record.stopReopen || this.workers.has(id)) throw closeError('LIFECYCLE_CONFLICT');
                await this.installMeta(meta, { reason: options?.reason });
            } catch {
                record.codes.add('APP_CLOSE_FAILED');await this.clean(record, 'close');this.releaseRecord(record);throw closeError('APP_CLOSE_FAILED');
            }
        });
    }
    async reinitializeAll(options?: ReinitializeDesktopAppsOptions): Promise<Omit<ReinitializeDesktopAppsResult, 'desktopId'>> {
        this.assertActive();
        const entries = [...this.installedApps.values()];
        const active = entries.flatMap(app => app.appId && (app.status === 'running' || app.status === 'collapsed')
            ? [app.appId] : []);
        const skippedInstallationIds = entries.filter(app => app.status === 'pending' || app.status === 'closed')
            .map(app => app.installationId);
        const results = await Promise.all(active.map(async id => {
            try { await this.reinitializeApp(id, options); return { id, state: 'done' }; }
            catch { return { id, state: 'failed' }; }
        }));
        return { reinitializedAppIds: results.filter(x => x.state === 'done').map(x => x.id),
            skippedInstallationIds, failedAppIds: results.filter(x => x.state === 'failed').map(x => x.id) };
    }
    private clean(record: OwnedSandbox, intent: 'close' | 'delete'): Promise<SandboxCloseReport> {
        if (record.cleanup) return record.cleanup;
        let actual: Promise<SandboxCloseReport>;
        try {
            if (intent === 'delete') { const deleting = record.worker.delete();void deleting.catch(() => {}); }
            actual = record.worker.disposeAsync();
        } catch (error) { actual = Promise.reject(error); }
        record.cleanup = actual.catch(error => { record.codes.add('APP_CLOSE_FAILED');throw error; });
        void record.cleanup.catch(() => {});return record.cleanup;
    }
    private retryRelease(record: OwnedSandbox): Promise<SandboxCloseReport> {
        if (record.releaseRetry) return record.releaseRetry;
        record.releaseRetry = record.worker.retryResourceRelease().finally(() => { record.releaseRetry = undefined; });
        return record.releaseRetry;
    }

    async retryResourceRelease(): Promise<AppManagerCloseReport> {
        if (this.phase !== 'settled' || !this.folded) return this.report();
        await Promise.all([...this.workers].map(async ([id, worker]) => {
            if (!worker.getCloseReport().host?.storage.ownerRetained) return;
            const record = this.owned(id, worker);
            const report = await this.retryRelease(record);
            if (!report.resourcesReleased || this.workers.get(id) !== worker) return;
            mergeCloseReport(this.folded!, this.contribution(record));
            this.releaseRecord(record);
            if (record.meta) this.installedApps.delete(record.meta.installationId);
        }));
        return this.report();
    }
    private releaseRecord(record: OwnedSandbox, keepRun = false): void {
        const report = record.worker.getCloseReport();
        if (!report.resourcesReleased) return;
        if (this.workers.get(record.id) === record.worker) this.workers.delete(record.id);
        if (!keepRun && record.meta) this.releaseRun(record.meta, record.id);
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
        for (const record of this.targets ?? [...this.workers].map(([id, worker]) => this.owned(id, worker))) mergeCloseReport(state, this.contribution(record));
        if (this.inFlight.size) state.resourcesReleased = false;
        if (this.ownsWorkerCapacity) {
            const workers = this.workerCapacity.getReport();state.workers = { ownership: 'owned', report: workers };
            if (workers.state !== 'closed') state.resourcesReleased = false;
        }
        return freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const });
    }
    getCloseReport(): AppManagerCloseReport { return this.closing && this.phase !== 'settled' ? this.closing.inspect() : this.report(); }
    beginClose(intent: 'close' | 'delete' = 'close'): AppManagerCloseHandle {
        if (this.closing) { if (this.intent === 'close' && intent === 'delete') throw closeError('LIFECYCLE_CONFLICT');return this.closing; }
        this.phase = 'closing';this.intent = intent;this.targets = [...this.workers].map(([id, worker]) => this.owned(id, worker));
        for (const record of this.targets) record.stopReopen = true;
        let complete!: (report: AppManagerCloseReport) => void;
        const completion = new Promise<AppManagerCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseHandle(() => this.report(), completion);
        const ownedCapacity = this.ownsWorkerCapacity ? this.workerCapacity.close() : undefined;
        const tasks = this.targets.map(record => record.releaseRetry ?? this.clean(record, intent));
        void Promise.resolve().then(async () => {
            await Promise.allSettled([...tasks, ...this.inFlight]);
            if (ownedCapacity) await ownedCapacity;
            this.folded = newCloseState('app-manager', intent);
            for (const record of this.targets!) {
                if (!record.worker.getCloseReport().resourcesReleased) continue;
                mergeCloseReport(this.folded, this.contribution(record));
                this.releaseRecord(record);
            }
            this.targets = undefined;this.phase = 'settled';return this.report();
        }).then(complete, () => {
            const state = this.folded ?? newCloseState('app-manager', intent);
            state.state = 'settled';state.resourcesReleased = false;state.verification = this.ownsWorkerCapacity ? 'mixed' : 'unverified';
            state.unverifiedParticipants++;addCloseFailure(state, 'apps', ['MANAGER_CLEANUP_FAILED'], { desktopId: String(this.desktop.id) });
            this.folded = state;this.targets = undefined;this.phase = 'settled';
            complete(freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const }));
        });
        return this.closing;
    }
    cleanupAsync(): Promise<AppManagerCloseReport> {
        return this.cleanupPromise ??= this.beginClose().completion.then(report => {
            for (const [id, app] of this.installedApps) if (!app.appId) this.installedApps.delete(id);
            return report;
        });
    }
    async closeApp(id: AppID, expectedInstanceId?: string): Promise<void> {
        this.assertActive();const worker = this.workers.get(id);this.assertExpectedInstance(worker, expectedInstanceId);if (!worker) return;const record = this.owned(id, worker);record.stopReopen = true;
        const accepted = record.meta && this.appTasks.get(record.meta.installationId)?.promise;
        const before = worker.getCloseReport();
        const report = await (before.state === 'settled' && before.host?.storage.ownerRetained
            ? this.retryRelease(record)
            : this.clean(record, 'close'));
        if (accepted) await accepted.catch(() => {});
        if (this.phase === 'active') {
            if (record.meta && this.runs.get(id) === record.meta && this.workers.get(id) === worker) record.meta.status = 'closed';
            this.releaseRecord(record);
        }
        const mapped = this.contribution(record);if (mapped.hasFailures || !report.resourcesReleased) throw closeError('APP_CLOSE_FAILED', mapped);
        this.desktop.logSystem(`Closed application: ${id}`);this.desktop.emitSignal('dom_mutation');
    }
    private windowOwner(id: AppID, expectedInstanceId?: string) {
        this.assertActive();
        const worker = this.workers.get(id);
        this.assertExpectedInstance(worker, expectedInstanceId);
        if (!worker || this.details.get(worker)?.stopReopen) return;
        return worker.windowActions;
    }
    getAppWindows(id: AppID, expectedInstanceId: string): AppWindows | undefined {
        if (this.phase !== 'active' || this.workers.get(id)?.appInstanceId !== expectedInstanceId) return;
        return this.windowOwner(id, expectedInstanceId)?.getWindows();
    }
    async collapseApp(id: AppID, expectedInstanceId?: string, note = ''): Promise<void> {
        const owner = this.windowOwner(id, expectedInstanceId);
        if (!owner && expectedInstanceId) throw closeError('APP_INSTANCE_CHANGED');
        if (!owner) return;
        owner.setAppWindow(note);
        this.desktop.emitSignal('dom_mutation');
    }
    async expandApp(id: AppID, expectedInstanceId?: string): Promise<void> {
        const owner = this.windowOwner(id, expectedInstanceId);
        if (!owner && expectedInstanceId) throw closeError('APP_INSTANCE_CHANGED');
        if (!owner) return;
        owner.setAppWindow(undefined);
        this.desktop.emitSignal('dom_mutation');
    }
    async setViewWindow(target: ViewWindowTarget, note: string | undefined): Promise<void> {
        const owner = this.windowOwner(target.appId, target.instanceId);
        if (!owner) throw closeError('APP_INSTANCE_CHANGED');
        owner.setViewWindow(target, note);
        this.desktop.emitSignal('dom_mutation');
    }
    async closeView(target: ViewWindowTarget): Promise<ViewCloseResult> {
        const owner = this.windowOwner(target.appId, target.instanceId);
        if (!owner) throw closeError('APP_INSTANCE_CHANGED');
        return owner.closeView(target);
    }
    getInstalledApps(): readonly AppDiscoveryInfo[] {
        return [...this.installedApps.values()].filter(app =>
            app.status === 'running' || this.appTasks.get(app.installationId)?.kind !== 'install').map(app => {
            const { installationId, appId, name, description, whatItIs, whenToUse } = app;
            const worker = appId ? this.workers.get(appId) : undefined;
            const status = app.status === 'running' && worker?.windowActions?.collapseNote !== undefined ? 'collapsed' : app.status;
            const appInstanceId = worker?.appInstanceId;
            return { installationId, status, name, description, whatItIs, whenToUse,
                ...(appId && appInstanceId && (status === 'running' || status === 'collapsed') ? { appId, appInstanceId } : {}) };
        });
    }
    getWorkerSandbox(id: AppID): WorkerSandbox | undefined { return this.workers.get(id); }
    isRunningApp(appId: string, instanceId: string): boolean {
        const id = appId as AppID, worker = this.workers.get(id);
        return this.phase === 'active' && this.runs.get(id)?.status === 'running' && worker?.status === 'running' &&
            worker.appInstanceId === instanceId && worker.windowActions?.collapseNote === undefined && !this.details.get(worker)?.stopReopen;
    }
    getAppInteraction(appId: string, expectedInstanceId: string, policy?: AppInteractionPolicy): AppInteractionResult {
        const id = appId as AppID, meta = this.runs.get(id), worker = this.workers.get(id);
        const current = () => this.phase === 'active' && !!meta && !!worker && this.runs.get(id) === meta && this.workers.get(id) === worker &&
            this.installedApps.get(meta.installationId) === meta &&
            (meta.status === 'running' || meta.status === 'collapsed') && worker.status === 'running' && !this.details.get(worker)?.stopReopen;
        if (!current()) return appInteractionUnavailable();
        const create = worker!.getAppInteraction;
        if (!current()) return appInteractionUnavailable();
        const result = create.call(worker, expectedInstanceId, policy);
        if (!current()) return appInteractionUnavailable();
        return result;
    }
}
