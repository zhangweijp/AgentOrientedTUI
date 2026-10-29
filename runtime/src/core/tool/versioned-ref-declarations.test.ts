import { describe, expect, it } from 'vitest';
import { compileSnapshotValueParams } from './snapshot-value-parameter-contract.js';
import { validateToolRefDeclarations } from './ref-declarations.js';
import { validateVersionedToolRefDeclarations as validate } from './versioned-ref-declarations.js';
const compiled = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });
if (!compiled.ok) throw Error('fixture');
const schema = compiled.contract.schema;
describe('R01/R25 exact versioned declaration admission', () => {
    it('admits only View-owned readonly new profiles, preserving old C1 refusal', () => {
        expect(validate(schema, false)).toBe(true);expect(() => validateToolRefDeclarations(schema, false)).toThrow();
        for (const [mutating, viewOwned, code] of [[true, true, 'REF_DECLARATION_INVALID'], [false, false, 'REF_CONTRACT_UNSUPPORTED']] as const)
            expect(() => validate(schema, mutating, viewOwned)).toThrow(expect.objectContaining({ code }));
    });
    it.each(['unknown', 'ordinary-params-v1', undefined])('does not upgrade marker %s', marker => {
        const s = { ...schema, ...(marker === undefined ? {} : { 'x-aotui-parameter-contract': marker }) };
        if (marker === undefined) delete s['x-aotui-parameter-contract'];
        if (marker === undefined) expect(validate(s, false)).toBe(true);
        else expect(() => validate(s, false)).toThrow();
    });
    it('preserves ordinary marker literals as data and rejects malformed new profile safely', () => {
        expect(validate({ type: 'object', properties: { meta: { type: 'object', default: { 'x-aotui-parameter-contract': 'snapshot-value-params-v1', 'x-aotui-ref': 'DATA' } } } }, false)).toBe(false);
        expect(() => validate({ ...schema, additionalProperties: 'PRIVATE_VALUE' }, false)).toThrow(expect.objectContaining({ code: 'REF_DECLARATION_INVALID' }));
    });
});
