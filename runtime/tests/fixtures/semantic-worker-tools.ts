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
    const opened = host.createInteractionScope({
        project: ({ source, selection }: any) => {
            const selected = new Set(selection.viewIds);
            const views = source.views.filter((view: any) => selected.has(view.id));
            return {
                views: views.map((view: any) => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                refs: Object.values(source.refs).filter((ref: any) => selected.has(ref.ownerViewId))
                    .map((ref: any) => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
                toolBindings: Object.values(source.tools).flatMap((tool: any) => tool.execution.kind === 'view-type'
                    ? views.some((view: any) => view.type === tool.viewType)
                        ? [{ toolId: tool.id, execution: tool.execution }]
                        : []
                    : tool.execution.targets.filter((target: any) => selected.has(target.viewId))
                        .map((target: any) => ({ toolId: tool.id, execution: { kind: 'view-instance', target } }))),
                content: [],
            };
        },
        authorize: () => true,
        canReadReceipt: () => true,
    });
    if (opened.status !== 'opened') throw new Error(opened.issue.code);
    const { client } = opened;
    try {
        const state = host.snapshotReceiver.core.store.readLatest(host.appId);
        if (state.status !== 'ready') throw new Error('Expected a ready Semantic snapshot');
        const viewIds = targetViewId ? [targetViewId] : state.snapshot.views.map((view: any) => view.id);
        const observed = await client.observe({ viewIds });
        if (observed.status !== 'observed') throw new Error(observed.issue.code);
        const adopted = client.adoptObservation(observed.observation.observationId);
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
        await client.close();
    }
}
