import { describe, expect, it } from 'vitest';
import { fitWindowPresentation, type WindowPresentation, type WindowRequestCost } from './window-budget.js';

type Trial = WindowPresentation & { measurement: WindowRequestCost };

describe('fitWindowPresentation', () => {
    it('preserves the requested body ahead of earlier candidates, including on the next ordinary fit', async () => {
        const keepBodies = new Set(['target']);
        const full: Trial = { hints: new Set(), managementOnly: false, measurement: { estimated: 19, inputLimit: 13 } };
        const measure = async (layout: WindowPresentation) => ({ ...layout, measurement: {
            estimated: layout.managementOnly ? 3 : 19 - 7 * layout.hints.size, inputLimit: 13,
        } });
        for (const requireBodies of [true, false]) {
            const plan = await fitWindowPresentation(full, ['earlier', 'target'], measure, { keepBodies, requireBodies });
            expect(plan.hints).toEqual(new Set(['earlier']));
            expect(plan.measurement.estimated).toBe(12);
        }
    });

    it('returns the required layout cost when only a fallback would fit', async () => {
        const keepBodies = new Set(['target']);
        const full: Trial = { hints: new Set(), managementOnly: false, measurement: { estimated: 20, inputLimit: 10 } };
        const measure = async (layout: WindowPresentation) => ({ ...layout, measurement: {
            estimated: layout.managementOnly ? 3 : layout.hints.has('target') ? 7 : 16, inputLimit: 10,
        } });
        const required = await fitWindowPresentation(full, ['other', 'target'], measure, { keepBodies, requireBodies: true });
        expect(required).toMatchObject({ managementOnly: false, hints: new Set(['other']), measurement: { estimated: 16 } });
        const changed = await fitWindowPresentation(full, ['other', 'target'], measure, { keepBodies });
        expect(changed).toMatchObject({ managementOnly: false, hints: new Set(['target']), measurement: { estimated: 7 } });
    });
});
