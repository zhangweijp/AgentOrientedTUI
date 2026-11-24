import type { StateStorageBackend } from '@aotui/core/persistence';
import type { ManagedApp } from '../app/managed-app.js';
import type { WorkerCapacity } from '../app/worker-capacity.js';
import type { ActiveTurn as CoreTurn, DesktopID, AppID } from '@aotui/core';
import type { UpdateSignal } from '../../spi/core/signals.js';
import type { ActiveTurn, AdoptTurnResult, CreateDesktopOptions, IDesktop, AppDiscoveryInfo, OpenAppOptions, ReceiptAccess, ReceiptLocator,
    RunningApp, RunningAppResult } from '../../spi/runtime/kernel.interface.js';
import { AOTUIError } from '@aotui/core';
import { SignalBus, type SignalListener } from './signal-bus.js';
import type { AppCloseHandle, DesktopCloseHandle, DesktopCloseReport } from '../../spi/runtime/close.interface.js';
import { addCloseFailure, closeError, createCloseHandle, displayCloseId, mergeCloseReport, newCloseState, snapshotClose } from './close-handle.js';
import { DesktopLogger, type LogEntry } from './desktop-logger.js';
import { AppManager } from '../app/manager.js';
import { RUNTIME_DEFAULTS, type RuntimeConfig } from '../../spi/config/index.js';
import { appInteractionUnavailable, type WorkerInteraction } from '../../spi/runtime/app-interaction.interface.js';
import type { ReceiptQuery, TurnSelection } from '@aotui/core';
import type { AppWindowTarget, ViewWindowTarget } from '../../spi/runtime/windows.js';
import { createTurnCoordinator } from '@aotui/core/host';
import { appInteractionFields, captureOptions } from '../app/interaction-config.js';
import { readAppManifest } from '../app/manifest.js';


export interface DesktopOptions {
    workerCapacity?: WorkerCapacity;
    storageBackend?: StateStorageBackend;
    policyForApp?: CreateDesktopOptions['policyForApp'];
    onResourcesReleased?: (desktop: Desktop) => void;
    /** 使用外部 AppManager (默认创建内部实例) */
    appManager?: AppManager;
    runtimeConfig?: RuntimeConfig;
}

export class Desktop implements IDesktop {
    private closeHandle?: DesktopCloseHandle;
    private onResourcesReleased?: (desktop: Desktop) => void;
    private readonly closeState = newCloseState('desktop');
    private readonly closingApps = new Map<ManagedApp, AppCloseHandle>();
    private readonly signalBus = new SignalBus();
    private readonly logger: DesktopLogger;

    // Use injected AppManager or create internal instance
    private readonly appManager: AppManager;
    private readonly turns = createTurnCoordinator();
    private readonly managedTurns = new WeakMap<ActiveTurn, CoreTurn>();
    private readonly runningApps = new WeakMap<WorkerInteraction, RunningApp>();

    constructor(readonly id: DesktopID, options?: DesktopOptions) {
        const runtimeConfig = options?.runtimeConfig ?? RUNTIME_DEFAULTS;
        this.onResourcesReleased = options?.onResourcesReleased;
        this.logger = new DesktopLogger(runtimeConfig.logger.maxSystemLogs);

        this.appManager = options?.appManager || new AppManager(this, { workerCapacity: options?.workerCapacity,
            runtimeConfig, storageBackend: options?.storageBackend, policyForApp: options?.policyForApp,
            onAppClosing: () => this.turns.eligibilityChanged() });

        this.logSystem('Desktop initialized.');
    }

    get isClosing(): boolean { return !!this.closeHandle; }



    readonly output: IDesktop['output'] = Object.freeze({
        subscribe: (listener: SignalListener) => {
            this.assertActive();
            this.signalBus.subscribe(listener);
        },
        unsubscribe: (listener: SignalListener) => this.signalBus.unsubscribe(listener),
    });

    private assertActive(): void { if (this.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: this.id }); }

    // --- System Commands (App) ---

    async openApp(installationId: string, options?: OpenAppOptions): Promise<RunningApp> {
        this.assertActive();
        const input = captureOptions(options, { policy: 'object' });
        return this.openedApp(await this.appManager.openApp(installationId, input?.policy));
    }

    getAppWindows(appId: AppID, expectedInstanceId: string) {
        this.assertActive();
        return this.appManager.getAppWindows(appId, expectedInstanceId);
    }

    private requireTurn(turn: ActiveTurn) {
        const owned = this.managedTurns.get(turn);
        if (!owned?.isCurrent) throw closeError('TURN_NOT_ACTIVE');
        return owned;
    }

    revokeWindowAccess(turn: ActiveTurn, target: AppWindowTarget | ViewWindowTarget): void {
        this.assertActive();
        const owned = this.requireTurn(turn);
        const { appId, instanceId } = target;
        const windows = this.appManager.getAppWindows(appId, instanceId);
        if (!windows) throw closeError('APP_INSTANCE_CHANGED');
        const view = 'viewId' in target
            ? windows.views.find(view => view.viewId === target.viewId && view.viewInstanceId === target.viewInstanceId)
            : undefined;
        if ('viewId' in target && !view) throw closeError('VIEW_INSTANCE_REVOKED');
        const current = this.appManager.getAppInteraction(appId, instanceId);
        if (current.status === 'rejected') throw closeError('APP_INSTANCE_CHANGED');
        const problem = this.turns.revokeWindowAccess(owned, current.interaction, view);
        if (problem) throw closeError(problem.code);
    }

    async closeView(target: ViewWindowTarget, turn?: ActiveTurn) {
        this.assertActive();
        if (turn !== undefined) this.requireTurn(turn);
        this.turns.eligibilityChanged();
        return this.appManager.closeView(target, turn && (() => this.requireTurn(turn)));
    }

    // --- Core Methods ---

    /**
     * [Worker-Only] Install Dynamic Worker App
     * 
     * App runs in a dedicated Worker Thread via IPC.
     */
    async installDynamicWorkerApp(
        appModulePath: string,
        options?: Parameters<IDesktop['installDynamicWorkerApp']>[1],
    ): Promise<RunningApp> {
        this.assertActive();
        return this.openedApp(await this.appManager.install(appModulePath, options));
    }

    /** Discover and register a local package without starting a Worker. */
    async registerPendingApp(options: Parameters<IDesktop['registerPendingApp']>[0]): Promise<string> {
        const captured = captureOptions(options, { ...appInteractionFields, installationId: 'string', localPath: 'string', config: 'object' });
        if (!captured?.installationId || captured.installationId.trim() !== captured.installationId)
            throw new AOTUIError('CONFIG_INVALID', { path: 'options.installationId', reason: 'Provide a stable installation key' });
        if (!captured.localPath?.trim()) throw new AOTUIError('CONFIG_INVALID', { path: 'options.localPath', reason: 'Provide the local App path' });
        this.assertActive();
        const config = captured.config ?? {};
        const { metadata, modulePath, persistenceSupport } = await readAppManifest(captured.localPath);
        return this.appManager.registerPendingApp({
            installationId: captured.installationId,
            name: metadata.app_name,
            description: metadata.description,
            whatItIs: metadata.whatItIs,
            whenToUse: metadata.whenToUse,
            modulePath,
            manifestPersistence: persistenceSupport,
            config,
            toolsEnabled: captured.toolsEnabled,
            projectionLimits: captured.projectionLimits,
        });
    }
    // --- Lifecycle Methods ---

    /**
     * 获取已安装应用列表
     */
    listApps(): readonly AppDiscoveryInfo[] {
        return this.appManager.listApps();
    }

    private openedApp(started: Pick<RunningApp, 'appId' | 'instanceId'>): RunningApp {
        const result = this.getRunningApp(started.appId, started.instanceId);
        if (result.status === 'rejected') throw closeError(result.issue.code);
        return result.app;
    }

    getRunningApp(appId: string, expectedInstanceId: string): RunningAppResult {
        const manager = this.appManager;
        if (this.isClosing) return appInteractionUnavailable();
        const result = manager.getAppInteraction(appId, expectedInstanceId);
        if (result.status === 'rejected') return result;
        const current = () => !this.isClosing && manager.isRunningApp(appId, expectedInstanceId);
        const { interaction } = result;
        const existing = this.runningApps.get(interaction);
        if (existing) return Object.freeze({ status: 'ready', app: existing });
        const owner = manager.getManagedApp(appId as AppID);
        if (!owner) return appInteractionUnavailable();
        const desktopId = this.id;
        const app: RunningApp = Object.freeze({
            appId: appId as AppID, instanceId: expectedInstanceId,
            observe: () => this.turns.prepareObservation(interaction, current),
            preview: () => current() ? interaction.preview() : Promise.resolve(appInteractionUnavailable()),
            async readReceipt(query: ReceiptQuery, timeoutMs?: number) {
                const unavailable = () => Object.freeze({ kind: 'unavailable' as const, ...appInteractionUnavailable().issue });
                if (!current()) return unavailable();
                const result = await interaction.readReceipt(query, timeoutMs);
                if (!current()) return unavailable();
                if (result.kind !== 'receipt') return result;
                const { observationId, invocationId } = result.receipt;
                return Object.freeze({ ...result, locator: Object.freeze({
                    desktopId, appId: appId as AppID, instanceId: expectedInstanceId, observationId, invocationId,
                }) });
            },
            beginClose: () => owner.beginClose(),
        });
        this.runningApps.set(interaction, app);
        return Object.freeze({ status: 'ready', app });
    }

    adoptTurn(input: TurnSelection): AdoptTurnResult {
        const result = this.turns.adoptTurn(input);
        if (result.status === 'rejected') return result;
        const { turn } = result;
        const invoke: ActiveTurn['invoke'] = async (appId, request, timeoutMs, signal) => {
            const original = this.turns.locate(turn, appId);
            let requestedId: unknown;
            try { requestedId = Object.getOwnPropertyDescriptor(request, 'invocationId')?.value; }
            catch { /* Core reports a malformed invocation. */ }
            const invoked = await turn.invoke(appId, request, timeoutMs, signal);
            if (!original || invoked.kind === 'refused') return invoked;
            const invocationId = invoked.kind === 'receipt' ? invoked.receipt.invocationId : requestedId;
            if (typeof invocationId !== 'string') return invoked;
            const locator = Object.freeze({ desktopId: this.id, appId: appId as AppID, ...original, invocationId });
            return Object.freeze({ ...invoked, locator });
        };
        const active: ActiveTurn = Object.freeze({ invoke, get isCurrent() { return turn.isCurrent; },
            readConsoleInputs: turn.readConsoleInputs, inspectRef: turn.inspectRef, release: turn.release });
        this.managedTurns.set(active, turn);
        return Object.freeze({ ...result, turn: active });
    }

    async readReceipt(locator: ReceiptLocator, timeoutMs?: number): Promise<ReceiptAccess> {
        if (locator?.desktopId !== this.id) return Object.freeze({
            kind: 'unavailable', code: 'RECEIPT_LOCATOR_UNAVAILABLE', message: 'The receipt does not belong to this Desktop.',
        });
        const result = this.getRunningApp(locator.appId, locator.instanceId);
        if (result.status === 'rejected') return Object.freeze({ kind: 'unavailable', ...result.issue });
        return result.app.readReceipt({ observationId: locator.observationId, invocationId: locator.invocationId }, timeoutMs);
    }
    /**
     * Get System Logs (for <desktop> area)
     */
    getSystemLogs(): LogEntry[] {
        return this.logger.getSystemLogs();
    }

    /**
     * Log System Message
     */
    logSystem(message: string, level: LogEntry['level'] = 'info'): void {
        if (!this.isClosing) this.logger.logSystem(message, level);
    }

    private report(): DesktopCloseReport {
        const state = structuredClone(this.closeState);
        for (const handle of this.closingApps.values()) mergeCloseReport(state, handle.inspect());
        state.pendingTasks = this.appManager.pendingStarts;
        const released = state.resourcesReleased && !state.pendingTasks &&
            state.cleanup.signalBus === 'done' && state.cleanup.logger === 'done';
        state.resourcesReleased = released;
        const settled = Number(state.state === 'settled');
        state.desktops = { accepted: 1, settled, pending: 1 - settled, notVerifiedReleased: released ? 0 : 1 };
        return snapshotClose({ ...state, scope: 'desktop', desktopId: displayCloseId(this.id) });
    }

    beginClose(): DesktopCloseHandle {
        const previous = this.closeHandle;
        if (previous && (this.closeState.state !== 'settled' || previous.inspect().resourcesReleased)) return previous;
        this.closeState.state = 'closing';
        let complete!: (report: DesktopCloseReport) => void;
        const completion = new Promise<DesktopCloseReport>(resolve => { complete = resolve; });
        this.closeHandle = createCloseHandle(() => this.report(), completion);

        const { apps, accepted } = previous ? { apps: [...this.closingApps.keys()], accepted: [] } : this.appManager.stopAdmission();
        if (!previous && this.turns.close().length) {
            addCloseFailure(this.closeState, 'apps', ['RESOURCE_RELEASE_FAILED'], { desktopId: this.id });
            this.closeState.resourcesReleased = false;
        }
        for (const app of apps) this.closingApps.set(app, app.beginClose());
        void this.finishClose(accepted).then(complete);
        return this.closeHandle;
    }

    private async finishClose(accepted: readonly Promise<unknown>[]): Promise<DesktopCloseReport> {
        const apps = [...this.closingApps];
        await Promise.allSettled(accepted);
        await Promise.all(apps.map(async ([app, handle]) => {
            try {
                const report = await handle.completion;
                if (report.resourcesReleased) {
                    mergeCloseReport(this.closeState, report);
                    this.closingApps.delete(app);
                }
            } catch {
                addCloseFailure(this.closeState, 'apps', ['APP_CLOSE_FAILED'], { desktopId: this.id, appId: app.appId });
            }
        }));
        await Promise.all([
            this.clean('signalBus', 'signals', () => this.signalBus.cleanup()),
            this.clean('logger', 'logger', () => this.logger.cleanup()),
        ]);
        this.appManager.clearInactiveInstallations();
        this.closeState.state = 'settled';
        const report = this.report();
        if (report.resourcesReleased) {
            const notify = this.onResourcesReleased;
            this.onResourcesReleased = undefined;
            notify?.(this);
        }
        return report;
    }

    private async clean(key: 'signalBus' | 'logger', stage: 'signals' | 'logger', action: () => unknown): Promise<void> {
        const cleanup = this.closeState.cleanup;
        if (cleanup[key] === 'done') return;
        cleanup[key] = 'pending';
        try { await action(); cleanup[key] = 'done'; }
        catch {
            cleanup[key] = 'failed';
            addCloseFailure(this.closeState, stage, ['DESKTOP_CLEANUP_FAILED'], { desktopId: this.id });
        }
    }

    // --- Internals ---

    public emitSignal(update: Pick<UpdateSignal, 'appId' | 'instanceId' | 'reason'>) {
        if (this.isClosing) return;
        const signal = Object.freeze({ ...update, desktopId: this.id, timestamp: Date.now() });
        this.signalBus.emit(signal, () => !this.isClosing);
    }

    // [RFC-001 Phase 2] DOM Observers Removed

}
