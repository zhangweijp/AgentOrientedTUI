import type { DesktopID } from '../core/types.js';

export interface ShutdownOptions {
    /** 超时时间(ms)，默认 30000 */
    timeoutMs?: number;
    /** 关闭前回调 */
    beforeClose?: () => Promise<void>;
}
export interface DesktopCloseOptions extends ShutdownOptions { intent?: 'close' | 'delete' }

export interface InteractionCloseReport {
    readonly verified: boolean;
    readonly retainedScopes: number;
    /** Core JSON/UTF-8 combinedBytes, not heap or RSS. */
    readonly retainedBytes: number;
}

export interface CloseReport {
    readonly scope: 'app-manager' | 'desktop' | 'runtime';
    readonly state: 'active' | 'closing' | 'settled';
    readonly ok: boolean;
    readonly hasFailures: boolean;
    readonly resourcesReleased: boolean;
    readonly interactions?: InteractionCloseReport;
    readonly verification: 'managed' | 'mixed' | 'unverified';
    readonly intent: 'close' | 'delete' | null;
    readonly apps: { readonly accepted: number; readonly settled: number; readonly pending: number; readonly notVerifiedReleased: number };
    readonly desktops: { readonly accepted: number; readonly settled: number; readonly pending: number; readonly notVerifiedReleased: number };
    readonly pendingOperations: number;
    readonly unverifiedParticipants: number;
    readonly appCleanup?: { readonly managedApps: number; readonly completedApps: number; readonly failedApps: number };
    readonly persistence: {
        readonly managedApps: number; readonly unnegotiatedApps: number; readonly notUsedApps: number;
        readonly closeReceipts: number; readonly missingCloseReceipts: number; readonly confirmedFlushes: number; readonly failedFlushes: number;
        readonly absentFlushes: number; readonly unknownApps: number; readonly unsavedKeys: number;
    };
    readonly resources: { readonly retainedStorageOwners: number; readonly storageActualIO: number; readonly openingStorageOwners: number };
    readonly pool: { readonly ownership: 'owned' | 'not-owned' | 'unverified'; readonly report: null | {
        readonly state: 'open' | 'closing' | 'closed'; readonly limit: number; readonly total: number; readonly reserved: number;
        readonly idle: number; readonly leased: number; readonly retiring: number;
        readonly issues: readonly ('WORKER_ERROR' | 'WORKER_TERMINATION_FAILED')[];
    } };
    readonly beforeClose: 'not-provided' | 'pending' | 'running' | 'done' | 'failed' | 'skipped-drain-failed' | 'skipped-deadline';
    readonly cleanup: {
        readonly signalBus: 'pending' | 'done' | 'failed' | 'not-owned' | 'unverified';
        readonly llmOutput: 'pending' | 'done' | 'failed' | 'not-owned' | 'unverified';
        readonly logger: 'pending' | 'done' | 'failed' | 'not-owned' | 'unverified';
    };
    readonly failures: readonly {
            readonly stage: 'admission' | 'apps' | 'persistence' | 'worker' | 'pool' | 'before-close' | 'signals' | 'llm-output' | 'logger' | 'manager';
        readonly codes: readonly ('INSTALL_FAILED' | 'DELETE_FAILED' | 'APP_CLOSE_FAILED' | 'RESET_FAILED' | 'RESOURCE_RELEASE_FAILED' |
            'WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED' | 'PERSISTENCE_CLOSE_FAILED' |
            'APP_UNMOUNT_FAILED' | 'APP_DELETE_FAILED' | 'BEFORE_CLOSE_FAILED' | 'BEFORE_CLOSE_SKIPPED' | 'DESKTOP_CLEANUP_FAILED' |
            'MANAGER_CLEANUP_FAILED')[];
        readonly desktopId?: string; readonly appId?: string;
    }[];
    readonly failureCount: number;
    readonly samplesTruncated: boolean;
}
export interface AppManagerCloseReport extends CloseReport { readonly scope: 'app-manager' }
export interface DesktopCloseReport extends CloseReport { readonly scope: 'desktop'; readonly intent: 'close' | 'delete'; readonly desktopId: string; readonly found: boolean }
export interface RuntimeCloseReport extends CloseReport { readonly scope: 'runtime'; readonly intent: 'close' }
export interface CloseOperation<R extends CloseReport> {
    readonly completion: Promise<R>;
    inspect(): R;
    wait(options?: { readonly timeoutMs?: number }): Promise<
        { readonly status: 'settled'; readonly report: R } | { readonly status: 'deadline'; readonly report: R }
    >;
}
export type DesktopCloseOperation = CloseOperation<DesktopCloseReport>;
export type RuntimeCloseOperation = CloseOperation<RuntimeCloseReport>;
export type AppManagerCloseOperation = CloseOperation<AppManagerCloseReport>;
export interface RuntimeCloseReporting {
    beginShutdown(reason?: string): RuntimeCloseOperation;
    beginDesktopShutdown(id: DesktopID, options?: ShutdownOptions): DesktopCloseOperation;
}
