import { expect, it } from 'vitest';
import { mergeCloseReport, newCloseState, recordAppClose, snapshotClose } from './close-handle.js';

function host(...values: unknown[]) {
    const interactions = values.length ? values[0] : { closed: true, retainedOperations: 0 };
    return { interactions, issues: [], worker: 'exited', resourcesReleased: true } as any;
}

function appReport(host: any) {
    const state = newCloseState('app');
    state.state = 'settled';
    recordAppClose(state, host, { desktopId: 'd', appId: 'a' }, new Set());
    return snapshotClose(state);
}

it('B2 C22/24 default reports include known-empty interactions', () => {
    expect(newCloseState('runtime').interactions).toEqual({ verified: true, retainedOperations: 0 });
    expect(appReport(host())).toMatchObject({ verification: 'managed', resourcesReleased: true, hasFailures: false,
        unverifiedParticipants: 0, interactions: { verified: true, retainedOperations: 0 } });
    for (const interactions of [{ closed: false, retainedOperations: 0 }, { closed: true, retainedOperations: 1 }])
        expect(appReport(host(interactions))).toMatchObject({ resourcesReleased: false, hasFailures: false, interactions: { verified: true } });
});

it('B2 C21 ordered folds preserve immutable snapshots, exact holder counts, and one owner count per child', () => {
    const report = (scopes: number) => appReport(host({ closed: true, retainedOperations: scopes }));
    const desktop = newCloseState('desktop');mergeCloseReport(desktop, report(1));mergeCloseReport(desktop, report(2));
    const previous = snapshotClose(structuredClone(desktop)), runtime = newCloseState('runtime');mergeCloseReport(runtime, previous);mergeCloseReport(runtime, report(3));
    expect(runtime.interactions).toEqual({ verified: true, retainedOperations: 6 });expect(runtime.hasFailures).toBe(false);
    desktop.interactions!.retainedOperations = 0;expect(previous.interactions?.retainedOperations).toBe(3);expect(Object.isFrozen(previous.interactions)).toBe(true);
    for (let i = 0; i < 2000; i++) { const state = newCloseState('runtime');mergeCloseReport(state, report(0));expect(state.interactions?.retainedOperations).toBe(0);expect(state.failures).toEqual([]); }
});

it('B2 C23 missing, partial and invalid interaction reports remain unknown without a business failure', () => {
    const bad = [undefined, null, {}, { closed: true }, { closed: 'true', retainedOperations: 0 }, { closed: true, retainedBytes: 0 },
        ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5, '0'].map(value => ({ closed: true, retainedOperations: value }))];
    for (const item of bad) {
        const report = appReport(host(item));
        expect(report).toMatchObject({ resourcesReleased: false, verification: 'mixed', hasFailures: false, unverifiedParticipants: 1, interactions: { verified: false } });
        expect(Number.isSafeInteger(report.interactions?.retainedOperations)).toBe(true);
        const state = newCloseState('runtime');mergeCloseReport(state, report);expect(state.unverifiedParticipants).toBe(1);
    }
    for (const registered of [0, 4]) {
        const child = newCloseState('desktop');delete child.interactions;child.unverifiedParticipants = registered;
        const parent = newCloseState('runtime');mergeCloseReport(parent, child);
        expect(parent.unverifiedParticipants).toBe(registered || 1);expect(parent.hasFailures).toBe(false);expect(parent.resourcesReleased).toBe(false);
        expect(parent.interactions?.verified).toBe(false);
    }
});

it('B2 C23 overflow saturates safe subtotals and marks coverage unknown without NaN, infinity, or duplicate unknowns', () => {
    const state = newCloseState('runtime'), first = newCloseState('desktop');first.interactions = { verified: true, retainedOperations: Number.MAX_SAFE_INTEGER };
    mergeCloseReport(state, first);const second = newCloseState('desktop');second.interactions = { verified: true, retainedOperations: 1 };
    mergeCloseReport(state, second);expect(state.interactions).toEqual({ verified: false, retainedOperations: Number.MAX_SAFE_INTEGER });
    expect(state).toMatchObject({ resourcesReleased: false, verification: 'mixed', hasFailures: false, unverifiedParticipants: 1 });
});
