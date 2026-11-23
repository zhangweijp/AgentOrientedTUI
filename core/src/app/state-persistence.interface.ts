import type { StateValue } from '../persistence/state-storage.js';
import type { StateFlushReport } from '../persistence/state-session.js';

export const STATE_SESSION_PROTOCOL = 'state-session-v2' as const;
export interface StatePersistenceOptions { readonly storageKey?: string }

/** Instance-owned serialized state only. No filesystem or lifecycle ownership is exposed. */
export interface AppStatePersistence {
    readonly protocol: typeof STATE_SESSION_PROTOCOL;
    readonly instanceId: string;
    load(key: string, options?: StatePersistenceOptions): Promise<StateValue | undefined>;
    save(key: string, value: StateValue, options?: StatePersistenceOptions): Promise<void>;
    remove(key: string, options?: StatePersistenceOptions): Promise<void>;
    flush(): Promise<StateFlushReport>;
}
