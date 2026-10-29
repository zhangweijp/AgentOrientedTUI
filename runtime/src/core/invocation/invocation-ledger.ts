/** Synchronous identity reservation only. Values and their lifecycle belong to the caller. */
export function createInvocationLedger<T>(maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new RangeError('Invalid invocation ledger capacity');
    const entries = new Map<string, Readonly<{ fingerprint: string; value: T }>>();
    function lookup(id: string, fingerprint: string):
        { status: 'missing' } | { status: 'conflict' } | { status: 'match'; value: T } {
        const entry = entries.get(id);
        return !entry ? { status: 'missing' } : entry.fingerprint === fingerprint
            ? { status: 'match', value: entry.value } : { status: 'conflict' };
    }
    return Object.freeze({
        lookup,
        claim(id: string, fingerprint: string, value: T) {
            const found = lookup(id, fingerprint);
            if (found.status !== 'missing') return found;
            if (entries.size >= maxEntries) return { status: 'full' as const };
            entries.set(id, Object.freeze({ fingerprint, value }));
            return { status: 'claimed' as const, value };
        },
        get(id: string): T | undefined { return entries.get(id)?.value; },
        *values() { for (const entry of entries.values()) yield entry.value; },
        get size() { return entries.size; },
        clear() { entries.clear(); },
    });
}
