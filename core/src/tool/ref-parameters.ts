import { parseExpressionAt, type MemberExpression } from 'acorn';
import { utf8Size } from '../snapshot/json.js';
import { isInstanceName, type JsonValue, type RefScope } from '../snapshot/types.js';
import { REF_VALUE_LIMITS } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
export type RefPath = readonly (string | number)[];

export interface RefAddress {
    readonly appId: string;
    readonly viewId: string;
    readonly refId: string;
    readonly path: RefPath;
}

const addressRoot = /^\$([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)(?=[.\[])/;
const placeholder = 'ref';
const addressBytes = 4096;
const maxPathSegments = REF_VALUE_LIMITS.maxDepth;

export function parseRefAddress(address: string): RefAddress | undefined {
    if (address.length > addressBytes || utf8Size(address) > addressBytes) return;
    const match = addressRoot.exec(address);
    if (!match) return;
    const [, appId, viewId] = match;
    if (!isInstanceName(appId) || !isInstanceName(viewId)) return;
    const expression = placeholder + address.slice(match[0].length);
    try {
        const last = parseExpressionAt(expression, 0, { ecmaVersion: 'latest' });
        if (last.type !== 'MemberExpression' || last.end !== expression.length) return;
        const members: (string | number)[] = [];
        let root: MemberExpression['object'] = last;
        while (root.type === 'MemberExpression') {
            if (members.length > maxPathSegments) return;
            const part = readMember(expression, root);
            if (part === undefined) return;
            members.push(part);
            root = root.object;
        }
        if (root.type !== 'Identifier' || root.start !== 0 || root.name !== placeholder || root.end !== placeholder.length) return;
        const refId = members.pop();
        if (typeof refId !== 'string' || !refId) return;
        return { appId, viewId, refId, path: members.reverse() };
    } catch { /* Invalid syntax or an invalid JSON string key. */ }
}

function readMember(expression: string, member: MemberExpression): string | number | undefined {
    const { object, property, computed, optional, end } = member;
    if (optional) return;
    const before = expression.slice(object.end, property.start);
    const key = expression.slice(property.start, property.end);
    const after = expression.slice(property.end, end);
    if (!computed) return before === '.' && after === '' && property.type === 'Identifier' && property.name === key ? key : undefined;
    if (before !== '[' || after !== ']' || property.type !== 'Literal') return;
    if (typeof property.value === 'string' && key.startsWith('"')) return JSON.parse(key) as string;
    if (typeof property.value === 'number' && /^(0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(property.value)) return property.value;
}

export function formatRefPath(path: RefPath): string {
    return path.map(segment => typeof segment === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
        ? '.' + segment : '[' + JSON.stringify(segment) + ']').join('');
}

/** Grants are detached JSON before validation. Reject paths that cannot fit in an address. */
export function isRefPath(path: unknown, root: string): path is RefPath {
    return Array.isArray(path) && path.length <= maxPathSegments && path.every(segment =>
        typeof segment === 'string' || (Number.isSafeInteger(segment) && segment >= 0)) &&
        utf8Size(root + formatRefPath(path)) <= addressBytes;
}

export function pathStartsWith(path: RefPath, prefix: RefPath): boolean {
    return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

/** The caller owns a captured snapshot value. Only its own JSON keys and indices are traversed. */
export function readRefPath(root: JsonValue, path: RefPath):
    { readonly found: true; readonly value: JsonValue } | { readonly found: false; readonly segment: number; readonly reason: string } {
    let value = root;
    for (const [index, segment] of path.entries()) {
        if (typeof segment === 'number') {
            if (!Array.isArray(value)) return { found: false, segment: index, reason: 'requires an array' };
            if (!Object.hasOwn(value, segment)) return { found: false, segment: index, reason: 'is outside the observed array' };
            value = (value as readonly JsonValue[])[segment]!;
        } else {
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                return { found: false, segment: index, reason: 'requires a JSON object' };
            if (!Object.hasOwn(value, segment)) return { found: false, segment: index, reason: 'is absent in the observed object' };
            value = (value as JsonObject)[segment]!;
        }
    }
    return { found: true, value };
}

export function isArrayElementPath(path: RefPath): boolean {
    return path.length === 1 && typeof path[0] === 'number';
}

export function refPath(param: string, index?: number): string {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param) ? '.' + param : '[' + JSON.stringify(param) + ']';
    return ('$' + key + (index === undefined ? '' : '[' + index + ']')).slice(0, 512);
}

export function scopeAllows(scope: RefScope, publisher: string, receiver: string, sameApp = true): boolean {
    return scope === 'public' || (sameApp && (scope === 'protected' || (scope === 'private' && publisher === receiver)));
}

export interface RefSlot {
    readonly param: string;
    readonly index?: number;
    readonly address: string;
    readonly expectedType?: string;
}

/** Decode only the declared parameter and direct homogeneous array positions. */
export function decodeRefParameters(fields: JsonObject, raw: JsonObject, select: (slot: RefSlot) => JsonValue): JsonObject {
    const value = { ...raw };
    for (const [param, field] of Object.entries(fields)) {
        if (!Object.hasOwn(raw, param)) continue;
        const schema = field as JsonObject;
        const decode = (entry: JsonValue, schema: JsonObject, index?: number) => {
            if (typeof entry !== 'string' || !entry.startsWith('$')) return entry;
            if (entry.startsWith('$$')) return entry.slice(1);
            const expectedType = schema['x-aotui-ref-kind'];
            return select({ param, ...(index === undefined ? {} : { index }), address: entry,
                ...(typeof expectedType === 'string' ? { expectedType } : {}) });
        };
        const supplied = raw[param]!;
        const items = schema.items;
        value[param] = schema.type === 'array' && items && typeof items === 'object' && !Array.isArray(items) && Array.isArray(supplied)
            ? supplied.map((item, index) => decode(item, items as JsonObject, index))
            : decode(supplied, schema);
    }
    return value;
}
