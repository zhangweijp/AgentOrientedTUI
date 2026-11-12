import type { JsonValue } from '@aotui/runtime/core';

/**
 * Export the JSON Schema portion of a TypeBox schema without invoking any
 * author-defined getters, converters, or serializers.
 *
 * TypeBox attaches non-enumerable compiler metadata to Schema nodes. The
 * exporter removes only metadata it knows is representational, and preserves
 * ordinary JSON data such as `default: { "~kind": "application value" }`.
 */

export type TypeBoxSchemaExportErrorCode =
    | 'TOOL_SCHEMA_INVALID'
    | 'TOOL_SCHEMA_UNSUPPORTED'
    | 'TOOL_SCHEMA_CAPACITY';

export class TypeBoxSchemaExportError extends Error {
    readonly code: TypeBoxSchemaExportErrorCode;
    readonly path: string;

    constructor(code: TypeBoxSchemaExportErrorCode, path: string, detail: string) {
        const boundedPath = path.length <= MAX_DIAGNOSTIC_PATH ? path : `…${path.slice(-(MAX_DIAGNOSTIC_PATH - 1))}`;
        super(`${code} at ${boundedPath}: ${detail}`);
        this.name = 'TypeBoxSchemaExportError';
        this.code = code;
        this.path = boundedPath;
        Object.defineProperty(this, 'reason', { value: detail });
    }
}

const MAX_DEPTH = 24;
const MAX_NODES = 5_000;
const MAX_UTF8_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_PATH = 240;
const encoder = new TextEncoder();

type Position = 'schema' | 'schema-map' | 'schema-array' | 'data';

const TYPEBOX_KINDS = new Set([
    'Any', 'Array', 'BigInt', 'Boolean', 'Call', 'Constructor', 'Cyclic', 'Deferred', 'Dependent',
    'Enum', 'ExtendsFalse', 'ExtendsTrue', 'ExtendsUnion', 'Function', 'Generic', 'Identifier',
    'Inferrable', 'Infer', 'Integer', 'Intersect', 'Literal', 'Never', 'Null', 'Number', 'Object',
    'Parameter', 'Record', 'Ref', 'Rest', 'String', 'Symbol', 'TemplateLiteral', 'This', 'Tuple',
    'Undefined', 'Union', 'Unknown', 'Void',
]);

const SCHEMA_MAP_KEYS = new Set([
    'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
]);
const SCHEMA_ARRAY_KEYS = new Set([
    'allOf', 'anyOf', 'oneOf', 'prefixItems',
]);
const SCHEMA_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'items',
    'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

interface Budget {
    nodes: number;
    bytes: number;
    readonly active: WeakSet<object>;
}

function fail(code: TypeBoxSchemaExportErrorCode, path: string, detail: string): never {
    throw new TypeBoxSchemaExportError(code, path, detail);
}

function encodedStringBytes(value: string, budget: Budget, path: string): number {
    // Every UTF-16 code unit contributes at least one byte to a JSON string.
    // Reject clearly oversized values before allocating escaped text or an
    // encoder buffer for an arbitrarily large declaration.
    if (value.length > MAX_UTF8_BYTES - budget.bytes) {
        fail('TOOL_SCHEMA_CAPACITY', path, `Export exceeds ${MAX_UTF8_BYTES} UTF-8 bytes`);
    }
    // JSON.stringify is applied only to a primitive string. It cannot invoke
    // application properties, `toJSON`, or accessors, and is used only to
    // count the JSON-encoded size; the value is never parsed back.
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return Number.POSITIVE_INFINITY;
    return encoder.encode(encoded).byteLength;
}

function propertyPath(path: string, key: string): string {
    const segment = key.length > 56 ? `${key.slice(0, 36)}…(${key.length} chars)` : key;
    const candidate = /^[A-Za-z_$~][\w$~-]*$/.test(segment)
        ? `${path}.${segment}`
        : `${path}[${JSON.stringify(segment)}]`;
    return candidate.length <= MAX_DIAGNOSTIC_PATH
        ? candidate
        : `…${candidate.slice(-(MAX_DIAGNOSTIC_PATH - 1))}`;
}

function addBytes(budget: Budget, bytes: number, path: string): void {
    budget.bytes += bytes;
    if (budget.bytes > MAX_UTF8_BYTES) {
        fail('TOOL_SCHEMA_CAPACITY', path, `Export exceeds ${MAX_UTF8_BYTES} UTF-8 bytes`);
    }
}

function addNode(budget: Budget, depth: number, path: string): void {
    if (depth > MAX_DEPTH) fail('TOOL_SCHEMA_CAPACITY', path, `Export exceeds depth ${MAX_DEPTH}`);
    budget.nodes++;
    if (budget.nodes > MAX_NODES) fail('TOOL_SCHEMA_CAPACITY', path, `Export exceeds ${MAX_NODES} values`);
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function childPosition(position: Position, key: string): Position {
    if (position === 'schema' && key === 'x-aotui-ref-value') return 'schema';
    if (position === 'schema' && SCHEMA_MAP_KEYS.has(key)) return 'schema-map';
    if (position === 'schema' && SCHEMA_ARRAY_KEYS.has(key)) return 'schema-array';
    if (position === 'schema' && SCHEMA_KEYS.has(key)) return 'schema';
    if (position === 'schema' && key === 'items') return 'schema';
    return 'data';
}

function copyValue(value: unknown, position: Position, path: string, depth: number, budget: Budget): unknown {
    addNode(budget, depth, path);

    if (value === null) {
        addBytes(budget, 4, path);
        return null;
    }
    if (typeof value === 'boolean') {
        addBytes(budget, value ? 4 : 5, path);
        return value;
    }
    if (typeof value === 'string') {
        addBytes(budget, encodedStringBytes(value, budget, path), path);
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('TOOL_SCHEMA_INVALID', path, 'Non-finite numbers are not JSON values');
        const jsonNumber = Object.is(value, -0) ? '0' : String(value);
        addBytes(budget, jsonNumber.length, path);
        return value;
    }
    if (typeof value !== 'object') {
        fail('TOOL_SCHEMA_INVALID', path, `Unsupported value type: ${typeof value}`);
    }

    if (budget.active.has(value)) fail('TOOL_SCHEMA_INVALID', path, 'Cyclic Schema or data is not supported');
    budget.active.add(value);
    try {
        if (Array.isArray(value)) return copyArray(value, position, path, depth, budget);
        if (!isPlainObject(value)) fail('TOOL_SCHEMA_INVALID', path, 'Only plain objects can be exported');
        return copyObject(value, position, path, depth, budget);
    } finally {
        budget.active.delete(value);
    }
}

function copyArray(input: unknown[], position: Position, path: string, depth: number, budget: Budget): readonly unknown[] {
    if (Object.getPrototypeOf(input) !== Array.prototype) {
        fail('TOOL_SCHEMA_INVALID', path, 'Array subclasses and custom prototypes are not supported');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) {
        fail('TOOL_SCHEMA_INVALID', path, 'Symbol properties are not supported');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || length < 0) fail('TOOL_SCHEMA_INVALID', path, 'Malformed array length');
    for (const key of Object.keys(descriptors)) {
        if (key === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
            fail('TOOL_SCHEMA_INVALID', propertyPath(path, key), 'Arrays may contain only indexed entries');
        }
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !('value' in descriptor)) {
            fail('TOOL_SCHEMA_INVALID', propertyPath(path, key), 'Array entries must be enumerable data properties');
        }
    }
    if (Object.keys(descriptors).filter(key => key !== 'length').length !== length) {
        fail('TOOL_SCHEMA_INVALID', path, 'Sparse arrays are not supported');
    }

    addBytes(budget, 2 + Math.max(0, length - 1), path);
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)]!;
        const nextPosition = position === 'schema-array' ? 'schema' : 'data';
        result.push(copyValue(descriptor.value, nextPosition, `${path}[${index}]`, depth + 1, budget));
    }
    return Object.freeze(result);
}

function copyObject(input: object, position: Position, path: string, depth: number, budget: Budget): Readonly<Record<string, unknown>> {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const refSchema = position === 'schema' && descriptors['x-aotui-ref-value'] !== undefined;
    const refWitness = refSchema && descriptors.type?.value === 'string' &&
        descriptors['~unsafe']?.value === null && descriptors['~unsafe']?.enumerable === false;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol')) fail('TOOL_SCHEMA_INVALID', path, 'Symbol properties are not supported');

    for (const rawKey of keys) {
        const key = rawKey as string;
        const descriptor = descriptors[key]!;
        const fieldPath = propertyPath(path, key);
        if (!('value' in descriptor)) fail('TOOL_SCHEMA_INVALID', fieldPath, 'Accessors are not supported');
        if (!descriptor.enumerable) {
            if (position !== 'schema') fail('TOOL_SCHEMA_INVALID', fieldPath, 'Hidden data properties are not supported');
            if (key === '~kind') {
                if (typeof descriptor.value !== 'string' || !TYPEBOX_KINDS.has(descriptor.value)) {
                    fail('TOOL_SCHEMA_UNSUPPORTED', fieldPath, 'Unknown TypeBox Schema kind');
                }
                continue;
            }
            if (key === '~optional' || key === '~readonly') {
                if (descriptor.value !== true) fail('TOOL_SCHEMA_INVALID', fieldPath, 'Malformed TypeBox metadata');
                continue;
            }
            if (key === '~unsafe' && descriptor.value === null && refWitness) continue;
            if (key.startsWith('~')) fail('TOOL_SCHEMA_UNSUPPORTED', fieldPath, 'TypeBox metadata has runtime semantics and cannot be exported');
            fail('TOOL_SCHEMA_INVALID', fieldPath, 'Hidden properties are not supported');
        }
    }

    if (refSchema && !refWitness) {
        fail('TOOL_SCHEMA_INVALID', path, 'Ref value annotations require a TypeBox static value witness');
    }

    addBytes(budget, 2 + Math.max(0, keys.length - 1), path);
    const output: Record<string, unknown> = {};
    for (const rawKey of keys) {
        const key = rawKey as string;
        const descriptor = descriptors[key]!;
        if (position === 'schema' && !descriptor.enumerable &&
            (key === '~kind' || key === '~optional' || key === '~readonly' || key === '~unsafe' && descriptor.value === null && refWitness)) continue;

        const keyPath = propertyPath(path, key);
        addBytes(budget, encodedStringBytes(key, budget, keyPath) + 1, keyPath);
        const nextPosition = position === 'schema'
            ? key === 'items' && Array.isArray(descriptor.value) ? 'schema-array' : childPosition(position, key)
            : position === 'schema-map' ? 'schema' : 'data';
        Object.defineProperty(output, key, {
            value: copyValue(descriptor.value, nextPosition, keyPath, depth + 1, budget),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }

    if (position === 'schema' && Object.hasOwn(output, 'enum') && !Object.hasOwn(output, 'type')) {
        const values = output.enum;
        if (Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string')) {
            Object.defineProperty(output, 'type', {
                value: 'string', enumerable: true, configurable: true, writable: true,
            });
            addNode(budget, depth + 1, propertyPath(path, 'type'));
            addNode(budget, depth + 2, propertyPath(path, 'type'));
            const typePath = propertyPath(path, 'type');
            addBytes(budget, encodedStringBytes('type', budget, typePath) + 1 + encodedStringBytes('string', budget, typePath) + 1, typePath);
        }
    }

    // The ordinary Runtime profile represents opaque JSON objects as
    // `{ type: 'object' }`. It is equivalent only when there are no field
    // rules, no required keys, and arbitrary properties remain allowed.
    if (position === 'schema' && depth > 0 && output.type === 'object' &&
        output.properties !== null && typeof output.properties === 'object' && !Array.isArray(output.properties) &&
        Object.keys(output.properties).length === 0 &&
        (output.required === undefined || Array.isArray(output.required) && output.required.length === 0) &&
        (output.additionalProperties === undefined || output.additionalProperties === true)) {
        delete output.properties;
        delete output.required;
        delete output.additionalProperties;
    }
    return Object.freeze(output);
}

/** Export a fresh deeply frozen JSON Schema node. */
export function exportTypeBoxValueSchema(schema: unknown): Readonly<Record<string, JsonValue>> {
    const budget: Budget = { nodes: 0, bytes: 0, active: new WeakSet() };
    const exported = copyValue(schema, 'schema', '$', 0, budget);
    if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
        fail('TOOL_SCHEMA_INVALID', '$', 'Expected a TypeBox Schema object');
    }
    return exported as Readonly<Record<string, JsonValue>>;
}

export function exportTypeBoxSchema(schema: unknown): Readonly<Record<string, JsonValue>> {
    const exported = exportTypeBoxValueSchema(schema);
    if (exported.type !== 'object' || !exported.properties || typeof exported.properties !== 'object' ||
        Array.isArray(exported.properties)) {
        fail('TOOL_SCHEMA_INVALID', '$', 'Tool inputSchema must be an object Schema with a properties map');
    }
    return exported;
}
