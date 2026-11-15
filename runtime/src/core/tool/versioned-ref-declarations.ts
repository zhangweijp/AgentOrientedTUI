import type { JsonValue } from '../snapshot/types.js';

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
