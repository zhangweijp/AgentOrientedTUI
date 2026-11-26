import type { InteractionStats } from '@aotui/core';

export interface InteractionCloseReport {
    readonly verified: boolean;
    readonly retainedOperations: number;
}

export interface CloseReport {
    readonly scope: 'app' | 'desktop' | 'runtime';
    readonly state: 'closing' | 'settled';
    readonly ok: boolean;
    readonly hasFailures: boolean;
    readonly resourcesReleased: boolean;
    readonly interactions?: InteractionCloseReport;
    readonly verification: 'managed' | 'mixed';
    readonly apps: { readonly accepted: number; readonly settled: number; readonly pending: number; readonly notVerifiedReleased: number };
    readonly desktops: { readonly accepted: number; readonly settled: number; readonly pending: number; readonly notVerifiedReleased: number };
    readonly pendingTasks: number;
    readonly unverifiedParticipants: number;
    readonly appCleanup?: { readonly managedApps: number; readonly completedApps: number; readonly failedApps: number };
    readonly workers: { readonly ownership: 'owned' | 'not-owned'; readonly report: null | {
        readonly state: 'open' | 'closing' | 'closed'; readonly limit: number; readonly total: number;
    } };
    readonly cleanup: {
        readonly signalBus: 'pending' | 'done' | 'failed' | 'not-owned';
        readonly logger: 'pending' | 'done' | 'failed' | 'not-owned';
    };
    readonly failures: readonly {
        readonly stage: 'admission' | 'apps' | 'worker' | 'signals' | 'logger';
        readonly codes: readonly ('INSTALL_FAILED' | 'APP_CLOSE_FAILED' | 'APP_CLOSE_DEADLINE_EXCEEDED' | 'RESOURCE_RELEASE_FAILED' |
            'WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED' | 'EXECUTION_CHANNEL_ENDED' |
            'APP_UNMOUNT_FAILED' | 'DESKTOP_CLEANUP_FAILED')[];
        readonly desktopId?: string; readonly appId?: string;
    }[];
    readonly failureCount: number;
    readonly samplesTruncated: boolean;
}
export interface AppCloseReport extends CloseReport {
    readonly scope: 'app';
    readonly desktopId: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly worker: 'not-created' | 'owned' | 'retiring' | 'exited';
    readonly closingInvocation?: NonNullable<InteractionStats['closingInvocation']>;
}
export interface DesktopCloseReport extends CloseReport { readonly scope: 'desktop'; readonly desktopId: string }
export interface RuntimeCloseReport extends CloseReport { readonly scope: 'runtime' }
export interface CloseHandle<R extends CloseReport> {
    readonly completion: Promise<R>;
    inspect(): R;
    wait(options?: { readonly timeoutMs?: number }): Promise<
        { readonly status: 'settled'; readonly report: R } | { readonly status: 'deadline'; readonly report: R }
    >;
}
export type DesktopCloseHandle = CloseHandle<DesktopCloseReport>;
export type RuntimeCloseHandle = CloseHandle<RuntimeCloseReport>;
export type AppCloseHandle = CloseHandle<AppCloseReport>;
