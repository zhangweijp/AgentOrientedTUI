import { describe, expect, it } from 'vitest';
import { compileOrdinarySchema, compileOrdinaryParams } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import { validateVersionedToolRefDeclarations as validate } from './versioned-ref-declarations.js';
const c = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1,
    'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: false }, 'view-type-parameters-v1');
if (!c.ok) throw Error('fixture');
const schema = ordinaryParameterProfile(c.contract) as Record<string, any>;
describe('qualified parameter declaration admission', () => {
    it('admits the current Ref profile and the ordinary profile through one compiler', () => {
        expect(validate(schema)).toBe(true);
        const plain = compileOrdinaryParams({}); if (!plain.ok) throw Error('fixture');
        expect(validate(ordinaryParameterProfile(plain.contract))).toBe(false);
    });
    it.each(['unknown', 'snapshot-value-params-v1', 'ordinary-params-v1', undefined])('does not upgrade Ref marker %s', marker => {
        const s = { ...schema, 'x-aotui-parameter-contract': marker };
        if (marker === undefined) delete s['x-aotui-parameter-contract'];
        expect(() => validate(s)).toThrow(expect.objectContaining({ code: 'REF_CONTRACT_UNSUPPORTED' }));
    });
    it('preserves annotation-looking literal data and rejects malformed profiles without leaking values', () => {
        const plain = compileOrdinaryParams({ meta: { type: 'object', default: { 'x-aotui-parameter-contract': 'snapshot-value-params-v1', 'x-aotui-ref': 'DATA' } } });
        if (!plain.ok) throw Error('fixture'); expect(validate(ordinaryParameterProfile(plain.contract))).toBe(false);
        expect(() => validate({ ...schema, additionalProperties: 'PRIVATE_VALUE' })).toThrow(expect.objectContaining({ code: 'REF_CONTRACT_UNSUPPORTED' }));
        let reads = 0; const getter = { get 'x-aotui-parameter-contract'() { reads++; return 'view-type-parameters-v1'; } };
        expect(() => validate(getter)).toThrow(); expect(reads).toBe(0);
    });
});
