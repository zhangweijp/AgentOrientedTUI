export const STATE_SESSION_PROTOCOL = 'state-session-v1' as const;
export const STATE_SESSION_VERSION = 1 as const;
import type { CapturedStateValue, Rejected, StateValue } from '../../core/persistence/state-storage.js';
import type { StateBinding, StateFlushReport } from '../../core/persistence/state-session.js';

export type { StateValue, StateIssue, StateMutationResult } from '../../core/persistence/state-storage.js';
export type { StateBinding, StateBindingStatus, StateRecovery, StateFlushReport, StateDisposeReport } from '../../core/persistence/state-session.js';

/** Instance-owned serialized state only. No filesystem or lifecycle ownership is exposed. */
export interface AppStatePersistence {
    readonly protocol: typeof STATE_SESSION_PROTOCOL;
    readonly instanceId: string;
    captureValue(value: unknown): Readonly<{ status: 'captured'; snapshot: CapturedStateValue }> | Rejected;
    bind(key: string, initialJSON: StateValue, options: Readonly<{ hydrate: boolean; storageKey?: string }>):
        Readonly<{ status: 'bound'; binding: StateBinding }> | Rejected;
    flush(): Promise<StateFlushReport>;
}
