import { expect, it } from 'vitest';
import { mergeCloseReport, newCloseState, sandboxCloseReport, snapshotClose } from './close-handle.js';

function host(...values: unknown[]) {
    const interactions = values.length ? values[0] : { closed: true, retainedOperations: 0, retainedBytes: 0 };
    return { state: 'settled', intent: 'close', resourcesReleased: true, issues: [],
        host: { interactions, issues: [],
            storage: { support: 'rejected', actualIO: 0, pending: 0, opening: false, ownerRetained: false, unsafe: false,
                release: { status: 'released' } } } } as any;
}

it('B2 C22/24 default reports include known-empty interactions when negotiation is rejected', () => {
    expect(newCloseState('runtime').interactions).toEqual({ verified: true, retainedOperations: 0, retainedBytes: 0 });
    expect(sandboxCloseReport(host(), 'd', 'a')).toMatchObject({ verification: 'mixed', resourcesReleased: true, hasFailures: false,
        unverifiedParticipants: 0, interactions: { verified: true, retainedOperations: 0, retainedBytes: 0 } });
    for (const interactions of [{ closed: false, retainedOperations: 0, retainedBytes: 0 }, { closed: true, retainedOperations: 1, retainedBytes: 90 }])
        expect(sandboxCloseReport(host(interactions), 'd', 'a')).toMatchObject({ resourcesReleased: false, hasFailures: false, interactions: { verified: true } });
});

it('B2 C21 ordered folds preserve immutable snapshots, exact subtotals, and one owner count per child', () => {
    const report = (scopes: number, bytes: number) => sandboxCloseReport(host({ closed: true, retainedOperations: scopes, retainedBytes: bytes }), 'd', 'a');
    const desktop = newCloseState('desktop');mergeCloseReport(desktop, report(1, 17));mergeCloseReport(desktop, report(2, 53));
    const previous = snapshotClose(desktop), runtime = newCloseState('runtime');mergeCloseReport(runtime, previous);mergeCloseReport(runtime, report(3, 41));
    expect(runtime.interactions).toEqual({ verified: true, retainedOperations: 6, retainedBytes: 111 });expect(runtime.hasFailures).toBe(false);
    desktop.interactions!.retainedBytes = 0;expect(previous.interactions?.retainedBytes).toBe(70);expect(Object.isFrozen(previous.interactions)).toBe(true);
    for (let i = 0; i < 2000; i++) { const state = newCloseState('runtime');mergeCloseReport(state, report(0, 0));expect(state.interactions?.retainedOperations).toBe(0);expect(state.failures).toEqual([]); }
});

it('B2 C23 old, partial, invalid and getter fields remain unknown with no getter invocation or business failure', () => {
    let getters = 0;const get = () => { getters++;return 0; };
    const bad = [undefined, null, {}, { closed: true }, { closed: 'true', retainedOperations: 0, retainedBytes: 0 },
        ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5, '0'].flatMap(value => [
            { closed: true, retainedOperations: value, retainedBytes: 7 }, { closed: true, retainedOperations: 2, retainedBytes: value }]),
        Object.defineProperty({ retainedOperations: 0, retainedBytes: 0 }, 'closed', { get }),
        Object.defineProperty({ closed: true, retainedBytes: 7 }, 'retainedOperations', { get }),
        Object.create({ closed: true, retainedOperations: 0, retainedBytes: 0 })];
    for (const item of bad) {
        const report = sandboxCloseReport(host(item), 'd', 'a');
        expect(report).toMatchObject({ resourcesReleased: false, verification: 'mixed', hasFailures: false, unverifiedParticipants: 1, interactions: { verified: false } });
        expect(Number.isSafeInteger(report.interactions?.retainedOperations)).toBe(true);expect(Number.isSafeInteger(report.interactions?.retainedBytes)).toBe(true);
        const state = newCloseState('runtime');mergeCloseReport(state, report);expect(state.unverifiedParticipants).toBe(1);
    }
    const wrapped = host();Object.defineProperty(wrapped.host, 'interactions', { get });
    expect(sandboxCloseReport(wrapped, 'd', 'a').interactions?.verified).toBe(false);
    for (const registered of [0, 4]) {
        const child = newCloseState('desktop');delete child.interactions;child.unverifiedParticipants = registered;
        const parent = newCloseState('runtime');mergeCloseReport(parent, child);
        expect(parent.unverifiedParticipants).toBe(registered || 1);expect(parent.hasFailures).toBe(false);expect(parent.resourcesReleased).toBe(false);
        Object.defineProperty(child, 'interactions', { configurable: true, get });const second = newCloseState('runtime');mergeCloseReport(second, child);expect(second.interactions?.verified).toBe(false);
    }
    expect(getters).toBe(0);
});

it('B2 C23 overflow saturates safe subtotals and marks coverage unknown without NaN, infinity, or duplicate unknowns', () => {
    const state = newCloseState('runtime'), first = newCloseState('desktop');first.interactions = { verified: true, retainedOperations: Number.MAX_SAFE_INTEGER, retainedBytes: Number.MAX_SAFE_INTEGER };
    mergeCloseReport(state, first);const second = newCloseState('desktop');second.interactions = { verified: true, retainedOperations: 1, retainedBytes: 1 };
    mergeCloseReport(state, second);expect(state.interactions).toEqual({ verified: false, retainedOperations: Number.MAX_SAFE_INTEGER, retainedBytes: Number.MAX_SAFE_INTEGER });
    expect(state).toMatchObject({ resourcesReleased: false, verification: 'mixed', hasFailures: false, unverifiedParticipants: 1 });
});
