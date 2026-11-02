/** Test helpers for invoking the current source-bound Tool path. */
import { mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

let invocationSequence = 0;

/** Make a Node fixture's bare `preact` import resolve from its own temp directory. */
export async function linkPreactPeer(appDirectory: string): Promise<void> {
    const nodeModules = join(appDirectory, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    await symlink(join(resolve(process.cwd()), 'node_modules', 'preact'), join(nodeModules, 'preact'), 'dir');
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
            return {
                views: source.views.filter((view: any) => selected.has(view.id))
                    .map((view: any) => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                refs: Object.values(source.refs).filter((ref: any) => selected.has(ref.ownerViewId))
                    .map((ref: any) => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
                targets: Object.values(source.tools).flatMap((tool: any) => tool.targets
                    .filter((target: any) => selected.has(target.viewId))
                    .map((target: any) => ({ toolId: tool.id, target }))),
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
        const tool = observed.observation.tools.find((candidate: any) => candidate.name === name);
        if (!tool) throw new Error('Observed Tool not found: ' + name);
        const binding = observed.observation.bindings.find((candidate: any) => candidate.toolId === tool.id &&
            (!targetViewId || candidate.target.viewId === targetViewId));
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
