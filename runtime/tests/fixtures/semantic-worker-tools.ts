/** Test helpers for invoking the current source-bound Tool path. */
import { access, mkdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurnCoordinator } from '@aotui/core/host';
import type { AppInvocation, ObservationCandidate, ObservationWindowSelection } from '@aotui/core';
import type { AppWorkerHost } from '../../src/engine/app/worker-host.js';

let invocationSequence = 0;

/** Make the SDK's Preact and TypeBox peer imports resolve from a Node fixture directory. */
export async function linkPreactPeer(appDirectory: string): Promise<void> {
    const nodeModules = join(appDirectory, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const repoRoot = resolve(runtimeRoot, '..');
    const peerSources = {
        preact: [join(repoRoot, 'node_modules', 'preact'), join(runtimeRoot, 'node_modules', 'preact')],
        typebox: [join(repoRoot, 'sdk', 'node_modules', 'typebox'), join(repoRoot, 'node_modules', 'typebox')],
    };
    for (const [peer, candidates] of Object.entries(peerSources)) {
        const source = await candidates.reduce<Promise<string | undefined>>(async (previous, candidate) => {
            const found = await previous;
            if (found) return found;
            try { await access(candidate); return candidate; } catch { return undefined; }
        }, Promise.resolve(undefined));
        if (!source) throw new Error(`Missing local ${peer} peer dependency for worker fixture`);
        try { await symlink(source, join(nodeModules, peer), 'dir'); }
        catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    }
}

/** Low-level Worker tests use the same turn coordinator as Desktop. */
export function workerTurns(host: AppWorkerHost, turns = createTurnCoordinator()) {
    return {
        async prepare() {
            const opened = host.getAppInteraction();
            if (opened.status !== 'ready') return opened;
            return turns.prepareObservation(opened.interaction, () => host.getAppInteraction().status === 'ready');
        },
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
        }, timeoutMs);
    } finally {
        turn.release();
    }
}
