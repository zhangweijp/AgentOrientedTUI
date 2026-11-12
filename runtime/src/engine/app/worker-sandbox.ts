/**
 * WorkerSandbox - Worker 隔离的 App 执行与资源生命周期所有者。
 * App 运行在独立 Worker Thread 中，交互通过 IPC 进行。
 * @module @aotui/runtime/engine/app-sandbox
 */

import type { AppID, DesktopID, ViewID } from '../../spi/index.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { LLMOutputEventMeta } from '../../spi/core/llm-output.js';
import { AppWorkerHost, type HostResourceReport } from './worker-host.js';
import type { WorkerCapacity } from './worker-capacity.js';
import type { StateStorageBackend } from './state-storage-host.js';
import { appInteractionUnavailable, type AppInteractionOptions, type AppInteractionResult } from '../../spi/runtime/app-interaction.interface.js';
import type { AppInteractionPolicy } from '../../core/invocation/app-interaction-types.js';
import { captureInteractionModes } from './interaction-config.js';

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
    workerCapacity?: WorkerCapacity;
    persistenceBackend?: StateStorageBackend;
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
 * WorkerSandbox - 管理一个 App 实例的 Host 和关闭流程。
 */
export interface SandboxCloseReport {
    readonly state: 'active' | 'closing' | 'settled'; readonly intent: null | 'close' | 'delete';
    readonly ok: boolean; readonly resourcesReleased: boolean;
    readonly host?: HostResourceReport;
    readonly issues: readonly ('INSTALL_FAILED' | 'DELETE_FAILED' | 'APP_CLOSE_FAILED' | 'APP_CLOSE_DEADLINE_EXCEEDED' | 'RESOURCE_RELEASE_FAILED')[];
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
    private installPromise?: Promise<void>;
    private installSettled = false;
    private intent: 'close' | 'delete' | null = null;
    private cleanupPromise?: Promise<SandboxCloseReport>;
    private closeVoidPromise?: Promise<void>;
    private finalReport?: SandboxCloseReport;
    private releaseRetry?: Promise<SandboxCloseReport>;
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

    getAppInteraction(expectedInstanceId: string, policy?: AppInteractionPolicy): AppInteractionResult {
        const host = this.workerHost;
        const current = () => !this.intent && this._status === 'running' && !!host && this.workerHost === host && host.getStatus() === 'running';
        if (!current()) return appInteractionUnavailable();
        if (!expectedInstanceId || host!.appInstanceId !== expectedInstanceId) return appInteractionUnavailable('APP_INSTANCE_MISMATCH');
        const result = host!.getAppInteraction(policy);
        if (!current()) return appInteractionUnavailable();
        return result;
    }

    // ════════════════════════════════════════════════════════════════
    //  Lifecycle Methods
    // ════════════════════════════════════════════════════════════════

    /** 安装 App 并启动该实例专属的 Worker。 */
    installDynamic(): Promise<void> {
        if (this.intent) return Promise.reject(lifecycleError('SANDBOX_CLOSED'));
        if (this.installPromise) return this.installSettled ? Promise.reject(lifecycleError('SANDBOX_ALREADY_INSTALLED')) : this.installPromise;
        const current = () => { if (this.intent) throw lifecycleError('SANDBOX_CLOSED'); };
        this.installPromise = Promise.resolve().then(async () => {
            current();
            const host = this.workerHost = new AppWorkerHost(this.config);
            host.onUpdateRequest = () => { if (!this.intent && this.workerHost === host) this.onUpdateRequest?.(); };
            await host.start();current();await host.open();current();this._status = 'running';
        }).then(() => { this.installSettled = true; }, error => {
            this.installSettled = true;this.closeIssues.add('INSTALL_FAILED');this.beginCleanup('close');throw Object.defineProperty(lifecycleError('INSTALL_FAILED'), 'cause', { value: error });
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
            issues: Object.freeze([...this.closeIssues]) });
    }
    private beginCleanup(intent: 'close' | 'delete'): Promise<SandboxCloseReport> {
        if (this.cleanupPromise) return this.cleanupPromise;
        this.intent = intent;this._status = 'closed';
        const host = this.workerHost;
        let closing: Promise<void> | undefined;
        this.cleanupPromise = Promise.resolve().then(async () => {
            if (closing) {
                try { await closing; }
                catch (error) {
                    const code = (error as { code?: string })?.code;
                    this.closeIssues.add(code === 'APP_DELETE_FAILED' ? 'DELETE_FAILED' :
                        code === 'APP_CLOSE_DEADLINE_EXCEEDED' ? code : 'APP_CLOSE_FAILED');
                }
            }
            await this.installPromise?.catch(() => {});
            const resource = await host?.waitForResourceRelease();
            if (resource && (!resource.resourcesReleased || resource.issues.length)) this.closeIssues.add('RESOURCE_RELEASE_FAILED');
            return this.settle(resource);
        });
        closing = host?.close(intent);
        return this.cleanupPromise;
    }
    private settle(host?: HostResourceReport): SandboxCloseReport {
        const resourcesReleased = host?.resourcesReleased ?? true;
        const ok = resourcesReleased && this.closeIssues.size === 0 &&
            (!host || host.storage.support !== 'managed' || host.storage.lifecycle?.ok === true && !host.storage.unsafe);
        return this.finalReport = Object.freeze({ state: 'settled', intent: this.intent, ok, resourcesReleased,
            ...(host ? { host } : {}), issues: Object.freeze([...this.closeIssues]) });
    }
    retryResourceRelease(): Promise<SandboxCloseReport> {
        if (this.releaseRetry) return this.releaseRetry;
        const report = this.finalReport;
        if (!report?.host?.storage.ownerRetained) return this.disposeAsync().then(initial => this.finalReport ?? initial);
        this.releaseRetry = this.workerHost!.retryResourceRelease().then(host => this.settle(host)).finally(() => {
            this.releaseRetry = undefined;
        });
        return this.releaseRetry;
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
