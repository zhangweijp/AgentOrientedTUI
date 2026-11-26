import { checkWireJson, DEFAULT_SNAPSHOT_LIMITS, SnapshotDataError } from '@aotui/core';
import type { JsonValue, ObservationSource, ObservedRef, ObservedTool, RefConsumer, ViewIdentity } from '@aotui/core';
import { encodeRefLiteral, REF_ADDRESS_PREFIX, refConsumerAllowed, scopeAllows } from '@aotui/core/host';

type JsonObject = Readonly<Record<string, JsonValue>>;
export interface PresentedRef {
    readonly source: Pick<ObservationSource, 'appId' | 'instanceId'>;
    readonly ref: ObservedRef;
}

const REF_KIND = 'x-aotui-ref-kind';
const hint = 'A compatible $ref.app_id.view_id.ref_id address is also accepted.';
/** The adapter-added address alternative. Script signatures can express it as a template literal. */
export const NATIVE_REF_ADDRESS_SCHEMA = Object.freeze({ type: 'string', description: 'A complete $ref.app_id.view_id.ref_id address.' });
export const NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA = Object.freeze({ ...NATIVE_REF_ADDRESS_SCHEMA,
    pattern: '^\\$ref\\.[A-Za-z0-9_]+\\.[A-Za-z0-9_]+\\.[A-Za-z_][A-Za-z0-9_]*([.\\[][\\s\\S]*)?$' });
const budgets = {
    maxDepth: DEFAULT_SNAPSHOT_LIMITS.maxDepth,
    maxNodes: DEFAULT_SNAPSHOT_LIMITS.maxNodes,
    maxCanonicalBytes: DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes,
};
const object = (value: JsonValue | undefined): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function valueType(value: JsonValue): string {
    return value === null ? 'null' : Array.isArray(value) ? 'array'
        : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
}

/** Include types at declared Ref paths, including item schemas of currently empty arrays. */
function refShapes(schema: JsonValue, shapes: Set<string>): void {
    if (!object(schema)) return;
    for (const shape of types(schema)) shapes.add(shape);
    if (Array.isArray(schema.anyOf)) for (const branch of schema.anyOf) refShapes(branch, shapes);
    if (Array.isArray(schema.prefixItems)) for (const item of schema.prefixItems) refShapes(item, shapes);
    if (object(schema.items)) refShapes(schema.items, shapes);
    if (object(schema.properties)) for (const property of Object.values(schema.properties)) refShapes(property, shapes);
    if (object(schema.additionalProperties)) refShapes(schema.additionalProperties, shapes);
    else if (schema.type === 'object' && schema.additionalProperties !== false) shapes.add('*');
    if (schema.type === 'array' && schema.items === undefined && schema.prefixItems === undefined) shapes.add('*');
}

function types(schema: JsonObject): Set<string> {
    if (typeof schema.type === 'string') return new Set([schema.type]);
    if (Object.hasOwn(schema, 'const')) return new Set([valueType(schema.const!)]);
    if (Array.isArray(schema.enum)) return new Set(schema.enum.map(valueType));
    if (Array.isArray(schema.anyOf)) return new Set(schema.anyOf.flatMap(branch => object(branch) ? [...types(branch)] : []));
    return new Set(['*']);
}
const shapeCache = new WeakMap<JsonObject, ReadonlySet<string>>();
function shapesOf(schema: JsonValue): ReadonlySet<string> {
    const cached = object(schema) ? shapeCache.get(schema) : undefined;
    if (cached) return cached;
    const shapes = new Set<string>();
    refShapes(schema, shapes);
    if (object(schema) && Object.isFrozen(schema)) shapeCache.set(schema, shapes);
    return shapes;
}

function canSelect(shapes: ReadonlySet<string>, field: JsonObject): boolean {
    return shapes.size > 0 && (shapes.has('*') || [...types(field)].some(type => shapes.has(type) ||
        type === 'number' && shapes.has('integer') || type === 'integer' && shapes.has('number')));
}

function acceptsAnyString(schema: JsonObject): boolean {
    if (schema.type !== undefined && schema.type !== 'string' || Object.hasOwn(schema, 'enum') || Object.hasOwn(schema, 'const') ||
        Object.hasOwn(schema, 'minLength') || Object.hasOwn(schema, 'maxLength')) return false;
    return !Array.isArray(schema.anyOf) || schema.anyOf.some(branch => object(branch) && acceptsAnyString(branch));
}

function addressSlot(field: JsonObject, shapes: ReadonlySet<string>): JsonObject {
    const description = typeof field.description === 'string' ? field.description + ' ' : '';
    if (typeof field[REF_KIND] === 'string') {
        const label = field[REF_KIND].length <= 128 ? field[REF_KIND] + ' Ref' : 'type-matched Ref';
        return { type: 'string', description: description + 'Provide a published ' + label + ' address using $ref.app_id.view_id.ref_id.' };
    }
    if (!canSelect(shapes, field) || acceptsAnyString(field)) return field;
    const address = types(field).has('string') ? NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA : NATIVE_REF_ADDRESS_SCHEMA;
    return { anyOf: [field, address], description: description + hint };
}

function wireLiterals(schema: JsonObject, shapes: ReadonlySet<string>, directItems: boolean): JsonObject {
    const field = { ...schema };
    const string = (value: JsonValue) => typeof value === 'string' ? encodeRefLiteral(value) : value;
    const literal = (value: JsonValue) => directItems && Array.isArray(value) ? value.map(string) : string(value);
    if (Object.hasOwn(schema, 'const')) field.const = literal(schema.const!);
    if (Object.hasOwn(schema, 'default')) field.default = literal(schema.default!);
    if (Array.isArray(schema.enum)) field.enum = schema.enum.map(literal);
    // A literal may gain one dollar sign in transit. The original bounds are checked after decoding.
    if (typeof schema.maxLength === 'number' && schema.maxLength >= REF_ADDRESS_PREFIX.length)
        field.maxLength = schema.maxLength + 1;
    if (Array.isArray(schema.anyOf)) field.anyOf = schema.anyOf.map(branch =>
        object(branch) ? wireLiterals(branch, shapes, directItems) : branch);
    if (directItems) {
        const element = (item: JsonValue) => object(item) ? addressSlot(wireLiterals(item, shapes, false), shapes) : item;
        if (object(schema.items)) field.items = element(schema.items);
        if (Array.isArray(schema.prefixItems)) field.prefixItems = schema.prefixItems.map(element);
    }
    return field;
}

function argumentSlot(schema: JsonObject, shapes: ReadonlySet<string>): JsonObject {
    const field = wireLiterals(schema, shapes, true);
    if (object(schema.items) && typeof schema.items[REF_KIND] === 'string' && !Object.hasOwn(schema, REF_KIND)) return field;
    return addressSlot(field, shapes);
}

/** Project a tool for the actual receiving mounts and Ref sources in this model request. */
export function projectNativeToolSchema(tool: ObservedTool, source: Pick<ObservationSource, 'appId' | 'instanceId'>,
    receivingViews: readonly ViewIdentity[], references: readonly PresentedRef[]): JsonObject {
    const targets: RefConsumer[] = receivingViews.map(view => ({ ...source, ...view }));
    const shapes = new Set<string>();
    for (const { source: publisher, ref } of references) {
        const sameApp = publisher.appId === source.appId && publisher.instanceId === source.instanceId;
        if (!targets.some(target => scopeAllows(ref.scope, ref.viewInstanceId, target.viewInstanceId, sameApp) &&
            refConsumerAllowed(ref.consumers, target))) continue;
        for (const shape of shapesOf(ref.valueSchema)) shapes.add(shape);
    }
    const input = tool.inputSchema;
    if (!object(input.properties) || !Array.isArray(input.required) || Object.hasOwn(input.properties, 'view_id'))
        throw new SnapshotDataError('TOOL_SCHEMA_INVALID', '$', 'Expected a business parameter object.');
    const multiple = tool.multiplicity === 'multiple';
    const properties = Object.fromEntries(Object.entries(input.properties).map(([name, schema]) => {
        if (!object(schema)) throw new SnapshotDataError('TOOL_SCHEMA_INVALID', '$.properties', 'Invalid business parameter.');
        return [name, argumentSlot(schema, shapes)];
    }));
    const result = {
        ...input, properties: { ...(multiple ? { view_id: { type: 'string', description: 'Receiving ' + tool.viewType + ' page XML view_id.' } } : {}), ...properties },
        required: multiple ? ['view_id', ...input.required] : input.required,
    };
    try { checkWireJson(result, budgets); }
    catch { throw new SnapshotDataError('TOOL_SCHEMA_CAPACITY', '$', 'The projected Tool schema exceeds the byte limit.'); }
    return result;
}
