import type { JsonValue, SnapshotIssueCode } from './types.js';

const snapshotError = Symbol.for('@aotui/core/snapshot-data-error');

/** Parsing/normalization errors, never a business Tool error. */
export class SnapshotDataError extends Error {
    readonly [snapshotError] = true;

    constructor(
        readonly code: SnapshotIssueCode,
        readonly path: string,
        message: string,
    ) {
        super(message);
        this.name = 'SnapshotDataError';
    }
}

export function isSnapshotDataError(value: unknown): value is SnapshotDataError {
    return value instanceof Error && Object.getOwnPropertyDescriptor(value, snapshotError)?.value === true;
}

/** Internal reason for a strict JSON copy budget rejection. */
export class JsonCopyLimitError extends SnapshotDataError {
    constructor(path: string, message: string) {
        super('SNAPSHOT_SERIALIZATION_ERROR', path, message);
    }
}

export interface JsonCopyLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxApproxBytes?: number;
}

/**
 * Copy instead of freezing developer-owned objects. Strict JSON data only:
 * no getters, symbols, class instances, sparse arrays, cycles or non-finite numbers.
 * A shared subobject is valid (copied twice); only ancestor cycles are rejected.
 * Security note: an untrusted Proxy may execute traps before it is rejected.
 * This is a data contract, not a hostile-JavaScript isolation boundary.
 */
export function copyJson(input: unknown, limits: JsonCopyLimits): JsonValue {
    return createJsonCopier(limits)(input);
}

/** Several values in the same candidate can share the existing copy budget. */
export function createJsonCopier(limits: JsonCopyLimits): (input: unknown) => JsonValue {
    return createJsonWalker(limits, true);
}

/** Check a captured value against a narrower budget without building a second tree. */
export function checkJsonLimits(input: unknown, limits: JsonCopyLimits): void {
    createJsonWalker(limits, false)(input);
}

type WireLimits = JsonCopyLimits & { readonly maxCanonicalBytes: number };

export function copyWireJson(input: unknown, limits: WireLimits): JsonValue {
    return createJsonWalker(limits, true, false, limits.maxCanonicalBytes)(input);
}

/** Validate bounded JSON and report whether the checked tree is frozen. */
export function checkWireJson(input: unknown, limits: WireLimits, freeze = false): boolean {
    const ownership = { frozen: true };
    createJsonWalker(limits, false, freeze, limits.maxCanonicalBytes, ownership)(input);
    return ownership.frozen;
}

function createJsonWalker(limits: JsonCopyLimits, clone: boolean, freeze = false, maxWireBytes?: number,
    ownership?: { frozen: boolean }): (input: unknown) => JsonValue {
    const ancestors = new Set<object>();
    let nodes = 0;
    let measuredBytes = 0;
    const wire = maxWireBytes !== undefined;
    const byteLimit = maxWireBytes ?? limits.maxApproxBytes ?? Number.MAX_SAFE_INTEGER;
    function reserve(bytes: number, path: string): void {
        measuredBytes += bytes;
        if (measuredBytes > byteLimit) {
            throw new JsonCopyLimitError(path, wire ? 'Encoded JSON exceeds the byte limit' : 'Approximate input byte budget exceeded');
        }
    }
    function walk(value: unknown, path: string, depth: number): JsonValue {
        if (!wire) reserve(2, path);
        if (++nodes > limits.maxNodes) {
            throw new JsonCopyLimitError(path, 'Node budget exceeded');
        }
        if (depth > limits.maxDepth) {
            throw new JsonCopyLimitError(path, 'Depth budget exceeded');
        }
        if (typeof value === 'string') {
            if (value.length > byteLimit) {
                throw new JsonCopyLimitError(path, 'String exceeds input byte budget');
            }
            reserve(utf8Size(wire ? JSON.stringify(value) : value), path);
            return value;
        }
        if (value === null || typeof value === 'boolean') {
            if (wire) reserve(value === false ? 5 : 4, path);
            return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            reserve(wire ? JSON.stringify(value).length : 24, path);
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value !== 'object') {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Expected finite JSON data');
        }
        if (ancestors.has(value)) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Cyclic object reference');
        }
        if (ownership?.frozen && !freeze && !Object.isFrozen(value)) ownership.frozen = false;
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Expected plain JSON object/array');
        }
        ancestors.add(value);
        try {
            const descriptors = Object.getOwnPropertyDescriptors(value);
            const keys = Reflect.ownKeys(descriptors);
            if (keys.some(key => typeof key !== 'string')) {
                throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Symbol properties are forbidden');
            }
            if (array) {
                const length = (value as unknown[]).length;
                if (keys.length !== length + 1) {
                    throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Sparse array or extra properties');
                }
                if (wire) reserve(2 + Math.max(length - 1, 0), path);
                const result: JsonValue[] | undefined = clone ? [] : undefined;
                for (let i = 0; i < length; i++) {
                    const descriptor = descriptors[String(i)];
                    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path + '[' + i + ']', 'Invalid array element');
                    }
                    const child = walk(descriptor.value, path + '[' + i + ']', depth + 1);
                    result?.push(child);
                }
                if (freeze) Object.freeze(value);
                return result ? Object.freeze(result) : null;
            }
            if (wire) reserve(2 + Math.max(keys.length - 1, 0), path);
            const result: Record<string, JsonValue> | undefined = clone ? Object.create(null) : undefined;
            for (const key of keys as string[]) {
                const descriptor = descriptors[key]!;
                const encodedKey = JSON.stringify(key);
                const fieldPath = path + '[' + encodedKey + ']';
                if (key.length > byteLimit) {
                    throw new JsonCopyLimitError(fieldPath, 'Object key exceeds byte budget');
                }
                reserve(wire ? utf8Size(encodedKey) + 1 : utf8Size(key) + 4, fieldPath);
                if (!descriptor.enumerable || !('value' in descriptor)) {
                    throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', fieldPath, 'Accessors/hidden properties are forbidden');
                }
                const child = walk(descriptor.value, fieldPath, depth + 1);
                if (result) Object.defineProperty(result, key, {
                    enumerable: true,
                    configurable: false,
                    writable: false,
                    value: child,
                });
            }
            if (freeze) Object.freeze(value);
            return result ? Object.freeze(result) : null;
        } finally {
            ancestors.delete(value);
        }
    }
    return input => walk(input, '$', 0);
}

/** Lossless canonical encoding of *strict* JSON data (object field order normalized). */
export function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    const record = value as Readonly<Record<string, JsonValue>>;
    return '{' + Object.keys(record).sort().map(
        key => JSON.stringify(key) + ':' + canonicalJson(record[key]!),
    ).join(',') + '}';
}

const encoder = new TextEncoder();
export function utf8Size(value: string): number {
    return encoder.encode(value).byteLength;
}

/** For diagnostics only. Equality and authorization compare canonical data, not this hash. */
export function diagnosticDigest(bytes: Uint8Array): string {
    let value = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
    }
    return 'fnv1a64:' + value.toString(16).padStart(16, '0');
}
