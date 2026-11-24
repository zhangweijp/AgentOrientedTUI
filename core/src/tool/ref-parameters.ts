import { parseExpressionAt, type MemberExpression } from 'acorn';
import { utf8Size } from '../snapshot/json.js';
import { isInstanceName } from '../snapshot/types.js';
import { MAX_REF_ADDRESS_BYTES, MAX_REF_PATH_SEGMENTS, type RefAddress } from './ref-path.js';

const addressRoot = /^\$ref\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)(?=[.\[])/;
const placeholder = 'ref';

export function parseRefAddress(address: string): RefAddress | undefined {
    if (address.length > MAX_REF_ADDRESS_BYTES || utf8Size(address) > MAX_REF_ADDRESS_BYTES) return;
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
            if (members.length > MAX_REF_PATH_SEGMENTS) return;
            const part = readMember(expression, root);
            if (part === undefined) return;
            members.push(part);
            root = root.object;
        }
        if (root.type !== 'Identifier' || root.start !== 0 || root.name !== placeholder || root.end !== placeholder.length) return;
        const refId = members.pop();
        if (typeof refId !== 'string' || !refId) return;
        return Object.freeze({ appId, viewId, refId, path: Object.freeze(members.reverse()) });
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
