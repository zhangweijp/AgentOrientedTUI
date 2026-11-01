import { describe, expect, it } from 'vitest';
import { createSnapshotCore, refKey } from './index.js';

/**
 * M1 integration fixture: a memory-only App producer. The business execution is
 * deliberately external to Core; M4 is responsible for real Tool routing/validation.
 */
class MemoryTaskApp {
    readonly appId = 'tasks';
    readonly instanceId = 'task-instance-1';
    private items = new Map<string, { id: string; title: string; revision: number; done: boolean }>();
    private order = ['a', 'b'];
    private producerSeq = 0;
    private sourceEpoch = 0;
    constructor() {
        this.items.set('a', { id: 'a', title: 'Stable', revision: 1, done: false });
        this.items.set('b', { id: 'b', title: 'Stable', revision: 1, done: false });
    }
    reorder(order: string[]) {
        this.order = [...order];
        this.sourceEpoch++;
    }
    complete(id: string, revision: number): 'completed' | 'stale' | 'not-found' {
        const current = this.items.get(id);
        if (!current) return 'not-found';
        if (current.revision !== revision) return 'stale';
        this.items.set(id, { ...current, done: true, revision: current.revision + 1 });
        this.sourceEpoch++;
        return 'completed';
    }
    draft() {
        const refs: Record<string, unknown> = {};
        const labels: string[] = [];
        for (const [index, id] of this.order.entries()) {
            const task = this.items.get(id)!;
            const refId = 'pending[' + index + ']';
            refs[refKey('task_list', 'mount_1', refId)] = {
                id: refId, ownerViewId: 'task_list', ownerViewInstanceId: 'mount_1',
                refType: 'Task',
                target: { kind: 'entity', entityType: 'Task', entityId: task.id, entityVersion: String(task.revision) },
            };
            labels.push('[' + task.title + '](' + refId + ')');
        }
        return {
            schemaVersion: 2, appId: this.appId, instanceId: this.instanceId,
            producerSeq: ++this.producerSeq, sourceEpoch: this.sourceEpoch, capturedAt: this.producerSeq,
            views: [{
                id: 'task_list', viewInstanceId: 'mount_1', type: 'TaskList',
                name: 'Tasks', kind: 'state',
                content: { format: 'markdown-v1', value: labels.join('\n') },
            }],
            refs,
            tools: {
                [JSON.stringify([this.appId, 'TaskList', 'complete_task'])]: {
                    id: JSON.stringify([this.appId, 'TaskList', 'complete_task']), name: 'complete_task', viewType: 'TaskList',
                    description: 'Complete a task only after business CAS verification',
                    inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
                    isMutating: true, targets: [{ viewId: 'task_list', viewInstanceId: 'mount_1', bindingVersion: 1 }],
                },
            },
        };
    }
}

describe('M1 isolated in-memory App → Snapshot → Ref → Tool descriptor → business CAS → Snapshot', () => {
    it('preserves old observations across reorder while allowing a safe business-side write', () => {
        const app = new MemoryTaskApp();
        const core = createSnapshotCore();
        core.lifecycle.startApp(app.appId, app.instanceId);
        const original = core.committer.accept(app.draft());
        expect(original.status).toBe('published');
        if (original.status !== 'published') return;
        const originalId = original.snapshot.id;
        const old = core.store.resolveRef({
            snapshotId: originalId, appId: app.appId, instanceId: app.instanceId,
            viewId: 'task_list', viewInstanceId: 'mount_1', refId: 'pending[0]',
        });
        expect(old.status).toBe('resolved');
        if (old.status !== 'resolved' || old.target.kind !== 'entity') return;
        const observedTarget = old.target;
        const publishedTool = core.store.getTool({
            snapshotId: originalId, appId: app.appId,
            instanceId: app.instanceId, toolId: JSON.stringify([app.appId, 'TaskList', 'complete_task']),
        });
        expect(publishedTool.status).toBe('found');

        app.reorder(['b', 'a']);
        const next = core.committer.accept(app.draft());
        expect(next.status).toBe('published');
        expect(app.complete(observedTarget.entityId, Number(observedTarget.entityVersion))).toBe('completed');
        const final = core.committer.accept(app.draft());
        expect(final.status).toBe('published');

        const stillOld = core.store.resolveRef({
            snapshotId: originalId, appId: app.appId, instanceId: app.instanceId,
            viewId: 'task_list', viewInstanceId: 'mount_1', refId: 'pending[0]',
        });
        expect(stillOld.status).toBe('resolved');
        if (stillOld.status === 'resolved' && stillOld.target.kind === 'entity') {
            expect(stillOld.target.entityId).toBe('a');
            expect(stillOld.target.entityVersion).toBe('1');
        }
        const staleAttempt = app.complete(observedTarget.entityId, Number(observedTarget.entityVersion));
        expect(staleAttempt).toBe('stale');
        expect(core.store.readLatest('tasks').status).toBe('ready');
    });
});
