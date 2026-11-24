import type { APP_LIFECYCLE_PROTOCOL } from '@aotui/core';

export interface AppCleanupReport {
    readonly protocol: typeof APP_LIFECYCLE_PROTOCOL;
    readonly instanceId: string;
    readonly state: 'active' | 'stopped' | 'pending' | 'completed' | 'failed';
    readonly issues: readonly ('APP_STOP_FAILED' | 'APP_STOP_ASYNC' | 'APP_CLEANUP_FAILED')[];
}
