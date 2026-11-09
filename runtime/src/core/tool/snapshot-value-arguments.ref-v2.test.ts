import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
function parameters(extra = false) {
    return compileOrdinarySchema({ type: 'object', properties: {
        file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } },
        choice: { type: 'string', enum: ['ok'] }, ...(extra ? { n: { type: 'number', default: 2 } } : {}),
    }, required: ['file'], additionalProperties: true }, 'view-type-parameters-v1');
}

import { prepareViewTypeParameters } from './snapshot-value-arguments.js';
const c = parameters();if (!c.ok) throw Error('fixture');
function fixture() {
    const core = createSnapshotCore();core.lifecycle.startApp('app', 'run');const id = JSON.stringify(['app', 'File', 'read']);let seq = 0;
    const publish = (label: string) => core.committer.accept({ schemaVersion: 3 as const, appId: 'app', instanceId: 'run', producerSeq: ++seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', kind: 'state' as const, content: { format: 'markdown-v1' as const, value: 'File' } }],
        refs: { [refKey('aa', 'mount', 'id')]: { id: 'id', ownerViewId: 'aa', ownerViewInstanceId: 'mount', refType: 'unknown', target: { kind: 'snapshot-value' as const, payload: { label } } } },
        tools: { [id]: { id, name: 'read', viewType: 'File', description: 'Read', inputSchema: ordinaryParameterProfile(c.contract), 
            execution: { kind: 'view-type' as const, activationId: 'active-1' } } } });
    const source = publish('A');if (source.status !== 'published') throw Error('fixture');return { core, id, publish, source: source.snapshot };
}
describe('R09/R10 original Ref preparation with newly admitted profile', () => {
    it('keeps historical source and ordinary fields after shared parameter validation', () => {
        const f = fixture();const held = f.core.store.acquire(f.source.id, { lifetime: 'owner' });if (held.status !== 'acquired') throw Error('holder');f.publish('B');const p = prepareViewTypeParameters(f.core.store, { appId: 'app', instanceId: 'run' }, { snapshotId: f.source.id, toolId: f.id,
            execution: { kind: 'view-type', activationId: 'active-1' }, args: { file: 'aa.id', choice: 'ok' } }, [{ viewId: 'aa', viewInstanceId: 'mount', refId: 'id' }]);
        expect(p.status).toBe('prepared');if (p.status !== 'prepared') return;
        try { expect(p.effectiveArgs).toEqual({ file: { label: 'A' }, choice: 'ok' });expect(p.refSources[0].snapshotId).toBe(f.source.id);expect(c.contract.validateResolvedInput!(p.effectiveArgs).ok).toBe(true); }
        finally { p.release(); held.lease.release(); }expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('rejects cross-instance source without a leaked lease', () => {
        const f = fixture();const p = prepareViewTypeParameters(f.core.store, { appId: 'app', instanceId: 'other' }, { snapshotId: f.source.id, toolId: f.id,
            execution: { kind: 'view-type', activationId: 'active-1' }, args: { file: 'aa.id' } }, [{ viewId: 'aa', viewInstanceId: 'mount', refId: 'id' }]);
        expect(p).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });expect(f.core.store.inspect().activeLeases).toBe(0);
    });
});
