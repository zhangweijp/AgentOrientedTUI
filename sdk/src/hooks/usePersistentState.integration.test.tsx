import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { usePersistentState } from './usePersistentState.js';
import type { PersistOptions } from './usePersistentState.js';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { createAppStatePersistence } from '../../../runtime/src/worker-runtime/state-persistence.js';
import { createMemoryStateStorage } from '../../../runtime/src/adapters/storage/memory-state-storage.js';
import type { StateStorage } from '../../../runtime/src/core/persistence/state-storage.js';
import { decodeStateRecord } from '../../../runtime/src/core/persistence/state-storage.js';
import { DEFAULT_STATE_SESSION_LIMITS } from '../../../runtime/src/adapters/storage/state-storage-protocol.js';
import { stateIssue } from '../../../runtime/src/core/persistence/state-storage.js';

const containers: HTMLElement[] = [];
afterEach(() => { for (const el of containers.splice(0)) { render(null, el);el.remove(); } });
const defer = <T = void>() => { let resolve!: (v: T) => void;const promise = new Promise<T>(r => { resolve = r; });return { promise, resolve }; };
function setup(initialText?: string, overrides: Partial<StateStorage> = {}) {
  const address = { namespace: '["d","a"]', key: 'k' };
  const backend = createMemoryStateStorage({ maxStoredKeys: 32, maxStoredBytes: 2000000, maxRecordBytes: 300000,
    maxAddressBytes: 1024, maxActiveOwners: 5, maxClaimedNamespaces: 10 }, initialText === undefined ? [] : [{ address, text: initialText }]);
  const open = backend.open('i');if (open.status !== 'opened') throw Error('fixture');
  const calls = { read: 0, replace: 0 };const storage: StateStorage = { ...open.storage,
    read: async a => { calls.read++;return (overrides.read ?? open.storage.read)(a); },
    replace: async (a, text) => { calls.replace++;return (overrides.replace ?? open.storage.replace)(a, text); }, ...overrides };
  const managed = createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a', storage, now: () => 1 });
  const container = document.createElement('div');containers.push(container);document.body.append(container);
  let tuple: ReturnType<typeof usePersistentState<any>>, key = 'k', options: PersistOptions<any> = {}, initial: any = 0;
  let initialized: Promise<unknown> = Promise.resolve();
  const port = { ...managed.port, bind(...args: Parameters<typeof managed.port.bind>) {
    const result = managed.port.bind(...args);
    if (result.status === 'bound') initialized = result.binding.recovery.then(() => undefined);
    return result;
  } };
  let child: (() => any) | undefined, usePort = true, config: object = {};
  function App() { tuple = usePersistentState(key, initial, options);return child ? h(child, {}) : null; }
  const draw = () => render(h(AppRuntimeContext.Provider, { value: { appId: 'a', desktopId: 'd', persistence: usePort ? port : undefined, launchConfig: config } as any }, h(App, {})), container);
  return { managed, port, backend, storage, calls, address, container, get tuple() { return tuple; }, draw,
    async commit() { act(() => draw());await act(async () => { await initialized; }); },
    change(v: { key?: string; options?: PersistOptions<any>; initial?: any; child?: () => any; usePort?: boolean; config?: object }) {
      if ('key' in v) key = v.key!;if ('options' in v) options = v.options!;if ('initial' in v) initial = v.initial;
      if ('child' in v) child = v.child;if ('usePort' in v) usePort = v.usePort!;if ('config' in v) config = v.config!;
    },
    async value() { const r = await open.storage.read(address);if (r.status !== 'found') return r.status;const decoded = decodeStateRecord(r.text, DEFAULT_STATE_SESSION_LIMITS);if (decoded.status !== 'found') throw Error('fixture decode');return decoded.snapshot.value; },
  };
}
const settle = () => act(async () => {});
describe('B05–B10 actual Preact commits with actual A and Memory', () => {
  it.each(['object', 'nested', 'shared-serializer', 'nan', 'accessor', 'symbol', 'hidden', 'class', 'budget'])('B05/B06/B09 F01 early capture %s is immutable or preserves failure before bind', async kind => {
    const f = setup();let getters = 0, captures = 0, phase: unknown, flushing!: ReturnType<typeof f.managed.port.flush>;
    const originalCapture = f.port.captureValue;f.port.captureValue = value => { captures++;return originalCapture(value); };
    class ClassValue { n = 1; }
    let input: any = { n: 1 }, shared: any = { n: 1 }, mutate = () => { input.n = 2; }, invalid = false;
    if (kind === 'nested') { input = { child: { n: 1 } };mutate = () => { input.child.n = 2; }; }
    if (kind === 'shared-serializer') mutate = () => { shared.n = 2; };
    if (kind === 'nan') { input = { n: NaN };mutate = () => { input.n = 7; };invalid = true; }
    if (kind === 'accessor') { input = Object.defineProperty({}, 'n', { enumerable: true, get() { getters++;return 1; } });mutate = () => {};invalid = true; }
    if (kind === 'symbol') { input = { n: 1, [Symbol()]: 2 };invalid = true; }
    if (kind === 'hidden') { input = Object.defineProperty({ n: 1 }, 'hidden', { value: 2 });invalid = true; }
    if (kind === 'class') { input = new ClassValue();invalid = true; }
    if (kind === 'budget') { input = 'x'.repeat(262145);mutate = () => {};invalid = true; }
    f.change({ initial: { n: 0 }, options: kind === 'shared-serializer' ? { serialize: value => value === input ? shared : value } : {}, child: () => {
      useLayoutEffect(() => { phase = f.tuple[2].getStatus().phase;f.tuple[1](input);mutate();flushing = f.managed.port.flush(); }, []);return null;
    } });
    await f.commit();const report = await flushing;expect(phase).toBe('pending');expect(getters).toBe(0);expect(captures).toBe(1);
    expect(report.ok).toBe(!invalid);
    if (invalid) {
      expect(report.entries[0]).toMatchObject({ issue: { code: 'SERIALIZATION_FAILED' } });expect(f.calls.replace).toBe(0);
      await f.commit();expect((await f.managed.port.flush()).ok).toBe(false);expect(f.calls.replace).toBe(0);
    } else expect(await f.value()).toEqual(kind === 'nested' ? { child: { n: 1 } } : { n: 1 });
    f.tuple[1]({ n: 3 });expect((await f.managed.port.flush()).ok).toBe(true);expect(await f.value()).toEqual({ n: 3 });
    expect(captures).toBe(1);await f.managed.close(() => render(null, f.container));
  });
  it('synchronous setters then flush capture once, independently of deferred Preact render; ordinary rerender does not capture', async () => {
    const f = setup();let serializes = 0, updaters = 0;
    f.change({ options: { serialize(v) { serializes++;return v; } } });await f.commit();
    expect(f.tuple[2].ready).toBe(true);
    const setter = f.tuple[1];setter((v: number) => { updaters++;return v + 1; });setter((v: number) => { updaters++;return v + 1; });
    const flush = f.managed.port.flush();expect(f.managed.port.flush()).toBe(flush);expect((await flush).ok).toBe(true);
    expect(await f.value()).toBe(2);expect(updaters).toBe(2);const count = serializes;
    f.change({ options: { serialize(v) { serializes++;return v; } } });await f.commit();await f.managed.port.flush();
    expect(serializes).toBe(count);expect(f.calls.replace).toBe(1);await f.managed.close(() => render(null, f.container));
  });
  it('child layout setter and flush preceding parent Hook binding are captured in the same commit', async () => {
    const f = setup();let pending!: ReturnType<typeof f.managed.port.flush>;
    f.change({ child: () => { useLayoutEffect(() => { f.tuple[1](7);pending = f.managed.port.flush(); }, []);return null; } });
    await f.commit();expect((await pending).ok).toBe(true);expect(await f.value()).toBe(7);await f.managed.close(() => render(null, f.container));
  });
  it('restores an application value property from the formal Core envelope', async () => {
    const f = setup('{"version":1,"updatedAt":1,"value":{"value":1}}');await f.commit();expect(f.tuple[0]).toEqual({ value: 1 });
    expect((await f.managed.port.flush()).ok).toBe(true);expect(f.calls.replace).toBe(0);await f.managed.close(() => render(null, f.container));
  });
  it.each([false, true])('reinitialize hydration opt-in=%s restores according to the actual session', async hydrate => {
    const f = setup('{"version":1,"updatedAt":1,"value":5}');f.change({ config: { __aotuiLifecycle: { startupKind: 'reinitialize' } }, options: { rehydrateOnReinitialize: hydrate } });
    await f.commit();expect(f.tuple[0]).toBe(hydrate ? 5 : 0);await f.managed.port.flush();expect(await f.value()).toBe(hydrate ? 5 : 0);
    await f.managed.close(() => render(null, f.container));
  });
  it('late recovery does not overwrite a newer setter; custom Date normalizes without freezing user T', async () => {
    const entered = defer(), finish = defer();const f = setup(undefined, { read: async () => { entered.resolve();await finish.promise;return { status: 'found', text: '{"version":1,"updatedAt":1,"value":"2000-01-01T00:00:00.000Z"}' }; } });
    f.change({ initial: new Date('1999-01-01'), options: { serialize: d => d.toISOString(), deserialize: s => new Date(s as string) } });
    act(() => f.draw());await entered.promise;const value = new Date('2020-01-01');f.tuple[1](value);value.setUTCFullYear(2030);
    finish.resolve();await settle();expect(f.tuple[0]).toBe(value);await f.managed.port.flush();expect(await f.value()).toBe('2020-01-01T00:00:00.000Z');
    await f.managed.close(() => render(null, f.container));
  });
  it('function T is never called by Preact, and functional updater runs only once', async () => {
    const f = setup();let calls = 0, updaters = 0;const fn = () => { calls++;return 5; };
    f.change({ initial: fn, options: { serialize: () => 5, deserialize: () => fn } });await f.commit();
    f.tuple[1](() => { updaters++;return fn; });await f.managed.port.flush();await settle();
    expect(f.tuple[0]).toBe(fn);expect([calls, updaters]).toEqual([0, 1]);await f.managed.close(() => render(null, f.container));
  });
  it('failed serializer retains UI plus fixed Core issue; remount restores captured session and cannot hide failure', async () => {
    const f = setup();f.change({ options: { serialize(v) { if (v === 'bad') throw Error('private payload');return v; } } });await f.commit();
    f.tuple[1](1);await f.managed.port.flush();f.tuple[1]('bad');await settle();expect(f.tuple[0]).toBe('bad');
    expect(f.tuple[2].getStatus()).toMatchObject({ dirty: true, issue: { code: 'SERIALIZATION_FAILED' } });
    render(null, f.container);await f.commit();expect(f.tuple[0]).toBe(1);
    const failure = await f.managed.port.flush();expect(failure.ok).toBe(false);expect(JSON.stringify(failure)).not.toContain('private payload');
    f.tuple[1](2);expect((await f.managed.port.flush()).ok).toBe(true);expect(await f.value()).toBe(2);await f.managed.close(() => render(null, f.container));
  });
  it('clear does not revive on rerender, but explicit setter creates a new revision; stale setter/clear cannot touch a new key', async () => {
    const f = setup();await f.commit();f.tuple[1](1);await f.managed.port.flush();await f.tuple[2].clear();
    await f.commit();await f.managed.port.flush();expect(await f.value()).toBe('missing');
    const old = f.tuple;f.change({ key: 'other' });await f.commit();let calls = 0;
    expect(() => old[1](() => { calls++;return 9; })).toThrow(expect.objectContaining({ code: 'STALE_BINDING' }));
    await expect(old[2].clear()).rejects.toMatchObject({ code: 'STALE_BINDING' });expect(calls).toBe(0);
    f.tuple[1](4);await f.managed.port.flush();expect(await f.value()).toBe('missing');await f.managed.close(() => render(null, f.container));
  });
  it('corruption and deserialize failure stay blocked until explicit successful clear, without silent writes', async () => {
    for (const text of ['{', '{"version":2,"updatedAt":1,"value":0}']) {
      const f = setup(text);await f.commit();expect(f.tuple[2].ready).toBe(true);expect((await f.managed.port.flush()).ok).toBe(false);expect(f.calls.replace).toBe(0);
      await f.tuple[2].clear();f.tuple[1](6);expect((await f.managed.port.flush()).ok).toBe(true);await f.managed.close(() => render(null, f.container));
    }
    const f = setup('{"version":1,"updatedAt":1,"value":1}');f.change({ options: { deserialize() { throw Error('private'); } } });await f.commit();
    expect(f.tuple[2].getStatus()).toMatchObject({ issue: { code: 'INITIALIZATION_FAILED' } });await f.managed.close(() => render(null, f.container));
  });
  it.each(['failed', 'unknown'] as const)('clear %s rejects with fixed diagnostic and does not reset UI', async status => {
    const f = setup(undefined, { remove: async () => status === 'failed' ? { status, effects: 'none', issue: stateIssue('IO_FAILED') } : { status, issue: stateIssue('UNKNOWN_OUTCOME') } });
    await f.commit();f.tuple[1](8);await expect(f.tuple[2].clear()).rejects.toHaveProperty('code');await settle();expect(f.tuple[0]).toBe(8);
    expect((await f.managed.close(() => render(null, f.container))).ok).toBe(false);
  });
  it('missing port explicitly fails and render failure before commit creates no Core binding or I/O', async () => {
    const f = setup();f.change({ usePort: false });expect(() => act(() => f.draw())).toThrow(expect.objectContaining({ code: 'PERSISTENCE_UNAVAILABLE' }));
    expect(f.calls.read).toBe(0);await f.managed.close(() => render(null, f.container), true);
    const other = setup();other.change({ child: () => { throw Error('abandoned render'); } });expect(() => act(() => other.draw())).toThrow('abandoned render');
    expect(other.managed.getStats().activeBindings).toBe(0);expect(other.calls.read).toBe(0);await other.managed.close(() => render(null, other.container), true);
  });
  it.each([new Map([['a', 1]]), new Date('2020-01-01'), 'x'.repeat(262145)])('unsupported/oversize setter cannot save the old value as the latest success', async value => {
    const f = setup();await f.commit();f.tuple[1](1);await f.managed.port.flush();f.tuple[1](value);
    expect((await f.managed.port.flush()).ok).toBe(false);expect(await f.value()).toBe(1);
    f.tuple[1](2);expect((await f.managed.port.flush()).ok).toBe(true);await f.managed.close(() => render(null, f.container));
  });
  it('old recovery and stale setter cannot change a newly committed key', async () => {
    const entered = defer(), finish = defer();const f = setup(undefined, { read: async address => {
      if (address.key === 'k') { entered.resolve();await finish.promise;return { status: 'found', text: '{"version":1,"updatedAt":1,"value":9}' }; }
      return { status: 'missing' };
    } });
    act(() => f.draw());await entered.promise;const old = f.tuple;f.change({ key: 'new' });await f.commit();f.tuple[1](3);
    finish.resolve();await settle();expect(f.tuple[0]).toBe(3);let invoked = 0;
    expect(() => old[1](() => { invoked++;return 8; })).toThrow();expect(invoked).toBe(0);
    await f.managed.close(() => render(null, f.container));
  });
  it('B08 storageKey replacement releases the old namespace and stale clear cannot remove its successor', async () => {
    const f = setup();await f.commit();f.tuple[1](1);await f.managed.port.flush();const old = f.tuple;
    f.change({ options: { storageKey: 'other' } });await f.commit();f.tuple[1](2);await f.managed.port.flush();
    await expect(old[2].clear()).rejects.toMatchObject({ code: 'STALE_BINDING' });
    expect(await f.value()).toBe(1);expect(await f.storage.read({ namespace: '["d","other"]', key: 'k' })).toMatchObject({ text: expect.stringContaining('"value":2') });
    await f.managed.close(() => render(null, f.container));
  });
});
