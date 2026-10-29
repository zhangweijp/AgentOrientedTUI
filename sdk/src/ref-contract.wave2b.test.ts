import { describe, expect, it } from 'vitest';
import { defineParams } from './operation/defineParams.js';
import { validateArgs } from './utils/validateArgs.js';

// Current SDK validation facts. These tests do not resolve or authorize Refs.
describe('Wave 2B: SDK reference declarations are not provenance validation', () => {
    const params = defineParams({ file: { type: 'reference', refType: 'File', required: true } });

    it('keeps explicit ParamDef metadata as runtime data but does not require refType at declaration', () => {
        expect(params.file).toEqual({ type: 'reference', refType: 'File', required: true });
        expect(() => defineParams({ file: { type: 'reference' } })).not.toThrow();
    });

    it.each(['file', '[File B](file)', { id: 'caller-owned', type: 'Todo' }])(
        'accepts string/object shape without acquiring a source: %j', file => {
            const args = { file };
            expect(validateArgs(args, params)).toEqual([]);
            expect(args.file).toBe(file);
        },
    );

    it('does not reinterpret ordinary text, ordinary objects or undeclared marker-shaped fields', () => {
        const args = { text: '[File B](file)', object: { $ref: 'file' }, extra: { $aotuiRef: 'file' } };
        const before = JSON.stringify(args);
        expect(validateArgs(args, { text: { type: 'string' }, object: { type: 'object' } })).toEqual([]);
        expect(JSON.stringify(args)).toBe(before);
    });

    it('SDK accepts reference arrays even though the current View-local Schema converter rejects them', () => {
        const args = { files: ['file', { id: 'untrusted' }] };
        expect(validateArgs(args, { files: { type: 'array', itemType: 'reference', refType: 'File' } })).toEqual([]);
        expect(args.files[0]).toBe('file');
    });

    it.each([{ file: true }, { file: 12 }, { file: [] }, { file: null }])('rejects unsupported required reference value shape: %j', ({ file }) => {
        expect(validateArgs({ file }, params)).toHaveLength(1);
    });
});
