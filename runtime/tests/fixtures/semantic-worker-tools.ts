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
): Promise<any> {
    const opened = host.getAppInteraction();
    if (opened.status !== 'ready') throw new Error(opened.issue.code);
    const client = opened.interaction;
    let observationId: string | undefined;
    try {
        const state = host.snapshotReceiver.core.store.readLatest(host.appId);
        if (state.status !== 'ready') throw new Error('Expected a ready Semantic snapshot');
        const viewIds = targetViewId ? [targetViewId] : state.snapshot.views.map((view: any) => view.id);
        const observed = await client.observe({ viewIds });
        if (observed.status !== 'observed') throw new Error(observed.issue.code);
        observationId = observed.observation.observationId;
        const adopted = client.adoptObservation(observationId);
        if (adopted.status !== 'adopted') throw new Error(adopted.issue.code);
        const tool = observed.observation.tools.find((candidate: any) => candidate.name === name);
        if (!tool) throw new Error('Observed Tool not found: ' + name);
        const binding = observed.observation.bindings.find((candidate: any) => candidate.toolId === tool.id &&
            (!targetViewId || candidate.execution.kind === 'view-type' || candidate.execution.target.viewId === targetViewId));
        if (!binding) throw new Error('Observed Tool binding not found: ' + name);
        return await client.invoke({
            invocationId: `worker-test-${Date.now()}-${++invocationSequence}`,
            observationId: observed.observation.observationId,
            bindingId: binding.bindingId,
            input,
        });
    } finally {
        if (observationId) client.releaseObservation(observationId);
    }
}
