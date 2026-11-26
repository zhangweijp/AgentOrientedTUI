import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './presentation.js';

describe('shared presentation helpers', () => {
    it('formats timestamps as UTC date and time', () => {
        expect(formatTimestamp(Date.UTC(2026, 9, 29, 7, 8, 9))).toBe('2026-10-29 07:08:09');
    });
});
