import { describe, expect, it } from 'vitest';
import { RESOLVED_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';
import { compileToolParameters } from './tool-parameters.js';

const ref = (kind = 'File', value: any = { type: 'object' }) => ({
    'x-aotui-ref-kind': kind, 'x-aotui-ref-value': value });
const schema = (properties: Record<string, any> = { file: ref() }, required = ['file'], additionalProperties = false) =>
    ({ type: 'object', properties, required, additionalProperties });
function compile(value = schema()) {
    const c = compileToolParameters(value);
    if (!c.ok) throw Error(JSON.stringify(c.issue)); return c.contract;
}
describe('Ref parameters in the shared qualified compiler', () => {
    it('captures one immutable contract for resolved payload validation', () => {
        const source = schema({ file: ref(), choice: { type: 'string', enum: ['ok'] } });
        const c = compile(source); source.properties.file['x-aotui-ref-kind'] = 'changed';
        expect(c.validateResolvedInput({ file: { path: 'a' }, choice: 'ok' }).ok).toBe(true);
        expect(c.validateResolvedInput({ file: '$ref.app.file.a', choice: 'ok' }).ok).toBe(false);
        expect(compileToolParameters(c.schema)).toMatchObject({ ok: true, contract: { schema: c.schema } });
        expect(Object.isFrozen(c.schema)).toBe(true);
    });
    it('requires exact Ref type identity and keeps significant whitespace in the declaration', () => {
        const a = compile(schema({ file: ref(' File ') })), b = compile();
        expect((a.schema.properties as any).file['x-aotui-ref-kind']).toBe(' File ');
        expect(a.schema).not.toEqual(b.schema);
    });
    it.each(['optional', 'multiple'])('admits the qualified %s Ref shape', kind => {
        const s = schema();
        if (kind === 'optional') s.required = [];
        if (kind === 'multiple') { s.properties.other = ref(); s.required.push('other'); }
        const c = compile(s);
        const resolved = kind === 'optional' ? {} : { file: { path: 'a' }, other: { path: 'b' } };
        expect(c.validateResolvedInput(resolved).ok).toBe(true);
        expect(compileToolParameters(c.schema)).toMatchObject({ ok: true, contract: { schema: c.schema } });
    });
    it('admits a bounded array of Ref names with a readonly object value per selection', () => {
        const c = compile(schema({ file: { type: 'array', items: ref(), maxItems: 2 } }));
        expect(c.validateResolvedInput({ file: [{ path: 'a' }, { path: 'b' }] }).ok).toBe(true);
        expect(c.validateResolvedInput({ file: ['$ref.app.file.a'] }).ok).toBe(false);
        expect(compileToolParameters(c.schema)).toMatchObject({ ok: true, contract: { schema: c.schema } });
    });
    it.each(['nested', 'nested-names-array', 'union'])('rejects unsupported Ref shape %s', kind => {
        const s = schema();
        if (kind === 'nested') s.properties.file = { type: 'object', properties: { nested: ref() } };
        if (kind === 'nested-names-array') s.properties.file = { type: 'array', items: { type: 'array', items: ref() } };
        if (kind === 'union') s.properties.file = { anyOf: [ref(), { type: 'null' }] };
        expect(compileToolParameters(s).ok).toBe(false);
    });
    it('keeps an object-list payload as one Ref and validates every business item', () => {
        const c = compile(schema({ file: ref('Files', { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }, { scope: 'protected' }) }));
        expect(c.validateResolvedInput({ file: [{ path: 'a' }] }).ok).toBe(true);
        expect(c.validateResolvedInput({ file: [{ path: 7 }] }).ok).toBe(false);
    });
    it.each([null, [], 'id', 7, true])('rejects invalid resolved object %j', file => {
        expect(compile().validateResolvedInput({ file }).ok).toBe(false);
    });
    it('preserves extras and reserved-looking data without defaults or conversion', () => {
        const c = compile(schema({ file: ref(), choice: { type: 'string', default: 'ok' } }, ['file'], true));
        const input = JSON.parse('{"file":{"x-aotui-ref":{"version":1}},"__proto__":{"safe":true}}');
        const r = c.validateResolvedInput(input); expect(r.ok).toBe(true);
        if (!r.ok) throw Error('fixture'); expect(r.value).not.toHaveProperty('choice');
        expect(Object.hasOwn(r.value, '__proto__')).toBe(true); expect(r.value).not.toBe(input);
        expect(Object.isFrozen(r.value.file)).toBe(true);
    });
    it('reads zero getters in Schema, raw and resolved parameters', () => {
        let reads = 0;
        const bad = Object.defineProperty({}, 'file', { enumerable: true, get() { reads++; return 'secret'; } });
        expect(compileToolParameters(schema(bad)).ok).toBe(false);
        expect(compile().validateResolvedInput(bad).ok).toBe(false); expect(reads).toBe(0);
    });
    it('includes Ref type and complete payload Schema in canonical identity and byte limits', () => {
        expect(compile().schema).not.toEqual(compile(schema({ file: ref('Todo') })).schema);
        expect(compileToolParameters(schema({ file: ref('x'.repeat(70 * 1024)) })).ok).toBe(false);
        const a = compile(schema({ file: ref(), z: { type: 'string' } }));
        const b = compile(schema({ z: { type: 'string' }, file: ref() })); expect(a.schema).toEqual(b.schema);
    });
    it('enforces the complete resolved argument node limit', () => {
        const c = compile(schema({ file: ref() }, ['file'], true));
        const resolvedItemsAtLimit = RESOLVED_TOOL_ARGUMENT_LIMITS.maxNodes - 3;
        expect(c.validateResolvedInput({ file: {}, nodes: Array(resolvedItemsAtLimit).fill(null) }).ok).toBe(true);
        expect(c.validateResolvedInput({ file: {}, nodes: Array(resolvedItemsAtLimit + 1).fill(null) }).ok).toBe(false);
    });
});
