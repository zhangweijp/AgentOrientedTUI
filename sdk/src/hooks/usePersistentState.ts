import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { useAppEnv } from './useAppEnv.js';
import { useInternalAppRuntimeContext } from '../context/AppRuntimeContext.js';
import type { AppStatePersistence, StateBindingStatus, StateValue, StateIssue } from '@aotui/runtime/spi';
import type { StateBinding } from '@aotui/runtime/spi';

export type PersistOptions<T> = {
  storageKey?: string;
  serialize?: (value: T) => unknown;
  deserialize?: (value: unknown) => T;
  rehydrateOnReinitialize?: boolean;
};
export type PersistStatus = StateBindingStatus | Readonly<{ phase: 'pending' }>;
export type PersistMeta = { ready: boolean; clear: () => Promise<void>; getStatus: () => PersistStatus };
const error = (issue: StateIssue) => Object.assign(new Error(issue.message), { code: issue.code });
const unavailable = () => Object.assign(new Error('Instance persistence is unavailable; use a compatible managed Runtime'), { code: 'PERSISTENCE_UNAVAILABLE' });

export type AOTUILifecycleMetadata = {
  startupKind?: "normal" | "reinitialize";
  reason?: string;
};

export function shouldHydratePersistentState(
  lifecycle: AOTUILifecycleMetadata | undefined,
  options: Pick<PersistOptions<unknown>, "rehydrateOnReinitialize"> = {}
): boolean {
  if (lifecycle?.startupKind === "reinitialize") {
    return options.rehydrateOnReinitialize === true;
  }
  return true;
}

export function resolvePersistentAppName({
  storageKey,
  appNameFromEnv,
  appId,
}: {
  storageKey?: string;
  appNameFromEnv?: string;
  appId: string | number;
}): string {
  return storageKey || appNameFromEnv || String(appId);
}

type Candidate<T> = {
  phase: 'pending' | 'bound' | 'released'; value: T; ready: boolean; updates: number;
  serialize?: PersistOptions<T>['serialize']; deserialize?: PersistOptions<T>['deserialize'];
  binding?: StateBinding; early?: { value?: unknown; failed: boolean };
};

export function usePersistentState<T>(key: string, initial: T, options: PersistOptions<T> = {}): [T, Dispatch<StateUpdater<T>>, PersistMeta] {
  const { persistence } = useInternalAppRuntimeContext();
  const lifecycle = useAppEnv<AOTUILifecycleMetadata>('__aotuiLifecycle');
  const hydrate = shouldHydratePersistentState(lifecycle, options);
  const [, refresh] = useState(0);
  const port: AppStatePersistence | undefined = persistence;
  const candidate = useMemo<Candidate<T>>(() => ({ phase: 'pending', value: initial, ready: false, updates: 0,
    serialize: options.serialize, deserialize: options.deserialize }), [key, options.storageKey, hydrate, port, port?.instanceId]);
  // Updating callback identities is a commit operation, never a render-time mutation of a live binding.
  useLayoutEffect(() => { candidate.serialize = options.serialize;candidate.deserialize = options.deserialize; });
  useLayoutEffect(() => {
    if (!port || port.protocol !== 'state-session-v1' || typeof port.bind !== 'function' || typeof port.flush !== 'function' || typeof port.captureValue !== 'function') throw unavailable();
    let captured: unknown;
    try { captured = candidate.serialize ? candidate.serialize(initial) : initial; }
    catch { throw Object.assign(new Error('Initial state could not be captured'), { code: 'SERIALIZATION_FAILED' }); }
    const result = port.bind(key, captured as StateValue, { hydrate, ...(options.storageKey !== undefined ? { storageKey: options.storageKey } : {}) });
    if (result.status !== 'bound') throw error(result.issue);
    const binding = result.binding;
    candidate.binding = binding;candidate.phase = 'bound';
    if (candidate.early) {
      if (candidate.early.failed) binding.reportUpdateFailure();
      else binding.update(candidate.early.value as StateValue);
      candidate.early = undefined;
    }
    void binding.recovery.then(recovery => {
      if (candidate.phase !== 'bound' || binding.inspect().phase === 'released') return;
      const needsValue = recovery.status === 'found' && (hydrate || recovery.source === 'session');
      let restored: T | undefined;
      try {
        if (needsValue && recovery.status === 'found') {
          restored = candidate.deserialize ? candidate.deserialize(recovery.value) : recovery.value as T;
          const normalized = candidate.serialize ? candidate.serialize(restored) : restored;
          const ack = binding.confirmInitialization(recovery, { status: 'ready', value: normalized as StateValue });
          if (ack.status === 'accepted' && candidate.updates === 0) candidate.value = restored;
        } else binding.confirmInitialization(recovery, { status: 'ready' });
      } catch { binding.confirmInitialization(recovery, { status: 'failed' }); }
      candidate.ready = true;refresh(n => n + 1);
    });
    return () => { candidate.phase = 'released';binding.release(); };
  }, [candidate]);
  const setter: Dispatch<StateUpdater<T>> = useMemo(() => update => {
    if (candidate.phase === 'released') throw Object.assign(new Error('State binding is no longer current'), { code: 'STALE_BINDING' });
    if (!port || typeof port.captureValue !== 'function') throw unavailable();
    if (candidate.binding) {
      const status = candidate.binding.inspect();
      if (status.phase === 'released') throw error(status.issue);
      if (status.phase !== 'open') throw Object.assign(new Error('State session is sealed'), { code: 'SEALED' });
    }
    const value = typeof update === 'function' ? (update as (previous: T) => T)(candidate.value) : update;
    let captured: unknown, failed = false;
    try { captured = candidate.serialize ? candidate.serialize(value) : value; } catch { failed = true; }
    if (candidate.binding) {
      if (failed) candidate.binding.reportUpdateFailure();else candidate.binding.update(captured as StateValue);
    } else {
      const snapshot = failed ? undefined : port.captureValue(captured);
      candidate.early = snapshot?.status === 'captured' ? { value: snapshot.snapshot.value, failed: false } : { failed: true };
    }
    candidate.updates++;candidate.value = value;
    refresh(n => n + 1);
  }, [candidate]);
  const clear = useMemo(() => async () => {
    if (!candidate.binding) throw unavailable();
    const result = await candidate.binding.clear();
    if (result.status !== 'applied') throw error(result.issue);
  }, [candidate]);
  return [candidate.value, setter, { ready: candidate.ready, clear,
    getStatus: () => candidate.phase === 'released' ? candidate.binding!.inspect() : candidate.binding?.inspect() ?? Object.freeze({ phase: 'pending' }) }];
}
