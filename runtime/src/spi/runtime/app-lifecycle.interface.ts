export interface AppLifecycleCallbacks {
    stop?(): void;
    close?(): void | Promise<void>;
}
export interface AppLifecyclePort {
    readonly protocol: 'app-lifecycle-v2';
    register(callbacks: AppLifecycleCallbacks): () => void;
}
export interface AppCleanupReport {
    readonly protocol: 'app-lifecycle-v2';
    readonly instanceId: string;
    readonly state: 'active' | 'stopped' | 'pending' | 'completed' | 'failed';
    readonly issues: readonly ('APP_STOP_FAILED' | 'APP_STOP_ASYNC' | 'APP_CLEANUP_FAILED')[];
}
