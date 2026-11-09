import { VIEW_TYPE_PARAMETERS_MODE } from './ordinary-parameter-contract.js';
import { SnapshotDataError } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { compileOrdinaryProfile } from './ordinary-parameter-profile.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
const object = (value: JsonValue | undefined): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function refField(field: JsonValue | undefined): field is JsonObject {
    return object(field) && Object.hasOwn(field, 'x-aotui-ref-value');
}

/** Enumerate validated top-level Ref selections in declaration and input order. */
export function selectedRefParameters(fields: JsonObject, args: JsonObject): readonly Readonly<{
    param: string; field: JsonObject; refId: JsonValue; index?: number;
}>[] {
    return Object.entries(fields).flatMap(([param, field]) => {
        if (!Object.hasOwn(args, param)) return [];
        if (refField(field)) return [{ param, field, refId: args[param] as JsonValue }];
        if (object(field) && field.type === 'array' && refField(field.items)) {
            const item = field.items;
            return (args[param] as readonly JsonValue[]).map((refId, index) => ({ param, field: item, refId, index }));
        }
        return [];
    });
}

/** Admission accepts normalized ordinary profiles only; it never grants execution. */
export function validateVersionedToolRefDeclarations(schema: JsonValue, path = '$.inputSchema'): boolean {
    const compiled = compileOrdinaryProfile(schema);
    if (!compiled) throw new SnapshotDataError('REF_CONTRACT_UNSUPPORTED', path, 'Invalid or retired parameter profile');
    return compiled.revision === VIEW_TYPE_PARAMETERS_MODE &&
        Object.values(compiled.schema.properties as Readonly<Record<string, JsonValue>>)
            .some(field => refField(field) || object(field) && refField(field.items));
}
