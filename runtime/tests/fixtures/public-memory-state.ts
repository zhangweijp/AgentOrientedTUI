import { createStateSession, type StateSessionLimits } from '@aotui/core';
import { createMemoryStateStorage } from '@aotui/runtime/adapters/memory-state-storage';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const memory = createMemoryStateStorage({ maxStoredKeys: 16, maxStoredBytes: 65536, maxRecordBytes: 16384, maxAddressBytes: 512,
  maxActiveOwners: 2, maxClaimedNamespaces: 4 });
const limits: StateSessionLimits = { maxDepth: 16, maxNodes: 1000, maxValueBytes: 8192, maxRecordBytes: 16384, maxAddressBytes: 512,
  maxKeys: 8, maxRetainedBytes: 65536, maxPendingRequests: 8, maxConcurrentRequests: 2, maxRevision: 1000 };
const address = { namespace: 'notes-data', key: 'count' }, first = memory.open('data-owner-1'); check(first.status === 'opened', 'Storage owner');
const session = createStateSession({ instanceId: 'data-owner-1', storage: first.storage, limits, now: () => 0 });
check((await session.load(address)) === undefined, 'Initial storage is empty');
await session.save(address, 41);
check((await session.flush()).ok, 'Explicit save is confirmed');
check((await session.dispose()).release.status === 'released', 'First owner actually released');
check(memory.getStats().activeOwners === 0 && memory.getStats().storedKeys === 1, 'Released ownership does not delete data');
const second = memory.open('data-owner-2'); check(second.status === 'opened', 'Fresh owner');
const restored = createStateSession({ instanceId: 'data-owner-2', storage: second.storage, limits, now: () => 0 });
const restoredValue = await restored.load(address); check(restoredValue === 41, 'New owner reads the persisted value');
check((await restored.dispose()).release.status === 'released' && memory.getStats().activeOwners === 0, 'Final owner release');

export const stateFixtureFacts = { restoredValue, stateOwners: memory.getStats().activeOwners, storedKeys: memory.getStats().storedKeys };
