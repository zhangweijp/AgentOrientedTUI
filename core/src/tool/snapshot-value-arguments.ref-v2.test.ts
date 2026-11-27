import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { compileToolParameters } from './tool-parameters.js';
function parameters(extra = false) {
    return compileToolParameters({ type: 'object', properties: {
        file: { 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } },
        choice: { type: 'string', enum: ['ok'] }, ...(extra ? { n: { type: 'number', default: 2 } } : {}),
    }, required: ['file'], additionalProperties: true });
}

import { prepareViewTypeParameters } from './snapshot-value-arguments.js';
const c = parameters();if (!c.ok) throw Error('fixture');
function fixture() {
    const core = createSnapshotCore({ appId: 'app', instanceId: 'run' });const id = JSON.stringify(['app', 'File', 'read']);let seq = 0;
    const publish = (label: string) => core.committer.accept({ healthySince: 1,  schemaVersion: 9 as const, appId: 'app', instanceId: 'run', producerSeq: ++seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ toolBindings: [{ toolId: id, activationId: 'a:1' }], id: 'aa', viewInstanceId: 'm:1', type: 'File', name: 'File', region: 'dynamic' as const, content: { format: 'markdown-v1' as const, value: 'File' } }],
        refs: { [refKey('aa', 'm:1', 'id')]: { continuity: [1,1,0] as const,  valueSchema: { type: 'object' }, scope: 'protected', id: 'id', ownerViewId: 'aa', ownerViewInstanceId: 'm:1', refType: 'unknown', target: { kind: 'snapshot-value' as const, payload: { label } } } },
        tools: { [id]: { multiplicity: 'multiple', id, name: 'read', viewType: 'File',  description: 'Read', inputSchema: c.contract.schema } } });
    const source = publish('A');if (source.status !== 'published') throw Error('fixture');return { core, publish, source: { appId: 'app', instanceId: 'run', snapshotId: source.snapshot.id,
        tool: source.snapshot.tools[id]!, receiver: { viewId: 'aa', viewInstanceId: 'm:1', activationId: 'a:1' } } };
}
describe('R09/R10 original Ref preparation with newly admitted profile', () => {
    it('keeps historical source and ordinary fields after shared parameter validation', () => {
        const f = fixture();const held = f.core.store.acquire(f.source.snapshotId);if (held.status !== 'acquired') throw Error('holder');f.publish('B');const p = prepareViewTypeParameters(f.core.store, f.source, c.contract, { file: '$ref.app.aa.id', choice: 'ok' }, [{ viewId: 'aa', viewInstanceId: 'm:1', refId: 'id' }], 'obs');
        expect(p.status).toBe('prepared');if (p.status !== 'prepared') return;
        try { expect(p.effectiveArgs).toEqual({ file: { label: 'A' }, choice: 'ok' });expect(p.refSources[0].snapshotId).toBe(f.source.snapshotId);expect(c.contract.validateResolvedInput!(p.effectiveArgs).ok).toBe(true); }
        finally { held.hold.release(); }expect(f.core.store.inspect().activeHolds).toBe(0);
    });
    it('rejects cross-instance source without a leaked lease', () => {
        const f = fixture();const p = prepareViewTypeParameters(f.core.store, { ...f.source, instanceId: 'other' }, c.contract, { file: '$ref.app.aa.id' }, [{ viewId: 'aa', viewInstanceId: 'm:1', refId: 'id' }], 'obs');
        expect(p).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });expect(f.core.store.inspect().activeHolds).toBe(0);
    });
});
