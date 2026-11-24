import { describe, expect, it } from 'vitest';
import { compileToolParameters } from './tool-parameters.js';
const literalNames = ['default', 'const', 'enum', 'examples'];
const compile = (s: any) => compileToolParameters(s);
describe('annotation boundaries in the shared parameter grammar', () => {
    it.each(['dependencies', '$defs', 'definitions', 'patternProperties', 'dependentSchemas', 'dependentRequired'])('rejects unsupported keyword %s at its declaration', keyword => {
        expect(compile({ type: 'object', [keyword]: { file: { type: 'integer' } } })).toMatchObject({
            ok: false, issue: { code: 'PARAMETER_DECLARATION_UNSUPPORTED', path: '$.' + keyword },
        });
    });
    it('keeps annotation-shaped default payload as opaque business data', () => {
        const payload = { 'x-aotui-ref': { version: 99 }, dependencies: { default: { type: 'integer' } } };
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
        expect(c.contract.validateResolvedInput({ file: { x: null } }).ok).toBe(true);
        expect(c.contract.validateResolvedInput({ file: {} }).ok).toBe(false);
    });
    it.each(['file', ...literalNames, 'x-aotui-ref'])('accepts the current annotation under ordinary parameter name %s', name => {
        expect(compile({ type: 'object', properties: { [name]: {
            'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: [name] }).ok).toBe(true);
    });
    it('keeps a parameter named x-aotui-ref ordinary when no annotation is present', () => {
        const c = compile({ type: 'object', properties: { 'x-aotui-ref': { type: 'string' } } });
        expect(c.ok).toBe(true); if (!c.ok) throw Error('fixture');
        expect(c.contract.validateResolvedInput({ 'x-aotui-ref': 'ordinary' }).ok).toBe(true);
    });
});
