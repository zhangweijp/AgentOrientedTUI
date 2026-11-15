import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshotV4, JsonValue, PreparedAppSnapshotDraftV4, SnapshotStoreOptions } from '../snapshot/types.js';
import { compileOrdinaryProfile } from './ordinary-parameter-profile.js';
import { prepareViewTypeParameters } from './snapshot-value-arguments.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';

const schema = (refType = 'unknown', parameter = 'file'): JsonValue => {
    const result = compileOrdinarySchema({ type: 'object', properties: { [parameter]: {
        type: 'string', minLength: 1, 'x-aotui-ref-kind': refType, 'x-aotui-ref-value': { type: 'object' },
    } }, required: [parameter], additionalProperties: true });
    if (!result.ok) throw Error('Invalid parameter fixture');
    return ordinaryParameterProfile(result.contract);
};

function fixture(options: {
    payload?: JsonValue; inputSchema?: JsonValue; refType?: string; refId?: string;
    viewId?: string; viewInstanceId?: string; activationId?: string;
    storeOptions?: SnapshotStoreOptions;
} = {}) {
    const context = { appId: 'app', instanceId: 'run' };
    const viewId = options.viewId ?? 'fd_A';
    const viewInstanceId = options.viewInstanceId ?? 'mount_A';
    const refId = options.refId ?? 'selected';
    const activationId = options.activationId ?? 'activation-1';
    const toolId = JSON.stringify(['app', 'FileDetail', 'inspect']);
    const payload = Object.hasOwn(options, 'payload') ? options.payload! : { label: 'A' };
    const core = createSnapshotCore(options.storeOptions);
    core.lifecycle.startApp(context.appId, context.instanceId);
    let sequence = 0;
    function refs(value: JsonValue = payload) {
        return {
            [refKey(viewId, viewInstanceId, refId)]: {
                id: refId, ownerViewId: viewId, ownerViewInstanceId: viewInstanceId,
                refType: options.refType ?? 'unknown',
                target: { kind: 'snapshot-value' as const, payload: value },
            },
            [refKey('fd_B', 'mount_B', refId)]: {
                id: refId, ownerViewId: 'fd_B', ownerViewInstanceId: 'mount_B', refType: 'unknown',
                target: { kind: 'snapshot-value' as const, payload: { label: 'B' } },
            },
        };
    }
    function attempt(patch: Partial<PreparedAppSnapshotDraftV4> = {}) {
        const seq = ++sequence;
        return core.committer.accept({
            schemaVersion: 4, ...context, producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            views: [
                { toolBindings: [{toolId,activationId}], id: viewId, viewInstanceId, type: 'FileDetail', name: 'A', kind: 'state', content: { format: 'markdown-v1', value: 'A' } },
                { toolBindings: [], id: 'fd_B', viewInstanceId: 'mount_B', type: 'FileDetail', name: 'B', kind: 'state', content: { format: 'markdown-v1', value: 'B' } },
            ], refs: refs(), tools: { [toolId]: {
                id: toolId, name: 'inspect', viewType: 'FileDetail', description: 'Inspect original state',
                inputSchema: options.inputSchema ?? schema(options.refType),
            } }, ...patch,
        });
    }
    function publish(patch: Partial<PreparedAppSnapshotDraftV4> = {}): AppSnapshotV4 {
        const result = attempt(patch);
        expect(result.status).toBe('published');
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 4) throw new Error('Expected V3 publication');
        return result.snapshot;
    }
    const source = publish();
    const request = { snapshotId: source.id,
        args: { file: `${viewId}.${refId}` } as Record<string, unknown> };
    const visibleRefs = [{ refId, viewId, viewInstanceId }];
    const tool=source.tools[toolId]!;
    const contract=compileOrdinaryProfile(tool.inputSchema)!;
    const receiver={viewId,viewInstanceId,activationId};
    function prepare(data=request,granted=visibleRefs) {
        return prepareViewTypeParameters(core.store,{...context,snapshotId:data.snapshotId,tool,receiver},contract,data.args as any,granted);
    }
    return { core, context, source, request, receiver, prepare, visibleRefs, refs, publish, attempt, toolId, refId, activationId };

}
type Fixture = ReturnType<typeof fixture>;
function success(f: Fixture, request: Fixture['request'] = f.request) {
    const result = f.prepare(request);
    expect(result.status, JSON.stringify(result)).toBe('prepared');
    if (result.status !== 'prepared') throw new Error('Expected preparation: ' + result.issue.code);
    return result;
}
function denied(f: Fixture, request: Fixture['request'], code: string) {
    const leases = f.core.store.inspect().activeLeases;
    const result = f.prepare(request);
    expect(result).toMatchObject({ status: 'rejected', issue: { code } });
    expect(f.core.store.inspect().activeLeases).toBe(leases);
    return result;
}
function assertNoLease(f: Fixture, prepared: ReturnType<typeof success>) {
    expect(prepared.status).toBe('prepared');
    expect(f.core.store.inspect().activeLeases).toBe(0);
}

describe('W01: original Store source, exact owner and detached arguments', () => {
    it.each(['changed', 'deleted'])('prepares historical A after the latest Ref is %s', change => {
        const f = fixture(); const held = f.core.store.acquire(f.source.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
        f.publish({ refs: change === 'changed' ? f.refs({ label: 'new A' }) : {} });
        const result = success(f);
        expect(result.effectiveArgs).toEqual({ file: { label: 'A' } });
        expect(result.rawArgs).toEqual({ file: 'fd_A.selected' });
        expect(result.refSources).toEqual([{ param: 'file', refId: 'selected', kind: 'snapshot-value', refType: 'unknown',
            snapshotId: f.source.id, viewId: 'fd_A', viewInstanceId: 'mount_A' }]);
        expect(result.refSources[0]).not.toHaveProperty('payload');
        held.lease.release(); assertNoLease(f,result);
    });

    it('selects same-name Refs by explicit View and never guesses from visibility', () => {
        const f = fixture(), other = { refId: f.refId, viewId: 'fd_B', viewInstanceId: 'mount_B' };
        const visible = [...f.visibleRefs, other];
        for (const [view, label] of [['fd_A', 'A'], ['fd_B', 'B']]) {
            const result = f.prepare({ ...f.request, args: { file: `${view}.selected` } }, visible);
            expect(result.status).toBe('prepared'); if (result.status !== 'prepared') throw Error('Expected ' + view);
            expect(result.effectiveArgs.file).toEqual({ label }); assertNoLease(f,result);
        }
        for (const address of ['selected', 'missing.selected', 'fd_A.selected.field', 'fd_A.unknown']) {
            denied(f, { ...f.request, args: { file: address } }, 'REF_NOT_VISIBLE');
        }
        expect(f.prepare(f.request,[other]))
            .toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_VISIBLE' } });
        const current = f.publish({ refs: { [refKey('fd_B', 'mount_B', 'selected')]: f.source.refs[refKey('fd_B', 'mount_B', 'selected')]! } });
        denied(f, { ...f.request, snapshotId: current.id }, 'REF_NOT_FOUND');
    });

    it('keeps all ordinary keys, missing fields, nested values and Ref-looking strings unchanged', () => {
        const baseSchema = schema() as Record<string, JsonValue>;
        const f = fixture({ inputSchema: { ...baseSchema, properties: {
            ...(baseSchema.properties as Record<string, JsonValue>), ordinary: { type: 'string' },
        }, required: ['file'], additionalProperties: true } });
        const args = JSON.parse('{"file":"fd_A.selected","extra":{"literal":"[A](selected)","list":[1,null,true]},"__proto__":{"safe":true}}');
        const result = success(f, { ...f.request, args });
        expect(Object.keys(result.effectiveArgs).sort()).toEqual(Object.keys(args).sort());
        expect(result.effectiveArgs).not.toHaveProperty('ordinary');
        expect(result.effectiveArgs.extra).toEqual(args.extra);
        expect(Object.hasOwn(result.effectiveArgs, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(result.effectiveArgs)).toBeNull();
        args.extra.list[0] = 999; args.file = 'other';
        expect(result.rawArgs.file).toBe('fd_A.selected');
        expect(result.effectiveArgs.extra).toEqual({ literal: '[A](selected)', list: [1, null, true] });
        const assertFrozen = (value: unknown): void => {
            if (value && typeof value === 'object') {
                expect(Object.isFrozen(value)).toBe(true);
                Object.values(value).forEach(assertFrozen);
            }
        };
        assertFrozen(result); assertNoLease(f,result);
    });

    it('does not trim or decode exact Ref identifiers', () => {
        const f = fixture({ refId: ' selected ' }); const result = success(f);
        expect(result.refSources[0]!.refId).toBe(' selected '); assertNoLease(f,result);
        denied(f, { ...f.request, args: { file: 'fd_A.selected' } }, 'REF_NOT_VISIBLE');
        denied(f, { ...f.request, args: { file: '[A]( selected )' } }, 'REF_NOT_VISIBLE');
        denied(f, { ...f.request, args: { file: ' ' } }, 'REF_NOT_VISIBLE');
    });
});

describe('W01: narrow execution subset and fixed rejection classes', () => {
    it.each([
        ['optional declaration', (() => { const base = schema() as Record<string, JsonValue>; return { ...base, required: [] }; })()],
        ['two declarations', (() => { const base = schema() as Record<string, JsonValue>;
            const properties = base.properties as Record<string, JsonValue>;
            return { ...base, properties: { ...properties, second: properties.file! }, required: ['file', 'second'] };
        })()],
    ])('publishes the newly admitted Ref parameter profile: %s', (_name, inputSchema) => {
        const f = fixture();
        const tool = f.source.tools[f.toolId]!;
        const result = f.attempt({ tools: { [f.toolId]: { ...tool, inputSchema } } });
        expect(result).toMatchObject({ status: 'published' });
        expect(f.core.store.inspect().activeLeases).toBe(0);
        f.core.lifecycle.dispose();
    });
    it('admits mutating Ref parameters without adding a separate Tool category', () => {
        const f = fixture({  }); assertNoLease(f, success(f));
    });
    it.each([null, true, 12, 'text', []])('refuses snapshot-value shape %j', payload => {
        const f = fixture({ payload }); denied(f, f.request, 'REF_VALUE_UNSUPPORTED');
    });
    it.each([
        [undefined, 'unknown', true], [undefined, 'File', false], ['File', 'File', true],
        ['File', 'unknown', false], ['File', 'File ', false],
    ])('uses explicit type equality only: declared %s actual %s', (requiredType, actualType, allowed) => {
        const f = fixture({ inputSchema: schema(requiredType), refType: actualType });
        if (allowed) { const result = success(f); expect(result.refSources[0]!.refType).toBe(actualType); assertNoLease(f,result); }
        else denied(f, f.request, 'REF_TYPE_MISMATCH');
    });
    it.each([undefined, null, '', {}, [], 1])('refuses a missing/non-string raw Ref %j', file => {
        const f = fixture();
        denied(f, { ...f.request, args: file === undefined ? {} : { file } }, 'TOOL_INVALID_ARGS');
    });
    it('returns a safe fixed error for an invalid raw Ref object containing a sentinel', () => {
        const f = fixture();
        const result = denied(f, { ...f.request, args: { file: { secret: 'W01_PRIVATE_PAYLOAD' } } }, 'TOOL_INVALID_ARGS');
        expect(JSON.stringify(result)).not.toContain('W01_PRIVATE_PAYLOAD');
    });
});

describe('W01: strict capture and caller source boundaries', () => {
    it.each(['getter', 'hidden', 'symbol', 'cycle', 'nonfinite', 'class', 'sparse', 'undefined'])('rejects %s without exposing caller data', kind => {
        const f = fixture(); const args: Record<string, unknown> = { file: 'fd_A.selected' }; const getter = vi.fn(() => 'W01_SENTINEL');
        if (kind === 'getter') Object.defineProperty(args, 'secret', { enumerable: true, get: getter });
        if (kind === 'hidden') Object.defineProperty(args, 'secret', { value: 'W01_SENTINEL' });
        if (kind === 'symbol') Object.defineProperty(args, Symbol('secret'), { value: true });
        if (kind === 'cycle') args.self = args;
        if (kind === 'nonfinite') args.value = Infinity;
        if (kind === 'class') args.value = new Date();
        if (kind === 'sparse') args.value = new Array(2);
        if (kind === 'undefined') args.value = undefined;
        const result = denied(f, { ...f.request, args }, 'TOOL_INVALID_ARGS');
        expect(getter).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('W01_SENTINEL');
    });
});
