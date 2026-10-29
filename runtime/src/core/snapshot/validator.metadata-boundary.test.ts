import { describe, expect, it } from 'vitest';
import { createSnapshotCore, validatePreparedDraft, validatePreparedV2Draft } from './index.js';

const text = '中文😀\n"\\\ud800';
const refId = '["view","mount","ref"]';
const toolId = '["app","Type","read"]';
const expected = {
    "1": {
        "canonicalContent": "{\"refs\":{\"[\\\"view\\\",\\\"mount\\\",\\\"ref\\\"]\":{\"id\":\"ref\",\"ownerViewGeneration\":\"mount\",\"ownerViewId\":\"view\",\"refType\":\"Value\",\"target\":{\"kind\":\"snapshot-value\",\"payload\":{\"text\":\"\u4e2d\u6587\ud83d\ude00\\n\\\"\\\\\\ud800\"}}}},\"tools\":{\"[\\\"app\\\",\\\"Type\\\",\\\"read\\\"]\":{\"description\":\"Read value\",\"id\":\"[\\\"app\\\",\\\"Type\\\",\\\"read\\\"]\",\"inputSchema\":{\"properties\":{},\"type\":\"object\"},\"isMutating\":false,\"name\":\"read\",\"viewType\":\"Type\",\"visible\":true}},\"views\":[{\"content\":{\"format\":\"markdown-v1\",\"value\":\"\u4e2d\u6587\ud83d\ude00\\n\\\"\\\\\\ud800\"},\"generation\":\"mount\",\"id\":\"view\",\"kind\":\"state\",\"name\":\"View\",\"type\":\"Type\"}]}",
        "contentDigest": "fnv1a64:6c8d04a417aa7085",
        "bytes": 679
    },
    "2": {
        "canonicalContent": "{\"refs\":{\"[\\\"view\\\",\\\"mount\\\",\\\"ref\\\"]\":{\"id\":\"ref\",\"ownerViewId\":\"view\",\"ownerViewInstanceId\":\"mount\",\"refType\":\"Value\",\"target\":{\"kind\":\"snapshot-value\",\"payload\":{\"text\":\"\u4e2d\u6587\ud83d\ude00\\n\\\"\\\\\\ud800\"}}}},\"schemaVersion\":2,\"tools\":{\"[\\\"app\\\",\\\"Type\\\",\\\"read\\\"]\":{\"description\":\"Read value\",\"id\":\"[\\\"app\\\",\\\"Type\\\",\\\"read\\\"]\",\"inputSchema\":{\"properties\":{},\"type\":\"object\"},\"isMutating\":false,\"name\":\"read\",\"targets\":[{\"bindingVersion\":1,\"viewId\":\"view\",\"viewInstanceId\":\"mount\"}],\"viewType\":\"Type\"}},\"views\":[{\"content\":{\"format\":\"markdown-v1\",\"value\":\"\u4e2d\u6587\ud83d\ude00\\n\\\"\\\\\\ud800\"},\"id\":\"view\",\"kind\":\"state\",\"name\":\"View\",\"type\":\"Type\",\"viewInstanceId\":\"mount\"}]}",
        "contentDigest": "fnv1a64:93b4f1ffe53e7634",
        "bytes": 742
    },
    "emptyV2": {
        "canonicalContent": "{\"refs\":{},\"schemaVersion\":2,\"tools\":{},\"views\":[]}",
        "contentDigest": "fnv1a64:d4ca7693eab7f0ed",
        "bytes": 136
    }
};

function fixture(version: 1 | 2) {
    return {
        schemaVersion: version, appId: 'app', instanceId: 'instance',
        producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{
            id: 'view', ...(version === 1 ? { generation: 'mount' } : { viewInstanceId: 'mount' }),
            type: 'Type', name: 'View', kind: 'state',
            content: { format: 'markdown-v1', value: text },
        }],
        refs: { [refId]: {
            id: 'ref', ownerViewId: 'view',
            ...(version === 1 ? { ownerViewGeneration: 'mount' } : { ownerViewInstanceId: 'mount' }),
            refType: 'Value', target: { kind: 'snapshot-value', payload: { text } },
        } },
        tools: { [toolId]: {
            id: toolId, name: 'read', viewType: 'Type', description: 'Read value',
            inputSchema: { type: 'object', properties: {} }, isMutating: false,
            ...(version === 1 ? { visible: true } : {
                targets: [{ viewId: 'view', viewInstanceId: 'mount', bindingVersion: 1 }],
            }),
        } },
    };
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

describe.each([1, 2] as const)('V%s complete metadata boundary', version => {
    const validate = version === 1 ? validatePreparedDraft : validatePreparedV2Draft;

    it('keeps complete metadata, escaped Unicode data, and detached frozen maps', () => {
        const input = fixture(version);
        const original = structuredClone(input);
        const checked = validate(input);
        expect(checked.ok).toBe(true);
        if (!checked.ok) throw new Error('Expected a valid fixture');
        expect(checked.value).toEqual({
            draft: original, canonicalContent: expected[version].canonicalContent,
            contentDigest: expected[version].contentDigest, bytes: expected[version].bytes,
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
        const input = fixture(version);
        let calls = 0;
        Object.defineProperty(input.views[0].content, 'value', {
            enumerable: true, configurable: true, get() { calls++; return text; },
        });
        const checked = validate(input);
        expect(checked.ok).toBe(false);
        if (checked.ok) throw new Error('Expected accessor rejection');
        expect(checked.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
        expect(checked.envelope).toEqual({ appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1 });
        expect(calls).toBe(0);
        expect(Object.isFrozen(input.views[0].content)).toBe(false);
    });

    it('keeps field rejection ahead of invalid identity and omits an invalid envelope', () => {
        const checked = validate({ ...fixture(version), appId: '', extra: true });
        expect(checked).toEqual({ ok: false, issue: {
            code: 'SNAPSHOT_INVALID', path: '$.extra',
            message: version === 1 ? 'Unknown schema field' : 'Unknown V2 field',
        } });
        expect(Reflect.ownKeys(checked)).toEqual(['ok', 'issue']);
        expect(Object.isFrozen(checked)).toBe(true);
    });

    it.each([-1, 0, 1])('keeps the final byte boundary at the fixed size %+i', delta => {
        const checked = validate(fixture(version), { maxSnapshotBytes: expected[version].bytes + delta });
        expect(checked.ok).toBe(delta >= 0);
        if (!checked.ok) expect(checked).toEqual({ ok: false, issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$',
            message: version === 1 ? 'App Snapshot byte budget exceeded' : 'V2 Snapshot byte budget exceeded',
        }, envelope: { appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1 } });
        else expect(checked.value.bytes).toBe(expected[version].bytes);
    });

    it('preserves unchanged identity, degraded lastGood, and recovery revision', () => {
        const core = createSnapshotCore({ now: () => 7 });
        core.lifecycle.startApp('app', 'instance');
        try {
            const first = core.committer.accept(fixture(version));
            if (first.status !== 'published') throw new Error('Expected publication');
            expect(first.snapshot.contentDigest).toBe(expected[version].contentDigest);
            const same = core.committer.accept({ ...fixture(version), producerSeq: 2, sourceEpoch: 2 });
            expect(same.status).toBe('unchanged');
            if (same.status !== 'unchanged') throw new Error('Expected unchanged');
            expect(same.snapshot).toBe(first.snapshot);
            const bad = core.committer.accept({ ...fixture(version), producerSeq: 3, sourceEpoch: 3, extra: true });
            expect(bad.status).toBe('rejected');
            const degraded = core.store.readLatest('app');
            expect(degraded.status).toBe('degraded');
            if (degraded.status !== 'degraded') throw new Error('Expected degraded');
            expect(degraded.lastGood).toBe(first.snapshot);
            const repair = fixture(version);
            repair.producerSeq = 4;
            repair.sourceEpoch = 4;
            repair.views[0].content.value = 'new';
            const recovered = core.committer.accept(repair);
            if (recovered.status !== 'published') throw new Error('Expected recovery');
            expect(recovered.snapshot.revision).toBe(2);
            expect(core.store.inspect().historicalSnapshots).toBe(1);
        } finally { core.lifecycle.dispose(); }
    });
});

it('retains complete metadata for a legal empty V2 application', () => {
    const input = { ...fixture(2), views: [], refs: {}, tools: {} };
    const checked = validatePreparedV2Draft(input);
    if (!checked.ok) throw new Error('Expected legal empty V2');
    expect(checked.value).toEqual({ draft: input, ...expected.emptyV2 });
    frozenData(checked.value.draft);
});

it('retains the proxy byte rejection before the separate V2 envelope rejection', () => {
    const belowProxy = validatePreparedV2Draft(fixture(2), { maxSnapshotBytes: 678 });
    const atProxy = validatePreparedV2Draft(fixture(2), { maxSnapshotBytes: 679 });
    expect(belowProxy.ok).toBe(false);
    expect(atProxy.ok).toBe(false);
    if (belowProxy.ok || atProxy.ok) throw new Error('Expected both byte guards');
    expect(belowProxy.issue).toEqual({ code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$',
        message: 'App Snapshot byte budget exceeded' });
    expect(atProxy.issue).toEqual({ code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$',
        message: 'V2 Snapshot byte budget exceeded' });
});
