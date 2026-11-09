import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshotV3, JsonValue, PreparedAppSnapshotDraftV3, SnapshotStoreOptions } from '../snapshot/types.js';
import { acquireToolSource } from './source-binding.js';
import { prepareViewTypeParameters } from './snapshot-value-arguments.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';

const schema = (refType = 'unknown', parameter = 'file'): JsonValue => {
    const result = compileOrdinarySchema({ type: 'object', properties: { [parameter]: {
        type: 'string', minLength: 1, 'x-aotui-ref-kind': refType, 'x-aotui-ref-value': { type: 'object' },
    } }, required: [parameter], additionalProperties: true }, 'view-type-parameters-v1');
    if (!result.ok) throw Error('Invalid parameter fixture');
    return ordinaryParameterProfile(result.contract);
};

function fixture(options: {
    payload?: JsonValue; inputSchema?: JsonValue; refType?: string; refId?: string;
    viewId?: string; viewInstanceId?: string; activationId?: string;  entity?: boolean;
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
                target: options.entity
                    ? { kind: 'entity' as const, entityType: 'File', entityId: 'A', entityVersion: '1' }
                    : { kind: 'snapshot-value' as const, payload: value },
            },
            [refKey('fd_B', 'mount_B', refId)]: {
                id: refId, ownerViewId: 'fd_B', ownerViewInstanceId: 'mount_B', refType: 'unknown',
                target: { kind: 'snapshot-value' as const, payload: { label: 'B' } },
            },
        };
    }
    function attempt(patch: Partial<PreparedAppSnapshotDraftV3> = {}) {
        const seq = ++sequence;
        return core.committer.accept({
            schemaVersion: 3, ...context, producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            views: [
                { id: viewId, viewInstanceId, type: 'FileDetail', name: 'A', kind: 'state', content: { format: 'markdown-v1', value: 'A' } },
                { id: 'fd_B', viewInstanceId: 'mount_B', type: 'FileDetail', name: 'B', kind: 'state', content: { format: 'markdown-v1', value: 'B' } },
            ], refs: refs(), tools: { [toolId]: {
                id: toolId, name: 'inspect', viewType: 'FileDetail', description: 'Inspect original state',
                inputSchema: options.inputSchema ?? schema(options.refType), 
                execution: { kind: 'view-type', activationId },
            } }, ...patch,
        });
    }
    function publish(patch: Partial<PreparedAppSnapshotDraftV3> = {}): AppSnapshotV3 {
        const result = attempt(patch);
        expect(result.status).toBe('published');
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 3) throw new Error('Expected V3 publication');
        return result.snapshot;
    }
    const source = publish();
    const request = { snapshotId: source.id, toolId, execution: { kind: 'view-type' as const, activationId },
        args: { file: `${viewId}.${refId}` } as Record<string, unknown> };
    const visibleRefs = [{ refId, viewId, viewInstanceId }];
    const sourceRequest = { ...context, snapshotId: source.id, toolId, execution: request.execution };
    return { core, context, source, request, sourceRequest, visibleRefs, refs, publish, attempt, toolId, viewId, viewInstanceId, refId, activationId };

}
type Fixture = ReturnType<typeof fixture>;
function success(f: Fixture, request: unknown = f.request) {
    const result = prepareViewTypeParameters(f.core.store, f.context, request, f.visibleRefs);
    expect(result.status, JSON.stringify(result)).toBe('prepared');
    if (result.status !== 'prepared') throw new Error('Expected preparation: ' + result.issue.code);
    return result;
}
function denied(f: Fixture, request: unknown, code: string) {
    const leases = f.core.store.inspect().activeLeases;
    const result = prepareViewTypeParameters(f.core.store, f.context, request, f.visibleRefs);
    expect(result).toMatchObject({ status: 'rejected', issue: { code } });
    expect(f.core.store.inspect().activeLeases).toBe(leases);
    return result;
}
function release(f: Fixture, prepared: ReturnType<typeof success>) {
    expect(f.core.store.inspect().activeLeases).toBe(1);
    prepared.release(); prepared.release();
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
        held.lease.release(); release(f, result);
    });

    it('selects same-name Refs by explicit View and never guesses from visibility', () => {
        const f = fixture(), other = { refId: f.refId, viewId: 'fd_B', viewInstanceId: 'mount_B' };
        const visible = [...f.visibleRefs, other];
        for (const [view, label] of [['fd_A', 'A'], ['fd_B', 'B']]) {
            const result = prepareViewTypeParameters(f.core.store, f.context,
                { ...f.request, args: { file: `${view}.selected` } }, visible);
            expect(result.status).toBe('prepared'); if (result.status !== 'prepared') throw Error('Expected ' + view);
            expect(result.effectiveArgs.file).toEqual({ label }); release(f, result);
        }
        for (const address of ['selected', 'missing.selected', 'fd_A.selected.field', 'fd_A.unknown']) {
            denied(f, { ...f.request, args: { file: address } }, 'REF_NOT_VISIBLE');
        }
        expect(prepareViewTypeParameters(f.core.store, f.context, f.request, [other]))
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
        assertFrozen(result); release(f, result);
    });

    it('captures a caller Proxy only once before acquiring its source', () => {
        const f = fixture(); let reads = 0;
        const caller = new Proxy(f.request, { ownKeys(target) { reads++; return Reflect.ownKeys(target); } });
        const store = { ...f.core.store, acquire: (id: string) => {
            expect(reads).toBe(1); return f.core.store.acquire(id);
        } };
        const result = prepareViewTypeParameters(store, f.context, caller, f.visibleRefs);
        expect(result.status, JSON.stringify(result)).toBe('prepared'); expect(reads).toBe(1);
        if (result.status !== 'prepared') throw new Error('Expected prepared');
        result.release(); expect(f.core.store.inspect().activeLeases).toBe(0);
    });

    it('does not trim or decode exact Ref identifiers', () => {
        const f = fixture({ refId: ' selected ' }); const result = success(f);
        expect(result.refSources[0]!.refId).toBe(' selected '); release(f, result);
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
        const f = fixture({  }); release(f, success(f));
    });
    it.each([null, true, 12, 'text', []])('refuses snapshot-value shape %j', payload => {
        const f = fixture({ payload }); denied(f, f.request, 'REF_VALUE_UNSUPPORTED');
    });
    it('refuses an Entity without changing the versioned Entity path', () => {
        const f = fixture({ entity: true }); denied(f, f.request, 'REF_TARGET_UNSUPPORTED');
    });
    it.each([
        [undefined, 'unknown', true], [undefined, 'File', false], ['File', 'File', true],
        ['File', 'unknown', false], ['File', 'File ', false],
    ])('uses explicit type equality only: declared %s actual %s', (requiredType, actualType, allowed) => {
        const f = fixture({ inputSchema: schema(requiredType), refType: actualType });
        if (allowed) { const result = success(f); expect(result.refSources[0]!.refType).toBe(actualType); release(f, result); }
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
    it.each(['appId', 'instanceId', 'owner', 'source', 'tool', 'target', 'viewId', 'selection', 'refSources'])('refuses extra caller authority field %s', field => {
        const f = fixture(); denied(f, { ...f.request, [field]: 'forged' }, 'TOOL_INVALID_ARGS');
    });
    it.each(['snapshotId', 'toolId', 'execution', 'args'])('refuses a missing request field %s', field => {
        const f = fixture(); const request: Record<string, unknown> = { ...f.request }; delete request[field];
        denied(f, request, 'TOOL_INVALID_ARGS');
    });
    it.each(['snapshotId', 'toolId'])('refuses an empty source identifier %s', field => {
        const f = fixture(); denied(f, { ...f.request, [field]: '' }, field === 'snapshotId' ? 'SNAPSHOT_EXPIRED' : 'TOOL_UNAVAILABLE');
    });
    it.each([null, [], true, 'args'])('refuses non-object args %j', args => {
        const f = fixture(); denied(f, { ...f.request, args }, 'TOOL_INVALID_ARGS');
    });
    it.each([null, [], 1, 'request'])('refuses request shape %j', request => {
        const f = fixture(); denied(f, request, 'TOOL_INVALID_ARGS');
    });
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
    it('does not evaluate a root getter and contains a throwing Proxy exception', () => {
        const f = fixture(); const getter = vi.fn(() => f.request.args);
        const request = { ...f.request }; Object.defineProperty(request, 'args', { enumerable: true, get: getter });
        denied(f, request, 'TOOL_INVALID_ARGS'); expect(getter).not.toHaveBeenCalled();
        let traps = 0;
        const proxy = new Proxy(f.request, { getPrototypeOf() { traps++; throw new Error('W01_PRIVATE_TRAP'); } });
        const result = denied(f, proxy, 'TOOL_INVALID_ARGS');
        expect(traps).toBe(1); expect(JSON.stringify(result)).not.toContain('W01_PRIVATE_TRAP');
    });
});

describe('W01: source invalidation and lease ownership', () => {
    it.each(['unmount-all', 'remount-all', 'disabled', 'binding', 'schema', 'degraded', 'restart'])('refuses %s without leaking a lease', change => {
        const f = fixture(); const held = f.core.store.acquire(f.source.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder'); const tool = f.source.tools[f.toolId]!;
        let expected = 'TOOL_SOURCE_STALE';
        if (change === 'unmount-all') {
            f.publish({ views: [], refs: {}, tools: {} }); expected = 'TOOL_UNAVAILABLE';
        } else if (change === 'remount-all') {
            f.publish({ views: f.source.views.map(v => ({ ...v, viewInstanceId: v.viewInstanceId + '-new' })), refs: {}, tools: {
                [f.toolId]: { ...tool, execution: { kind: 'view-type', activationId: 'reopened' } },
            } });
        } else if (change === 'disabled') { f.publish({ tools: {} }); expected = 'TOOL_UNAVAILABLE';
        } else if (change === 'binding') {
            f.publish({ tools: { [f.toolId]: { ...tool, execution: { kind: 'view-type', activationId: 'replacement' } } } });
        } else if (change === 'schema') {
            f.publish({ tools: { [f.toolId]: { ...tool, inputSchema: schema('File') } } });
        } else if (change === 'degraded') {
            expect(f.core.committer.accept({ schemaVersion: 3, ...f.context, producerSeq: 2,
                sourceEpoch: 2, capturedAt: 2, views: 'invalid', refs: {}, tools: {} }).status).toBe('rejected');
            expect(f.core.store.readLatest('app').status).toBe('degraded'); expected = 'SNAPSHOT_UNREADY';
        } else {
            f.core.lifecycle.stopApp('app', 'run'); f.core.lifecycle.startApp('app', 'run2'); f.publish({ instanceId: 'run2' }); expected = 'APP_INSTANCE_MISMATCH';
        }
        denied(f, f.request, expected); held.lease.release(); expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('preserves source-not-found and capacity errors', () => {
        const f = fixture(); denied(f, { ...f.request, snapshotId: 'not-a-source' }, 'SNAPSHOT_EXPIRED');
        denied(f, { ...f.request, toolId: 'not-a-tool' }, 'TOOL_UNAVAILABLE');
        denied(f, { ...f.request, execution: { kind: 'view-type', activationId: 'forged' } }, 'TOOL_SOURCE_CONFLICT');
        const full = fixture({ storeOptions: { maxActiveLeases: 0 } }); denied(full, full.request, 'SNAPSHOT_CAPACITY');
    });
    it('rejects a Snapshot V1 publication before a source identity or lease can be created', () => {
        const core = createSnapshotCore(); core.lifecycle.startApp('app', 'run');
        const old = core.committer.accept({ schemaVersion: 1, appId: 'app', instanceId: 'run', producerSeq: 1,
            sourceEpoch: 1, capturedAt: 1, views: [{ id: 'fd_A', generation: 'g', type: 'FileDetail', name: 'A',
                kind: 'state', content: { format: 'markdown-v1', value: 'A' } }], refs: {}, tools: {} });
        expect(old).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_INVALID', path: '$.schemaVersion' } });
        expect(core.store.inspect().activeLeases).toBe(0);
    });
    it('success owns exactly one lease and releases idempotently even after caller mutation', () => {
        const f = fixture(); const result = success(f);
        f.request.snapshotId = 'mutated'; f.request.args.file = 'changed';
        expect(result.refSources[0]!.snapshotId).toBe(f.source.id); release(f, result);
    });
    it('reacquires the same current source after one lease expires', () => {
        let now = 0; const f = fixture({ storeOptions: { now: () => now, leaseTtlMs: 10, historyTtlMs: 20 } });
        const first = success(f); now = 10; expect(f.core.store.inspect().activeLeases).toBe(0);
        const source = acquireToolSource(f.core.store, f.sourceRequest);
        expect(source.status).toBe('found'); expect(f.core.store.inspect().activeLeases).toBe(1);
        first.release(); expect(f.core.store.inspect().activeLeases).toBe(1);
        if (source.status !== 'found') throw new Error('Expected current source');
        source.release(); expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('cannot reacquire retired history after TTL even while a pin retains the original A', () => {
        let now = 0; const f = fixture({ storeOptions: { now: () => now, leaseTtlMs: 100, historyTtlMs: 20 } });
        const first = success(f); now = 1; f.publish({ refs: f.refs({ label: 'new' }) }); now = 21;
        expect(f.core.store.getById(f.source.id).status).toBe('found');
        const result = acquireToolSource(f.core.store, f.sourceRequest);
        expect(result).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
        denied(f, f.request, 'SNAPSHOT_EXPIRED'); expect(first.effectiveArgs.file).toEqual({ label: 'A' });
        release(f, first); expect(f.core.store.getById(f.source.id).status).toBe('rejected');
    });
});

// Independent fixture accounting of the signed codec rules: root depth=0,
// +2 per node, +24 per finite number, UTF-8 string bytes, +keyBytes+4.
function measure(value: JsonValue): { nodes: number; depth: number; approx: number; canonical: number } {
    let nodes = 0; let depth = 0; let approx = 0;
    function walk(v: JsonValue, level: number) {
        nodes++; depth = Math.max(depth, level); approx += 2;
        if (typeof v === 'string') approx += utf8Size(v);
        else if (typeof v === 'number') approx += 24;
        else if (Array.isArray(v)) v.forEach(x => walk(x, level + 1));
        else if (v !== null && typeof v === 'object') Object.entries(v).forEach(([key, x]) => {
            approx += utf8Size(key) + 4; walk(x, level + 1);
        });
    }
    walk(value, 0); return { nodes, depth, approx, canonical: utf8Size(canonicalJson(value)) };
}
function nested(levels: number): JsonValue {
    let value: JsonValue = {};
    for (let n = 0; n < levels; n++) value = { next: value };
    return value;
}
function escapedBytes(bytes: number): string {
    return '\0'.repeat(Math.floor(bytes / 6)) + 'x'.repeat(bytes % 6);
}

describe('W01 T07: reachable argument depth, nodes, approx and canonical boundaries', () => {
    it.each([23, 24, 25])('raw depth %i (request depth is raw+1)', depth => {
        const f = fixture({ payload: {} }); const args = { file: 'fd_A.selected', ordinary: nested(depth - 1) };
        expect(measure(args).depth).toBe(depth); expect(measure({ ...f.request, args } as JsonValue).depth).toBe(depth + 1);
        if (depth > 24) denied(f, { ...f.request, args }, 'TOOL_INVALID_ARGS');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([9_999, 10_000, 10_001])('raw nodes %i (request nodes are raw+6)', nodes => {
        const f = fixture({ payload: {} }); const args = { file: 'fd_A.selected', values: Array(nodes - 3).fill(null) };
        expect(measure(args).nodes).toBe(nodes); expect(measure({ ...f.request, args } as JsonValue).nodes).toBe(nodes + 6);
        if (nodes > 10_000) denied(f, { ...f.request, args }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([23, 24, 25])('effective depth %i, recomputed from the args root', depth => {
        const f = fixture({ payload: nested(depth - 1) });
        if (depth > 24) denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else { const result = success(f); expect(measure(result.effectiveArgs).depth).toBe(depth); release(f, result); }
    });
    it.each([9_999, 10_000, 10_001])('effective nodes %i', nodes => {
        const f = fixture({ payload: { label: 'A' } }); const args = { file: 'fd_A.selected', values: Array(nodes - 4).fill(null) };
        expect(measure(args).nodes).toBe(nodes - 1);
        if (nodes > 10_000) denied(f, { ...f.request, args }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else { const result = success(f, { ...f.request, args }); expect(measure(result.effectiveArgs).nodes).toBe(nodes); release(f, result); }
    });
    it.each([131_071, 131_072, 131_073])('raw approx bytes %i', bytes => {
        const f = fixture({ payload: {} }); const base = { file: 'fd_A.selected', padding: '' };
        const args = { ...base, padding: 'x'.repeat(bytes - measure(base).approx) };
        expect(measure(args).approx).toBe(bytes);
        if (bytes > 131_072) denied(f, { ...f.request, args }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([131_071, 131_072, 131_073])('raw canonical UTF-8 bytes %i with escaped data', bytes => {
        const f = fixture({ payload: {} }); const base = { file: 'fd_A.selected', padding: '' };
        const args = { ...base, padding: escapedBytes(bytes - measure(base).canonical) };
        expect(measure(args).canonical).toBe(bytes); expect(measure(args).approx).toBeLessThan(131_072);
        if (bytes > 131_072) denied(f, { ...f.request, args }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([131_071, 131_072, 131_073])('effective approx bytes %i', bytes => {
        const base = { file: { text: '' } }; const payload = { text: 'x'.repeat(bytes - measure(base).approx) };
        const f = fixture({ payload }); expect(measure({ file: payload }).approx).toBe(bytes);
        if (bytes > 131_072) denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f));
    });
    it.each([131_071, 131_072, 131_073])('effective canonical UTF-8 bytes %i', bytes => {
        const base = { file: { text: '' } }; const payload = { text: escapedBytes(bytes - measure(base).canonical) };
        const f = fixture({ payload }); expect(measure({ file: payload }).canonical).toBe(bytes);
        expect(measure({ file: payload }).approx).toBeLessThan(131_072);
        if (bytes > 131_072) denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f));
    });
    it('refuses a Snapshot-legal 200 KiB payload before constructing an oversized prepared value', () => {
        const f = fixture({ payload: { text: 'x'.repeat(200 * 1024) } });
        denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });
    it('counts repeated aliases independently rather than taking a shared-object discount', () => {
        const shared = { text: 'x'.repeat(65_536) }; const f = fixture({ payload: { a: shared, b: shared } });
        denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });
    it('counts actual UTF-8 bytes rather than UTF-16 string length', () => {
        const text = '🙂'.repeat(32_768); expect(text.length).toBe(65_536); expect(utf8Size(text)).toBe(131_072);
        const f = fixture({ payload: { text } }); denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });
});

describe('W01 T07: complete request and prepared envelope overhead', () => {
    it.each([139_263, 139_264, 139_265])('complete request approx bytes %i via a real long activation identity', bytes => {
        const template = fixture({ payload: {} });
        template.request.args = { file: 'fd_A.selected', numericPadding: [0, 0, 0, 0] };
        const base = measure(template.request as JsonValue).approx;
        const activationId = 'v'.repeat(bytes - base + template.activationId.length);
        const f = fixture({ payload: {}, activationId }); f.request.args = template.request.args;
        expect(measure(f.request as JsonValue).approx).toBe(bytes);
        expect(measure(f.request as JsonValue).canonical).toBeLessThan(139_264);
        // Long source IDs occur again in provenance; lower input limits pass but envelope does not.
        denied(f, f.request, bytes > 139_264 ? 'TOOL_INVALID_ARGS' : 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });
    it.each([139_263, 139_264, 139_265])('complete request canonical bytes %i independently of approx', bytes => {
        const base = fixture({ payload: {} }); const emptyLength = measure(base.request as JsonValue).canonical;
        const activationId = escapedBytes(bytes - emptyLength + base.activationId.length);
        const f = fixture({ payload: {}, activationId });
        expect(measure(f.request as JsonValue).canonical).toBe(bytes); expect(measure(f.request as JsonValue).approx).toBeLessThan(139_264);
        denied(f, f.request, bytes > 139_264 ? 'TOOL_INVALID_ARGS' : 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });

    function envelopeFor(f: Fixture, refType: string, padding: string): JsonValue {
        return { source: { ...f.context, snapshotId: f.source.id, toolId: f.toolId,
            activationId: f.activationId },
        effectiveArgs: { file: {}, padding, numbers: [0, 0, 0] }, refSources: [{ param: 'file', refId: f.refId, kind: 'snapshot-value',
            refType, snapshotId: f.source.id, viewId: f.viewId, viewInstanceId: f.viewInstanceId }] };
    }
    it.each([139_263, 139_264, 139_265])('prepared envelope approx bytes %i includes source/provenance', bytes => {
        const padding = 'x'.repeat(120 * 1024); const first = fixture({ payload: {} });
        const refType = 'T'.repeat(bytes - measure(envelopeFor(first, '', padding)).approx);
        const f = fixture({ payload: {}, refType }); expect(measure(envelopeFor(f, refType, padding)).approx).toBe(bytes);
        expect(measure({ file: {}, padding }).approx).toBeLessThan(131_072);
        if (bytes > 139_264) denied(f, { ...f.request, args: { file: 'fd_A.selected', padding, numbers: [0, 0, 0] } }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args: { file: 'fd_A.selected', padding, numbers: [0, 0, 0] } }));
    });
    it.each([139_263, 139_264, 139_265])('prepared envelope canonical bytes %i is checked separately', bytes => {
        const padding = 'x'.repeat(120 * 1024); const first = fixture({ payload: {} });
        const refType = escapedBytes(bytes - measure(envelopeFor(first, '', padding)).canonical);
        const f = fixture({ payload: {}, refType });
        expect(measure(envelopeFor(f, refType, padding)).canonical).toBe(bytes);
        expect(measure(envelopeFor(f, refType, padding)).approx).toBeLessThan(139_264);
        if (bytes > 139_264) denied(f, { ...f.request, args: { file: 'fd_A.selected', padding, numbers: [0, 0, 0] } }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args: { file: 'fd_A.selected', padding, numbers: [0, 0, 0] } }));
    });
    it('proves the reachable envelope node/depth maxima under the smaller args profile', () => {
        const f = fixture({ payload: {} });
        const result = success(f, { ...f.request, args: { file: 'fd_A.selected', values: Array(9_997).fill(null) } });
        const envelope = { source: { ...f.context, snapshotId: f.source.id, toolId: f.toolId, activationId: f.activationId }, effectiveArgs: result.effectiveArgs, refSources: result.refSources };
        expect(measure(result.effectiveArgs).nodes).toBe(10_000);
        expect(measure(envelope).nodes).toBe(10_016);
        expect(() => copyJson(envelope, { maxDepth: 26, maxNodes: 11_000, maxApproxBytes: 139_264 })).not.toThrow();
        release(f, result);
        const deep = fixture({ payload: nested(23) }); const prepared = success(deep);
        const deepEnvelope = { source: { ...deep.context, snapshotId: deep.source.id, toolId: deep.toolId, activationId: deep.activationId }, effectiveArgs: prepared.effectiveArgs, refSources: prepared.refSources };
        expect(measure(prepared.effectiveArgs).depth).toBe(24); expect(measure(deepEnvelope).depth).toBe(25);
        release(deep, prepared);
    });
});
