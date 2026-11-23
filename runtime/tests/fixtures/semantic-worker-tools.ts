/** Test helpers for invoking the current source-bound Tool path. */
import { access, mkdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export async function invokeObservedTool(
    host: any,
    name: string,
    input: Record<string, unknown> = {},
    targetViewId?: string,
    timeoutMs?: number,
): Promise<any> {
    const opened = host.getAppInteraction();
    if (opened.status !== 'ready') throw new Error(opened.issue.code);
    const client = opened.interaction;
    let observationId: string | undefined;
    try {
        const observed = await client.observe({ all: true });
        if (observed.status !== 'observed') throw new Error(observed.issue.code);
        observationId = observed.observation.observationId;
        const adopted = client.adoptObservation(observationId);
        if (adopted.status !== 'adopted') throw new Error(adopted.issue.code);
        const tool = observed.observation.tools.find((candidate: any) => candidate.name === name);
        if (!tool) throw new Error('Observed Tool not found: ' + name);
        const viewId = targetViewId ?? (typeof input.view_id === 'string' ? input.view_id : undefined) ??
            observed.observation.views.find((view: any) => view.type === tool.viewType &&
                (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id)))?.id;
        if (!viewId) throw new Error('Observed Tool has no target: ' + name);
        return await client.invoke({
            invocationId: `worker-test-${Date.now()}-${++invocationSequence}`,
            observationId: observed.observation.observationId,
            toolId: tool.id,
            input: { view_id: viewId, ...input },
        }, timeoutMs);
    } finally {
        if (observationId) client.releaseObservation(observationId);
    }
}
