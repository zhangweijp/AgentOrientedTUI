import { describe, expect, it } from 'vitest';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';

const refParams = {
    file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' },
} as const;

function typeContract() {
    useViewTypeTool('inspect', { description: 'Inspect', params: refParams, isMutating: false }, args => {
        // Snapshot values handed to a Ref handler are recursively immutable.
        // @ts-expect-error Ref object fields are read-only
        args.file.path = '/mutated';
        return { success: true };
    });

    useViewTypeTool('find', { description: 'Find', params: { query: { type: 'string', required: true } }, isMutating: false }, args => {
        // @ts-expect-error explicitly read-only ordinary arguments are immutable too
        args.query = 'changed';
        return { success: true };
    });

    // @ts-expect-error Ref tools must explicitly declare isMutating: false
    useViewTypeTool('inspect', { description: 'Inspect', params: refParams }, () => ({ success: true }));
}

void typeContract;

describe('View-local Tool type contract', () => {
    it('keeps compile-time Ref restrictions attached to the one Hook', () => {
        expect(typeof useViewTypeTool).toBe('function');
    });
});
