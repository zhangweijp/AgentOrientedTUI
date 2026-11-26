/** Test helpers for invoking the current source-bound Tool path. */
import { createTurnCoordinator } from '@aotui/core/host';
import type { AppInvocation, ObservationCandidate, ObservationWindowSelection } from '@aotui/core';
import type { AppWorkerHost } from '../../src/engine/app/worker-host.js';

let invocationSequence = 0;

/** Low-level Worker tests use the same turn coordinator as Desktop. */
export function workerTurns(host: AppWorkerHost, turns = createTurnCoordinator()) {
    return {
        prepare: () => host.prepareObservation(client =>
            turns.prepareObservation(client, () => host.getAppInteraction().status === 'ready')),
        adopt(candidate: ObservationCandidate, windows?: ObservationWindowSelection) {
            const adopted = turns.adoptTurn({ apps: [{ candidate, ...(windows && { windows }) }] });
            if (adopted.status !== 'adopted') {
                candidate.discard();
                throw new Error(adopted.issue.code);
            }
            return adopted.turn;
        },
    };
}

export async function invokeObservedTool(
    host: AppWorkerHost,
    name: string,
    input: AppInvocation['input'] = {},
    targetViewId?: string,
    timeoutMs?: number,
): Promise<any> {
    const turns = workerTurns(host);
    const prepared = await turns.prepare();
    if (prepared.status !== 'prepared') throw new Error(prepared.issue.code);
    const { candidate } = prepared;
    const { observation } = candidate;
    const turn = turns.adopt(candidate);
    try {
        const tool = observation.tools.find(candidate => candidate.name === name);
        if (!tool) throw new Error('Observed Tool not found: ' + name);
        const viewId = targetViewId ?? (typeof input.view_id === 'string' ? input.view_id : undefined) ??
            observation.views.find(view => view.type === tool.viewType &&
                (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id)))?.id;
        if (!viewId) throw new Error('Observed Tool has no target: ' + name);
        return await turn.invoke(host.appId, {
            invocationId: `worker-test-${Date.now()}-${++invocationSequence}`,
            observationId: observation.observationId,
            toolId: tool.id,
            viewId, input,
        }, timeoutMs ?? host.timeout);
    } finally {
        turn.release();
    }
}
