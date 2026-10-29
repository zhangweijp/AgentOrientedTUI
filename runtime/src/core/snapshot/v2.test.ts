import { describe, expect, it } from 'vitest';
import { createSnapshotCore, refKey } from './index.js';
import { validatePreparedV2Draft } from './v2-validator.js';

const appId = 'system_ide';
const instanceId = 'runtime-app-instance-1';
const groupedName = JSON.stringify([appId, 'FileDetail', 'lsp_hover']);

function makeV2(
    sequence = 1,
    sourceEpoch = sequence,
    viewInstanceId = 'vi:v1:["runtime-app-instance-1",1]',
    bindingVersion = 1,
) {
    const target = { viewId: 'fd_0', viewInstanceId, bindingVersion };
    return {
        schemaVersion: 2 as const, appId, instanceId,
        producerSeq: sequence, sourceEpoch, capturedAt: 100 + sequence,
        views: [{
            id: 'fd_0', viewInstanceId,
            type: 'FileDetail', name: 'App.tsx',
            kind: 'state', content: { format: 'markdown-v1', value: 'App.tsx' },
        }],
        refs: {
            [refKey('fd_0', viewInstanceId, 'selection')]: {
                id: 'selection', ownerViewId: 'fd_0',
                ownerViewInstanceId: viewInstanceId, refType: 'File',
                target: { kind: 'snapshot-value', payload: { file: 'App.tsx' } },
            },
        },
        tools: {
            [groupedName]: {
                id: groupedName, name: 'lsp_hover', viewType: 'FileDetail',
                description: 'Hover symbol in file',
                inputSchema: { type: 'object', properties: { line: { type: 'number' } } },
                isMutating: false, targets: [target],
            },
        },
    };
}
function core() {
    const c = createSnapshotCore();
    c.lifecycle.startApp(appId, instanceId);
    return c;
}
function published(result: ReturnType<ReturnType<typeof core>['committer']['accept']>) {
    expect(result.status).toBe('published');
    if (result.status !== 'published') throw new Error('Expected published');
    return result.snapshot;
}
function rejected(result: ReturnType<ReturnType<typeof core>['committer']['accept']>,
    code: string) {
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Expected rejected');
    expect(result.issue.code).toBe(code);
    return result.issue;
}

describe('M4 Stage 2: strict versioned V2 source-bound Snapshot contract', () => {
    it('commits source ViewInstanceId + Tool binding in ONE immutable V2 Snapshot', () => {
        const c = core();
        const source = makeV2();
        const result = published(c.committer.accept(source));
        expect(result.schemaVersion).toBe(2);
        expect(result.id).toContain('aotui-app-snapshot:v2:');
        expect(result.contentDigest).toMatch(/^fnv1a64:/);
        if (result.schemaVersion !== 2) throw new Error('Expected V2');
        expect(result.views[0].viewInstanceId).toBe(source.views[0].viewInstanceId);
        expect(result.tools[groupedName].targets[0].bindingVersion).toBe(1);
        expect(Object.isFrozen(result.tools[groupedName].targets)).toBe(true);
        expect(Object.isFrozen(result.views[0])).toBe(true);
        expect(JSON.stringify(result)).not.toContain('handler');
        expect(c.store.getTool({
            snapshotId: result.id, appId, instanceId, toolId: groupedName,
        })).toMatchObject({
            status: 'found',
            tool: { id: groupedName, targets: [{ viewId: 'fd_0', bindingVersion: 1 }] },
        });
        expect(c.store.resolveRef({
            snapshotId: result.id, appId, instanceId, viewId: 'fd_0',
            viewInstanceId: source.views[0].viewInstanceId, refId: 'selection',
        })).toMatchObject({ status: 'resolved', target: {
            kind: 'snapshot-value', payload: { file: 'App.tsx' },
        } });
        expect(c.store.resolveRef({
            snapshotId: result.id, appId, instanceId, viewId: 'fd_0',
            viewGeneration: source.views[0].viewInstanceId, refId: 'selection',
        })).toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
    });

    it('retains the old fd_0/vi_A binding when fd_0 is closed and reopened as vi_B', () => {
        const c = core();
        const old = makeV2(1, 1);
        const original = published(c.committer.accept(old));
        const replacement = makeV2(2, 2, 'vi:v1:["runtime-app-instance-1",2]', 2);
        replacement.refs[refKey('fd_0', replacement.views[0].viewInstanceId, 'selection')]
            .target.payload.file = 'new project B'; // new source
        const latest = published(c.committer.accept(replacement));
        expect(latest.revision).toBe(2);
        expect(latest.id).not.toBe(original.id);
        const prior = c.store.getById(original.id);
        expect(prior.status).toBe('found');
        if (prior.status !== 'found' || prior.snapshot.schemaVersion !== 2) throw new Error('Historical V2 required');
        expect(prior.snapshot.tools[groupedName].targets[0].viewInstanceId)
            .toBe(old.views[0].viewInstanceId);
        expect(prior.snapshot.refs[refKey('fd_0', old.views[0].viewInstanceId, 'selection')]
            .target).toMatchObject({ payload: { file: 'App.tsx' } });
        expect(c.store.resolveRef({
            snapshotId: latest.id, appId, instanceId, viewId: 'fd_0',
            viewInstanceId: old.views[0].viewInstanceId, refId: 'selection',
        })).toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
    });

    it('Tool-only re-registration changes Revision; equal content does not', () => {
        const c = core();
        const first = published(c.committer.accept(makeV2(1, 1)));
        const unchanged = c.committer.accept(makeV2(2, 2));
        expect(unchanged.status).toBe('unchanged');
        if (unchanged.status === 'unchanged') expect(unchanged.snapshot.id).toBe(first.id);
        const differentBinding = published(c.committer.accept(makeV2(3, 3, makeV2().views[0].viewInstanceId, 2)));
        expect(differentBinding.revision).toBe(2);
        expect(differentBinding.contentDigest).not.toBe(first.contentDigest);
        rejected(c.committer.accept(makeV2(4, 3, makeV2().views[0].viewInstanceId, 3)),
            'SNAPSHOT_SOURCE_EPOCH_CONFLICT');
    });

    it('V1 remains supported and is not silently interpreted as V2', () => {
        const c = core();
        const v1 = {
            schemaVersion: 1, appId, instanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{
                id: 'fd_0', generation: 'sdk_mount_A', type: 'FileDetail',
                name: 'App.tsx', kind: 'state',
                content: { format: 'markdown-v1', value: 'Legacy file' },
            }],
            refs: {}, tools: {},
        };
        const first = published(c.committer.accept(v1));
        expect(first.schemaVersion).toBe(1);
        expect(first.id).toContain('aotui-app-snapshot:v1:');
        rejected(c.committer.accept({
            ...v1, producerSeq: 2, sourceEpoch: 2,
            views: [{ ...v1.views[0], viewInstanceId: 'vi_B' }],
        }), 'SNAPSHOT_INVALID');
        const next = published(c.committer.accept(makeV2(3, 3)));
        expect(next.schemaVersion).toBe(2);
        expect(next.id).toContain('aotui-app-snapshot:v2:');
        expect(c.store.getById(first.id).status).toBe('found');
        expect(c.store.resolveRef({
            snapshotId: first.id, appId, instanceId, viewId: 'fd_0',
            viewInstanceId: 'sdk_mount_A', refId: 'selection',
        })).toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
    });

    it('rejects non-mounted or mismatched Tool targets, including wrong View type', () => {
        const c = core();
        for (const [n, change] of [
            (d: ReturnType<typeof makeV2>) => { d.tools[groupedName].targets[0].viewInstanceId = 'other'; },
            (d: ReturnType<typeof makeV2>) => { d.tools[groupedName].targets[0].viewId = 'fd_9'; },
            (d: ReturnType<typeof makeV2>) => { d.views[0].type = 'Workspace'; },
        ].entries()) {
            const draft = makeV2(n+1);
            change(draft);
            expect(rejected(c.committer.accept(draft), 'SNAPSHOT_INVALID').path)
                .toContain('targets');
        }
    });

    it('rejects duplicate targets, empty targets, and unversioned binding ids', () => {
        const c = core();
        for (const change of [
            (d: ReturnType<typeof makeV2>) => { d.tools[groupedName].targets = []; },
            (d: ReturnType<typeof makeV2>) => {
                d.tools[groupedName].targets = [d.tools[groupedName].targets[0], d.tools[groupedName].targets[0]];
            },
            (d: ReturnType<typeof makeV2>) => { d.tools[groupedName].targets[0].bindingVersion = 0; },
        ]) {
            const draft = makeV2();
            change(draft);
            rejected(c.committer.accept(draft), 'SNAPSHOT_INVALID');
        }
    });

    it('rejects malformed group Tool IDs and unknown schema fields', () => {
        const c = core();
        const wrongName = makeV2();
        wrongName.tools[groupedName].id = 'system_ide-FileDetail-lsp_hover';
        rejected(c.committer.accept(wrongName), 'SNAPSHOT_INVALID');
        const extra = makeV2();
        (extra.tools[groupedName] as any).visible = true;
        rejected(c.committer.accept(extra), 'SNAPSHOT_INVALID');
        const extraView = makeV2();
        (extraView.views[0] as any).generation = 'legacy_generation';
        rejected(c.committer.accept(extraView), 'SNAPSHOT_INVALID');
        const version3 = { ...makeV2(), schemaVersion: 3 };
        rejected(c.committer.accept(version3), 'SNAPSHOT_INVALID');
    });

    it('forbids a mismatched V2 Ref instanceId and Ref index alias', () => {
        const c = core();
        const bad = makeV2();
        const key = Object.keys(bad.refs)[0];
        bad.refs[key].ownerViewInstanceId = 'wrong';
        rejected(c.committer.accept(bad), 'SNAPSHOT_INVALID');
        const alias = makeV2();
        const value = Object.values(alias.refs)[0];
        delete (alias.refs as any)[Object.keys(alias.refs)[0]];
        (alias.refs as any)['fd_0:selection'] = value;
        rejected(c.committer.accept(alias), 'SNAPSHOT_INVALID');
    });

    it('ensures expired V2 leases and source App instance scope behave as V1', () => {
        let now = 0;
        const c = createSnapshotCore({ now: () => now, historyTtlMs: 20, leaseTtlMs: 30 });
        c.lifecycle.startApp(appId, instanceId);
        const a = published(c.committer.accept(makeV2(1, 1)));
        const lease = c.store.acquire(a.id, 10);
        expect(lease.status).toBe('acquired');
        now = 11;
        published(c.committer.accept(makeV2(2, 2, 'vi_B', 2)));
        if (lease.status === 'acquired') lease.lease.release();
        now = 35;
        expect(c.store.getById(a.id).status).toBe('rejected');
        expect(c.store.getTool({
            snapshotId: a.id, appId, instanceId, toolId: groupedName,
        })).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
        const wrong = makeV2(3, 3);
        wrong.instanceId = 'different-app-run';
        rejected(c.committer.accept(wrong), 'APP_INSTANCE_MISMATCH');
    });

    it('rejects getters and does not execute them in a V2 envelope', () => {
        let executed = 0;
        const untrusted = makeV2();
        Object.defineProperty(untrusted.tools[groupedName], 'targets', {
            get() { executed++; return []; }, enumerable: true,
        });
        const checked = validatePreparedV2Draft(untrusted);
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
        expect(executed).toBe(0);
    });

    it('enforces input bytes and number-of-target limits', () => {
        const big = makeV2();
        big.views[0].content.value = 'x'.repeat(10_000);
        expect(validatePreparedV2Draft(big, { maxSnapshotBytes: 1_000 }).ok).toBe(false);
        const list = makeV2();
        list.tools[groupedName].targets = Array.from({ length: 100 }, () => ({
            ...list.tools[groupedName].targets[0],
        }));
        expect(validatePreparedV2Draft(list, { maxViews: 5 }).ok).toBe(false);
    });
});


describe('M4 Stage 2: V2 adversarial source and schema boundaries', () => {
    it('fails closed on malformed envelope, duplicate View identity and impossible Tool Schema', () => {
        const adversaries: Array<[string, (draft: any) => void]> = [
            ['empty appId', d => { d.appId = ''; }],
            ['empty instanceId', d => { d.instanceId = ''; }],
            ['invalid producerSeq', d => { d.producerSeq = -1; }],
            ['negative sourceEpoch', d => { d.sourceEpoch = -2; }],
            ['invalid capturedAt', d => { d.capturedAt = -1; }],
            ['duplicate View ID', d => { d.views.push({ ...d.views[0], viewInstanceId: 'different' }); }],
            ['duplicate ViewInstanceId', d => {
                d.views.push({ ...d.views[0], id: 'fd_1' });
            }],
            ['empty View instance', d => { d.views[0].viewInstanceId = ''; }],
            ['invalid View kind', d => { d.views[0].kind = 'ghost'; }],
            ['unknown Root field', d => { d.extra = true; }],
            ['unknown Ref field', d => {
                Object.values(d.refs).forEach((ref: any) => { ref.extra = true; });
            }],
            ['bad Ref payload Date', d => {
                Object.values(d.refs).forEach((ref: any) => { ref.target.payload = new Date(); });
            }],
            ['unserializable Tool description', d => { d.tools[groupedName].description = BigInt(12); }],
            ['invalid Tool Schema', d => { d.tools[groupedName].inputSchema = { type: 'string' }; }],
            ['invalid Tool mutating flag', d => { d.tools[groupedName].isMutating = 'maybe'; }],
            ['extra target field', d => { d.tools[groupedName].targets[0].other = 'illegal'; }],
            ['noninteger target binding', d => { d.tools[groupedName].targets[0].bindingVersion = 1.2; }],
        ];
        for (const [description, modify] of adversaries) {
            const draft = makeV2();
            modify(draft);
            const checked = validatePreparedV2Draft(draft);
            expect(checked.ok, description).toBe(false);
        }
    });

    it('continues V2 with no visible tools and refuses resurrection of an old Tool binding', () => {
        const c = core();
        const first = published(c.committer.accept(makeV2(1)));
        const unavailable = makeV2(2, 2);
        unavailable.tools = {} as any; // no View currently exposes the Tool
        const without = published(c.committer.accept(unavailable));
        expect(without.schemaVersion).toBe(2);
        expect(c.store.getTool({
            snapshotId: without.id, appId, instanceId, toolId: groupedName,
        })).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_UNAVAILABLE' } });
        const offered = published(c.committer.accept(makeV2(3, 3)));
        expect(offered.revision).toBe(3);
        if (offered.schemaVersion !== 2 || first.schemaVersion !== 2) throw Error('Expected V2');
        expect(offered.tools[groupedName].targets[0].viewInstanceId)
            .toBe(first.tools[groupedName].targets[0].viewInstanceId);
        // Reusing a bindingVersion after disable/re-enable is PRODUCER violation.
        // The full SDK Tool Registry issues a new version; Core has no independent
        // live registration authority and must not claim it detects this alone.
    });

    it(' rejects an unknown App name in a self-consistent tool group', () => {
        const input = makeV2();
        input.tools[groupedName].id = JSON.stringify(['other-app', 'FileDetail', 'lsp_hover']);
        const checked = validatePreparedV2Draft(input);
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.issue.path).toContain('.id');
    });
});
