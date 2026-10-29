import type { JsonValue, SnapshotIssueCode } from './types.js';

/** Parsing/normalization errors, never a business Tool error. */
export class SnapshotDataError extends Error {
    constructor(
        readonly code: SnapshotIssueCode,
        readonly path: string,
        message: string,
    ) {
        super(message);
        this.name = 'SnapshotDataError';
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
    const ancestors = new Set<object>();
    let nodes = 0;
    let approxBytes = 0;
    const byteLimit = limits.maxApproxBytes ?? Number.MAX_SAFE_INTEGER;
    function reserve(bytes: number, path: string): void {
        approxBytes += bytes;
        if (approxBytes > byteLimit) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Approximate input byte budget exceeded');
        }
    }
    function copy(value: unknown, path: string, depth: number): JsonValue {
        reserve(2, path); // minimum structural overhead; final canonical bytes are checked separately
        if (++nodes > limits.maxNodes) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Node budget exceeded');
        }
        if (depth > limits.maxDepth) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Depth budget exceeded');
        }
        if (typeof value === 'string') {
            if (value.length > byteLimit) {
                throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'String exceeds input byte budget');
            }
            reserve(utf8Size(value), path);
            return value;
        }
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) {
            reserve(24, path);
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value !== 'object') {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Expected finite JSON data');
        }
        if (ancestors.has(value)) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Cyclic object reference');
        }
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
                const result: JsonValue[] = [];
                for (let i = 0; i < length; i++) {
                    const descriptor = descriptors[String(i)];
                    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path + '[' + i + ']', 'Invalid array element');
                    }
                    result.push(copy(descriptor.value, path + '[' + i + ']', depth + 1));
                }
                return Object.freeze(result);
            }
            const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
            for (const key of keys as string[]) {
                const descriptor = descriptors[key]!;
                const fieldPath = path + '[' + JSON.stringify(key) + ']';
                if (key.length > byteLimit) {
                    throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', fieldPath, 'Object key exceeds byte budget');
                }
                reserve(utf8Size(key) + 4, fieldPath);
                if (!descriptor.enumerable || !('value' in descriptor)) {
                    throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', fieldPath, 'Accessors/hidden properties are forbidden');
                }
                Object.defineProperty(result, key, {
                    enumerable: true,
                    configurable: false,
                    writable: false,
                    value: copy(descriptor.value, fieldPath, depth + 1),
                });
            }
            return Object.freeze(result);
        } finally {
            ancestors.delete(value);
        }
    }
    return copy(input, '$', 0);
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

export function utf8Size(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

/** For diagnostics only. Equality and authorization compare canonical data, not this hash. */
export function diagnosticDigest(canonical: string): string {
    const bytes = new TextEncoder().encode(canonical);
    let value = 0xcbf29ce484222325n;
    for (const byte of bytes) {
        value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
    }
    return 'fnv1a64:' + value.toString(16).padStart(16, '0');
}
