import type { AppID, DesktopID } from '@aotui/core';
import type { AppDiscoveryInfo, CreateDesktopOptions, RunningApp } from '../../spi/runtime/kernel.interface.js';
import { createAppId } from '../../spi/core/id-factory.js';
import { closeError } from '../core/close-handle.js';
import { ManagedApp } from './managed-app.js';
import { WorkerCapacity } from './worker-capacity.js';
import { RUNTIME_DEFAULTS } from '../../spi/config/index.js';
import { appInteractionUnavailable, type AppInteractionOptions, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import type { AppWindows, ViewCloseResult, ViewWindowTarget } from '../../spi/runtime/windows.js';
import type { AppInteractionPolicy } from '@aotui/core';
import { appInstallFields, captureOptions, capturePolicy, captureProjectionLimits, captureToolsEnabled } from './interaction-config.js';
import type { ProjectionLimits } from '@aotui/core';
import { resolveAppModule } from './manifest.js';
import type { UpdateSignal } from '../../spi/core/signals.js';
import type { AppExecutionBackend } from '../../spi/runtime/execution-backend.js';
import { localCommandBackend } from '../../adapters/local-command-backend.js';

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
     */
    status: AppDiscoveryInfo['status'];

    /** [RFC-014] 懒加载: 模块路径 */
    readonly modulePath?: string;
    readonly command?: readonly string[];
    readonly backend?: AppExecutionBackend;

    /** [RFC-025] Reopen 时复用的启动配置 */
    config?: import('@aotui/core').AppLaunchConfig;

}

export interface AppManagerOptions {
    runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;
    workerCapacity?: WorkerCapacity;
    policyForApp?: CreateDesktopOptions['policyForApp'];
    onAppClosing?: () => void;
}



interface IDesktopInternal {
    readonly id: DesktopID;
    emitSignal(update: Pick<UpdateSignal, 'appId' | 'instanceId' | 'reason'>): void;
    logSystem(message: string, level?: 'info' | 'warn' | 'error'): void;
}

type InstallOptions = Omit<PendingOptions, 'modulePath' | 'name' | 'backend' | 'command'> & { name?: string; policy?: AppInteractionPolicy };
type StartedApp = Pick<RunningApp, 'appId' | 'instanceId'>;
type PendingOptions = AppInteractionOptions & {
        installationId?: string;
        name: string;
        description?: string;
        whatItIs?: string;
        whenToUse?: string;
        modulePath?: string;
        command?: readonly string[];
        backend?: string;
        config?: import('@aotui/core').AppLaunchConfig;
    };
/** Owns the installation directory and live App objects for a Desktop. */
export class AppManager {
    private readonly workers = new Map<AppID, ManagedApp>();
    private readonly installedApps = new Map<string, InstalledApp>();
    private readonly runs = new Map<AppID, InstalledApp>();
    private readonly nextSequence = new Map<string, number>();
    private installationIdCounter = 0;
    private readonly workerCapacity: WorkerCapacity;
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly appTasks = new Map<string, { kind: string; promise: Promise<unknown>; openPolicy?: AppInteractionPolicy }>();
    private accepting = true;

    constructor(private readonly desktop: IDesktopInternal, private readonly options: AppManagerOptions = {}) {
        this.workerCapacity = options.workerCapacity ?? new WorkerCapacity((options.runtimeConfig ?? RUNTIME_DEFAULTS).worker.maxWorkers);
    }
    private assertActive(): void { if (!this.accepting) throw closeError('APP_MANAGER_CLOSED'); }
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
    private track<T>(id: string, kind: string, run: () => Promise<T>, openPolicy?: AppInteractionPolicy): Promise<T> {
        try {
            this.assertActive();const previous = this.appTasks.get(id);
            if (previous) return previous.kind === kind && kind !== 'install' && previous.openPolicy === openPolicy
                ? previous.promise as Promise<T> : Promise.reject(closeError('APP_ALREADY_EXISTS'));
            this.capacity();
        } catch (error) { return Promise.reject(error); }
        let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });
        const token = { kind, promise, openPolicy };this.appTasks.set(id, token);this.inFlight.add(promise);
        const release = () => { this.inFlight.delete(promise);if (this.appTasks.get(id) === token) this.appTasks.delete(id); };
        try { void run().then(value => { release();resolve(value); }, error => { release();reject(error); }); }
        catch (error) { release();reject(error); }
        void promise.catch(() => {});return promise;
    }
    private current(meta: InstalledApp, worker?: ManagedApp): void {
        this.assertActive();
        if (this.installedApps.get(meta.installationId) !== meta || worker && (!meta.appId || this.workers.get(meta.appId) !== worker))
            throw closeError('LIFECYCLE_CONFLICT');
    }
    install(appModulePath: string, options?: InstallOptions): Promise<StartedApp> {
        let meta: InstalledApp;
        let policy: AppInteractionPolicy | undefined;
        try {
            this.capacity();
            const captured = captureOptions(options, appInstallFields);
            policy = capturePolicy(captured?.policy);
            const { metadata, modulePath } = resolveAppModule(appModulePath, captured?.name);
            meta = this.registration({ ...captured, name: metadata.app_name, modulePath,
                description: captured?.description ?? metadata.description,
                whatItIs: captured?.whatItIs ?? metadata.whatItIs, whenToUse: captured?.whenToUse ?? metadata.whenToUse });
        } catch (error) { return Promise.reject(error); }
        return this.track(meta.installationId, 'install', async () => {
            this.installedApps.set(meta.installationId, meta);
            try { return await this.installMeta(meta, policy); }
            catch (error) {
                if (!meta.appId && this.installedApps.get(meta.installationId) === meta)
                    this.installedApps.delete(meta.installationId);
                throw error;
            }
        });
    }
    private async installMeta(meta: InstalledApp, policy?: AppInteractionPolicy): Promise<StartedApp> {
        this.current(meta);
        let worker: ManagedApp | undefined;
        const id = meta.appId ?? this.reserveRun(meta);
        if (!policy && this.options.policyForApp) {
            try {
                policy = capturePolicy(this.options.policyForApp(Object.freeze({
                    desktopId: this.desktop.id, appId: id, installationId: meta.installationId, name: meta.name,
                })));
                if (!policy) throw new TypeError('The configured factory returned no policy.');
            } catch (cause) {
                this.releaseRun(meta, id);
                throw Object.assign(new Error('The Host could not create an interaction policy for ' + meta.installationId, { cause }),
                    { code: 'APP_INTERACTION_POLICY_CREATION_FAILED' });
            }
        }
        try {
            this.current(meta);
            const app = new ManagedApp({ appId: id, desktopId: this.desktop.id, name: meta.name, appModulePath: meta.modulePath,
                installationId: meta.installationId, backend: meta.backend, command: meta.command,
                ...(meta.config === undefined ? {} : { config: meta.config }),
                runtimeConfig: this.options.runtimeConfig, workerCapacity: this.workerCapacity,
                toolsEnabled: meta.toolsEnabled, projectionLimits: meta.projectionLimits, policy },
            () => {
                if (this.workers.get(id) !== app) return;
                const wasRunning = meta.status === 'running';
                meta.status = 'closed';
                this.options.onAppClosing?.();
                if (wasRunning) this.desktop.emitSignal({ reason: 'app_closed', appId: id, instanceId: app.appInstanceId });
            }, () => {
                if (this.workers.get(id) !== app) return;
                this.workers.delete(id);
                this.releaseRun(meta, id);
            });
            worker = app;
            this.workers.set(id, app);
            const emit = (reason: UpdateSignal['reason']) => {
                if (this.accepting && this.workers.get(id) === app)
                    this.desktop.emitSignal({ reason, appId: id, instanceId: app.appInstanceId });
            };
            app.onUpdate = emit;
            await app.start();
            this.current(meta, app);
            if (app.isClosing) throw closeError('APP_MANAGER_CLOSED');
            meta.status = 'running';
            this.desktop.logSystem(`Started app: ${id}`);
            emit('app_opened');
            return { appId: id, instanceId: app.appInstanceId };
        } catch (error) {
            const failure = Object.defineProperty(closeError('INSTALL_FAILED'), 'cause', { value: error });
            if (worker) {
                const handle = worker.closeFailedStartup();
                try {
                    const { report } = await handle.wait({ timeoutMs: worker.timeout });
                    Object.defineProperty(failure, 'closeReport', { value: report });
                }
                catch (cleanupError) { Object.defineProperty(failure, 'cleanupError', { value: cleanupError }); }
            } else this.releaseRun(meta, id);
            throw failure;
        }
    }
    private registration(options: PendingOptions): InstalledApp {
        const toolsEnabled = captureToolsEnabled(options);
        const projectionLimits = captureProjectionLimits(options);
        const name = options.name;
        const installationId = options.installationId ?? this.allocateInstallationId();
        if (!installationId.length || installationId !== installationId.trim()) throw closeError('INSTALL_FAILED');
        if (this.installedApps.has(installationId) || this.appTasks.has(installationId)) throw closeError('APP_ALREADY_EXISTS');
        const registry = this.options.runtimeConfig?.executionBackends;
        const backend = options.command !== undefined ? localCommandBackend
            : options.backend !== undefined && registry && Object.hasOwn(registry, options.backend) ? registry[options.backend] : undefined;
        if (options.backend !== undefined && !backend) {
            throw Object.assign(new Error('Execution backend is unavailable: ' + options.backend),
                { code: 'EXECUTION_BACKEND_UNAVAILABLE', path: 'options.backend' });
        }
        return { installationId, name, description: options.description, whatItIs: options.whatItIs, whenToUse: options.whenToUse,
            status: 'pending', modulePath: options.modulePath, command: options.command, backend,
            config: options.config,
            toolsEnabled, projectionLimits };
    }
    registerPendingApp(options: PendingOptions): string {
        this.assertActive();
        const meta = this.registration(options);
        this.installedApps.set(meta.installationId, meta);
        this.desktop.logSystem(`Registered application installation: ${meta.installationId} (${meta.name})`);
        return meta.installationId;
    }
    openApp(installationId: string, policy?: AppInteractionPolicy): Promise<StartedApp> {
        let captured: AppInteractionPolicy | undefined;
        try { this.assertActive();captured = capturePolicy(policy); } catch (error) { return Promise.reject(error); }
        const meta = this.installedApps.get(installationId);
        if (!meta || (meta.status !== 'pending' && meta.status !== 'closed'))
            return Promise.reject(closeError('LIFECYCLE_CONFLICT'));
        return this.track(installationId, 'open', async () => {
            this.current(meta);
            if (meta.appId) throw closeError('APP_ALREADY_EXISTS');
            return this.installMeta(meta, captured);
        }, policy);
    }
    get pendingStarts(): number { return this.inFlight.size; }
    stopAdmission() {
        this.accepting = false;
        return { apps: [...this.workers.values()], accepted: [...this.inFlight] };
    }
    clearInactiveInstallations(): void {
        for (const [id, meta] of this.installedApps) if (!meta.appId) this.installedApps.delete(id);
    }
    private windowOwner(id: AppID, expectedInstanceId: string) {
        const worker = this.workers.get(id);
        return worker && worker.appInstanceId === expectedInstanceId ? worker.windowActions : undefined;
    }
    getAppWindows(id: AppID, expectedInstanceId: string): AppWindows | undefined {
        return this.accepting ? this.windowOwner(id, expectedInstanceId)?.getWindows() : undefined;
    }
    async closeView(target: ViewWindowTarget, confirmTurn?: () => void): Promise<ViewCloseResult> {
        this.assertActive();
        const owner = this.windowOwner(target.appId, target.instanceId);
        if (!owner) throw closeError('APP_INSTANCE_CHANGED');
        return owner.closeView(target, confirmTurn);
    }
    listApps(): readonly AppDiscoveryInfo[] {
        return [...this.installedApps.values()].filter(app =>
            app.status === 'running' || this.appTasks.get(app.installationId)?.kind !== 'install').map(app => {
            const { installationId, appId, name, status, description, whatItIs, whenToUse } = app;
            const worker = appId ? this.workers.get(appId) : undefined;
            const appInstanceId = worker?.appInstanceId;
            return { installationId, status, name, description, whatItIs, whenToUse,
                ...(appId && appInstanceId && status === 'running' ? { appId, appInstanceId } : {}) };
        });
    }
    getManagedApp(id: AppID): ManagedApp | undefined { return this.workers.get(id); }
    isCurrentApp(appId: string, instanceId: string): boolean {
        const id = appId as AppID, worker = this.workers.get(id);
        return this.accepting && this.runs.get(id)?.status === 'running' && worker?.appInstanceId === instanceId && !worker.isClosing;
    }
    getAppInteraction(appId: string, expectedInstanceId: string): AppInteractionResult {
        const id = appId as AppID;
        if (!this.accepting || this.runs.get(id)?.status !== 'running') return appInteractionUnavailable();
        return this.workers.get(id)?.getAppInteraction(expectedInstanceId) ?? appInteractionUnavailable();
    }
}
