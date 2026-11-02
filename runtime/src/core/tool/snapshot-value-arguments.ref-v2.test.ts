import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { compileSnapshotValueParams } from './snapshot-value-parameter-contract.js';
import { prepareSnapshotValueArguments } from './snapshot-value-arguments.js';
const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' }, choice: { type: 'enum', options: ['ok'] } });if (!c.ok) throw Error('fixture');
function fixture() {
    const core = createSnapshotCore();core.lifecycle.startApp('app', 'run');const id = JSON.stringify(['app', 'File', 'read']);let seq = 0;
    const publish = (label: string) => core.committer.accept({ schemaVersion: 2 as const, appId: 'app', instanceId: 'run', producerSeq: ++seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', kind: 'state' as const, content: { format: 'markdown-v1' as const, value: 'File' } }],
        refs: { [refKey('aa', 'mount', 'id')]: { id: 'id', ownerViewId: 'aa', ownerViewInstanceId: 'mount', refType: 'unknown', target: { kind: 'snapshot-value' as const, payload: { label } } } },
        tools: { [id]: { id, name: 'read', viewType: 'File', description: 'Read', inputSchema: c.contract.schema, isMutating: false, targets: [{ viewId: 'aa', viewInstanceId: 'mount', bindingVersion: 1 }] } } });
    const source = publish('A');if (source.status !== 'published') throw Error('fixture');return { core, id, publish, source: source.snapshot };
}
describe('R09/R10 original Ref preparation with newly admitted profile', () => {
    it('keeps historical source and ordinary fields; parameter rules remain outside preparation', () => {
        const f = fixture();f.publish('B');const p = prepareSnapshotValueArguments(f.core.store, { appId: 'app', instanceId: 'run' }, { snapshotId: f.source.id, toolId: f.id, viewId: 'aa', args: { file: 'id', choice: 7 } });
        expect(p.status).toBe('prepared');if (p.status !== 'prepared') return;
        try { expect(p.effectiveArgs).toEqual({ file: { label: 'A' }, choice: 7 });expect(p.refSources[0].snapshotId).toBe(f.source.id);expect(c.contract.validateEffective(p.effectiveArgs).ok).toBe(false); }
        finally { p.release(); }expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('rejects cross-instance source without a leaked lease', () => {
        const f = fixture();const p = prepareSnapshotValueArguments(f.core.store, { appId: 'app', instanceId: 'other' }, { snapshotId: f.source.id, toolId: f.id, viewId: 'aa', args: { file: 'id' } });
        expect(p).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });expect(f.core.store.inspect().activeLeases).toBe(0);
    });
});
