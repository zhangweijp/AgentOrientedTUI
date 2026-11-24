import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { validatePreparedSnapshot } from './validate-snapshot.js';
import { canonicalJson } from './json.js';
import { DEFAULT_SNAPSHOT_LIMITS, VIEW_METADATA_BYTES } from './snapshot-support.js';
import { compileToolParameters } from '../tool/tool-parameters.js';

const text = '中文😀\n"\\\ud800';
const refId = '["view","mount","ref"]';
const toolId = '["app","Type","read"]';
const empty = compileToolParameters({ type: 'object', properties: {} });
if (!empty.ok) throw new Error('Fixture Tool schema must compile');
const emptySchema = empty.contract.schema;
const expected = {
    canonicalContent: canonicalJson({
        schemaVersion: 8,
        views: [{ toolBindings: [{ toolId, activationId: 'active-read' }], id: 'view', viewInstanceId: 'mount', type: 'Type', name: 'View', region: 'dynamic',
            content: { format: 'markdown-v1', value: text } }],
        refs: { [refId]: { valueSchema: { type: 'object' }, scope: 'protected', id: 'ref', ownerViewId: 'view', ownerViewInstanceId: 'mount', refType: 'Value',
            target: { kind: 'snapshot-value', payload: { text } } } },
        tools: { [toolId]: { multiplicity: 'multiple', id: toolId, name: 'read', viewType: 'Type',  description: 'Read value',
            inputSchema: emptySchema } },
    } as any),
    contentDigest: 'fnv1a64:d5745fd531cebede',
    bytes: 860,
    emptyCanonicalContent: '{"refs":{},"schemaVersion":8,"tools":{},"views":[]}',
    emptyContentDigest: 'fnv1a64:692b628ab889e35b',
    emptyBytes: 136,
};

function fixture() {
    return {
        schemaVersion: 8 as const, appId: 'app', instanceId: 'instance',
        producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ toolBindings: [{ toolId, activationId: 'active-read' }], id: 'view', viewInstanceId: 'mount', type: 'Type', name: 'View', region: 'dynamic',
            content: { format: 'markdown-v1', value: text } }],
        refs: { [refId]: { valueSchema: { type: 'object' }, scope: 'protected', id: 'ref', ownerViewId: 'view', ownerViewInstanceId: 'mount', refType: 'Value',
            target: { kind: 'snapshot-value', payload: { text } } } },
        tools: { [toolId]: { multiplicity: 'multiple', id: toolId, name: 'read', viewType: 'Type',  description: 'Read value',
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

describe('Snapshot metadata boundary', () => {
    it('keeps complete metadata, escaped Unicode data, and detached frozen maps', () => {
        const input = fixture();
        const original = structuredClone(input);
        const checked = validatePreparedSnapshot(input);
        expect(checked.ok).toBe(true);
        if (!checked.ok) throw new Error('Expected a valid fixture');
        expect(checked.value).toEqual({
            draft: original, canonicalContent: expected.canonicalContent,
            contentBytes: new TextEncoder().encode(expected.canonicalContent), bytes: expected.bytes,
        });
        expect(Reflect.ownKeys(checked.value)).toEqual(['draft', 'canonicalContent', 'contentBytes', 'bytes']);
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
        const checked = validatePreparedSnapshot(input);
        expect(checked.ok).toBe(false);
        if (checked.ok) throw new Error('Expected accessor rejection');
        expect(checked.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
        expect(checked.envelope).toEqual({ appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1 });
        expect(calls).toBe(0);
        expect(Object.isFrozen(input.views[0].content)).toBe(false);
    });

    it('keeps strict field rejection ahead of invalid identity', () => {
        const checked = validatePreparedSnapshot({ ...fixture(), appId: '', extra: true });
        expect(checked).toEqual({ ok: false, issue: {
            code: 'SNAPSHOT_INVALID', path: '$.extra', message: 'Unknown Snapshot field',
        } });
        expect(Reflect.ownKeys(checked)).toEqual(['ok', 'issue']);
        expect(Object.isFrozen(checked)).toBe(true);
    });

    it('validates instance names and keeps the canonical View metadata byte limit', () => {
        const base = fixture();
        const view = { ...base.views[0]!, id: '', name: 'Item', toolBindings: [] };
        const draft = (id: string) => ({ ...base, views: [{ ...view, id }], refs: {}, tools: {} });
        expect(validatePreparedSnapshot(draft('file-甲\n')).ok).toBe(false);
        expect(validatePreparedSnapshot(draft('1_file')).ok).toBe(true);
        const { content: _content, toolBindings: _bindings, ...metadata } = view;
        const id = 'x'.repeat(VIEW_METADATA_BYTES - canonicalBytes(metadata));
        expect(validatePreparedSnapshot(draft(id)).ok).toBe(true);
        expect(validatePreparedSnapshot(draft(id + 'x'))).toMatchObject({
            ok: false, issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[0]' },
        });
    });

    it.each([-1, 0, 1])('keeps the final byte boundary at the fixed size %+i', delta => {
        const input = boundaryFixture(), bytes = canonicalBytes(input);
        const checked = validatePreparedSnapshot(input, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: bytes + delta });
        expect(checked.ok).toBe(delta >= 0);
        if (!checked.ok) expect(checked).toEqual({ ok: false, issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$', message: 'Snapshot byte budget exceeded',
        }, envelope: { appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1 } });
        else expect(checked.value.bytes).toBe(bytes);
    });

    it('counts the escaped envelope and content at the exact UTF-8 frame boundary', () => {
        const input = boundaryFixture();
        input.appId = '1_app';
        input.instanceId = text + '\udc00';
        input.producerSeq = Number.MAX_SAFE_INTEGER;
        input.sourceEpoch = 0;
        input.capturedAt = 12_345_678_901;
        input.refs[refId]!.target.payload.text = text.repeat(600);
        input.views[0]!.toolBindings = [];
        const frame = { ...input, tools: {} };
        const bytes = canonicalBytes(frame);
        expect(validatePreparedSnapshot(frame, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: bytes }))
            .toMatchObject({ ok: true, value: { bytes } });
        expect(validatePreparedSnapshot(frame, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: bytes - 1 }))
            .toMatchObject({ ok: false, issue: { path: '$', message: 'Snapshot byte budget exceeded' } });
    });

    it('preserves unchanged identity, degraded lastGood, and recovery revision', () => {
        const core = createSnapshotCore({ appId: 'app', instanceId: 'instance', now: () => 7 });
        try {
            const first = core.committer.accept(fixture());
            if (first.status !== 'published') throw new Error('Expected publication');
            expect(Object.getOwnPropertyDescriptor(first.snapshot, 'contentDigest')).toEqual({
                value: expected.contentDigest, writable: false, enumerable: true, configurable: false,
            });
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
            expect(core.store.inspect().heldSnapshots).toBe(0);
        } finally { core.lifecycle.dispose(); }
    });
});

it('retains complete metadata for a legal empty Snapshot application', () => {
    const input = { ...fixture(), views: [], refs: {}, tools: {} };
    const checked = validatePreparedSnapshot(input);
    if (!checked.ok) throw new Error('Expected legal empty Snapshot');
    expect(checked.value).toEqual({ draft: input, canonicalContent: expected.emptyCanonicalContent,
        contentBytes: new TextEncoder().encode(expected.emptyCanonicalContent), bytes: expected.emptyBytes });
    frozenData(checked.value.draft);
    const core = createSnapshotCore({ appId: input.appId, instanceId: input.instanceId });
    try {
        expect(core.committer.accept(input)).toMatchObject({ status: 'published', snapshot: { contentDigest: expected.emptyContentDigest } });
    } finally { core.lifecycle.dispose(); }
});

it('enforces the complete Snapshot byte limit directly', () => {
    const input = boundaryFixture();
    const checked = validatePreparedSnapshot(input, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: canonicalBytes(input) - 1 });
    expect(checked).toMatchObject({ ok: false, issue: {
        code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$', message: 'Snapshot byte budget exceeded',
    } });
});
