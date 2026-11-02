/**
 * WorkerSandbox - Worker 隔离的 App 执行与资源生命周期所有者。
 * App 运行在独立 Worker Thread 中，交互通过 IPC 进行。
 * @module @aotui/runtime/engine/app-sandbox
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { AppID, DesktopID, ViewID } from '../../spi/index.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { LLMOutputEventMeta } from '../../spi/core/llm-output.js';
import { AppWorkerHost, type HostResourceReport } from './worker-host.js';
import { WorkerPool, type WorkerPoolReport, type WorkerLease, type WorkerLeaseReleaseReport } from './worker-pool.js';
import { RUNTIME_DEFAULTS } from '../../spi/config/index.js';
import type { AppInteractionOptions, AppScopeResult } from '../../spi/runtime/app-interaction.interface.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';
import { captureInteractionModes } from './interaction-config.js';

// [C1 Fix] Default worker script path from Runtime package
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_WORKER_SCRIPT = resolve(__dirname, '../../worker-runtime/index.js');

/**
 * Sandbox 状态机
 * 
 * 状态转换:
 * created → running (installDynamic)
 * running ↔ paused
 * running/paused → closed
 */
export type SandboxStatus = 'created' | 'running' | 'paused' | 'closed';

/**
 * WorkerSandbox 配置
 */
export interface WorkerSandboxConfig extends AppInteractionOptions {
    workerPool?: WorkerPool;
    /** App ID */
    appId: AppID;
    /** Desktop ID */
    desktopId: DesktopID;
    /** App 名称 */
    name?: string;
    /** App 模块路径 (用于动态 import) */
    appModulePath: string;
    /** 
     * Worker runtime 脚本路径 (可选)
     * [C1 Fix] 默认使用 Runtime 内置的 worker-runtime
     */
    workerScriptPath?: string;
    /** 应用启动配置 (环境变量、初始状态等) */
    config?: import('../../spi/app/app-config.interface.js').AppLaunchConfig;
    /** [RFC-005] Runtime Config */
    runtimeConfig?: import('../../spi/config/index.js').RuntimeConfig;
}

/**
 * WorkerSandbox - 管理 App 的 Worker lease、Host 和关闭流程。
 */
export interface SandboxCloseReport {
    readonly state: 'active' | 'closing' | 'settled'; readonly intent: null | 'close' | 'delete';
    readonly ok: boolean; readonly resourcesReleased: boolean;
    readonly host?: HostResourceReport; readonly lease?: WorkerLeaseReleaseReport; readonly ownedPool?: WorkerPoolReport;
    readonly issues: readonly ('INSTALL_FAILED' | 'DELETE_FAILED' | 'APP_CLOSE_FAILED' | 'RESET_FAILED' | 'RESOURCE_RELEASE_FAILED')[];
}
const lifecycleError = (code: 'SANDBOX_CLOSED' | 'SANDBOX_ALREADY_INSTALLED' | 'INSTALL_FAILED' | 'LIFECYCLE_CONFLICT' | 'SANDBOX_CLOSE_FAILED', report?: SandboxCloseReport) =>
    Object.assign(new Error(code), { code, ...(report ? { report } : {}) });

export class WorkerSandbox {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly name?: string;
    readonly createdAt: number;

    private workerHost: AppWorkerHost | null = null;
    private _status: SandboxStatus = 'created';
    private readonly pool: WorkerPool;
    private readonly ownsPool: boolean;
    private lease?: WorkerLease;
    private installPromise?: Promise<void>;
    private installSettled = false;
    private installToken?: object;
    private intent: 'close' | 'delete' | null = null;
    private cleanupPromise?: Promise<SandboxCloseReport>;
    private closeVoidPromise?: Promise<void>;
    private finalReport?: SandboxCloseReport;
    private leaseResult?: WorkerLeaseReleaseReport;
    private readonly closeIssues = new Set<SandboxCloseReport['issues'][number]>();



    // 回调
    onUpdateRequest?: () => void;

    constructor(private readonly config: WorkerSandboxConfig) {
        const interactionModes = captureInteractionModes(config);
        this.config = { ...config, interactionModes };
        this.appId = config.appId;
        this.desktopId = config.desktopId;
        this.name = config.name;
        this.createdAt = Date.now();
        this.ownsPool = !config.workerPool;
        this.pool = config.workerPool ?? new WorkerPool({ ...(config.runtimeConfig ?? RUNTIME_DEFAULTS).worker.pool });
    }

    // ════════════════════════════════════════════════════════════════
    //  Public State and Interaction Access
    // ════════════════════════════════════════════════════════════════

    get status(): SandboxStatus {
        return this._status;
    }

    get appInstanceId(): string | undefined {
        return this.workerHost?.appInstanceId;
    }

    createAppScope(policy: ScopePolicy): AppScopeResult {
        const host = this.workerHost;
        const unavailable = (): AppScopeResult => Object.freeze({ status: 'rejected', issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' }) });
        const current = () => !this.intent && this._status === 'running' && !!host && this.workerHost === host && host.getStatus() === 'running';
        if (!current()) return unavailable();
        const result = host!.createInteractionScope(policy);
        if (!current()) { if (result.status === 'opened') result.client.close();return unavailable(); }
        return result;
    }

    // ════════════════════════════════════════════════════════════════
    //  Lifecycle Methods
    // ════════════════════════════════════════════════════════════════

    /**
     * 安装动态 App (启动 Worker)
     * 
     * [WorkerPool] 从池中获取 Worker
     */
    installDynamic(): Promise<void> {
        if (this.intent) return Promise.reject(lifecycleError('SANDBOX_CLOSED'));
        if (this.installPromise) return this.installSettled ? Promise.reject(lifecycleError('SANDBOX_ALREADY_INSTALLED')) : this.installPromise;
        const token = this.installToken = Object.freeze({});
        const scriptPath = resolve(this.config.workerScriptPath || DEFAULT_WORKER_SCRIPT);
        const current = () => { if (this.installToken !== token || this.intent) throw lifecycleError('SANDBOX_CLOSED'); };
        this.installPromise = Promise.resolve().then(async () => {
            current();this.lease = await this.pool.acquireLease(scriptPath);current();
            const host = this.workerHost = new AppWorkerHost({ ...this.config, workerScriptPath: scriptPath,
                existingWorker: this.lease.worker, runtimeConfig: this.config.runtimeConfig,
            });
            host.onUpdateRequest = () => { if (!this.intent && this.workerHost === host) this.onUpdateRequest?.(); };
            await host.start();current();await host.open();current();this._status = 'running';
        }).then(() => { this.installSettled = true; }, () => {
            this.installSettled = true;this.closeIssues.add('INSTALL_FAILED');this.beginCleanup('close');throw lifecycleError('INSTALL_FAILED');
        });
        void this.installPromise.catch(() => {});return this.installPromise;
    }

    /**
     * 暂停 App
     */
    async pause(): Promise<void> {
        this.ensureNotClosed();

        if (this._status !== 'running') {
            return;
        }

        if (this.workerHost) {
            await this.workerHost.pause();
        }
        if (!this.intent) this._status = 'paused';
    }

    /**
     * 恢复 App
     */
    async resume(): Promise<void> {
        this.ensureNotClosed();

        if (this._status !== 'paused') {
            return;
        }

        if (this.workerHost) {
            await this.workerHost.resume();
        }
        if (!this.intent) this._status = 'running';
    }

    async reinitialize(reason?: string): Promise<void> {
        this.ensureNotClosed();

        if (this._status !== 'running' && this._status !== 'paused') {
            return;
        }

        if (this.workerHost) {
            await this.workerHost.reinitialize(reason);
        }
    }

    /**
     * 关闭 App
     */
    getCloseReport(): SandboxCloseReport {
        if (this.finalReport) return this.finalReport;
        return Object.freeze({ state: this.intent ? 'closing' : 'active', intent: this.intent, ok: false, resourcesReleased: false,
            ...(this.workerHost ? { host: this.workerHost.getResourceReport() } : {}),
            ...(this.leaseResult ? { lease: this.leaseResult } : {}), ...(this.ownsPool ? { ownedPool: this.pool.getReport() } : {}),
            issues: Object.freeze([...this.closeIssues]) });
    }
    private beginCleanup(intent: 'close' | 'delete'): Promise<SandboxCloseReport> {
        if (this.cleanupPromise) return this.cleanupPromise;
        this.intent = intent;this._status = 'closed';
        this.workerHost?.beginInteractionClose();
        this.workerHost?.beginApplicationStop();
        // Close pool admission synchronously; await it only after this lease is returned.
        const ownedDestroy = this.ownsPool ? this.pool.destroy() : undefined;
        this.cleanupPromise = Promise.resolve().then(async () => {
            if (this.installPromise) await this.installPromise.catch(() => {});
            const host = this.workerHost;
            if (intent === 'delete' && host) { try { await host.delete(); } catch { this.closeIssues.add('DELETE_FAILED'); } }
            if (host) { try { await host.close(); } catch { this.closeIssues.add('APP_CLOSE_FAILED'); } }
            let returned: import('node:worker_threads').Worker | null = null;
            let leaseRelease: Promise<WorkerLeaseReleaseReport> | undefined;
            const retireLease = this.lease ? () => {
                leaseRelease ??= this.lease!.release(false);
                return leaseRelease;
            } : undefined;
            if (host) {
                try { returned = await host.releaseWorker(retireLease); } catch { this.closeIssues.add('RESET_FAILED'); }
                if (!returned) {
                    if (host.getResourceReport().issues.includes('RESET_FAILED')) this.closeIssues.add('RESET_FAILED');
                    if (!leaseRelease) { try { host.terminate(); } catch { this.closeIssues.add('RESOURCE_RELEASE_FAILED'); } }
                }
            }
            let resource: HostResourceReport | undefined;
            if (host) {
                try { resource = await host.waitForResourceRelease(); } catch { this.closeIssues.add('RESOURCE_RELEASE_FAILED'); }
                if (!resource?.resourcesReleased || resource.issues.length) this.closeIssues.add('RESOURCE_RELEASE_FAILED');
            }
            if (this.lease) {
                const healthy = returned === this.lease.worker && !!resource?.resourcesReleased && this.closeIssues.size === 0;
                try {
                    this.leaseResult = await (leaseRelease ?? this.lease.release(healthy));
                    if (this.leaseResult.issue) this.closeIssues.add('RESOURCE_RELEASE_FAILED');
                } catch { this.closeIssues.add('RESOURCE_RELEASE_FAILED'); }
            }
            let ownedPool: WorkerPoolReport | undefined;
            if (ownedDestroy) {
                try { ownedPool = await ownedDestroy;if (ownedPool.issues.length) this.closeIssues.add('RESOURCE_RELEASE_FAILED'); }
                catch { this.closeIssues.add('RESOURCE_RELEASE_FAILED'); }
            }
            const resourcesReleased = (!host || resource?.resourcesReleased === true) && (!this.lease || !!this.leaseResult) && (!this.ownsPool || ownedPool?.state === 'closed');
            const ok = resourcesReleased && this.closeIssues.size === 0 && (!resource || resource.storage.support !== 'managed' || resource.storage.lifecycle?.ok === true && !resource.storage.unsafe);
            this.finalReport = Object.freeze({ state: 'settled', intent, ok, resourcesReleased,
                ...(resource ? { host: resource } : {}), ...(this.leaseResult ? { lease: this.leaseResult } : {}), ...(ownedPool ? { ownedPool } : {}),
                issues: Object.freeze([...this.closeIssues]) });
            return this.finalReport;
        });
        return this.cleanupPromise;
    }
    close(): Promise<void> {
        const cleanup = this.beginCleanup(this.intent ?? 'close');
        if (!this.closeVoidPromise) {
            this.closeVoidPromise = cleanup.then(report => { if (!report.ok) throw lifecycleError('SANDBOX_CLOSE_FAILED', report); });
            void this.closeVoidPromise.catch(() => {});
        }
        return this.closeVoidPromise;
    }
    delete(): Promise<void> {
        if (this.intent === 'close') return Promise.reject(lifecycleError('LIFECYCLE_CONFLICT'));
        this.beginCleanup('delete');return this.close();
    }
    disposeAsync(): Promise<SandboxCloseReport> { return this.beginCleanup(this.intent ?? 'close'); }

    /**
     * 发送外部事件
     */
    async sendExternalEvent(
        viewId: ViewID,
        eventType: string,
        data: Record<string, unknown>
    ): Promise<void> {
        this.ensureNotClosed();
        if (!this.workerHost) {
            throw new AOTUIError('WORKER_NOT_STARTED', { appId: this.appId });
        }
        await this.workerHost.sendExternalEvent(viewId, eventType, data);
    }

    // ════════════════════════════════════════════════════════════════
    //  [RFC-011] LLM Output Channel
    // ════════════════════════════════════════════════════════════════

    /**
     * [RFC-011] Push LLM text to Worker
     * [RFC-020] Now accepts structured payload { reasoning?, content? }
     */
    pushLLMOutput(
        payload: { reasoning?: string; content?: string },
        type: 'complete',
        meta?: Pick<LLMOutputEventMeta, 'model' | 'providerId' | 'modelId' | 'usage'>
    ): void {
        if (this.intent) return;
        if (!this.workerHost) {
            console.warn(`[WorkerSandbox] Cannot push LLM text: Worker not started for ${this.appId}`);
            return;
        }
        this.workerHost.pushLLMOutput(payload, type, meta);
    }



    // ════════════════════════════════════════════════════════════════
    //  Internal
    // ════════════════════════════════════════════════════════════════

    private ensureNotClosed(): void {
        if (this.intent) throw lifecycleError('SANDBOX_CLOSED');
    }
}
