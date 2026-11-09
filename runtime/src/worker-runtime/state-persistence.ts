import { createStateSession } from '../core/persistence/state-session.js';
import type { StateSessionLimits, StateFlushReport, StateDisposeReport } from '../core/persistence/state-session.js';
import { captureStateValue, rejectState, requireStateLimits, stateFields } from '../core/persistence/state-storage.js';
import type { StateStorage, StateValue } from '../core/persistence/state-storage.js';
import type { AppStatePersistence } from '../spi/runtime/state-persistence.interface.js';
import { DEFAULT_STATE_SESSION_LIMITS, STATE_SESSION_PROTOCOL } from '../adapters/storage/state-storage-protocol.js';

export interface ManagedPersistenceReport {
    readonly protocol: typeof STATE_SESSION_PROTOCOL; readonly instanceId: string;
    readonly ok: boolean; readonly unmount: 'pending' | 'completed' | 'failed';
    readonly flush?: StateFlushReport; readonly dispose?: StateDisposeReport;
}
export function createAppStatePersistence(options: Readonly<{ instanceId: string; desktopId: string; appKey: string;
    storage: StateStorage; limits?: StateSessionLimits; now?: () => number }>) {
    const { instanceId, desktopId, appKey } = options;
    const limits = requireStateLimits(options.limits ?? DEFAULT_STATE_SESSION_LIMITS, Object.keys(DEFAULT_STATE_SESSION_LIMITS));
    const session = createStateSession({ instanceId, storage: options.storage, limits, now: options.now ?? Date.now });
    let manual: Promise<StateFlushReport> | undefined, shutdownPromise: Promise<StateFlushReport> | undefined;
    let lastManual: StateFlushReport | undefined;
    let closePromise: Promise<ManagedPersistenceReport> | undefined;
    let report: ManagedPersistenceReport = Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId: options.instanceId, ok: false, unmount: 'pending' });
    const port: AppStatePersistence = Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId: options.instanceId,
        captureValue: (value: unknown) => captureStateValue(value, limits),
        bind(key: string, value: StateValue, input: Readonly<{ hydrate: boolean; storageKey?: string }>) {
            const f = stateFields(input);
            if (!f || !f.hydrate || Object.keys(f).some(k => k !== 'hydrate' && k !== 'storageKey') ||
                Object.hasOwn(f, 'storageKey') && (typeof f.storageKey!.value !== 'string' || !f.storageKey!.value.length)) return rejectState('INVALID_INPUT');
            return session.bind({ namespace: JSON.stringify([desktopId, f.storageKey?.value ?? appKey]), key }, value, { hydrate: f.hydrate.value });
        },
        flush() {
            if (manual) return manual;
            // Install the Promise now, capture Core's finite batch after this synchronous commit.
            manual = Promise.resolve().then(() => session.flush()).then(result => { lastManual = result;manual = undefined;return result; });
            return manual;
        },
    });
    function shutdown(): Promise<StateFlushReport> {
        if (shutdownPromise) return shutdownPromise;
        session.seal();
        const pending = manual;
        shutdownPromise = (async () => {
            const previous = pending ? await pending : lastManual;
            const flush = previous && !previous.ok ? previous : await session.flush();
            report = Object.freeze({ ...report, flush });
            return flush;
        })();
        return shutdownPromise;
    }
    function close(unmount: () => void | Promise<void>, initialFailure = false): Promise<ManagedPersistenceReport> {
        if (closePromise) return closePromise;
        session.seal();
        closePromise = (async () => {
            let flush: StateFlushReport | undefined, unmounted = true;
            if (!initialFailure) { try { flush = await shutdown(); } catch { /* cleanup remains mandatory */ } }
            try { await unmount(); } catch { unmounted = false; }
            const dispose = await session.dispose();
            report = Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId: options.instanceId,
                ok: !initialFailure && !!flush?.ok && unmounted && dispose.release.status === 'released' && dispose.unsaved.length === 0,
                unmount: unmounted ? 'completed' : 'failed', ...(flush ? { flush } : {}), dispose });
            return report;
        })();
        return closePromise;
    }
    return Object.freeze({ port, shutdown, close, getReport: () => report, getStats: session.getStats });
}
