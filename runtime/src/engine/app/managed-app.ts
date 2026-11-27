import { AppWorkerHost, type AppWorkerHostConfig } from './worker-host.js';
import { appInteractionUnavailable } from '../../spi/runtime/app-interaction.interface.js';
import type { AppCloseHandle, AppCloseReport } from '../../spi/runtime/close.interface.js';
import type { UpdateSignal } from '../../spi/core/signals.js';
import { closeError, createCloseHandle, displayCloseId, newCloseState, recordAppClose, snapshotClose } from '../core/close-handle.js';

/** Owns the lifetime and close handle for one accepted App launch. */
export class ManagedApp {
    private readonly host: AppWorkerHost;
    private readonly issues = new Set<AppCloseReport['failures'][number]['codes'][number]>();
    private closeHandle?: AppCloseHandle;
    private settled = false;
    onUpdate?: (reason: UpdateSignal['reason']) => void;

    constructor(config: AppWorkerHostConfig, private readonly onClosing: () => void, private onReleased?: () => void) {
        this.host = new AppWorkerHost(config);
        this.host.onUpdate = reason => { if (!this.closeHandle || reason === 'app_runtime_changed') this.onUpdate?.(reason); };
    }

    get appId() { return this.host.appId; }
    get appInstanceId() { return this.host.appInstanceId; }
    get timeout() { return this.host.timeout; }
    get status() { return this.host.getStatus(); }
    get isClosing() { return !!this.closeHandle; }
    readRunFacts() { return this.host.readRunFacts(); }
    get windowActions() { return !this.closeHandle && this.status === 'running' ? this.host : undefined; }

    getAppInteraction(expectedInstanceId: string) {
        if (this.closeHandle) return appInteractionUnavailable();
        if (this.appInstanceId !== expectedInstanceId) return appInteractionUnavailable('APP_INSTANCE_MISMATCH');
        return this.host.getAppInteraction();
    }

    prepareObservation(prepare: Parameters<AppWorkerHost['prepareObservation']>[0]) {
        return this.host.prepareObservation(prepare);
    }

    preview() { return this.host.preview(); }

    async start(): Promise<void> {
        await this.host.start();
        if (this.closeHandle) throw closeError('APP_MANAGER_CLOSED');
        await this.host.open();
        if (this.closeHandle) throw closeError('APP_MANAGER_CLOSED');
    }

    closeFailedStartup(): AppCloseHandle {
        if (this.closeHandle) return this.closeHandle;
        this.issues.add('INSTALL_FAILED');
        return this.beginClose();
    }

    beginClose(): AppCloseHandle {
        const previous = this.closeHandle;
        if (previous && (!this.settled || previous.inspect().resourcesReleased)) return previous;
        this.settled = false;
        // Publish the handle before stopping the Worker or notifying Desktop.
        let closing: Promise<void> | undefined;
        const completion = Promise.resolve().then(async () => {
            if (closing) try { await closing; }
            catch (error) {
                const code = (error as { code?: string })?.code;
                this.issues.add(code === 'APP_CLOSE_DEADLINE_EXCEEDED' || code === 'APP_UNMOUNT_FAILED'
                    ? code : 'APP_CLOSE_FAILED');
            }
            try {
                const resource = await this.host.waitForReleaseAttempt();
                if (!resource.resourcesReleased) this.issues.add('RESOURCE_RELEASE_FAILED');
            } catch { this.issues.add('RESOURCE_RELEASE_FAILED'); }
            this.settled = true;
            const report = this.report();
            if (report.resourcesReleased) {
                const released = this.onReleased;
                this.onReleased = undefined;
                released?.();
            }
            return report;
        });
        this.closeHandle = createCloseHandle(() => this.report(), completion);
        if (!previous) {
            closing = this.host.close();
            this.onClosing();
        } else this.host.retryRelease();
        return this.closeHandle;
    }

    private report(): AppCloseReport {
        const host = this.host.getResourceReport(), state = newCloseState('app');
        state.state = this.settled ? 'settled' : 'closing';
        const desktopId = displayCloseId(this.host.desktopId), appId = displayCloseId(this.appId);
        recordAppClose(state, host, { desktopId, appId }, this.issues);
        return snapshotClose({ ...state, scope: 'app', desktopId, appId,
            instanceId: this.appInstanceId, worker: host.worker,
            ...(host.appCleanup?.report ? { appCleanupReport: host.appCleanup.report } : {}),
            ...(host.closingInvocation ? { closingInvocation: host.closingInvocation } : {}) });
    }
}
