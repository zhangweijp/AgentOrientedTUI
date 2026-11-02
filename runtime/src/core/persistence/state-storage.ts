import { canonicalJson, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';

export type StateValue = JsonValue;
export interface StateAddress { readonly namespace: string; readonly key: string }
export interface StateValueLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    /** Canonical business-value UTF-8 bytes, separately from the outer record. */
    readonly maxValueBytes: number;
    readonly maxRecordBytes: number;
    /** JSON tuple bytes for addresses; JSON string bytes for instance/owner IDs. */
    readonly maxAddressBytes: number;
}
const messages = {
    INVALID_INPUT: 'Invalid persistence input or configuration',
    CAPACITY_EXCEEDED: 'Persistence capacity exceeded',
    PERMISSION_DENIED: 'Storage permission denied',
    IO_FAILED: 'Storage operation failed',
    NAMESPACE_BUSY: 'Namespace belongs to another active owner',
    OWNER_BUSY: 'Instance already has an active storage owner',
    OWNER_RELEASED: 'Storage owner was released',
    CORRUPT: 'Stored state is not valid supported JSON data',
    UNSUPPORTED_FORMAT: 'Stored state format is unsupported',
    INITIALIZATION_FAILED: 'State initialization did not complete successfully',
    SERIALIZATION_FAILED: 'State update could not be captured',
    UNKNOWN_OUTCOME: 'Storage mutation outcome cannot be confirmed',
    STALE_BINDING: 'State binding is no longer current',
    SEALED: 'State session is sealed',
    DISPOSED: 'State session is disposed',
    REVISION_EXHAUSTED: 'State revision capacity exhausted',
    INVALID_RECEIPT: 'Storage returned an invalid receipt',
    CLOCK_INVALID: 'Persistence clock did not return a finite number',
    ADDRESS_UNSUPPORTED: 'State address cannot be represented by this storage',
    RESOURCE_UNSUPPORTED: 'Storage resource type or identity is unsupported',
} as const;
export type StateIssueCode = keyof typeof messages;
export interface StateIssue { readonly code: StateIssueCode; readonly message: string }
export const stateIssue = (code: StateIssueCode): StateIssue => Object.freeze({ code, message: messages[code] });
export type Rejected = Readonly<{ status: 'rejected'; issue: StateIssue }>;
export const rejectState = (code: StateIssueCode): Rejected => Object.freeze({ status: 'rejected', issue: stateIssue(code) });
export interface CapturedStateValue { readonly value: StateValue; readonly bytes: number }
export type StateReadResult = Readonly<{ status: 'found'; text: string }> | Readonly<{ status: 'missing' }> | Readonly<{ status: 'failed'; issue: StateIssue }>;
export type StateMutationResult = Readonly<{ status: 'applied' }> | Readonly<{ status: 'failed'; effects: 'none'; issue: StateIssue }> | Readonly<{ status: 'unknown'; issue: StateIssue }>;
export type StateReleaseResult = Readonly<{ status: 'released' }> | Readonly<{ status: 'failed'; issue: StateIssue }> | Readonly<{ status: 'unknown'; issue: StateIssue }>;
export interface StateStorage {
    readonly owner: string;
    read(address: StateAddress): Promise<StateReadResult>;
    replace(address: StateAddress, text: string): Promise<StateMutationResult>;
    remove(address: StateAddress): Promise<StateMutationResult>;
    /** released promises that all previously admitted effects have actually ended. */
    release(): Promise<StateReleaseResult>;
}
export const failedRead = (code: StateIssueCode): StateReadResult => Object.freeze({ status: 'failed', issue: stateIssue(code) });
export const failedMutation = (code: StateIssueCode): StateMutationResult => Object.freeze({ status: 'failed', effects: 'none', issue: stateIssue(code) });
export const unknownMutation = (): StateMutationResult => Object.freeze({ status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') });

/** Inspect data descriptors, never evaluate a data getter or copy a cause/message. */
export function stateFields(input: unknown): Record<string, PropertyDescriptor> | null {
    if (!input || typeof input !== 'object') return null;
    try {
        const proto = Object.getPrototypeOf(input);
        if (proto !== Object.prototype && proto !== null) return null;
        const fields = Object.getOwnPropertyDescriptors(input);
        if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !fields[key]!.enumerable || !('value' in fields[key]!))) return null;
        return fields;
    } catch { return null; }
}
export function requireStateLimits<T extends object>(input: T, keys: readonly string[]): Readonly<T> {
    const fields = stateFields(input);
    if (!fields || Object.keys(fields).length !== keys.length || keys.some(k => !fields[k] || !Number.isSafeInteger(fields[k]!.value) || fields[k]!.value <= 0)) {
        throw new Error('INVALID_INPUT: explicit positive safe-integer persistence limits are required');
    }
    const copied = Object.create(null) as Record<string, number>;
    for (const key of keys) copied[key] = fields[key]!.value;
    return Object.freeze(copied) as Readonly<T>;
}
export function validStateOwner(owner: unknown, maxAddressBytes: number): owner is string {
    return typeof owner === 'string' && owner.length > 0 && utf8Size(JSON.stringify(owner)) <= maxAddressBytes;
}
export function captureStateAddress(input: unknown, maxAddressBytes: number): Readonly<{ status: 'captured'; address: StateAddress; identity: string; bytes: number }> | Rejected {
    const fields = stateFields(input);
    if (!fields || Object.keys(fields).length !== 2 || !fields.namespace || !fields.key) return rejectState('INVALID_INPUT');
    const namespace = fields.namespace.value, key = fields.key.value;
    if (typeof namespace !== 'string' || !namespace.length || typeof key !== 'string' || !key.length) return rejectState('INVALID_INPUT');
    const identity = JSON.stringify([namespace, key]), bytes = utf8Size(identity);
    if (bytes > maxAddressBytes) return rejectState('CAPACITY_EXCEEDED');
    return Object.freeze({ status: 'captured', address: Object.freeze({ namespace, key }), identity, bytes });
}
export function captureStateValue(input: unknown, limits: StateValueLimits): Readonly<{ status: 'captured'; snapshot: CapturedStateValue }> | Rejected {
    try {
        // copyJson's early byte estimate is conservative. Allow its fixed per-node
        // estimate overhead; the authoritative value budget below is exact JSON.
        const maxApproxBytes = Math.min(Number.MAX_SAFE_INTEGER, limits.maxValueBytes + 32 * limits.maxNodes);
        const value = copyJson(input, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxApproxBytes });
        const bytes = utf8Size(canonicalJson(value));
        return bytes > limits.maxValueBytes ? rejectState('CAPACITY_EXCEEDED') : Object.freeze({ status: 'captured', snapshot: Object.freeze({ value, bytes }) });
    } catch (error) { return rejectState(error instanceof SnapshotDataError && /budget|exceed/i.test(error.message) ? 'CAPACITY_EXCEEDED' : 'SERIALIZATION_FAILED'); }
}
export type DecodedState = Readonly<{ status: 'found'; snapshot: CapturedStateValue }> | Rejected;
export function decodeStateRecord(text: string, limits: StateValueLimits): DecodedState {
    if (typeof text !== 'string') return rejectState('CORRUPT');
    if (utf8Size(text) > limits.maxRecordBytes) return rejectState('CAPACITY_EXCEEDED');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return rejectState('CORRUPT'); }
    const fields = stateFields(parsed);
    if (!fields || Object.keys(fields).length !== 3 || ['version', 'updatedAt', 'value'].some(k => !Object.hasOwn(fields, k))) return rejectState('UNSUPPORTED_FORMAT');
    if (fields.version!.value !== 1) return rejectState('UNSUPPORTED_FORMAT');
    if (typeof fields.updatedAt!.value !== 'number' || !Number.isFinite(fields.updatedAt!.value)) return rejectState('CORRUPT');
    const value = fields.value!.value;
    const captured = captureStateValue(value, limits);
    return captured.status === 'rejected' ? rejectState(captured.issue.code === 'CAPACITY_EXCEEDED' ? 'CAPACITY_EXCEEDED' : 'CORRUPT') : Object.freeze({ status: 'found', snapshot: captured.snapshot });
}
export function encodeStateRecord(snapshot: CapturedStateValue, updatedAt: number, limits: StateValueLimits): Readonly<{ status: 'encoded'; text: string; bytes: number }> | Rejected {
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return rejectState('CLOCK_INVALID');
    const text = canonicalJson({ version: 1, updatedAt, value: snapshot.value }), bytes = utf8Size(text);
    return bytes > limits.maxRecordBytes ? rejectState('CAPACITY_EXCEEDED') : Object.freeze({ status: 'encoded', text, bytes });
}
const receiptIssue = (input: unknown): StateIssue | null => {
    const fields = stateFields(input);
    if (!fields || Object.keys(fields).some(k => k !== 'code' && k !== 'message') || !fields.code || typeof fields.code.value !== 'string' || !Object.hasOwn(messages, fields.code.value)) return null;
    return stateIssue(fields.code.value as StateIssueCode);
};
export function captureStateReadResult(input: unknown, maxRecordBytes: number): StateReadResult {
    const fields = stateFields(input);
    if (!fields) return failedRead('INVALID_RECEIPT');
    const keys = Object.keys(fields), status = fields.status?.value;
    if (status === 'missing' && keys.length === 1) return Object.freeze({ status });
    if (status === 'found' && keys.length === 2 && typeof fields.text?.value === 'string') {
        return utf8Size(fields.text.value) <= maxRecordBytes ? Object.freeze({ status, text: fields.text.value }) : failedRead('CAPACITY_EXCEEDED');
    }
    const issue = receiptIssue(fields.issue?.value);
    return status === 'failed' && keys.length === 2 && issue ? Object.freeze({ status, issue }) : failedRead('INVALID_RECEIPT');
}
export function captureStateMutationResult(input: unknown): StateMutationResult {
    const fields = stateFields(input);
    if (!fields) return unknownMutation();
    const keys = Object.keys(fields), status = fields.status?.value, issue = receiptIssue(fields.issue?.value);
    if (status === 'applied' && keys.length === 1) return Object.freeze({ status });
    if (status === 'failed' && keys.length === 3 && fields.effects?.value === 'none' && issue) return Object.freeze({ status, effects: 'none', issue });
    return unknownMutation();
}
export function captureStateReleaseResult(input: unknown): StateReleaseResult {
    const fields = stateFields(input);
    if (fields?.status?.value === 'released' && Object.keys(fields).length === 1) return Object.freeze({ status: 'released' });
    const issue = receiptIssue(fields?.issue?.value);
    if (fields?.status?.value === 'failed' && Object.keys(fields).length === 2 && issue) return Object.freeze({ status: 'failed', issue });
    return Object.freeze({ status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') });
}
