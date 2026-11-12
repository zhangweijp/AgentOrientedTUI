import { describe, expect, it } from 'vitest';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
const legacy = { type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } };
const literalNames = ['default', 'const', 'enum', 'examples'];
const compile = (s: any) => compileOrdinarySchema(s, 'view-type-parameters-v1');
describe('annotation boundaries in the shared parameter grammar', () => {
    it.each(['ordinary', ...literalNames])('rejects unsupported dependency Schema member %s', name => {
        expect(compile({ type: 'object', properties: { file: { type: 'string' } }, dependencies: {
            [name]: { type: 'object', properties: { file: legacy } },
        } }).ok).toBe(false);
    });
    it.each(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas'])('rejects unsupported legacy annotation in %s', keyword => {
        for (const name of [...literalNames, 'x-aotui-ref']) expect(compile({ type: 'object', [keyword]: {
            [name]: { type: 'object', properties: { file: legacy } },
        } }).ok).toBe(false);
    });
    it.each(['dependencies', 'dependentRequired'])('does not silently admit unsupported keyword %s', keyword => {
        expect(compile({ type: 'object', properties: { 'x-aotui-ref': { type: 'boolean' }, file: { type: 'string' } },
            [keyword]: { 'x-aotui-ref': ['file'] } }).ok).toBe(false);
    });
    it.each([true, false, { type: 'object', properties: {} }])('rejects unsupported dependency value %j', value => {
        expect(compile({ type: 'object', dependencies: { 'x-aotui-ref': value } }).ok).toBe(false);
    });
    it('keeps annotation-shaped default payload as opaque business data', () => {
        const payload = { 'x-aotui-ref': { version: 99 }, dependencies: { default: legacy } };
        const c = compile({ type: 'object', properties: { file: { type: 'object', default: payload } } });
        expect(c.ok).toBe(true); if (!c.ok) throw Error('fixture');
        expect((c.contract.schema.properties as any).file.default).toEqual(payload);
    });
    it.each(['enum', 'examples'])('rejects unsupported or malformed object keyword %s', keyword => {
        expect(compile({ type: 'object', properties: { file: { type: 'object', [keyword]: {} } } }).ok).toBe(false);
    });
    it('validates a JSON object literal by value', () => {
        const c = compile({ type: 'object', properties: { file: { type: 'object', const: { x: null } } } });
        expect(c.ok).toBe(true);
        if (!c.ok) throw Error('fixture');
        expect(c.contract.validate({ file: { x: null } }).ok).toBe(true);
        expect(c.contract.validate({ file: {} }).ok).toBe(false);
    });
    it.each(['file', ...literalNames, 'x-aotui-ref'])('accepts the current annotation under ordinary parameter name %s', name => {
        expect(compile({ type: 'object', properties: { [name]: { type: 'string', minLength: 1,
            'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: [name] }).ok).toBe(true);
    });
    it('keeps a parameter named x-aotui-ref ordinary when no annotation is present', () => {
        const c = compile({ type: 'object', properties: { 'x-aotui-ref': { type: 'string' } } });
        expect(c.ok).toBe(true); if (!c.ok) throw Error('fixture');
        expect(c.contract.validate({ 'x-aotui-ref': 'ordinary' }).ok).toBe(true);
    });
});
