import type { CapturedStateValue, Rejected, StateValue } from '../../core/persistence/state-storage.js';
import type { StateBinding, StateFlushReport } from '../../core/persistence/state-session.js';

export type { StateValue, StateIssue, StateMutationResult } from '../../core/persistence/state-storage.js';
export type { StateBinding, StateBindingStatus, StateRecovery, StateFlushReport, StateDisposeReport } from '../../core/persistence/state-session.js';

/** Instance-owned serialized state only. No filesystem or lifecycle ownership is exposed. */
export interface AppStatePersistence {
    readonly protocol: 'state-session-v1';
    readonly instanceId: string;
    captureValue(value: unknown): Readonly<{ status: 'captured'; snapshot: CapturedStateValue }> | Rejected;
    bind(key: string, initialJSON: StateValue, options: Readonly<{ hydrate: boolean; storageKey?: string }>):
        Readonly<{ status: 'bound'; binding: StateBinding }> | Rejected;
    flush(): Promise<StateFlushReport>;
}
