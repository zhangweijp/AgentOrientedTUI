import { WorkerPool } from '../app/worker-pool.js';
/**
 * Engine Layer - Desktop Manager Implementation
 * 
 * 管理 Desktop 实例的生命周期和并发控制。
 * 
 * @module @aotui/runtime/engine/desktop-manager
 */

import type {
    IDesktopManager,
    DesktopID,
    AppState,
    DesktopStatus,
    IDesktop,
    IRuntimeContext, // New
} from '../../spi/index.js';
import { AOTUIError } from '../../spi/core/errors.js';
import { Desktop } from './desktop.js';
import type { DesktopCloseOptions, DesktopCloseHandle, DesktopCloseReport, RuntimeCloseHandle, RuntimeCloseReport } from '../../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, closeTimeout, closeVoid, createCloseHandle, displayCloseId, freezeClose, mergeCloseReport, newCloseState, snapshotClose } from './close-handle.js';

// ============================================================================
// Desktop Manager Implementation
// ============================================================================

/**
 * Desktop 管理器实现
 * 
 * 封装 Desktop 的创建、存储和生命周期控制。
 * Kernel 通过 IDesktopManager 接口与之交互，实现依赖反转。
 * 
 * @example
 * ```typescript
 * const manager = new DesktopManager();
 * const desktopId = await manager.create();
 * const desktop = manager.get(desktopId);
 * ```
 */
import { RuntimeConfig, RUNTIME_DEFAULTS } from '../../spi/config/index.js';

export class DesktopManager implements IDesktopManager {
    private desktops = new Map<DesktopID, Desktop>();
    private config: RuntimeConfig;
    private readonly workerPool: WorkerPool;
    private closing?: RuntimeCloseHandle;
    private shutdownPromise?: Promise<void>;
    private phase: 'active' | 'closing' | 'settled' = 'active';
    private closeState = newCloseState('runtime');
    private closeTargets?: Map<Desktop, DesktopCloseHandle>;
    private readonly capturedClosures = new WeakSet<Desktop>();
    private readonly removing = new Set<Promise<void>>();

    private assertActive(): void { if (this.phase !== 'active') throw new AOTUIError('RUNTIME_SHUTDOWN'); }

    constructor(config?: RuntimeConfig) {
        this.config = config ?? RUNTIME_DEFAULTS;
        this.workerPool = new WorkerPool({ ...this.config.worker.pool });
    }

    // ─────────────────────────────────────────────────────────────
    //  Desktop 创建与持有
    // ─────────────────────────────────────────────────────────────


    async create(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID> {
        this.assertActive();
        if (desktopId !== undefined && this.desktops.has(desktopId)) throw closeError('DESKTOP_ALREADY_EXISTS');
        const desktop = new Desktop(desktopId, { runtimeConfig: this.config, context, workerPool: this.workerPool });
        if (this.desktops.has(desktop.id)) { void desktop.dispose().catch(() => {});throw closeError('DESKTOP_ALREADY_EXISTS'); }
        this.desktops.set(desktop.id, desktop);
        return desktop.id;
    }

    beginDesktopShutdown(desktopId: DesktopID, options?: DesktopCloseOptions): DesktopCloseHandle {
        closeTimeout(options);
        const desktop = this.desktops.get(desktopId);
        if (!desktop) {
            const state = newCloseState('desktop', options?.intent ?? 'close');state.state = 'settled';
            const report: DesktopCloseReport = freezeClose({ ...snapshotClose(state), scope: 'desktop', intent: options?.intent ?? 'close', desktopId: displayCloseId(desktopId), found: false });
            return createCloseHandle(() => report, Promise.resolve(report));
        }
        const handle = desktop.beginClose(options);
        // Capture the actual object. A late completion can never remove a successor.
        if (!this.capturedClosures.has(desktop)) {
            this.capturedClosures.add(desktop);
            const removing = handle.completion.then(report => {
                if (report.resourcesReleased && this.desktops.get(desktopId) === desktop) {
                    this.desktops.delete(desktopId);
                }
            }).catch(() => { addCloseFailure(this.closeState, 'manager', ['MANAGER_CLEANUP_FAILED'], { desktopId });this.closeState.resourcesReleased = false; });
            this.removing.add(removing);void removing.then(() => this.removing.delete(removing));
        }
        return handle;
    }

    get(desktopId: DesktopID): IDesktop | undefined {
        return this.desktops.get(desktopId);
    }

    listDesktopIds(): DesktopID[] {
        return Array.from(this.desktops.keys());
    }

    // ─────────────────────────────────────────────────────────────
    //  当前状态查询
    // ─────────────────────────────────────────────────────────────

    getAppStates(desktopId: DesktopID): AppState[] {
        const desktop = this.desktops.get(desktopId);
        return desktop?.getAppStates() ?? [];
    }

    getDesktopInfo(desktopId: DesktopID): { status: DesktopStatus; createdAt: number } | undefined {
        const desktop = this.desktops.get(desktopId);
        if (!desktop) return undefined;

        return {
            status: desktop.status,
            createdAt: desktop.createdAt
        };
    }

    // ─────────────────────────────────────────────────────────────
    //  Desktop 生命周期
    // ─────────────────────────────────────────────────────────────

    async suspend(desktopId: DesktopID): Promise<void> {
        const desktop = this.getDesktopOrThrow(desktopId);
        await desktop.suspend();
    }

    async resume(desktopId: DesktopID): Promise<void> {
        const desktop = this.getDesktopOrThrow(desktopId);
        await desktop.resume();
    }

    private report(): RuntimeCloseReport {
        const state = structuredClone(this.closeState);state.state = this.phase;
        for (const handle of this.closeTargets?.values() ?? []) mergeCloseReport(state, handle.inspect());
        const pool = this.workerPool.getReport();state.pool = { ownership: 'owned', report: { ...pool, issues: [...pool.issues] } };
        state.resourcesReleased &&= pool.state === 'closed';
        addCloseFailure(state, 'pool', pool.issues);
        return freezeClose({ ...snapshotClose(state), scope: 'runtime' as const, intent: 'close' as const });
    }
    beginShutdown(): RuntimeCloseHandle {
        if (this.closing) return this.closing;
        this.phase = 'closing';this.closeTargets = new Map();
        let complete!: (report: RuntimeCloseReport) => void;
        const completion = new Promise<RuntimeCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseHandle(() => this.report(), completion);
        const pool = this.workerPool.destroy();
        // Every Desktop is started synchronously before any completion is awaited.
        for (const [id, desktop] of this.desktops) {
            try { this.closeTargets.set(desktop, this.beginDesktopShutdown(id)); }
            catch { this.closeState.resourcesReleased = false;addCloseFailure(this.closeState, 'apps', ['MANAGER_CLEANUP_FAILED'], { desktopId: id }); }
        }
        void (async () => {
            await Promise.allSettled([pool, ...this.closeTargets!.values()].map(value => value instanceof Promise ? value : value.completion));
            await Promise.allSettled([...this.removing]);
            const folded = structuredClone(this.closeState);
            for (const handle of this.closeTargets!.values()) mergeCloseReport(folded, handle.inspect());
            this.closeTargets = undefined;this.closeState = folded;
            this.phase = 'settled';complete(this.report());
        })();
        return this.closing;
    }
    shutdown(): Promise<void> { return this.shutdownPromise ??= closeVoid(this.beginShutdown().completion, 'RUNTIME_CLOSE_FAILED'); }

    // ─────────────────────────────────────────────────────────────
    //  Internal Helpers
    // ─────────────────────────────────────────────────────────────

    /**
     * 获取 Desktop 或抛出 E_NOT_FOUND 错误
     */
    private getDesktopOrThrow(desktopId: DesktopID): Desktop {
        this.assertActive();
        const desktop = this.desktops.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        return desktop;
    }
}
