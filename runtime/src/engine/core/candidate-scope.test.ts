import type { ObservationCandidate, PrepareObservationResult } from '@aotui/core';
import { expect, it, vi } from 'vitest';
import type { RunningApp } from '../../spi/runtime/kernel.interface.js';
import { createCandidateScope } from './candidate-scope.js';

function appWithCandidate(discard: ObservationCandidate['discard']): RunningApp {
    return { observe: async () => ({ status: 'prepared', candidate: { discard } }) } as RunningApp;
}

const firstIssue = { code: 'DISCARD_FIRST', message: 'Could not release A', path: '$.a' };
const secondIssue = { code: 'DISCARD_SECOND', message: 'Could not release B' };

it('returns all cleanup issues and does not retry a closed scope', async () => {
    const scope = createCandidateScope();
    const discardA = vi.fn(() => [firstIssue]);
    const cause = Object.assign(new Error(secondIssue.message), { code: secondIssue.code });
    const discardB = vi.fn(() => { throw cause; });
    const discardC = vi.fn(() => []);
    const a = appWithCandidate(discardA);
    await scope.observe(a);
    await scope.observe(appWithCandidate(discardB));
    await scope.observe(appWithCandidate(discardC));

    expect(scope.discard()).toEqual([firstIssue, { ...secondIssue, cause }]);
    expect(scope.discard()).toEqual([]);
    expect(await scope.observe(a)).toMatchObject({ status: 'rejected', issue: { code: 'CANDIDATE_SCOPE_CLOSED' } });
    expect(discardA).toHaveBeenCalledOnce();
    expect(discardB).toHaveBeenCalledOnce();
    expect(discardC).toHaveBeenCalledOnce();
});

it('retains the first cleanup code and the original preparation error under using', async () => {
    const original = new Error('prepare failed');
    const discardA = vi.fn(() => [firstIssue]);
    const discardB = vi.fn(() => [secondIssue]);
    const failed = async () => {
        using scope = createCandidateScope();
        await scope.observe(appWithCandidate(discardA));
        await scope.observe(appWithCandidate(discardB));
        await scope.observe({ observe: async () => { throw original; } } as RunningApp);
    };

    await expect(failed()).rejects.toMatchObject({
        error: { ...firstIssue, issues: [firstIssue, secondIssue] },
        suppressed: original,
    });
    expect(discardA).toHaveBeenCalledOnce();
    expect(discardB).toHaveBeenCalledOnce();
});

it.each([{ issues: [] }, { issues: [firstIssue] }])('cleans up an observation that resolves after scope closure (%j)', async ({ issues }) => {
    const discard = vi.fn(() => issues);
    let complete!: (prepared: PrepareObservationResult) => void;
    const observing = new Promise<PrepareObservationResult>(resolve => { complete = resolve; });
    const scope = createCandidateScope();
    const pending = scope.observe({ observe: () => observing } as RunningApp);
    expect(scope.discard()).toEqual([]);
    const prepared = await appWithCandidate(discard).observe();
    complete(prepared);

    if (issues.length) await expect(pending).rejects.toMatchObject({ ...firstIssue, issues });
    else await expect(pending).resolves.toMatchObject({ status: 'rejected', issue: { code: 'CANDIDATE_SCOPE_CLOSED' } });
    expect(discard).toHaveBeenCalledOnce();
    expect(scope.discard()).toEqual([]);
});
