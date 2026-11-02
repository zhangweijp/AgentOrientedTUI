import { utf8Size } from '../../core/snapshot/json.js';
import { captureStateAddress, failedMutation, failedRead, requireStateLimits, stateFields, stateIssue, validStateOwner } from '../../core/persistence/state-storage.js';
import type { StateAddress, StateIssue, StateStorage } from '../../core/persistence/state-storage.js';

export interface MemoryStateStorageLimits {
    readonly maxStoredKeys: number;
    /** Stored address-tuple bytes plus stored text UTF-8 bytes. */
    readonly maxStoredBytes: number;
    readonly maxRecordBytes: number;
    /** Also bounds JSON-encoded instance IDs, independently of owner count. */
    readonly maxAddressBytes: number;
    readonly maxActiveOwners: number;
    readonly maxClaimedNamespaces: number;
}
export function createMemoryStateStorage(limits: MemoryStateStorageLimits, initial: readonly Readonly<{ address: StateAddress; text: string }>[] = []) {
    limits = requireStateLimits(limits, ['maxStoredKeys', 'maxStoredBytes', 'maxRecordBytes', 'maxAddressBytes', 'maxActiveOwners', 'maxClaimedNamespaces']);
    const values = new Map<string, Readonly<{ text: string; bytes: number }>>();
    type Owner = { id: string; released: boolean };
    const owners = new Map<string, Owner>(), namespaces = new Map<string, Owner>();let storedBytes = 0;
    if (!Array.isArray(initial) || Object.getPrototypeOf(initial) !== Array.prototype || initial.length > limits.maxStoredKeys) throw new Error('INVALID_INPUT: bounded initial records array required');
    const initialFields = Object.getOwnPropertyDescriptors(initial);
    if (Reflect.ownKeys(initialFields).length !== initial.length + 1) throw new Error('INVALID_INPUT: dense initial records required');
    for (let index = 0; index < initial.length; index++) {
        const descriptor = initialFields[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('INVALID_INPUT: initial records cannot use accessors');
        const input: unknown = descriptor.value;
        const fields = stateFields(input), address = captureStateAddress(fields?.address?.value, limits.maxAddressBytes), text = fields?.text?.value;
        if (!fields || Object.keys(fields).length !== 2 || address.status === 'rejected' || typeof text !== 'string' || utf8Size(text) > limits.maxRecordBytes || values.has(address.identity)) throw new Error('INVALID_INPUT: invalid memory storage initial records');
        const bytes = address.bytes + utf8Size(text);
        if (values.size >= limits.maxStoredKeys || storedBytes + bytes > limits.maxStoredBytes) throw new Error('CAPACITY_EXCEEDED: initial memory records exceed limits');
        values.set(address.identity, Object.freeze({ text, bytes }));storedBytes += bytes;
    }
    function open(ownerId: string): Readonly<{ status: 'opened'; storage: StateStorage }> | Readonly<{ status: 'rejected'; issue: StateIssue }> {
        const rejected = (code: Parameters<typeof stateIssue>[0]) => Object.freeze({ status: 'rejected' as const, issue: stateIssue(code) });
        if (!validStateOwner(ownerId, limits.maxAddressBytes)) return rejected('INVALID_INPUT');
        if (owners.has(ownerId)) return rejected('OWNER_BUSY');
        if (owners.size >= limits.maxActiveOwners) return rejected('CAPACITY_EXCEEDED');
        const owner: Owner = { id: ownerId, released: false };owners.set(ownerId, owner);
        const check = (input: StateAddress) => {
            if (owner.released || owners.get(ownerId) !== owner) return { issue: stateIssue('OWNER_RELEASED') } as const;
            const address = captureStateAddress(input, limits.maxAddressBytes);
            if (address.status === 'rejected') return { issue: address.issue } as const;
            const claimed = namespaces.get(address.address.namespace);
            if (claimed && claimed !== owner) return { issue: stateIssue('NAMESPACE_BUSY') } as const;
            if (!claimed && namespaces.size >= limits.maxClaimedNamespaces) return { issue: stateIssue('CAPACITY_EXCEEDED') } as const;
            return { address } as const;
        };
        const claim = (address: StateAddress) => { namespaces.set(address.namespace, owner); };
        const storage: StateStorage = Object.freeze({ owner: ownerId,
            async read(input: StateAddress) {
                const checked = check(input);if (checked.issue) return failedRead(checked.issue.code);
                claim(checked.address.address);const found = values.get(checked.address.identity);
                return found ? Object.freeze({ status: 'found' as const, text: found.text }) : Object.freeze({ status: 'missing' as const });
            },
            async replace(input: StateAddress, text: string) {
                const checked = check(input);if (checked.issue) return failedMutation(checked.issue.code);
                if (typeof text !== 'string' || utf8Size(text) > limits.maxRecordBytes) return failedMutation(typeof text === 'string' ? 'CAPACITY_EXCEEDED' : 'INVALID_INPUT');
                const { address } = checked, previous = values.get(address.identity), bytes = address.bytes + utf8Size(text);
                if ((!previous && values.size >= limits.maxStoredKeys) || storedBytes - (previous?.bytes ?? 0) + bytes > limits.maxStoredBytes) return failedMutation('CAPACITY_EXCEEDED');
                claim(address.address);storedBytes += bytes - (previous?.bytes ?? 0);values.set(address.identity, Object.freeze({ text, bytes }));return Object.freeze({ status: 'applied' as const });
            },
            async remove(input: StateAddress) {
                const checked = check(input);if (checked.issue) return failedMutation(checked.issue.code);
                claim(checked.address.address);const found = values.get(checked.address.identity);
                if (found) { values.delete(checked.address.identity);storedBytes -= found.bytes; }
                return Object.freeze({ status: 'applied' as const });
            },
            async release() {
                if (!owner.released) {
                    owner.released = true;
                    if (owners.get(ownerId) === owner) owners.delete(ownerId);
                    for (const [namespace, current] of namespaces) if (current === owner) namespaces.delete(namespace);
                }
                return Object.freeze({ status: 'released' as const });
            },
        });
        return Object.freeze({ status: 'opened', storage });
    }
    return Object.freeze({ open, getStats: () => Object.freeze({ storedKeys: values.size, storedBytes, activeOwners: owners.size, claimedNamespaces: namespaces.size }) });
}
