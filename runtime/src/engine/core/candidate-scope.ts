import type { InteractionIssue, ObservationCandidate, PrepareObservationResult } from '@aotui/core';
import type { CandidateScope, RunningApp } from '../../spi/runtime/kernel.interface.js';

const closedScope = Object.freeze({ status: 'rejected', issue: Object.freeze({
    code: 'CANDIDATE_SCOPE_CLOSED', message: 'The observation candidate scope is closed.',
}) } as const);

function discardCandidate(candidate: ObservationCandidate): readonly InteractionIssue[] {
    try { return candidate.discard(); }
    catch (cause) {
        const fallback = { code: 'OBSERVATION_RELEASE_FAILED', message: 'The observation candidate could not be discarded.' };
        try {
            if (cause && typeof cause === 'object') {
                const { code, message, path } = cause as Partial<InteractionIssue>;
                return [Object.freeze({
                    code: typeof code === 'string' ? code : fallback.code,
                    message: typeof message === 'string' ? message : fallback.message,
                    ...(typeof path === 'string' ? { path } : {}),
                    cause,
                })];
            }
        } catch { /* Preserve a thrown value whose diagnostic properties cannot be read. */ }
        return [Object.freeze({ ...fallback, cause })];
    }
}

function throwCleanupIssues(issues: readonly InteractionIssue[]): void {
    const first = issues[0];
    if (first) throw Object.assign(new Error(first.message), first, { issues });
}

export function createCandidateScope(): CandidateScope {
    const candidates = new Set<ObservationCandidate>();
    let closed = false;

    function discard(): readonly InteractionIssue[] {
        closed = true;
        const pending = [...candidates];
        candidates.clear();
        return Object.freeze(pending.flatMap(discardCandidate));
    }

    return Object.freeze({
        async observe(app: Pick<RunningApp, 'observe'>): Promise<PrepareObservationResult> {
            if (closed) return closedScope;
            const result = await app.observe();
            if (result.status === 'rejected') return result;
            if (closed) {
                throwCleanupIssues(discardCandidate(result.candidate));
                return closedScope;
            }
            candidates.add(result.candidate);
            return result;
        },
        discard,
        [Symbol.dispose]() { throwCleanupIssues(discard()); },
    });
}
