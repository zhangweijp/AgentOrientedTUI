import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { validatePreparedV5Draft } from './v5-validator.js';
import { canonicalJson } from './json.js';
import { DEFAULT_SNAPSHOT_LIMITS, VIEW_METADATA_BYTES } from './snapshot-support.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';

const text = '中文😀\n"\\\ud800';
const refId = '["view","mount","ref"]';
const toolId = '["app","Type","read"]';
const empty = compileOrdinarySchema({ type: 'object', properties: {} });
if (!empty.ok) throw new Error('Fixture Tool schema must compile');
const emptySchema = ordinaryParameterProfile(empty.contract);
const expected = {
    canonicalContent: canonicalJson({
        schemaVersion: 5,
        views: [{ toolBindings: [{ toolId, activationId: 'active-read' }], id: 'view', viewInstanceId: 'mount', type: 'Type', name: 'View', kind: 'state',
            content: { format: 'markdown-v1', value: text } }],
        refs: { [refId]: { id: 'ref', ownerViewId: 'view', ownerViewInstanceId: 'mount', refType: 'Value',
            target: { kind: 'snapshot-value', payload: { text } } } },
        tools: { [toolId]: { id: toolId, name: 'read', viewType: 'Type', nameSharedAcrossViewTypes: false, description: 'Read value',
            inputSchema: emptySchema } },
    } as any),
    contentDigest: 'fnv1a64:15d32d615941e3a2',
    bytes: 867,
    emptyCanonicalContent: '{"refs":{},"schemaVersion":5,"tools":{},"views":[]}',
    emptyContentDigest: 'fnv1a64:20916c6eeb9e97e6',
    emptyBytes: 136,
};

function fixture() {
    return {
        schemaVersion: 5 as const, appId: 'app', instanceId: 'instance',
        producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ toolBindings: [{ toolId, activationId: 'active-read' }], id: 'view', viewInstanceId: 'mount', type: 'Type', name: 'View', kind: 'state',
            content: { format: 'markdown-v1', value: text } }],
        refs: { [refId]: { id: 'ref', ownerViewId: 'view', ownerViewInstanceId: 'mount', refType: 'Value',
            target: { kind: 'snapshot-value', payload: { text } } } },
        tools: { [toolId]: { id: toolId, name: 'read', viewType: 'Type', nameSharedAcrossViewTypes: false, description: 'Read value',
            inputSchema: emptySchema } },
    };
}

function boundaryFixture() {
    const input = fixture();
    input.refs[refId]!.target.payload.text = 'x'.repeat(20_000);
    return input;
}
function canonicalBytes(value: unknown): number {
    return new TextEncoder().encode(canonicalJson(value as any)).byteLength;
}

function frozenData(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : null);
    for (const property of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, property)!;
        expect('value' in descriptor).toBe(true);
        expect(descriptor.writable).toBe(false);
        frozenData(descriptor.value);
    }
}

describe('V5 complete metadata boundary', () => {
    it('keeps complete metadata, escaped Unicode data, and detached frozen maps', () => {
        const input = fixture();
        const original = structuredClone(input);
        const checked = validatePreparedV5Draft(input);
        expect(checked.ok).toBe(true);
        if (!checked.ok) throw new Error('Expected a valid fixture');
        expect(checked.value).toEqual({
            draft: original, canonicalContent: expected.canonicalContent,
            contentDigest: expected.contentDigest, bytes: expected.bytes,
        });
        expect(Reflect.ownKeys(checked.value)).toEqual(['draft', 'canonicalContent', 'contentDigest', 'bytes']);
        expect(Object.isFrozen(checked)).toBe(true);
        expect(Object.isFrozen(checked.value)).toBe(true);
        frozenData(checked.value.draft);
        expect(Object.isFrozen(input)).toBe(false);
        input.views[0].content.value = 'changed';
        input.refs[refId].target.payload.text = 'changed';
        expect(checked.value.draft).toEqual(original);
    });

    it('rejects accessors without calling the getter or freezing caller data', () => {
        const input = fixture();
        let calls = 0;
        Object.defineProperty(input.views[0].content, 'value', {
            enumerable: true, configurable: true, get() { calls++; return text; },
        });
        const checked = validatePreparedV5Draft(input);
        expect(checked.ok).toBe(false);
        if (checked.ok) throw new Error('Expected accessor rejection');
        expect(checked.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
        expect(checked.envelope).toEqual({ appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1 });
        expect(calls).toBe(0);
        expect(Object.isFrozen(input.views[0].content)).toBe(false);
    });

    it('keeps strict field rejection ahead of invalid identity', () => {
        const checked = validatePreparedV5Draft({ ...fixture(), appId: '', extra: true });
        expect(checked).toEqual({ ok: false, issue: {
            code: 'SNAPSHOT_INVALID', path: '$.extra', message: 'Unknown Snapshot field',
        } });
        expect(Reflect.ownKeys(checked)).toEqual(['ok', 'issue']);
        expect(Object.isFrozen(checked)).toBe(true);
    });

    it('accepts wider Core View IDs while keeping the canonical View metadata byte limit', () => {
        const base = fixture();
        const view = { ...base.views[0]!, id: '', name: 'Item', toolBindings: [] };
        const draft = (id: string) => ({ ...base, views: [{ ...view, id }], refs: {}, tools: {} });
        expect(validatePreparedV5Draft(draft('file-甲\n')).ok).toBe(true);
        const { content: _content, toolBindings: _bindings, ...metadata } = view;
        const id = 'x'.repeat(VIEW_METADATA_BYTES - canonicalBytes(metadata));
        expect(validatePreparedV5Draft(draft(id)).ok).toBe(true);
        expect(validatePreparedV5Draft(draft(id + 'x'))).toMatchObject({
            ok: false, issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[0]' },
        });
    });

    it.each([-1, 0, 1])('keeps the final byte boundary at the fixed size %+i', delta => {
        const input = boundaryFixture(), bytes = canonicalBytes(input);
        const checked = validatePreparedV5Draft(input, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: bytes + delta });
        expect(checked.ok).toBe(delta >= 0);
        if (!checked.ok) expect(checked).toEqual({ ok: false, issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$', message: 'Snapshot byte budget exceeded',
        }, envelope: { appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1 } });
        else expect(checked.value.bytes).toBe(bytes);
    });

    it('preserves unchanged identity, degraded lastGood, and recovery revision', () => {
        const core = createSnapshotCore({ appId: 'app', instanceId: 'instance', now: () => 7 });
        try {
            const first = core.committer.accept(fixture());
            if (first.status !== 'published') throw new Error('Expected publication');
            expect(first.snapshot.contentDigest).toBe(expected.contentDigest);
            const same = core.committer.accept({ ...fixture(), producerSeq: 2, sourceEpoch: 2 });
            expect(same.status).toBe('unchanged');
            if (same.status !== 'unchanged') throw new Error('Expected unchanged');
            expect(same.snapshot).toBe(first.snapshot);
            const bad = core.committer.accept({ ...fixture(), producerSeq: 3, sourceEpoch: 3, extra: true });
            expect(bad.status).toBe('rejected');
            const degraded = core.store.readLatest('app');
            expect(degraded.status).toBe('degraded');
            if (degraded.status !== 'degraded') throw new Error('Expected degraded');
            expect(degraded.lastGood).toBe(first.snapshot);
            const repair = fixture();
            repair.producerSeq = 4;
            repair.sourceEpoch = 4;
            repair.views[0].content.value = 'new';
            const recovered = core.committer.accept(repair);
            if (recovered.status !== 'published') throw new Error('Expected recovery');
            expect(recovered.snapshot.revision).toBe(2);
            expect(core.store.inspect().historicalSnapshots).toBe(0);
        } finally { core.lifecycle.dispose(); }
    });
});

it('retains complete metadata for a legal empty V5 application', () => {
    const input = { ...fixture(), views: [], refs: {}, tools: {} };
    const checked = validatePreparedV5Draft(input);
    if (!checked.ok) throw new Error('Expected legal empty V5');
    expect(checked.value).toEqual({ draft: input, canonicalContent: expected.emptyCanonicalContent,
        contentDigest: expected.emptyContentDigest, bytes: expected.emptyBytes });
    frozenData(checked.value.draft);
});

it('enforces the V5 whole-envelope byte limit directly', () => {
    const input = boundaryFixture();
    const checked = validatePreparedV5Draft(input, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: canonicalBytes(input) - 1 });
    expect(checked).toMatchObject({ ok: false, issue: {
        code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$', message: 'Snapshot byte budget exceeded',
    } });
});
