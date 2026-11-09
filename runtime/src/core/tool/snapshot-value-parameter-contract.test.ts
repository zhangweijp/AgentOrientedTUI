import { describe, expect, it } from 'vitest';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { compileOrdinaryProfile, ordinaryParameterProfile } from './ordinary-parameter-profile.js';

const ref = (kind = 'File', value: any = { type: 'object' }) => ({ type: 'string', minLength: 1,
    'x-aotui-ref-kind': kind, 'x-aotui-ref-value': value });
const schema = (properties: Record<string, any> = { file: ref() }, required = ['file'], additionalProperties = false) =>
    ({ type: 'object', properties, required, additionalProperties });
function compile(value = schema()) {
    const c = compileOrdinarySchema(value, 'view-type-parameters-v1');
    if (!c.ok) throw Error(JSON.stringify(c.issue)); return c.contract;
}
describe('Ref parameters in the shared qualified compiler', () => {
    it('captures one immutable contract for model input and resolved payload validation', () => {
        const source = schema({ file: ref(), choice: { type: 'string', enum: ['ok'] } });
        const c = compile(source); source.properties.file['x-aotui-ref-kind'] = 'changed';
        expect(c.revision).toBe('view-type-parameters-v1');
        expect(c.validateModelInput!({ file: 'File:a', choice: 'ok' }).ok).toBe(true);
        expect(c.validateResolvedInput!({ file: { path: 'a' }, choice: 'ok' }).ok).toBe(true);
        expect(c.validateResolvedInput!({ file: 'File:a', choice: 'ok' }).ok).toBe(false);
        expect(compileOrdinaryProfile(ordinaryParameterProfile(c))?.fingerprint).toBe(c.fingerprint);
        expect(Object.isFrozen(c.schema)).toBe(true);
    });
    it('requires exact Ref type identity and keeps significant whitespace in the declaration', () => {
        const a = compile(schema({ file: ref(' File ') })), b = compile();
        expect((a.schema.properties as any).file['x-aotui-ref-kind']).toBe(' File ');
        expect(a.fingerprint).not.toBe(b.fingerprint);
    });
    it.each(['optional', 'multiple'])('admits the qualified %s Ref shape', kind => {
        const s = schema();
        if (kind === 'optional') s.required = [];
        if (kind === 'multiple') { s.properties.other = ref(); s.required.push('other'); }
        const c = compile(s);
        const raw = kind === 'optional' ? {} : { file: 'File:a', other: 'File:b' };
        const resolved = kind === 'optional' ? {} : { file: { path: 'a' }, other: { path: 'b' } };
        expect(c.validateModelInput!(raw).ok).toBe(true);
        expect(c.validateResolvedInput!(resolved).ok).toBe(true);
        expect(compileOrdinaryProfile(ordinaryParameterProfile(c))?.fingerprint).toBe(c.fingerprint);
    });
    it('admits a bounded array of Ref names with a readonly object value per selection', () => {
        const c = compile(schema({ file: { type: 'array', items: ref(), maxItems: 2 } }));
        expect(c.validateModelInput!({ file: ['File:a', 'File:b'] }).ok).toBe(true);
        expect(c.validateResolvedInput!({ file: [{ path: 'a' }, { path: 'b' }] }).ok).toBe(true);
        expect(c.validateModelInput!({ file: [{ path: 'a' }] }).ok).toBe(false);
        expect(c.validateResolvedInput!({ file: ['File:a'] }).ok).toBe(false);
        expect(c.validateModelInput!({ file: ['a', 'b', 'c'] }).ok).toBe(false);
        expect(compileOrdinaryProfile(ordinaryParameterProfile(c))?.fingerprint).toBe(c.fingerprint);
    });
    it.each(['nested', 'nested-names-array', 'primitive', 'primitive-list'])('rejects unsupported Ref shape %s', kind => {
        const s = schema();
        if (kind === 'nested') s.properties.file = { type: 'object', properties: { nested: ref() } };
        if (kind === 'nested-names-array') s.properties.file = { type: 'array', items: { type: 'array', items: ref() } };
        if (kind === 'primitive') s.properties.file = ref('File', { type: 'string' });
        if (kind === 'primitive-list') s.properties.file = ref('File', { type: 'array', items: { type: 'string' } });
        expect(compileOrdinarySchema(s, 'view-type-parameters-v1').ok).toBe(false);
    });
    it('keeps an object-list payload as one Ref and validates every business item', () => {
        const c = compile(schema({ file: ref('Files', { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }) }));
        expect(c.validateModelInput!({ file: 'Files:all' }).ok).toBe(true);
        expect(c.validateModelInput!({ file: ['File:a'] }).ok).toBe(false);
        expect(c.validateResolvedInput!({ file: [{ path: 'a' }] }).ok).toBe(true);
        expect(c.validateResolvedInput!({ file: [{ path: 7 }] }).ok).toBe(false);
    });
    it.each(['', {}, null, [], 7, true])('rejects invalid raw Ref %j', file => {
        expect(compile().validateModelInput!({ file }).ok).toBe(false);
    });
    it.each([null, [], 'id', 7, true])('rejects invalid resolved object %j', file => {
        expect(compile().validateResolvedInput!({ file }).ok).toBe(false);
    });
    it('preserves extras and reserved-looking data without defaults or conversion', () => {
        const c = compile(schema({ file: ref(), choice: { type: 'string', default: 'ok' } }, ['file'], true));
        const input = JSON.parse('{"file":{"x-aotui-ref":{"version":1}},"__proto__":{"safe":true}}');
        const r = c.validateResolvedInput!(input); expect(r.ok).toBe(true);
        if (!r.ok) throw Error('fixture'); expect(r.value).not.toHaveProperty('choice');
        expect(Object.hasOwn(r.value, '__proto__')).toBe(true); expect(r.value).not.toBe(input);
        expect(Object.isFrozen(r.value.file)).toBe(true);
    });
    it.each(['snapshot-value-params-v1', 'ordinary-params-v1', 'future', undefined])('never upgrades an old or wrong Ref marker %s', marker => {
        const p: any = { ...ordinaryParameterProfile(compile()) as object, 'x-aotui-parameter-contract': marker };
        if (marker === undefined) delete p['x-aotui-parameter-contract'];
        expect(compileOrdinaryProfile(p)).toBeNull();
    });
    it.each(['extra-root', 'required-order', 'missing-extra', 'old-annotation'])('rejects a noncanonical profile %s', kind => {
        const p: any = JSON.parse(JSON.stringify(ordinaryParameterProfile(compile(schema({ file: ref(), z: { type: 'string' } }, ['file', 'z'])))));
        if (kind === 'extra-root') p.extra = true;
        if (kind === 'required-order') p.required.reverse();
        if (kind === 'missing-extra') delete p.additionalProperties;
        if (kind === 'old-annotation') p.properties.file['x-aotui-ref'] = { version: 1 };
        expect(compileOrdinaryProfile(p)).toBeNull();
    });
    it('reads zero getters in Schema, profile, raw and resolved parameters', () => {
        let reads = 0;
        const bad = Object.defineProperty({}, 'file', { enumerable: true, get() { reads++; return 'secret'; } });
        expect(compileOrdinarySchema(schema(bad), 'view-type-parameters-v1').ok).toBe(false);
        expect(compileOrdinaryProfile(bad)).toBeNull();
        expect(compile().validateModelInput!(bad).ok).toBe(false);
        expect(compile().validateResolvedInput!(bad).ok).toBe(false); expect(reads).toBe(0);
    });
    it('includes Ref type and complete payload Schema in canonical identity and byte limits', () => {
        expect(compile().fingerprint).not.toBe(compile(schema({ file: ref('Todo') })).fingerprint);
        expect(compileOrdinarySchema(schema({ file: ref('x'.repeat(70 * 1024)) }), 'view-type-parameters-v1').ok).toBe(false);
        const a = compile(schema({ file: ref(), z: { type: 'string' } }));
        const b = compile(schema({ z: { type: 'string' }, file: ref() })); expect(a.fingerprint).toBe(b.fingerprint);
    });
    it('uses the shared input budgets for the complete raw and expanded arguments', () => {
        const c = compile(schema({ file: ref() }, ['file'], true));
        expect(c.validateModelInput!({ file: 'File:a', nodes: Array(9997).fill(null) }).ok).toBe(true);
        expect(c.validateModelInput!({ file: 'File:a', nodes: Array(9998).fill(null) }).ok).toBe(false);
        expect(c.validateResolvedInput!({ file: {}, nodes: Array(9997).fill(null) }).ok).toBe(true);
        expect(c.validateResolvedInput!({ file: {}, nodes: Array(9998).fill(null) }).ok).toBe(false);
        // Depth and both byte metrics are also exercised at exact boundaries by
        // ordinary-parameter-contract P10 and snapshot-value-arguments W01 T07.
    });
});
