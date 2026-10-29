import { SnapshotDataError } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';

type ObjectJson = Readonly<Record<string, JsonValue>>;
function record(value: JsonValue | undefined): value is ObjectJson {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(code: 'REF_DECLARATION_INVALID' | 'REF_CONTRACT_UNSUPPORTED', path: string, message: string): never {
    throw new SnapshotDataError(code, path, code + ': ' + message);
}
function invalid(path: string, message: string): never {
    return fail('REF_DECLARATION_INVALID', path, message);
}
function checkMetadata(value: JsonValue, path: string): void {
    if (!record(value) || Object.keys(value).some(key => !['version', 'kind', 'owner', 'refType'].includes(key))) {
        invalid(path, 'Expected an exact snapshot-value declaration');
    }
    if (typeof value.version !== 'number' || typeof value.kind !== 'string' || typeof value.owner !== 'string') {
        invalid(path, 'Declaration version, kind and owner have invalid types');
    }
    if (value.version !== 1 || value.kind !== 'snapshot-value' || value.owner !== 'tool-target') {
        fail('REF_CONTRACT_UNSUPPORTED', path, 'Unsupported Ref declaration version, kind or owner');
    }
    if (Object.hasOwn(value, 'refType') && (typeof value.refType !== 'string' || !value.refType.trim())) {
        invalid(path, 'refType must be a nonempty string');
    }
}

/** Presence only, without evaluating ParamDef getters. Semantics are checked after copyJson. */
export function hasRefParamDeclaration(params: unknown): boolean {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
    let found = false;
    for (const field of Object.values(Object.getOwnPropertyDescriptors(params))) {
        if (!('value' in field)) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$', 'Accessors/hidden properties are forbidden');
        }
        const value = field.value;
        if (value && typeof value === 'object' &&
            (Object.hasOwn(value, 'refSource') || Object.hasOwn(value, 'x-aotui-ref'))) found = true;
    }
    return found;
}

/** Internal: caller supplies data already checked by copyJson, never live developer objects. */
export function refParamDeclaration(field: JsonValue, path: string): ObjectJson | undefined {
    if (!record(field)) return undefined;
    if (Object.hasOwn(field, 'x-aotui-ref')) invalid(path, 'SDK parameters must use refSource');
    if (!Object.hasOwn(field, 'refSource')) return undefined;
    if (typeof field.refSource !== 'string') invalid(path, 'refSource must be a supported string');
    if (field.refSource !== 'snapshot-value-v1') fail('REF_CONTRACT_UNSUPPORTED', path, 'Unsupported refSource');
    if (field.type !== 'reference' || Object.keys(field).some(key =>
        !['type', 'required', 'desc', 'refType', 'refSource'].includes(key))) {
        invalid(path, 'Only a top-level single reference parameter can opt in');
    }
    if (Object.hasOwn(field, 'required') && typeof field.required !== 'boolean' ||
        Object.hasOwn(field, 'desc') && typeof field.desc !== 'string') {
        invalid(path, 'Invalid parameter field type');
    }
    const metadata = Object.freeze({ version: 1, kind: 'snapshot-value', owner: 'tool-target',
        ...(Object.hasOwn(field, 'refType') ? { refType: field.refType! } : {}) });
    checkMetadata(metadata, path);
    return metadata;
}

export function validateRefParams(params: JsonValue): boolean {
    if (!record(params)) return false;
    let found = false;
    for (const [name, field] of Object.entries(params)) {
        if (refParamDeclaration(field, '$.params[' + JSON.stringify(name) + ']')) found = true;
    }
    return found;
}

/** Internal: inspect an already copied public Schema; return true only for valid declarations. */
export function validateToolRefDeclarations(
    schema: JsonValue, isMutating: boolean, viewOwned = true, path = '$.inputSchema',
): boolean {
    let found = false;
    function visit(value: JsonValue, topProperty: boolean, at: string): void {
        if (Array.isArray(value)) {
            value.forEach((child, index) => visit(child, false, at + '[' + index + ']'));
            return;
        }
        if (!record(value)) return;
        if (Object.hasOwn(value, 'x-aotui-ref')) {
            if (!topProperty || value.type !== 'string' || Object.keys(value).some(key =>
                !['type', 'description', 'x-aotui-ref'].includes(key)) ||
                Object.hasOwn(value, 'description') && typeof value.description !== 'string') {
                invalid(at, 'Ref declarations require an exact top-level string property');
            }
            checkMetadata(value['x-aotui-ref']!, at + '.x-aotui-ref');
            found = true;
        }
        for (const [key, child] of Object.entries(value)) {
            // Literal values and dependentRequired property-name lists are not subschemas.
            if (['x-aotui-ref', 'default', 'const', 'enum', 'examples', 'dependentRequired'].includes(key)) continue;
            const childPath = at + '[' + JSON.stringify(key) + ']';
            if (['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas', 'dependencies'].includes(key) && record(child)) {
                for (const [name, nested] of Object.entries(child)) {
                    // Legacy dependencies arrays contain property names; other members are schemas.
                    if (key === 'dependencies' && Array.isArray(nested)) continue;
                    visit(nested, key === 'properties' && value === schema, childPath + '[' + JSON.stringify(name) + ']');
                }
            } else visit(child, false, childPath);
        }
    }
    visit(schema, false, path);
    if (!found) return false;
    if (!record(schema) || schema.type !== 'object' || !record(schema.properties) ||
        Object.keys(schema).some(key => !['type', 'properties', 'required', 'description', 'additionalProperties'].includes(key)) ||
        Object.hasOwn(schema, 'description') && typeof schema.description !== 'string' ||
        Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
        invalid(path, 'Ref declarations require a simple object Schema');
    }
    const properties = schema.properties;
    if (Object.hasOwn(schema, 'required') && (!Array.isArray(schema.required) ||
        schema.required.some(name => typeof name !== 'string' || !Object.hasOwn(properties, name)))) {
        invalid(path, 'Invalid required parameter names');
    }
    if (!viewOwned) fail('REF_CONTRACT_UNSUPPORTED', path, 'Ref declarations require a View-local Tool');
    if (isMutating !== false) invalid(path, 'Ref declarations require an explicitly read-only Tool');
    return true;
}
