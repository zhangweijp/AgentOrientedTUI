import { expect, it } from 'vitest';
import { createInvocationLedger } from './invocation-ledger.js';

it('reserves synchronously, compares full strings, never evicts and delegates value lifecycle', () => {
    const ledger = createInvocationLedger<{ content?: string }>(1), value = { content: 'business-value' };
    expect(ledger.lookup('id', 'complete')).toEqual({ status: 'missing' });
    expect(ledger.claim('id', 'complete', value)).toEqual({ status: 'claimed', value });
    expect(ledger.lookup('id', 'complete')).toEqual({ status: 'match', value });
    expect(ledger.claim('id', 'different', {})).toEqual({ status: 'conflict' });
    expect(ledger.claim('other', 'different', {})).toEqual({ status: 'full' });
    delete value.content;
    expect(ledger.lookup('id', 'complete')).toEqual({ status: 'match', value: {} });
    expect(ledger.size).toBe(1); ledger.clear(); expect(ledger.size).toBe(0);
});
