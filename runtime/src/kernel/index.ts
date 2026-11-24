import type { DesktopID } from '@aotui/core';
import { createDesktopId } from '../spi/core/id-factory.js';
import type { CreateDesktopOptions, IKernel, IDesktop } from '../spi/runtime/kernel.interface.js';
import { RUNTIME_DEFAULTS, type RuntimeConfig } from '../spi/config/index.js';
import { Desktop } from '../engine/core/desktop.js';
import { WorkerCapacity } from '../engine/app/worker-capacity.js';
import type { StateStorageBackend } from '@aotui/core/persistence';
import { AOTUIError } from '@aotui/core';
import type { DesktopCloseHandle, RuntimeCloseHandle, RuntimeCloseReport } from '../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, createCloseHandle, mergeCloseReport, newCloseState, snapshotClose } from '../engine/core/close-handle.js';
import { captureOptions } from '../engine/app/interaction-config.js';

export class Kernel implements IKernel {
    private readonly desktops = new Map<DesktopID, Desktop>();
    private readonly workerCapacity: WorkerCapacity;
    private closing?: RuntimeCloseHandle;
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly closingDesktops = new Map<Desktop, DesktopCloseHandle | undefined>();
    private readonly closeState = newCloseState('runtime');

    constructor(private readonly config: RuntimeConfig = RUNTIME_DEFAULTS, private readonly storageBackend?: StateStorageBackend) {
        this.workerCapacity = new WorkerCapacity(config.worker.maxWorkers);
    }

    private assertRuntimeAvailable(): void {
        if (this.closing) throw new AOTUIError('RUNTIME_SHUTDOWN');
    }

    private assertDesktopAvailable(desktop: IDesktop): void {
        if (desktop.isClosing)
            throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: desktop.id });
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
     * @returns The newly owned Desktop
     */
    createDesktop(options?: DesktopID | CreateDesktopOptions): Promise<IDesktop> {
        try {
            this.assertRuntimeAvailable();
            if (this.inFlight.size >= 128) throw closeError('LIFECYCLE_CAPACITY_EXCEEDED');
        } catch (error) { return Promise.reject(error); }
        let resolve!: (desktop: IDesktop) => void, reject!: (error: unknown) => void;
        const promise = new Promise<IDesktop>((yes, no) => { resolve = yes; reject = no; });
        this.inFlight.add(promise);
        void this.createDesktopAccepted(options).then(
            desktop => { this.inFlight.delete(promise); resolve(desktop); },
            error => { this.inFlight.delete(promise); reject(error); },
        );
        void promise.catch(() => {});
        return promise;
    }
    private async createDesktopAccepted(options?: DesktopID | CreateDesktopOptions): Promise<IDesktop> {
        const input = typeof options === 'string' ? { id: options } : captureOptions(options, { id: 'string', policyForApp: 'function' });
        const desktop = await this.createDesktopInstance(input?.id, input?.policyForApp);
        if (this.closing) {
            await this.startDesktopClose(desktop)?.completion.catch(() => {});
            throw new AOTUIError('RUNTIME_SHUTDOWN');
        }
        this.assertDesktopAvailable(desktop);
        return desktop;
    }
    private createDesktopInstance(id?: DesktopID, policyForApp?: CreateDesktopOptions['policyForApp']): Desktop {
        this.assertRuntimeAvailable();
        const key = id ?? createDesktopId();
        if (this.desktops.has(key)) throw closeError('DESKTOP_ALREADY_EXISTS');
        const desktop = new Desktop(key, {
            runtimeConfig: this.config, workerCapacity: this.workerCapacity, storageBackend: this.storageBackend, policyForApp,
            onResourcesReleased: released => {
                if (this.desktops.get(key) === released) this.desktops.delete(key);
            },
        });
        this.desktops.set(key, desktop);
        return desktop;
    }

    /**
     * Gets a Desktop instance for direct lifecycle and output access.
     * @throws {AOTUIError} DESKTOP_NOT_FOUND if the Desktop does not exist.
     */
    getDesktop(desktopId: DesktopID): IDesktop {
        const desktop = this.desktops.get(desktopId);
        if (!desktop) {
            throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId });
        }
        return desktop;
    }

    private startDesktopClose(desktop: Desktop, retry = false): DesktopCloseHandle | undefined {
        if (!retry && this.closingDesktops.has(desktop)) return this.closingDesktops.get(desktop);
        this.closingDesktops.set(desktop, undefined);
        try {
            const handle = desktop.beginClose();
            this.closingDesktops.set(desktop, handle);
            return handle;
        } catch {
            addCloseFailure(this.closeState, 'admission', ['DESKTOP_CLEANUP_FAILED'], { desktopId: desktop.id });
        }
    }

    private report(): RuntimeCloseReport {
        const state = structuredClone(this.closeState);
        for (const handle of this.closingDesktops.values()) {
            if (handle) mergeCloseReport(state, handle.inspect());
            else {
                state.desktops.accepted++;
                state.desktops.settled++;
                state.desktops.notVerifiedReleased++;
                state.resourcesReleased = false;
            }
        }
        state.pendingTasks = this.inFlight.size;
        const workers = this.workerCapacity.getReport();
        state.workers = { ownership: 'owned', report: workers };
        state.resourcesReleased &&= state.pendingTasks === 0 && workers.state === 'closed';
        return snapshotClose({ ...state, scope: 'runtime' });
    }

    beginClose(): RuntimeCloseHandle {
        const previous = this.closing;
        if (previous && (this.closeState.state !== 'settled' || previous.inspect().resourcesReleased)) return previous;
        this.closeState.state = 'closing';
        let complete!: (value: RuntimeCloseReport) => void;
        const completion = new Promise<RuntimeCloseReport>(resolve => { complete = resolve; });
        this.closing = createCloseHandle(() => this.report(), completion);
        // Stop admission before visiting any owner. Accepted creates can add their own Desktop during the wait.
        const accepted = previous ? [] : [...this.inFlight];
        const capacity = this.workerCapacity.close();
        const desktops = previous ? this.closingDesktops.keys() : this.desktops.values();
        for (const desktop of [...desktops]) this.startDesktopClose(desktop, !!previous);
        void (async () => {
            await Promise.allSettled([capacity, ...accepted]);
            await Promise.all([...this.closingDesktops].map(async ([desktop, handle]) => {
                if (!handle) return;
                try {
                    const report = await handle.completion;
                    if (report.resourcesReleased) {
                        mergeCloseReport(this.closeState, report);
                        this.closingDesktops.delete(desktop);
                    }
                } catch { addCloseFailure(this.closeState, 'admission', ['DESKTOP_CLEANUP_FAILED'], { desktopId: desktop.id }); }
            }));
            this.closeState.state = 'settled';
            complete(this.report());
        })();
        return this.closing;
    }
}
