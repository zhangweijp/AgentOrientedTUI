import type { JsonValue } from '../snapshot/types.js';
import type { RefPath } from '../tool/ref-parameters.js';

const record = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, JsonValue>> : undefined;

/** Project the selected schema without retaining the enclosing keys or array bounds. */
export function programRefSchema(schema: JsonValue | undefined, path: RefPath): JsonValue | undefined {
    if (path.length === 0) return schema;
    const node = record(schema);
    if (!node) return;
    if (Array.isArray(node.anyOf)) {
        const branches = node.anyOf.map(branch => programRefSchema(branch, path));
        if (branches.every(branch => branch !== undefined)) return { anyOf: branches };
        return;
    }
    const [key, ...rest] = path;
    if (typeof key === 'number' && node.type === 'array') {
        return programRefSchema(node.items === false
            ? Array.isArray(node.prefixItems) ? node.prefixItems[key] : undefined
            : node.items, rest);
    }
    if (typeof key === 'string' && node.type === 'object') {
        const fields = record(node.properties);
        if (fields && Object.hasOwn(fields, key)) return programRefSchema(fields[key], rest);
    }
}
