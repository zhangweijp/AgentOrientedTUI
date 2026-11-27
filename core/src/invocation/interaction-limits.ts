import { plainConfigObject } from '../snapshot/projection-limits.js';
import type { InteractionLimits } from './app-interaction-types.js';

/** Fixed complete Receipt encoding bound; only the total budget is configurable. */
export const RECEIPT_BYTES = 560 * 1024;
const hard: InteractionLimits = Object.freeze({
    maxPendingInvocations: 64, maxReads: 64, maxEntriesPerScope: 128, maxEntries: 128,
    maxReceiptContents: 128, maxReceiptBytes: 128 * RECEIPT_BYTES, receiptTtlMs: 600_000,
});

export function normalizeInteractionLimits(input: unknown, path = 'options.interactionLimits'): InteractionLimits {
    const fields = input === undefined ? {} : plainConfigObject(input, Object.keys(hard), path);
    function value(key: keyof InteractionLimits, fallback: number, minimum = 1): number {
        const n = Object.hasOwn(fields, key) ? fields[key] : fallback;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < minimum || n > hard[key])
            throw Object.assign(new TypeError('Expected a safe integer from ' + minimum + ' to ' + hard[key]), { path: path + '.' + key });
        return n;
    }
    const maxEntries = value('maxEntries', 32);
    const maxReceiptContents = value('maxReceiptContents', maxEntries);
    return Object.freeze({
        maxPendingInvocations: value('maxPendingInvocations', 4),
        maxReads: value('maxReads', 8), maxEntriesPerScope: value('maxEntriesPerScope', 32), maxEntries,
        maxReceiptContents, maxReceiptBytes: value('maxReceiptBytes', maxReceiptContents * RECEIPT_BYTES, RECEIPT_BYTES),
        receiptTtlMs: value('receiptTtlMs', 60_000),
    });
}
