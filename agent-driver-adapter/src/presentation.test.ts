import { describe, expect, it } from 'vitest';
import { formatAppStatus, formatTimestamp } from './presentation.js';

describe('shared presentation helpers', () => {
    it('formats application statuses consistently', () => {
        expect(formatAppStatus('running')).toBe('running');
        expect(formatAppStatus('paused')).toBe('paused');
        expect(formatAppStatus('pending')).toBe('available (not started)');
        expect(formatAppStatus('closed')).toBe('not launched');
        expect(formatAppStatus('collapsed')).toBe('minimized');
    });

    it('formats timestamps as UTC date and time', () => {
        expect(formatTimestamp(Date.UTC(2026, 9, 29, 7, 8, 9))).toBe('2026-10-29 07:08:09');
    });
});
