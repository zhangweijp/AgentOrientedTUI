export const APP_LIFECYCLE_PROTOCOL = 'app-lifecycle-v2' as const;
export const APP_LIFECYCLE_VERSION = 2 as const;
export interface AppLifecycleCallbacks {
    stop?(): void;
    close?(): void | Promise<void>;
}
export interface AppLifecyclePort {
    readonly protocol: typeof APP_LIFECYCLE_PROTOCOL;
    register(callbacks: AppLifecycleCallbacks): () => void;
}
export interface AppCleanupReport {
    readonly protocol: typeof APP_LIFECYCLE_PROTOCOL;
    readonly instanceId: string;
    readonly state: 'active' | 'stopped' | 'pending' | 'completed' | 'failed';
    readonly issues: readonly ('APP_STOP_FAILED' | 'APP_STOP_ASYNC' | 'APP_CLEANUP_FAILED')[];
}
