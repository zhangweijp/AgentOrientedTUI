export const APP_LIFECYCLE_PROTOCOL = 'app-lifecycle-v2' as const;

export interface AppLifecycleCallbacks {
    stop?(): void;
    close?(): void | Promise<void>;
}

export interface AppLifecyclePort {
    readonly protocol: typeof APP_LIFECYCLE_PROTOCOL;
    register(callbacks: AppLifecycleCallbacks): () => void;
}
