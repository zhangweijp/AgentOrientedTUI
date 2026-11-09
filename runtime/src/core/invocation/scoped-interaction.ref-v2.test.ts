import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';
function parameters(extra = false) {
    return compileOrdinarySchema({ type: 'object', properties: {
        file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } },
        choice: { type: 'string', enum: ['ok'] }, ...(extra ? { n: { type: 'number', default: 2 } } : {}),
    }, required: ['file'], additionalProperties: true }, 'view-type-parameters-v1');
}

import { createScopedInteraction } from './scoped-interaction.js';
function deferred() { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; }
function fixture() {
    const core = createSnapshotCore({ now: () => 0 });core.lifecycle.startApp('app', 'run');const id = JSON.stringify(['app', 'File', 'read']);let seq = 0;
    let contract = parameters();if (!contract.ok) throw Error('fixture');
    let schema = ordinaryParameterProfile(contract.contract);
    const calls = { validate: 0, policy: 0, execute: 0 }, seen: any[] = [];
    const controls = { authorize: (_ctx: any): any => true };
    function publish(label = 'A', mounted = true) {
        const s = ++seq;const r = core.committer.accept({ schemaVersion: 3, appId: 'app', instanceId: 'run', producerSeq: s, sourceEpoch: s, capturedAt: s,
            views: mounted ? [{ id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', kind: 'state', content: { format: 'markdown-v1', value: label } }] : [],
            refs: mounted ? { [refKey('aa', 'mount', 'id')]: { id: 'id', ownerViewId: 'aa', ownerViewInstanceId: 'mount', refType: 'unknown', target: { kind: 'snapshot-value', payload: { label } } } } : {},
            tools: mounted ? { [id]: { id, name: 'read', viewType: 'File', description: 'Read', inputSchema: schema, 
                execution: { kind: 'view-type', activationId: label === 'rule' ? 'rule-2' : 'active-1' } } } : {} });
        expect(r.status).toBe('published');if (r.status !== 'published') throw Error('publication');return r.snapshot;
    }
    const original = publish();
    const binding = { identity: {}, mode: 'view-type-parameters-v1' as const, isLive: () => ({ ok: true }), validateInput: (_s: unknown, input: any) => {
        calls.validate++;if (!contract.ok) throw Error('fixture');const r = contract.contract.validateResolvedInput!(input);return r.ok ? { ok: true, value: r.value } : { ok: false };
    }, execute: (ctx: any) => { calls.execute++;seen.push(ctx);return { kind: 'tool-result' as const, phase: 'entered-returned' as const, result: { success: true, data: { label: ctx.effectiveInput.file.label } } }; } };
    const authority = createScopedInteraction(core.store, { namespace: 'ref-v2', now: () => 0 });
    const opened = authority.createScope({ appId: 'app', instanceId: 'run', policy: { project: ({ source }) => ({
        views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })), refs: Object.values(source.refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        toolBindings: Object.values(source.tools).map(t => ({ toolId: t.id, execution: t.execution })), content: [] }),
        authorize: ctx => { calls.policy++;seen.push(ctx);return controls.authorize(ctx); }, canReadReceipt: () => true }, execution: { resolve: () => binding } });
    if (opened.status !== 'opened') throw Error('scope');const client = opened.client;
    return { core, client, controls, calls, seen, publish, original, changeRule() {
        contract = parameters(true);
        if (!contract.ok) throw Error('fixture');schema = ordinaryParameterProfile(contract.contract);publish('rule');
    }, async request(input: any = { file: 'aa.id', choice: 'ok' }) {
        const o = await client.observe({ viewIds: ['aa'] });if (o.status !== 'observed') throw Error('observation');expect(client.adoptObservation(o.observation.observationId)).toEqual({ status: 'adopted' });const b = o.observation.bindings[0]!;
        return { invocationId: 'i', observationId: o.observation.observationId, bindingId: b.bindingId, input };
    } };
}
describe('R08/R09/R11 unchanged Core coordination with versioned Ref admission', () => {
    it('rejects ordinary parameters during prepare before custom validation, policy and dispatch', async () => {
        const f = fixture();try { const result = await f.client.invoke(await f.request({ file: 'aa.id', choice: 7 }));expect(result).toMatchObject({ kind: 'receipt', receipt: { outcome: { code: 'TOOL_INVALID_ARGS' } } });expect(f.calls).toEqual({ validate: 0, policy: 0, execute: 0 }); }
        finally { f.client.close(); }expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('keeps original A after B publication and shows the same provenance to policy and adapter', async () => {
        const f = fixture();const request = await f.request();f.publish('B');
        try { expect(await f.client.invoke(request)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });expect(f.seen).toHaveLength(2);
            for (const ctx of f.seen) { expect(ctx.effectiveInput.file).toEqual({ label: 'A' });expect(ctx.source.snapshotId).toBe(f.original.id);expect(ctx.rawInput.file).toBe('aa.id');expect(ctx.refSources[0].snapshotId).toBe(f.original.id); } }
        finally { f.client.close(); }
    });
    it.each(['rule', 'unmount', 'scope'])('rechecks %s after an awaited policy without adapter entry', async kind => {
        const f = fixture(), started = deferred(), release = deferred();f.controls.authorize = () => { started.resolve();return release.promise.then(() => true); };
        const running = f.client.invoke(await f.request());await started.promise;
        if (kind === 'rule') f.changeRule();if (kind === 'unmount') f.publish('A', false);if (kind === 'scope') f.client.close();release.resolve();
        const result: any = await running;expect(f.calls.execute).toBe(0);expect(result.code ?? result.receipt.outcome.code).toBe(kind === 'rule' ? 'TOOL_SOURCE_STALE' : kind === 'unmount' ? 'TOOL_UNAVAILABLE' : 'SCOPE_UNAVAILABLE');
        f.client.close();expect(f.core.store.inspect().activeLeases).toBe(0);
    });
});
