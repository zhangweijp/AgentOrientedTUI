import { createStateSession, stateError, stateFields, stateIssue } from '@aotui/core/persistence';
import type { AppStatePersistence, StatePersistenceOptions, StateSessionLimits, StateStorage, StateValue } from '@aotui/core';
import { DEFAULT_STATE_SESSION_LIMITS, STATE_SESSION_PROTOCOL, type ManagedPersistenceReport } from '../adapters/storage/state-storage-protocol.js';
export function createAppStatePersistence(options: Readonly<{ instanceId: string; desktopId: string; appKey: string;
    storage: StateStorage; limits?: StateSessionLimits; now?: () => number }>) {
    const { instanceId, desktopId, appKey } = options;
    const session = createStateSession({ instanceId, storage: options.storage,
        limits: options.limits ?? DEFAULT_STATE_SESSION_LIMITS, now: options.now ?? Date.now });
    let closePromise: Promise<ManagedPersistenceReport> | undefined;
    let report: ManagedPersistenceReport | undefined;
    function address(key: string, input?: StatePersistenceOptions) {
        const fields = input === undefined ? {} : stateFields(input);
        if (!fields || Object.keys(fields).some(field => field !== 'storageKey') ||
            (fields.storageKey && (typeof fields.storageKey.value !== 'string' || !fields.storageKey.value.length)))
            throw stateError(stateIssue('INVALID_INPUT'));
        return { namespace: JSON.stringify([desktopId, fields.storageKey?.value ?? appKey]), key };
    }
    const port: AppStatePersistence = Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId: options.instanceId,
        async load(key: string, input?: StatePersistenceOptions) { return session.load(address(key, input)); },
        async save(key: string, value: StateValue, input?: StatePersistenceOptions) { return session.save(address(key, input), value); },
        async remove(key: string, input?: StatePersistenceOptions) { return session.remove(address(key, input)); },
        flush: session.flush,
    });
    function close(unmount: () => void | Promise<void>): Promise<ManagedPersistenceReport> {
        if (closePromise) return closePromise;
        closePromise = Promise.resolve().then(async () => {
            let unmounted = true;
            try { await unmount(); } catch { unmounted = false; }
            session.seal();
            const flush = await session.flush();
            const dispose = await session.dispose();
            report = Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId: options.instanceId,
                ok: flush.ok && dispose.release.status === 'released' && dispose.unsaved.length === 0,
                unmount: unmounted ? 'completed' : 'failed', flush, dispose });
            return report;
        });
        return closePromise;
    }
    return Object.freeze({ port, close, getReport: () => report, getStats: session.getStats });
}
