import type { DesktopID } from '@aotui/core';
import { createDesktopId } from '../spi/core/id-factory.js';
import type { IKernel, IDesktop, ReinitializeDesktopAppsOptions, ReinitializeDesktopAppsResult } from '../spi/runtime/kernel.interface.js';
import { RUNTIME_DEFAULTS, type RuntimeConfig } from '../spi/config/index.js';
import { Desktop } from '../engine/core/desktop.js';
import { WorkerCapacity } from '../engine/app/worker-capacity.js';
import type { StateStorageBackend } from '@aotui/core/internal';
import { AOTUIError } from '@aotui/core';
import type { DesktopCloseOptions, DesktopCloseHandle, DesktopCloseReport, RuntimeCloseHandle, RuntimeCloseReport, ShutdownOptions } from '../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, closeTimeout, closeVoid, createCloseHandle, displayCloseId, freezeClose, mergeCloseReport, newCloseState, snapshotClose } from '../engine/core/close-handle.js';
import { appInstallFields, captureOptions } from '../engine/app/interaction-config.js';
import { appInteractionUnavailable, type AppInteractionResult } from '../spi/runtime/app-interaction.interface.js';
import type { AppInteractionPolicy } from '@aotui/core';

export class Kernel implements IKernel {
    private readonly desktops = new Map<DesktopID, Desktop>();
    private readonly workerCapacity: WorkerCapacity;
    private shutdownPromise: Promise<void> | null = null;
    private closing?: RuntimeCloseHandle;
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly shutdownTargets = new Map<Desktop, DesktopCloseHandle | undefined>();
    private readonly closeState = newCloseState('runtime');

    constructor(private readonly config: RuntimeConfig = RUNTIME_DEFAULTS, private readonly storageBackend?: StateStorageBackend) {
        this.workerCapacity = new WorkerCapacity(config.worker.maxWorkers);
    }

    private assertRuntimeAvailable(): void {
        if (this.closing) throw new AOTUIError('RUNTIME_SHUTDOWN');
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
    private assertDesktopAvailable(desktop: IDesktop): void {
        if (desktop.isClosing)
            throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: desktop.id });
    }
    private acceptsDesktopDiagnostics(desktop: IDesktop, desktopId: DesktopID): boolean {
        return !this.closing && this.desktops.get(desktopId) === desktop && !desktop.isClosing;
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
     * @returns The unique identifier of the created Desktop
     */
    createDesktop(desktopId?: DesktopID): Promise<DesktopID> { return this.business(() => this.createDesktopAccepted(desktopId)); }
    private async createDesktopAccepted(desktopId?: DesktopID): Promise<DesktopID> {
        const desktop = await this.createDesktopInstance(desktopId);
        if (this.closing) {
            await this.startDesktopShutdown(desktop)?.completion.catch(() => {});
            throw new AOTUIError('RUNTIME_SHUTDOWN');
        }
        this.assertDesktopAvailable(desktop);
        return desktop.id;
    }
    private createDesktopInstance(id?: DesktopID): Desktop {
        const key = id ?? createDesktopId();
        if (this.desktops.has(key)) throw closeError('DESKTOP_ALREADY_EXISTS');
        const desktop = new Desktop(key, {
            runtimeConfig: this.config, workerCapacity: this.workerCapacity, storageBackend: this.storageBackend,
            onResourcesReleased: released => {
                if (this.desktops.get(key) === released) this.desktops.delete(key);
            },
        });
        this.desktops.set(key, desktop);
        return desktop;
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
        const desktop = this.desktops.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        return desktop;
    }

    getAppInteraction(desktopId: DesktopID, appId: string, expectedInstanceId: string, policy?: AppInteractionPolicy): AppInteractionResult {
        const desktop = this.desktops.get(desktopId);
        const current = () => !!desktop && this.acceptsDesktopDiagnostics(desktop, desktopId);
        if (!current()) return appInteractionUnavailable();
        const create = desktop!.getAppInteraction;
        if (!current()) return appInteractionUnavailable();
        const result = create.call(desktop, appId, expectedInstanceId, policy);
        if (!current()) return appInteractionUnavailable();
        return result;
    }

    /**
     * [Worker-Only] 安装 App
     * 
     */
    installDynamicWorkerApp(desktopId: DesktopID, appModulePath: string, options?: Parameters<IKernel['installDynamicWorkerApp']>[2]): Promise<string> {
        try {
            const captured = captureOptions(options, appInstallFields);
            return this.business(() => this.installDynamicWorkerAppAccepted(desktopId, appModulePath, captured));
        } catch (error) { return Promise.reject(error); }
    }
    private async installDynamicWorkerAppAccepted(
        desktopId: DesktopID,
        appModulePath: string,
        options?: Parameters<IKernel['installDynamicWorkerApp']>[2]
    ): Promise<string> {
        this.assertRuntimeAvailable();
        const desktop = this.getDesktop(desktopId);
        this.assertDesktopAvailable(desktop);
        return desktop.installDynamicWorkerApp(appModulePath, options);
    }

    reinitializeDesktopApps(desktopId: DesktopID, options?: ReinitializeDesktopAppsOptions): Promise<ReinitializeDesktopAppsResult> { return this.business(() => this.reinitializeDesktopAppsAccepted(desktopId, options)); }
    private async reinitializeDesktopAppsAccepted(
        desktopId: DesktopID,
        options?: ReinitializeDesktopAppsOptions
    ): Promise<ReinitializeDesktopAppsResult> {
        this.assertRuntimeAvailable();
        const desktop = this.getDesktop(desktopId);

        this.assertDesktopAvailable(desktop);return desktop.reinitializeApps(options);
    }

    deleteDesktop(desktopId: DesktopID): Promise<void> {
        try { return closeVoid(this.beginDesktopClose(desktopId, { intent: 'delete' }).completion, 'DESKTOP_CLOSE_FAILED'); }
        catch (error) { return Promise.reject(error); }
    }

    beginDesktopShutdown(desktopId: DesktopID, options?: ShutdownOptions): DesktopCloseHandle { return this.beginDesktopClose(desktopId, options); }

    private beginDesktopClose(desktopId: DesktopID, options?: DesktopCloseOptions): DesktopCloseHandle {
        const desktop = this.desktops.get(desktopId);
        if (desktop) return desktop.beginClose(options);
        closeTimeout(options);
        const callback = options?.beforeClose, intent = options?.intent ?? 'close';
        if (intent !== 'close' && intent !== 'delete' || callback !== undefined && typeof callback !== 'function') throw closeError('CLOSE_OPTIONS_INVALID');
        const state = newCloseState('desktop', intent);
        state.state = 'settled';
        const report: DesktopCloseReport = freezeClose({ ...snapshotClose(state), scope: 'desktop',
            intent, desktopId: displayCloseId(desktopId), found: false });
        return createCloseHandle(() => report, Promise.resolve(report));
    }

    private startDesktopShutdown(desktop: Desktop): DesktopCloseHandle | undefined {
        if (this.shutdownTargets.has(desktop)) return this.shutdownTargets.get(desktop);
        this.shutdownTargets.set(desktop, undefined);
        try {
            const handle = desktop.beginClose();
            this.shutdownTargets.set(desktop, handle);
            return handle;
        } catch {
            const state = this.closeState;
            state.resourcesReleased = false;
            state.desktops.accepted++;
            state.desktops.settled++;
            state.desktops.notVerifiedReleased++;
            addCloseFailure(state, 'admission', ['DESKTOP_CLEANUP_FAILED'], { desktopId: desktop.id });
        }
    }

    private report(): RuntimeCloseReport {
        const state = structuredClone(this.closeState);
        for (const handle of this.shutdownTargets.values()) if (handle) mergeCloseReport(state, handle.inspect());
        state.pendingTasks = this.inFlight.size;
        const workers = this.workerCapacity.getReport();
        state.workers = { ownership: 'owned', report: workers };
        state.resourcesReleased &&= state.pendingTasks === 0 && workers.state === 'closed';
        return freezeClose({ ...snapshotClose(state), scope: 'runtime' as const, intent: 'close' as const });
    }

    beginShutdown(): RuntimeCloseHandle {
        if (this.closing) return this.closing;
        let complete!: (value: RuntimeCloseReport) => void;
        const completion = new Promise<RuntimeCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseHandle(() => this.report(), completion);
        // Snapshot accepted calls after synchronously stopping admission.
        const accepted = [...this.inFlight];
        const capacity = this.workerCapacity.close();
        for (const desktop of [...this.desktops.values()]) this.startDesktopShutdown(desktop);
        void (async () => {
            await Promise.allSettled([capacity, ...accepted]);
            await Promise.all([...this.shutdownTargets].map(async ([desktop, handle]) => {
                if (!handle) return;
                try { await handle.completion; }
                catch {
                    this.closeState.resourcesReleased = false;
                    addCloseFailure(this.closeState, 'admission', ['DESKTOP_CLEANUP_FAILED'], { desktopId: desktop.id });
                }
            }));
            for (const handle of this.shutdownTargets.values()) if (handle) mergeCloseReport(this.closeState, handle.inspect());
            this.shutdownTargets.clear();
            this.closeState.state = 'settled';
            complete(this.report());
        })();
        return this.closing;
    }

    shutdown(): Promise<void> { return this.shutdownPromise ??= closeVoid(this.beginShutdown().completion, 'RUNTIME_CLOSE_FAILED'); }
}
