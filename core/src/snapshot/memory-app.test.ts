import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { refKey } from './snapshot-support.js';
import { compileToolParameters } from '../tool/tool-parameters.js';

const taskToolSchema = compileToolParameters({ type: 'object', properties: { target: { type: 'string' } }, required: ['target'] });
if (!taskToolSchema.ok) throw new Error('Fixture Tool schema must compile');

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
        const toolId = JSON.stringify([this.appId, 'TaskList', 'complete_task']);
        const refs: Record<string, unknown> = {};
        const labels: string[] = [];
        for (const [index, id] of this.order.entries()) {
            const task = this.items.get(id)!;
            const refId = 'pending_' + index;
            refs[refKey('task_list', 'mount_1', refId)] = { valueSchema: { type: 'object' }, scope: 'protected',
                id: refId, ownerViewId: 'task_list', ownerViewInstanceId: 'mount_1',
                refType: 'Task',
                target: { kind: 'snapshot-value', payload: { id: task.id, revision: task.revision } },
            };
            labels.push('[' + task.title + '](' + refId + ')');
        }
        return {
            schemaVersion: 8, appId: this.appId, instanceId: this.instanceId,
            producerSeq: ++this.producerSeq, sourceEpoch: this.sourceEpoch, capturedAt: this.producerSeq,
            views: [{
                toolBindings: [{ toolId, activationId: 'active-complete' }], id: 'task_list', viewInstanceId: 'mount_1', type: 'TaskList',
                name: 'Tasks', region: 'dynamic',
                content: { format: 'markdown-v1', value: labels.join('\n') },
            }],
            refs,
            tools: {
                [toolId]: { multiplicity: 'multiple',
                    id: toolId, name: 'complete_task', viewType: 'TaskList',
                     description: 'Complete a task only after business CAS verification',
                    inputSchema: taskToolSchema.contract.schema,
                },
            },
        };
    }
}

describe('M1 isolated in-memory App → Snapshot → Ref → Tool descriptor → business CAS → Snapshot', () => {
    it('preserves old observations across reorder while allowing a safe business-side write', () => {
        const app = new MemoryTaskApp();
        const core = createSnapshotCore({ appId: app.appId, instanceId: app.instanceId });
        const original = core.committer.accept(app.draft());
        expect(original.status).toBe('published');
        if (original.status !== 'published') return;
        const originalId = original.snapshot.id;
        const held = core.store.acquire(originalId); if (held.status !== 'acquired') throw Error('holder');
        const old = core.store.resolveRef({
            snapshotId: originalId, appId: app.appId, instanceId: app.instanceId,
            viewId: 'task_list', viewInstanceId: 'mount_1', refId: 'pending_0',
        });
        expect(old.status).toBe('resolved');
        if (old.status !== 'resolved') throw Error('Expected historical Ref');
        const observedTarget = old.target.payload as { id: string; revision: number };
        const toolId = JSON.stringify([app.appId, 'TaskList', 'complete_task']);
        expect(held.hold.snapshot.tools[toolId]).toMatchObject({ id: toolId });

        app.reorder(['b', 'a']);
        const next = core.committer.accept(app.draft());
        expect(next.status).toBe('published');
        expect(app.complete(observedTarget.id, observedTarget.revision)).toBe('completed');
        const final = core.committer.accept(app.draft());
        expect(final.status).toBe('published');

        const stillOld = core.store.resolveRef({
            snapshotId: originalId, appId: app.appId, instanceId: app.instanceId,
            viewId: 'task_list', viewInstanceId: 'mount_1', refId: 'pending_0',
        });
        expect(stillOld.status).toBe('resolved');
        expect(stillOld).toMatchObject({ target: { kind: 'snapshot-value', payload: { id: 'a', revision: 1 } } });
        const staleAttempt = app.complete(observedTarget.id, observedTarget.revision);
        expect(staleAttempt).toBe('stale');
        expect(core.store.readLatest('tasks').status).toBe('ready');
        held.hold.release(); expect(core.store.inspect().activeHolds).toBe(0);
    });
});
