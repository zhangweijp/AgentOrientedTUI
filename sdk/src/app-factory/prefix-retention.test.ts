import { expect, it, vi } from 'vitest';
import { DEFAULT_PROJECTION_LIMITS, type PreparedAppSnapshotDraft } from '@aotui/core';
import { AppKernel } from '../../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createAppId, createDesktopId } from '../../../runtime/src/spi/core/id-factory.js';
import { createApp, createView, defineViewType, ref, type AppAuthorContext, type PublishResult, type ToolResult, type ViewHandle } from '../index.js';

// Only inject the existing internal retention limit. The registry, SDK author
// entry, coordinator, Kernel guards and callback execution are the real implementations.
vi.mock('@aotui/core/producer', async importOriginal => {
    const actual = await importOriginal<typeof import('@aotui/core/producer')>();
    return {
        ...actual,
        createViewOwnedTools: (appId: string, instanceId: string, limits?: Parameters<typeof actual.createViewOwnedTools>[2]) =>
            actual.createViewOwnedTools(appId, instanceId, { ...limits, maxRetainedBytes: 2048 }),
    };
});

it('preserves candidate qualification, but an authoritative history-capacity failure revokes local execution without changing a completed write', async () => {
    const File = defineViewType<{ work(): ToolResult; close(): ToolResult }>()({
        name: 'File', multiplicity: 'multiple', region: 'dynamic',
        tools: { edit: { description: 'Write', execute: ({ context }) => context.work() } },
        onClose: { execute: ({ context }) => context.close() },
    });
    const stable = createView(File, { idPrefix: 'stable' });
    let author!: AppAuthorContext, writes = 0, closes = 0;
    let overflow: ViewHandle<typeof File> | undefined;
    let failAfterWrite = false, writePublication: PublishResult | undefined;
    function work(): ToolResult {
        writes++;
        if (failAfterWrite) writePublication = author.publish(() => [frame(stable), frame(overflow!)]);
        return { success: true, data: { writes } };
    }
    function frame(handle: typeof stable) {
        return handle.frame({
            body: String(writes), refs: [ref('value', writes, { scope: 'public', schema: { type: 'number' } })],
            context: { work, close() { closes++; return { success: true }; } },
        });
    }
    const kernel = new AppKernel({
        appId: createAppId('app'), desktopId: createDesktopId('desk'), instanceId: 'prefix-run',
        projectionLimits: DEFAULT_PROJECTION_LIMITS,
        factory: createApp({ app_name: 'prefix_budget', viewTypes: [File], initialize(app) {
            author = app;
            expect(app.publish(() => [frame(stable)])).toMatchObject({ ok: true, epoch: 1 });
        } }),
    });
    const coordinator = kernel.getProjectionCoordinator();
    function draft(): PreparedAppSnapshotDraft {
        const published = coordinator.nextPublication();
        if (!('draft' in published)) throw Error(published.failure.issue.message);
        return published.draft;
    }
    function source(d: PreparedAppSnapshotDraft) {
        const view = d.views[0]!, binding = view.toolBindings[0]!;
        return { view, tool: d.tools[binding.toolId]!, receiver: {
            viewId: view.id, viewInstanceId: view.viewInstanceId, activationId: binding.activationId,
        } };
    }
    const invoke = (d: PreparedAppSnapshotDraft) => {
        const { tool, receiver } = source(d);
        return kernel.invokeBoundTypeTool(tool, receiver, {}, terminal => terminal);
    };
    const close = (d: PreparedAppSnapshotDraft) => {
        const { view } = source(d);
        return kernel.closeView(view.id, view.viewInstanceId, view.closeActivationId!, terminal => terminal);
    };
    try {
        await kernel.onOpen();
        let before = draft(), opened = 0;
        for (let i = 0; i < 1000; i++) {
            const transient = createView(File, { idPrefix: 'p' + i + 'x'.repeat(100) });
            before = draft();
            const result = author.publish(() => [frame(stable), frame(transient)], { mode: 'candidate' });
            if (!result.ok) {
                expect(result).toMatchObject({ ok: false, state: 'preserved', cause: { code: 'TOOL_CAPACITY' } });
                overflow = transient;
                break;
            }
            opened++;
            expect(author.publish(() => [frame(stable)])).toMatchObject({ ok: true });
        }
        expect(opened).toBeGreaterThan(0);
        expect(overflow).toBeDefined();
        expect(author.readViewId(overflow!)).toBeUndefined();
        expect(author.readViewId(stable)).toBe('stable_1');
        const preserved = draft();
        expect(preserved).toMatchObject({ sourceEpoch: before.sourceEpoch, views: before.views, refs: before.refs, tools: before.tools });
        expect(await invoke(before)).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { writes: 1 } } });
        expect(await close(before)).toMatchObject({ phase: 'entered-returned' });
        expect(closes).toBe(1);
        const old = source(before).view;
        expect(kernel.refDescriptor(old.id, old.viewInstanceId, 'value')).toBeDefined();

        failAfterWrite = true;
        expect(await invoke(before)).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { writes: 2 } } });
        expect(writePublication).toMatchObject({ ok: false, state: 'degraded', cause: { code: 'TOOL_CAPACITY' } });
        expect(coordinator.healthy).toBe(false);
        expect(coordinator.token().epoch).toBe(before.sourceEpoch);
        expect(author.readViewId(stable)).toBeUndefined();
        expect(kernel.refDescriptor(old.id, old.viewInstanceId, 'value')).toBeUndefined();
        expect(await invoke(before)).toMatchObject({ phase: 'not-entered', result: { error: { code: 'SNAPSHOT_UNREADY' } } });
        expect(await close(before)).toMatchObject({ phase: 'not-entered', result: { error: { code: 'SNAPSHOT_UNREADY' } } });
        expect([writes, closes]).toEqual([2, 1]);
        const blocked = vi.fn(() => [frame(stable)]);
        expect(author.publish(blocked, { mode: 'candidate' })).toMatchObject({ ok: false, state: 'preserved', issue: { code: 'SNAPSHOT_UNREADY' } });
        expect(blocked).not.toHaveBeenCalled();

        failAfterWrite = false;
        expect(author.publish(() => [frame(stable)])).toMatchObject({ ok: true, epoch: before.sourceEpoch + 1 });
        const repaired = draft(), fresh = source(repaired).view;
        expect(fresh).toMatchObject({ id: old.id, viewInstanceId: old.viewInstanceId });
        expect(fresh.toolBindings[0]!.activationId).not.toBe(old.toolBindings[0]!.activationId);
        expect(fresh.closeActivationId).not.toBe(old.closeActivationId);
        expect(Object.values(repaired.refs)[0]!.continuity).toEqual(Array(3).fill(repaired.sourceEpoch));
        expect(await invoke(before)).toMatchObject({ phase: 'not-entered' });
        expect(await close(before)).toMatchObject({ phase: 'not-entered' });
        expect(await invoke(repaired)).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { writes: 3 } } });
        expect(await close(repaired)).toMatchObject({ phase: 'entered-returned' });
        expect([writes, closes]).toEqual([3, 2]);
    } finally { await kernel.onClose(); }
});
