import { describe, expect, it } from 'vitest';
import { canonicalJson, copyJson, utf8Size } from './json.js';
import { createSnapshotCore } from './store.js';
import { refKey } from './snapshot-support.js';
import { validatePreparedV5Draft } from './v5-validator.js';
import type { JsonValue, PreparedAppSnapshotDraftV5, SnapshotCore } from './types.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';

// Evidence of CURRENT Core/DOM-adapter behavior, not a proposed Ref executor.
// Identities and declarations below are fixtures, not mounts performed by SDK.
const appId = 'wave2b';
const instanceId = 'wave2b-run';
const mountA = 'fixture-mount-A';
const mountB = 'fixture-mount-B';
const toolId = JSON.stringify([appId, 'FileDetail', 'inspect']);
const argsLimits = { maxDepth: 24, maxNodes: 10_000, maxApproxBytes: 128 * 1024 };
const refParameters = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true });
if (!refParameters.ok) throw new Error('Invalid Ref fixture');

function draft(sequence = 1, valueA: JsonValue = { value: 'A' }, a = mountA): PreparedAppSnapshotDraftV5 {
    return {
        schemaVersion: 5, appId, instanceId,
        producerSeq: sequence, sourceEpoch: sequence, capturedAt: sequence,
        views: [['fd_A', a], ['fd_B', mountB]].map(([id, viewInstanceId]) => ({
            toolBindings: [{ toolId, activationId: 'active-' + viewInstanceId }], id, viewInstanceId, type: 'FileDetail', name: id, kind: 'state',
            content: { format: 'markdown-v1', value: '[File](file)' },
        })),
        refs: {
            [refKey('fd_A', a, 'file')]: {
                id: 'file', ownerViewId: 'fd_A', ownerViewInstanceId: a, refType: 'File',
                target: { kind: 'snapshot-value', payload: valueA },
            },
            [refKey('fd_B', mountB, 'file')]: {
                id: 'file', ownerViewId: 'fd_B', ownerViewInstanceId: mountB, refType: 'File',
                target: { kind: 'snapshot-value', payload: { value: 'B' } },
            },
        },
        tools: { [toolId]: {
            id: toolId, name: 'inspect', viewType: 'FileDetail', nameSharedAcrossViewTypes: false, description: 'Inspect',
            inputSchema: ordinaryParameterProfile(refParameters.contract),
        } },
    };
}
function start(options: Omit<Parameters<typeof createSnapshotCore>[0], 'appId' | 'instanceId'> = {}) {
    return createSnapshotCore({ appId, instanceId, ...options });
}
function publish(core: SnapshotCore, input = draft()) {
    const result = core.committer.accept(input);
    expect(result.status).toBe('published');
    if (result.status !== 'published' || result.snapshot.schemaVersion !== 5) throw new Error('Expected a committed snapshot');
    return result.snapshot;
}
function selector(snapshotId: string, viewId = 'fd_A', viewInstanceId = mountA, refId = 'file') {
    return { snapshotId, appId, instanceId, viewId, viewInstanceId, refId };
}
describe('Wave 2B: exact historical Ref lookup', () => {
    it('resolves two same-named Refs by exact source owner, without suffix fallback', () => {
        const core = start(); const source = publish(core);
        expect(core.store.resolveRef(selector(source.id))).toMatchObject({
            status: 'resolved', target: { payload: { value: 'A' } },
        });
        expect(core.store.resolveRef(selector(source.id, 'fd_B', mountB))).toMatchObject({
            status: 'resolved', target: { payload: { value: 'B' } },
        });
        expect(core.store.resolveRef(selector(source.id, 'fd_A', mountB))).toMatchObject({
            status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' },
        });
    });

    it('Ref-only A to B publishes a new immutable value while old source and Tool stay usable', () => {
        const core = start(); const originalValue = { nested: { value: 'A' } };
        const old = publish(core, draft(1, originalValue));
        const held = core.store.acquire(old.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
        originalValue.nested.value = 'caller mutation';
        const fresh = publish(core, draft(2, { nested: { value: 'B' } }));
        expect(fresh.id).not.toBe(old.id);
        expect(fresh.views).toEqual(old.views);
        expect(fresh.tools).toEqual(old.tools);
        const historical = core.store.resolveRef(selector(old.id));
        expect(historical).toMatchObject({ status: 'resolved', target: { payload: { nested: { value: 'A' } } } });
        if (historical.status !== 'resolved' || historical.target.kind !== 'snapshot-value') throw new Error('Expected data');
        const payload = historical.target.payload as { nested: { value: string } };
        expect(Object.isFrozen(payload.nested)).toBe(true);
        expect(() => { payload.nested.value = 'mutation'; }).toThrow(TypeError);
        expect(core.store.resolveRef(selector(fresh.id))).toMatchObject({
            status: 'resolved', target: { payload: { nested: { value: 'B' } } },
        });
        expect(core.store.getTool({ snapshotId: old.id, appId, instanceId, toolId })).toMatchObject({ status: 'found' });
        held.lease.release(); expect(core.store.inspect().activeLeases).toBe(0);
    });

    it('remount never retargets an old Ref while another same-type View keeps the shared Tool active', () => {
        const core = start(); const old = publish(core);
        const held = core.store.acquire(old.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
        const fresh = publish(core, draft(2, { value: 'replacement' }, 'fixture-new-A'));
        expect(core.store.resolveRef(selector(old.id))).toMatchObject({
            status: 'resolved', target: { payload: { value: 'A' } },
        });
        expect(core.store.resolveRef(selector(fresh.id))).toMatchObject({
            status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' },
        });
        expect(core.store.resolveRef(selector(old.id, 'fd_A', 'fixture-new-A'))).toMatchObject({
            status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' },
        });
        expect(fresh.views.find(view => view.id === 'fd_B')?.toolBindings).toEqual(old.views.find(view => view.id === 'fd_B')?.toolBindings);
        expect(fresh.views.find(view => view.id === 'fd_A')?.toolBindings).not.toEqual(old.views.find(view => view.id === 'fd_A')?.toolBindings);
        expect(fresh.tools).toEqual(old.tools);
        held.lease.release(); expect(core.store.inspect().activeLeases).toBe(0);
    });

    it('a missing Ref in A cannot resolve to B even though B owns a Ref with the same id', () => {
        const core = start(); const input = draft();
        const source = publish(core, { ...input, refs: { [refKey('fd_B', mountB, 'file')]: input.refs[refKey('fd_B', mountB, 'file')] } });
        expect(core.store.resolveRef(selector(source.id))).toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_FOUND' } });
        expect(core.store.resolveRef(selector(source.id, 'fd_B', mountB)).status).toBe('resolved');
        expect(core.store.resolveRef(selector(source.id, 'fd_A', mountA, '[File B](file)')))
            .toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_FOUND' } });
    });

    it.each([
        ['App', { appId: 'other-app' }],
        ['AppInstance', { instanceId: 'other-run' }],
    ])('rejects a selector from another %s', (_name, override) => {
        const core = start(); const source = publish(core);
        expect(core.store.resolveRef({ ...selector(source.id), ...override })).toMatchObject({
            status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' },
        });
    });

    it('returns the Ref type and business payload from the snapshot', () => {
        const core = start(); const input = draft();
        const source = publish(core, { ...input, refs: {
            ...input.refs,
            [refKey('fd_A', mountA, 'file')]: {
                ...input.refs[refKey('fd_A', mountA, 'file')], refType: 'Todo',
                target: { kind: 'snapshot-value', payload: { id: 'no-resource-is-opened', version: 'v1' } },
            },
        } });
        expect(core.store.resolveRef(selector(source.id))).toMatchObject({
            status: 'resolved', ref: { refType: 'Todo' },
            target: { kind: 'snapshot-value', payload: { id: 'no-resource-is-opened', version: 'v1' } },
        });
    });

    it('rejects a malformed owner, unknown target category and unknown descriptor fields', () => {
        const input = draft(); const key = refKey('fd_A', mountA, 'file');
        for (const ref of [
            { ...input.refs[key], ownerViewInstanceId: mountB },
            { ...input.refs[key], target: { kind: 'resource', payload: {} } },
            { ...input.refs[key], target: { kind: 'entity', entityType: 'File', entityId: 'old' } },
            { ...input.refs[key], extraAuthority: true },
        ]) expect(validatePreparedV5Draft({ ...input, refs: { ...input.refs, [key]: ref } })).toMatchObject({
            ok: false, issue: { code: 'SNAPSHOT_INVALID' },
        });
        expect(validatePreparedV5Draft({ ...input, tools: {
            [toolId]: { ...input.tools[toolId], refParams: { file: 'File' } },
        } })).toMatchObject({ ok: false, issue: { code: 'SNAPSHOT_INVALID' } });
    });

    it('expired but pinned history is readable by resolveRef and cannot be freshly acquired for execution', () => {
        let now = 0;
        const core = start({ now: () => now, historyTtlMs: 20, leaseTtlMs: 100 });
        const old = publish(core); const lease = core.store.acquire(old.id);
        if (lease.status !== 'acquired') throw new Error('Expected lease');
        now = 1; publish(core, draft(2, { value: 'B' }));
        now = 21;
        expect(core.store.resolveRef(selector(old.id))).toMatchObject({ status: 'resolved', target: { payload: { value: 'A' } } });
        expect(core.store.acquire(old.id)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
        lease.lease.release();
        expect(core.store.resolveRef(selector(old.id))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
    });

    it('stopping an App removes its current Snapshot while pinned Ref data is retained', () => {
        const core = start(); const source = publish(core);
        const held = core.store.acquire(source.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
        core.lifecycle.stop();
        expect(core.store.resolveRef(selector(source.id)).status).toBe('resolved');
        expect(core.store.readLatest(appId)).toMatchObject({ status: 'stopped' });
        held.lease.release(); expect(core.store.inspect().activeLeases).toBe(0);
    });
});

describe('Wave 2B: current JSON budgets at prospective expansion boundaries (no resolver)', () => {
    it('a Snapshot-legal payload can exceed the existing Tool args byte budget', () => {
        const core = start(); const value = { text: 'x'.repeat(140 * 1024) };
        const source = publish(core, draft(1, value));
        expect(core.store.resolveRef(selector(source.id)).status).toBe('resolved');
        expect(() => copyJson({ file: value }, argsLimits)).toThrow('byte budget');
    });

    it('repeated aliases cost bytes and produce separate copies, even when their source payload is shared', () => {
        const value = { text: 'x'.repeat(70 * 1024) };
        expect(() => copyJson({ first: value }, argsLimits)).not.toThrow();
        expect(() => copyJson({ first: value, second: value }, argsLimits)).toThrow('byte budget');
        const small = { text: 'small' };
        const copied = copyJson({ first: small, second: small }, argsLimits) as Record<string, JsonValue>;
        expect(copied.first).toEqual(copied.second);
        expect(copied.first).not.toBe(copied.second);
        expect(utf8Size(canonicalJson(copied))).toBe(52);
    });

    it('counts depth from the resulting args root rather than from an isolated Ref payload', () => {
        let value: JsonValue = 'leaf';
        for (let n = 0; n < 24; n++) value = { child: value };
        expect(() => copyJson(value, argsLimits)).not.toThrow();
        expect(validatePreparedV5Draft(draft(1, value)).ok).toBe(true);
        expect(() => copyJson({ file: value }, argsLimits)).toThrow('Depth budget');
    });

    it('charges repeated payload nodes against the aggregate args node budget', () => {
        const value = Array.from({ length: 5_000 }, () => null);
        expect(() => copyJson({ first: value }, argsLimits)).not.toThrow();
        expect(() => copyJson({ first: value, second: value }, argsLimits)).toThrow('Node budget');
    });
});
