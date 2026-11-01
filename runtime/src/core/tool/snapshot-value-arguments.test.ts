import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshotV2, JsonValue, PreparedAppSnapshotDraftV2, SnapshotStoreOptions } from '../snapshot/types.js';
import { acquireToolSource } from './source-binding.js';
import { prepareSnapshotValueArguments } from './snapshot-value-arguments.js';

const marker = (refType?: string) => ({ version: 1, kind: 'snapshot-value', owner: 'tool-target',
    ...(refType === undefined ? {} : { refType }) });
const schema = (refType?: string, parameter = 'file'): JsonValue => ({ type: 'object', properties: {
    [parameter]: { type: 'string', 'x-aotui-ref': marker(refType) },
}, required: [parameter] });

function fixture(options: {
    payload?: JsonValue; inputSchema?: JsonValue; refType?: string; refId?: string;
    viewId?: string; viewInstanceId?: string; isMutating?: boolean; entity?: boolean;
    storeOptions?: SnapshotStoreOptions;
} = {}) {
    const context = { appId: 'app', instanceId: 'run' };
    const viewId = options.viewId ?? 'fd_A';
    const viewInstanceId = options.viewInstanceId ?? 'mount_A';
    const refId = options.refId ?? 'selected';
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
    function publish(patch: Partial<PreparedAppSnapshotDraftV2> = {}): AppSnapshotV2 {
        const seq = ++sequence;
        const result = core.committer.accept({
            schemaVersion: 2, ...context, producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            views: [
                { id: viewId, viewInstanceId, type: 'FileDetail', name: 'A', kind: 'state', content: { format: 'markdown-v1', value: 'A' } },
                { id: 'fd_B', viewInstanceId: 'mount_B', type: 'FileDetail', name: 'B', kind: 'state', content: { format: 'markdown-v1', value: 'B' } },
            ], refs: refs(), tools: { [toolId]: {
                id: toolId, name: 'inspect', viewType: 'FileDetail', description: 'Inspect original state',
                inputSchema: options.inputSchema ?? schema(), isMutating: options.isMutating ?? false,
                targets: [{ viewId, viewInstanceId, bindingVersion: 1 },
                    { viewId: 'fd_B', viewInstanceId: 'mount_B', bindingVersion: 1 }],
            } }, ...patch,
        });
        expect(result.status).toBe('published');
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 2) throw new Error('Expected V2 publication');
        return result.snapshot;
    }
    const source = publish();
    const request = { snapshotId: source.id, toolId, viewId, args: { file: refId } as Record<string, unknown> };
    return { core, context, source, request, refs, publish, toolId, viewId, viewInstanceId, refId };
}
type Fixture = ReturnType<typeof fixture>;
function success(f: Fixture, request: unknown = f.request) {
    const result = prepareSnapshotValueArguments(f.core.store, f.context, request);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') throw new Error('Expected preparation: ' + result.issue.code);
    return result;
}
function denied(f: Fixture, request: unknown, code: string) {
    const leases = f.core.store.inspect().activeLeases;
    const result = prepareSnapshotValueArguments(f.core.store, f.context, request);
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
        const f = fixture();
        f.publish({ refs: change === 'changed' ? f.refs({ label: 'new A' }) : {} });
        const result = success(f);
        expect(result.effectiveArgs).toEqual({ file: { label: 'A' } });
        expect(result.rawArgs).toEqual({ file: 'selected' });
        expect(result.sourceRequest).toEqual({ ...f.context, snapshotId: f.source.id, toolId: f.toolId, viewId: f.viewId });
        expect(result.refSources).toEqual([{ param: 'file', refId: 'selected', kind: 'snapshot-value', refType: 'unknown',
            snapshotId: f.source.id, viewId: 'fd_A', viewInstanceId: 'mount_A' }]);
        expect(result.refSources[0]).not.toHaveProperty('payload');
        expect(result.tool).toEqual(f.source.tools[f.toolId]);
        expect(result.target).toEqual(f.source.tools[f.toolId]!.targets[0]);
        release(f, result);
    });

    it('uses the target owner for two same-named Refs and never searches other Views', () => {
        const f = fixture();
        const a = success(f); expect(a.effectiveArgs.file).toEqual({ label: 'A' }); a.release();
        const b = success(f, { ...f.request, viewId: 'fd_B' });
        expect(b.effectiveArgs.file).toEqual({ label: 'B' }); release(f, b);
        const onlyB = fixture();
        const current = onlyB.publish({ refs: { [refKey('fd_B', 'mount_B', 'selected')]: onlyB.source.refs[refKey('fd_B', 'mount_B', 'selected')]! } });
        denied(onlyB, { ...onlyB.request, snapshotId: current.id }, 'REF_NOT_FOUND');
    });

    it('keeps all ordinary keys, missing fields, nested values and Ref-looking strings unchanged', () => {
        const f = fixture({ inputSchema: { type: 'object', properties: {
            file: { type: 'string', 'x-aotui-ref': marker() }, ordinary: { type: 'string' },
        }, required: ['file', 'ordinary'], additionalProperties: false } });
        const args = JSON.parse('{"file":"selected","extra":{"literal":"[A](selected)","list":[1,null,true]},"__proto__":{"safe":true}}');
        const result = success(f, { ...f.request, args });
        expect(Object.keys(result.effectiveArgs).sort()).toEqual(Object.keys(args).sort());
        expect(result.effectiveArgs).not.toHaveProperty('ordinary');
        expect(result.effectiveArgs.extra).toEqual(args.extra);
        expect(Object.hasOwn(result.effectiveArgs, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(result.effectiveArgs)).toBeNull();
        args.extra.list[0] = 999; args.file = 'other';
        expect(result.rawArgs.file).toBe('selected');
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
        const result = prepareSnapshotValueArguments(store, f.context, caller);
        expect(result.status).toBe('prepared'); expect(reads).toBe(1);
        if (result.status !== 'prepared') throw new Error('Expected prepared');
        result.release(); expect(f.core.store.inspect().activeLeases).toBe(0);
    });

    it('does not trim or decode exact Ref identifiers', () => {
        const f = fixture({ refId: ' selected ' }); const result = success(f);
        expect(result.refSources[0]!.refId).toBe(' selected '); release(f, result);
        denied(f, { ...f.request, args: { file: 'selected' } }, 'REF_NOT_FOUND');
        denied(f, { ...f.request, args: { file: '[A]( selected )' } }, 'REF_NOT_FOUND');
        denied(f, { ...f.request, args: { file: ' ' } }, 'REF_NOT_FOUND');
    });
});

describe('W01: narrow execution subset and fixed rejection classes', () => {
    it.each([
        ['no declaration', { type: 'object', properties: {} }],
        ['optional declaration', { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': marker() } } }],
        ['two declarations', { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': marker() }, second: { type: 'string', 'x-aotui-ref': marker() } }, required: ['file', 'second'] }],
    ])('keeps C1 publication compatible but refuses preparation: %s', (_name, inputSchema) => {
        const f = fixture({ inputSchema: inputSchema as JsonValue });
        denied(f, f.request, 'REF_CONTRACT_UNSUPPORTED');
    });
    it('refuses a mutating Tool before considering its declaration subset', () => {
        const f = fixture({ isMutating: true, inputSchema: { type: 'object' } });
        denied(f, f.request, 'TOOL_PERMISSION_DENIED');
    });
    it.each([null, true, 12, 'text', []])('refuses snapshot-value shape %j', payload => {
        const f = fixture({ payload }); denied(f, f.request, 'REF_VALUE_UNSUPPORTED');
    });
    it('refuses an Entity without changing the versioned Entity path', () => {
        const f = fixture({ entity: true }); denied(f, f.request, 'REF_TARGET_UNSUPPORTED');
    });
    it.each([
        [undefined, 'unknown', true], [undefined, 'File', true], ['File', 'File', true],
        ['File', 'unknown', false], ['File', 'File ', false],
    ])('uses explicit type equality only: declared %s actual %s', (requiredType, actualType, allowed) => {
        const f = fixture({ inputSchema: schema(requiredType), refType: actualType });
        if (allowed) { const result = success(f); expect(result.refSources[0]!.refType).toBe(actualType); release(f, result); }
        else denied(f, f.request, 'REF_TYPE_MISMATCH');
    });
    it.each([undefined, null, '', {}, [], 1])('refuses a missing/non-string raw Ref %j', file => {
        const f = fixture();
        denied(f, { ...f.request, args: file === undefined ? {} : { file } }, 'OPERATION_INVALID_ARGS');
    });
    it('returns a safe fixed error for an invalid raw Ref object containing a sentinel', () => {
        const f = fixture();
        const result = denied(f, { ...f.request, args: { file: { secret: 'W01_PRIVATE_PAYLOAD' } } }, 'OPERATION_INVALID_ARGS');
        expect(JSON.stringify(result)).not.toContain('W01_PRIVATE_PAYLOAD');
    });
});

describe('W01: strict capture and caller source boundaries', () => {
    it.each(['appId', 'instanceId', 'owner', 'source', 'tool', 'target', 'selection', 'refSources'])('refuses extra caller authority field %s', field => {
        const f = fixture(); denied(f, { ...f.request, [field]: 'forged' }, 'OPERATION_INVALID_ARGS');
    });
    it.each(['snapshotId', 'toolId', 'viewId', 'args'])('refuses a missing request field %s', field => {
        const f = fixture(); const request: Record<string, unknown> = { ...f.request }; delete request[field];
        denied(f, request, 'OPERATION_INVALID_ARGS');
    });
    it.each(['snapshotId', 'toolId', 'viewId'])('refuses an empty source identifier %s', field => {
        const f = fixture(); denied(f, { ...f.request, [field]: '' }, 'OPERATION_INVALID_ARGS');
    });
    it.each([null, [], true, 'args'])('refuses non-object args %j', args => {
        const f = fixture(); denied(f, { ...f.request, args }, 'OPERATION_INVALID_ARGS');
    });
    it.each([null, [], 1, 'request'])('refuses request shape %j', request => {
        const f = fixture(); denied(f, request, 'OPERATION_INVALID_ARGS');
    });
    it.each(['getter', 'hidden', 'symbol', 'cycle', 'nonfinite', 'class', 'sparse', 'undefined'])('rejects %s without exposing caller data', kind => {
        const f = fixture(); const args: Record<string, unknown> = { file: 'selected' }; const getter = vi.fn(() => 'W01_SENTINEL');
        if (kind === 'getter') Object.defineProperty(args, 'secret', { enumerable: true, get: getter });
        if (kind === 'hidden') Object.defineProperty(args, 'secret', { value: 'W01_SENTINEL' });
        if (kind === 'symbol') Object.defineProperty(args, Symbol('secret'), { value: true });
        if (kind === 'cycle') args.self = args;
        if (kind === 'nonfinite') args.value = Infinity;
        if (kind === 'class') args.value = new Date();
        if (kind === 'sparse') args.value = new Array(2);
        if (kind === 'undefined') args.value = undefined;
        const result = denied(f, { ...f.request, args }, 'OPERATION_INVALID_ARGS');
        expect(getter).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('W01_SENTINEL');
    });
    it('does not evaluate a root getter and contains a throwing Proxy exception', () => {
        const f = fixture(); const getter = vi.fn(() => f.request.args);
        const request = { ...f.request }; Object.defineProperty(request, 'args', { enumerable: true, get: getter });
        denied(f, request, 'OPERATION_INVALID_ARGS'); expect(getter).not.toHaveBeenCalled();
        let traps = 0;
        const proxy = new Proxy(f.request, { getPrototypeOf() { traps++; throw new Error('W01_PRIVATE_TRAP'); } });
        const result = denied(f, proxy, 'OPERATION_INVALID_ARGS');
        expect(traps).toBe(1); expect(JSON.stringify(result)).not.toContain('W01_PRIVATE_TRAP');
    });
});

describe('W01: source invalidation and lease ownership', () => {
    it.each(['unmount', 'remount', 'disabled', 'binding', 'schema', 'degraded', 'restart'])('refuses %s without leaking a lease', change => {
        const f = fixture(); const tool = f.source.tools[f.toolId]!;
        let expected = 'TOOL_SOURCE_STALE';
        if (change === 'unmount') {
            f.publish({ views: f.source.views.filter(v => v.id !== f.viewId), refs: {}, tools: {
                [f.toolId]: { ...tool, targets: tool.targets.filter(t => t.viewId !== f.viewId) },
            } }); expected = 'VIEW_INSTANCE_REVOKED';
        } else if (change === 'remount') {
            f.publish({ views: f.source.views.map(v => v.id === f.viewId ? { ...v, viewInstanceId: 'mount_C' } : v), refs: {}, tools: {
                [f.toolId]: { ...tool, targets: tool.targets.map(t => t.viewId === f.viewId ? { ...t, viewInstanceId: 'mount_C' } : t) },
            } }); expected = 'VIEW_INSTANCE_REVOKED';
        } else if (change === 'disabled') { f.publish({ tools: {} }); expected = 'TOOL_UNAVAILABLE';
        } else if (change === 'binding') {
            f.publish({ tools: { [f.toolId]: { ...tool, targets: tool.targets.map(t => ({ ...t, bindingVersion: 2 })) } } });
        } else if (change === 'schema') {
            f.publish({ tools: { [f.toolId]: { ...tool, inputSchema: { ...schema() as object, description: 'New contract' } } } });
        } else if (change === 'degraded') {
            expect(f.core.committer.accept({ schemaVersion: 2, ...f.context, producerSeq: 2,
                sourceEpoch: 2, capturedAt: 2, views: 'invalid', refs: {}, tools: {} }).status).toBe('rejected');
            expect(f.core.store.readLatest('app').status).toBe('degraded'); expected = 'SNAPSHOT_UNREADY';
        } else {
            f.core.lifecycle.stopApp('app', 'run'); f.core.lifecycle.startApp('app', 'run2'); f.publish({ instanceId: 'run2' }); expected = 'APP_INSTANCE_MISMATCH';
        }
        denied(f, f.request, expected);
    });
    it('preserves source-not-found and capacity errors', () => {
        const f = fixture(); denied(f, { ...f.request, snapshotId: 'not-a-source' }, 'SNAPSHOT_EXPIRED');
        denied(f, { ...f.request, toolId: 'not-a-tool' }, 'TOOL_UNAVAILABLE');
        denied(f, { ...f.request, viewId: 'not-a-view' }, 'TOOL_UNAVAILABLE');
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
        expect(result.sourceRequest.snapshotId).toBe(f.source.id); release(f, result);
    });
    it('reacquires the same current source after one lease expires', () => {
        let now = 0; const f = fixture({ storeOptions: { now: () => now, leaseTtlMs: 10, historyTtlMs: 20 } });
        const first = success(f); now = 10; expect(f.core.store.inspect().activeLeases).toBe(0);
        const source = acquireToolSource(f.core.store, first.sourceRequest);
        expect(source.status).toBe('found'); expect(f.core.store.inspect().activeLeases).toBe(1);
        first.release(); expect(f.core.store.inspect().activeLeases).toBe(1);
        if (source.status !== 'found') throw new Error('Expected current source');
        source.release(); expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('cannot reacquire retired history after TTL even while a pin retains the original A', () => {
        let now = 0; const f = fixture({ storeOptions: { now: () => now, leaseTtlMs: 100, historyTtlMs: 20 } });
        const first = success(f); now = 1; f.publish({ refs: f.refs({ label: 'new' }) }); now = 21;
        expect(f.core.store.getById(f.source.id).status).toBe('found');
        const result = acquireToolSource(f.core.store, first.sourceRequest);
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
        const f = fixture({ payload: {} }); const args = { file: 'selected', ordinary: nested(depth - 1) };
        expect(measure(args).depth).toBe(depth); expect(measure({ ...f.request, args } as JsonValue).depth).toBe(depth + 1);
        if (depth > 24) denied(f, { ...f.request, args }, 'OPERATION_INVALID_ARGS');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([9_999, 10_000, 10_001])('raw nodes %i (request nodes are raw+4)', nodes => {
        const f = fixture({ payload: {} }); const args = { file: 'selected', values: Array(nodes - 3).fill(null) };
        expect(measure(args).nodes).toBe(nodes); expect(measure({ ...f.request, args } as JsonValue).nodes).toBe(nodes + 4);
        if (nodes > 10_000) denied(f, { ...f.request, args }, 'OPERATION_INVALID_ARGS');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([23, 24, 25])('effective depth %i, recomputed from the args root', depth => {
        const f = fixture({ payload: nested(depth - 1) });
        if (depth > 24) denied(f, f.request, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else { const result = success(f); expect(measure(result.effectiveArgs).depth).toBe(depth); release(f, result); }
    });
    it.each([9_999, 10_000, 10_001])('effective nodes %i', nodes => {
        const f = fixture({ payload: { label: 'A' } }); const args = { file: 'selected', values: Array(nodes - 4).fill(null) };
        expect(measure(args).nodes).toBe(nodes - 1);
        if (nodes > 10_000) denied(f, { ...f.request, args }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else { const result = success(f, { ...f.request, args }); expect(measure(result.effectiveArgs).nodes).toBe(nodes); release(f, result); }
    });
    it.each([131_071, 131_072, 131_073])('raw approx bytes %i', bytes => {
        const f = fixture({ payload: {} }); const base = { file: 'selected', padding: '' };
        const args = { ...base, padding: 'x'.repeat(bytes - measure(base).approx) };
        expect(measure(args).approx).toBe(bytes);
        if (bytes > 131_072) denied(f, { ...f.request, args }, 'OPERATION_INVALID_ARGS');
        else release(f, success(f, { ...f.request, args }));
    });
    it.each([131_071, 131_072, 131_073])('raw canonical UTF-8 bytes %i with escaped data', bytes => {
        const f = fixture({ payload: {} }); const base = { file: 'selected', padding: '' };
        const args = { ...base, padding: escapedBytes(bytes - measure(base).canonical) };
        expect(measure(args).canonical).toBe(bytes); expect(measure(args).approx).toBeLessThan(131_072);
        if (bytes > 131_072) denied(f, { ...f.request, args }, 'OPERATION_INVALID_ARGS');
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
    it.each([139_263, 139_264, 139_265])('complete request approx bytes %i via a real long View ID', bytes => {
        const template = fixture({ payload: {} });
        template.request.args = { file: 'selected', numericPadding: [0, 0, 0, 0] };
        const base = measure(template.request as JsonValue).approx;
        const viewId = 'v'.repeat(bytes - base + template.viewId.length);
        const f = fixture({ payload: {}, viewId }); f.request.args = template.request.args;
        expect(measure(f.request as JsonValue).approx).toBe(bytes);
        expect(measure(f.request as JsonValue).canonical).toBeLessThan(139_264);
        // Long source IDs occur again in provenance; lower input limits pass but envelope does not.
        denied(f, f.request, bytes > 139_264 ? 'OPERATION_INVALID_ARGS' : 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });
    it.each([139_263, 139_264, 139_265])('complete request canonical bytes %i independently of approx', bytes => {
        const base = fixture({ payload: {} }); const emptyLength = measure(base.request as JsonValue).canonical;
        const escapedView = escapedBytes(bytes - emptyLength + base.viewId.length);
        const f = fixture({ payload: {}, viewId: escapedView });
        expect(measure(f.request as JsonValue).canonical).toBe(bytes); expect(measure(f.request as JsonValue).approx).toBeLessThan(139_264);
        denied(f, f.request, bytes > 139_264 ? 'OPERATION_INVALID_ARGS' : 'REF_ARGUMENT_BUDGET_EXCEEDED');
    });

    function envelopeFor(f: Fixture, refType: string, padding: string): JsonValue {
        return { source: { ...f.context, snapshotId: f.source.id, toolId: f.toolId, viewId: f.viewId,
            viewInstanceId: f.viewInstanceId, bindingVersion: 1 },
        effectiveArgs: { file: {}, padding }, refSources: [{ param: 'file', refId: f.refId, kind: 'snapshot-value',
            refType, snapshotId: f.source.id, viewId: f.viewId, viewInstanceId: f.viewInstanceId }] };
    }
    it.each([139_263, 139_264, 139_265])('prepared envelope approx bytes %i includes source/provenance', bytes => {
        const padding = 'x'.repeat(120 * 1024); const first = fixture({ payload: {} });
        const refType = 'T'.repeat(bytes - measure(envelopeFor(first, '', padding)).approx);
        const f = fixture({ payload: {}, refType }); expect(measure(envelopeFor(f, refType, padding)).approx).toBe(bytes);
        expect(measure({ file: {}, padding }).approx).toBeLessThan(131_072);
        if (bytes > 139_264) denied(f, { ...f.request, args: { file: 'selected', padding } }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args: { file: 'selected', padding } }));
    });
    it.each([139_263, 139_264, 139_265])('prepared envelope canonical bytes %i is checked separately', bytes => {
        const padding = 'x'.repeat(120 * 1024); const first = fixture({ payload: {} });
        const refType = escapedBytes(bytes - measure(envelopeFor(first, '', padding)).canonical);
        const f = fixture({ payload: {}, refType });
        expect(measure(envelopeFor(f, refType, padding)).canonical).toBe(bytes);
        expect(measure(envelopeFor(f, refType, padding)).approx).toBeLessThan(139_264);
        if (bytes > 139_264) denied(f, { ...f.request, args: { file: 'selected', padding } }, 'REF_ARGUMENT_BUDGET_EXCEEDED');
        else release(f, success(f, { ...f.request, args: { file: 'selected', padding } }));
    });
    it('proves the reachable envelope node/depth maxima under the smaller args profile', () => {
        const f = fixture({ payload: {} });
        const result = success(f, { ...f.request, args: { file: 'selected', values: Array(9_997).fill(null) } });
        const envelope = { source: { ...result.sourceRequest, viewInstanceId: result.target.viewInstanceId,
            bindingVersion: result.target.bindingVersion }, effectiveArgs: result.effectiveArgs, refSources: result.refSources };
        expect(measure(result.effectiveArgs).nodes).toBe(10_000);
        expect(measure(envelope).nodes).toBe(10_018);
        expect(() => copyJson(envelope, { maxDepth: 26, maxNodes: 11_000, maxApproxBytes: 139_264 })).not.toThrow();
        release(f, result);
        const deep = fixture({ payload: nested(23) }); const prepared = success(deep);
        const deepEnvelope = { source: { ...prepared.sourceRequest, viewInstanceId: prepared.target.viewInstanceId,
            bindingVersion: prepared.target.bindingVersion }, effectiveArgs: prepared.effectiveArgs, refSources: prepared.refSources };
        expect(measure(prepared.effectiveArgs).depth).toBe(24); expect(measure(deepEnvelope).depth).toBe(25);
        release(deep, prepared);
    });
});
