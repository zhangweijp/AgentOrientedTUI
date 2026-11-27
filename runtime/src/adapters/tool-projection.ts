import { canonicalJson, checkWireJson, copyWireJson, DEFAULT_SNAPSHOT_LIMITS, SnapshotDataError } from '@aotui/core';
import type { InteractionIssue, JsonValue, ObservationSource, ObservedRef, ObservedTool } from '@aotui/core';
import { encodeRefLiteral, REF_ADDRESS_PREFIX } from '@aotui/core/host';

type JsonObject = Readonly<Record<string, JsonValue>>;
export interface PresentedRef {
    readonly source: Pick<ObservationSource, 'appId' | 'instanceId'>;
    readonly ref: ObservedRef;
}

const REF_KIND = 'x-aotui-ref-kind';
const hint = 'A compatible $ref.app_id.view_id.ref_id address is also accepted.';
/** All generated address branches use this pattern, never an observed Ref shape. */
export const NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA = Object.freeze({
    type: 'string', description: 'A complete $ref.app_id.view_id.ref_id address.',
    pattern: '^\\$ref\\.[A-Za-z0-9_]+\\.[A-Za-z0-9_]+\\.[A-Za-z_][A-Za-z0-9_]*([.\\[][\\s\\S]*)?$',
});
const budgets = {
    maxDepth: DEFAULT_SNAPSHOT_LIMITS.maxDepth,
    maxNodes: DEFAULT_SNAPSHOT_LIMITS.maxNodes,
    maxCanonicalBytes: DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes,
};
const object = (value: JsonValue | undefined): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const pathOf = (path: string, name: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? path + '.' + name : path + '[' + JSON.stringify(name) + ']';

export class ModelToolSchemaError extends Error implements InteractionIssue {
    readonly code = 'MODEL_TOOL_SCHEMA_UNSUPPORTED';
    constructor(readonly path: string, message: string) { super(message); }
}
function unsupported(path: string, message: string): never {
    throw new ModelToolSchemaError(path, message);
}
function annotation(key: string) { return key === 'description' || key === 'default'; }
function unconstrained(schema: JsonObject, type?: string) {
    return Object.keys(schema).every(key => annotation(key) || key === 'type' && schema.type === type)
        && (type === undefined ? schema.type === undefined : schema.type === type);
}
function pureUnion(schema: JsonObject): boolean {
    return Array.isArray(schema.anyOf) && Object.keys(schema).every(key => key === 'anyOf' || annotation(key));
}
function stringLiteral(value: JsonValue) { return typeof value === 'string' ? encodeRefLiteral(value) : value; }

/** Only exact duplicates and obvious containment in {} / string are reduced. */
function reduce(branches: readonly JsonObject[]): JsonObject[] {
    const unique = [...new Map(branches.map(branch => [canonicalJson(branch), branch])).values()];
    const universal = unique.find(branch => unconstrained(branch));
    if (universal) return [universal];
    const string = unique.find(branch => unconstrained(branch, 'string'));
    if (!string) return unique;
    return unique.filter(branch => branch === string || !(branch.type === 'string' ||
        typeof branch.const === 'string' || Array.isArray(branch.enum) && branch.enum.every(value => typeof value === 'string')));
}

function alternatives(branches: readonly JsonObject[], field: JsonObject, description?: string): JsonObject {
    const reduced = reduce(branches);
    return { ...(reduced.length === 1 ? reduced[0]! : { anyOf: reduced }),
        ...(description === undefined ? {} : { description }),
        ...(Object.hasOwn(field, 'default') ? { default: field.default! } : {}) };
}

function addressOnly(field: JsonObject): JsonObject {
    const kind = field[REF_KIND] as string;
    const label = kind.length <= 128 ? kind + ' Ref' : 'type-matched Ref';
    const description = typeof field.description === 'string' ? field.description + ' ' : '';
    return { ...NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA,
        description: description + 'Provide a published ' + label + ' address using $ref.app_id.view_id.ref_id.' };
}

function addressSlot(field: JsonObject): JsonObject {
    if (unconstrained(field) || unconstrained(field, 'string')) return field;
    const description = (typeof field.description === 'string' ? field.description + ' ' : '') + hint;
    const branches = pureUnion(field) ? field.anyOf as readonly JsonObject[] : [field];
    return alternatives([...branches, NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA], field, description);
}

/** Compile literal spellings at exactly the decoded positions. Nested business JSON is untouched. */
function wireLiterals(schema: JsonObject, directItems: boolean, path: string): JsonObject {
    const field = { ...schema };
    const literal = (value: JsonValue) => directItems && Array.isArray(value) ? value.map(stringLiteral) : stringLiteral(value);
    if (Object.hasOwn(schema, 'const')) field.const = literal(schema.const!);
    if (Object.hasOwn(schema, 'default')) field.default = literal(schema.default!);
    if (Array.isArray(schema.enum)) field.enum = schema.enum.map(literal);
    if (typeof schema.maxLength === 'number' && schema.maxLength >= REF_ADDRESS_PREFIX.length)
        field.maxLength = schema.maxLength + 1;

    const hasArrayChoice = Array.isArray(schema.const) || Array.isArray(schema.enum) && schema.enum.some(Array.isArray);
    if (Array.isArray(schema.anyOf)) {
        // Do not distribute arbitrary intersecting constraints across resolved-array alternatives.
        if (directItems && !pureUnion(schema) && (schema.type === 'array' || schema.type === undefined &&
            (hasArrayChoice || Object.hasOwn(schema, 'const') || Object.hasOwn(schema, 'enum'))))
            unsupported(path + '.anyOf', 'Intersecting array/choice alternatives exceed the standard generation profile.');
        field.anyOf = schema.anyOf.map((branch, index) => {
            if (!object(branch)) unsupported(path + '.anyOf[' + index + ']', 'Expected a schema object.');
            return wireLiterals(branch, directItems, path + '.anyOf[' + index + ']');
        });
    }
    if (!directItems) return field;

    const element = (item: JsonValue, itemPath: string): JsonObject => {
        if (!object(item)) unsupported(itemPath, 'Expected an element schema object.');
        return typeof item[REF_KIND] === 'string' ? addressOnly(item) : addressSlot(wireLiterals(item, false, itemPath));
    };
    if (object(schema.items)) field.items = element(schema.items, path + '.items');
    if (Array.isArray(schema.prefixItems)) field.prefixItems = schema.prefixItems.map((item, index) =>
        element(item, path + '.prefixItems[' + index + ']'));

    if (schema.type === 'array' && (Object.hasOwn(schema, 'const') || Object.hasOwn(schema, 'enum'))) {
        // The widened array branch contains the original wire-literal array branch:
        // same type, lengths and compiled element constraints, without resolved-array choices.
        // A fixed empty tuple has no directly decoded elements and needs no widening.
        if (schema.items !== false || Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
            delete field.const;
            delete field.enum;
        }
    } else if (schema.type === undefined && hasArrayChoice) {
        // Untyped choices can also contain ordinary objects/scalars. Retain those literals.
        if (Object.hasOwn(schema, 'const') && Object.hasOwn(schema, 'enum'))
            unsupported(path + '.enum', 'Intersecting untyped array choices exceed the standard generation profile.');
        const array = { type: 'array', items: {} };
        if (Array.isArray(schema.const)) return alternatives([array], field, typeof field.description === 'string' ? field.description : undefined);
        const rest = (field.enum as readonly JsonValue[]).filter(value => !Array.isArray(value));
        return alternatives([...(rest.length ? [{ ...field, enum: rest }] : []), array], field,
            typeof field.description === 'string' ? field.description : undefined);
    }
    return field;
}

/** Only the sealed business declaration participates, never observation or receiver state. */
export function projectNativeToolSchema(tool: Pick<ObservedTool, 'inputSchema' | 'multiplicity' | 'viewType'>): JsonObject {
    try {
        const input = tool.inputSchema;
        checkWireJson(input, budgets);
        if (!object(input) || input.type !== 'object' || !object(input.properties) || !Array.isArray(input.required))
            unsupported('$', 'Expected a sealed business parameter object.');
        if (Object.hasOwn(input.properties, 'view_id'))
            unsupported('$.properties.view_id', 'view_id is reserved for the receiving View.');
        const properties = Object.fromEntries(Object.entries(input.properties).map(([name, schema]) => {
            const path = pathOf('$.properties', name);
            if (!object(schema)) unsupported(path, 'Expected a business parameter schema.');
            if (typeof schema[REF_KIND] === 'string') return [name, addressOnly(schema)];
            const field = wireLiterals(schema, true, path);
            const addressArray = object(schema.items) && typeof schema.items[REF_KIND] === 'string';
            return [name, addressArray ? field : addressSlot(field)];
        }));
        const multiple = tool.multiplicity === 'multiple';
        return copyWireJson({
            ...input, properties: { ...(multiple ? { view_id: { type: 'string', description: 'Receiving ' + tool.viewType + ' page XML view_id.' } } : {}), ...properties },
            required: multiple ? ['view_id', ...input.required] : input.required,
        }, budgets) as JsonObject;
    } catch (error) {
        if (error instanceof SnapshotDataError) unsupported(error.path, error.message);
        throw error;
    }
}
