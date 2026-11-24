import type { JsonValue } from '../snapshot/types.js';
import type { RefPath } from '../tool/ref-path.js';

const record = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, JsonValue>> : undefined;

/** Project the selected schema without retaining the enclosing keys or array bounds. */
export function declaredRefSchema(schema: JsonValue | undefined, path: RefPath): JsonValue | undefined {
    if (path.length === 0) return schema;
    const node = record(schema);
    if (!node) return;
    const [key, ...rest] = path;
    if (typeof key === 'number' && node.type === 'array') {
        const declared = declaredRefSchema(node.items === false
            ? Array.isArray(node.prefixItems) ? node.prefixItems[key] : undefined
            : node.items, rest);
        if (declared !== undefined) return declared;
    }
    if (typeof key === 'string' && node.type === 'object') {
        const fields = record(node.properties);
        if (fields && Object.hasOwn(fields, key)) return declaredRefSchema(fields[key], rest);
    }
    if (Array.isArray(node.anyOf)) {
        const declared = node.anyOf.map(branch => declaredRefSchema(branch, path))
            .filter((branch): branch is JsonValue => branch !== undefined);
        return declared.length > 1 ? Object.freeze({ anyOf: Object.freeze(declared) }) : declared[0];
    }
}
