import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { createViewOwnedTools, type ViewToolSpec } from './view-owned-tools.js';
import { compileOrdinaryParams } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import { compileSnapshotValueParams } from './snapshot-value-parameter-contract.js';

const empty = { type: 'object', properties: {}, required: [], additionalProperties: false } as const;
const ref = { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: ['file'], additionalProperties: false } as const;
const spec = (name = 'read', description = 'Read'): ViewToolSpec => ({ name, description, inputSchema: empty, isMutating: false });
const bytes = (v: unknown) => utf8Size(canonicalJson(v as JsonValue));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const ceilings = { maxViews: 1000, maxBindings: 10000, maxRetainedBytes: 32 * 1024 * 1024 };

describe('W09-A Registry finite retention', () => {
    it.each(Object.entries(ceilings))('A11 validates and captures %s', (key, hard) => {
        for (const n of [1, hard]) expect(() => createViewOwnedTools('a', 'i', { [key]: n === 1 && key === 'maxRetainedBytes' ? 100 : n })).not.toThrow();
        for (const n of [-1, 0.5, NaN, Infinity, hard + 1]) expect(() => createViewOwnedTools('a', 'i', { [key]: n })).toThrow(RangeError);
        const config: any = { [key]: 0 };
        if (key === 'maxRetainedBytes') expect(() => createViewOwnedTools('a', 'i', config)).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        else { const r = createViewOwnedTools('a', 'i', config); config[key] = hard;
            if (key === 'maxViews') expect(() => r.mount('v', 'T')).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
            else { const v = r.mount('v', 'T'); expect(() => r.registerTool(v.viewInstanceId, spec(), () => ({ success: true }))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' })); }
        }
    });
    it('A11 rejects unknown keys and charges base identity before creating activity', () => {
        expect(() => createViewOwnedTools('a', 'i', { typo: 1 } as any)).toThrow(RangeError);
        expect(() => createViewOwnedTools('a', 'i', { [Symbol()]: 1 } as any)).toThrow(RangeError);
        const need = bytes({ appId: 'a', appInstanceId: 'i' });
        expect(() => createViewOwnedTools('a', 'i', { maxRetainedBytes: need - 1 })).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        expect(createViewOwnedTools('a', 'i', { maxRetainedBytes: need }).inspect()).toEqual({ state: 'active', views: 0, bindings: 0, retainedBytes: need });
    });
    it('A11 reaches actual default 1000 mounted Views and 10000 registered Tools', () => {
        const r = createViewOwnedTools('a', 'i'); let first = '';
        for (let n = 0; n < 1000; n++) { const v = r.mount('v' + n, 'T'); if (!n) first = v.viewInstanceId; }
        expect(() => r.mount('extra', 'T')).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        for (let n = 0; n < 10000; n++) r.registerTool(first, spec('t' + n), () => ({ success: true }));
        expect(() => r.registerTool(first, spec('extra'), () => ({ success: true }))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(r.inspect()).toMatchObject({ views: 1000, bindings: 10000 }); expect(r.listTools()).toHaveLength(10000);
        r.unmount(first); expect(r.inspect()).toMatchObject({ views: 999, bindings: 0 });
        expect(r.mount('new', 'T').viewInstanceId).toContain('1001');
    });
    it.each([-1, 0, 1])('A12 independent Unicode/canonical View byte budget delta %s', delta => {
        const identity = { appId: '中', appInstanceId: '😀' }, v = { viewId: 'v\n', viewType: 'T中', viewInstanceId: 'vi:v1:' + JSON.stringify(['😀', 1]) };
        const need = bytes(identity) + bytes(v), r = createViewOwnedTools('中', '😀', { maxRetainedBytes: need + delta });
        if (delta < 0) expect(() => r.mount(v.viewId, v.viewType)).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        else { expect(r.mount(v.viewId, v.viewType)).toEqual(v); expect(r.inspect().retainedBytes).toBe(need); }
    });
    it.each([-1, 0, 1])('A12 independent binding byte budget delta %s', delta => {
        const v = { viewId: 'v', viewType: 'T', viewInstanceId: 'vi:v1:' + JSON.stringify(['i', 1]) }, declaration = spec('读', '😀\n');
        const base = bytes({ appId: 'a', appInstanceId: 'i' }) + bytes(v), r = createViewOwnedTools('a', 'i', { maxRetainedBytes: base + bytes(declaration) + delta });
        r.mount('v', 'T');
        if (delta < 0) { expect(() => r.registerTool(v.viewInstanceId, declaration, () => ({ success: true }))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' })); expect(r.inspect().retainedBytes).toBe(base); }
        else { const release = r.registerTool(v.viewInstanceId, declaration, () => ({ success: true })); expect(r.inspect().retainedBytes).toBe(base + bytes(declaration));
            release(); expect(r.inspect().retainedBytes).toBe(base);
            r.registerTool(v.viewInstanceId, declaration, () => ({ success: true })); expect(r.inspect().retainedBytes).toBe(base + bytes(declaration));
            expect(r.inspect().bindings).toBe(1); }
    });
    it('A12 failed mount/registration do not consume sequence or displace the old binding', async () => {
        const r = createViewOwnedTools('a', 'i', { maxViews: 1, maxBindings: 1 }); const v = r.mount('v', 'T');
        expect(() => r.mount('other', 'T')).toThrow(); r.unmount(v.viewInstanceId);
        const next = r.mount('v', 'T'); expect(next.viewInstanceId).toBe('vi:v1:["i",2]');
        const cleanup = r.registerTool(next.viewInstanceId, spec(), () => ({ success: true, data: 19 }));
        const old = r.listTools()[0]; expect(old.targets[0].bindingVersion).toBe(1);
        expect(() => r.registerTool(next.viewInstanceId, spec('extra'), () => ({ success: true }))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(r.validate(old, old.targets[0])).toEqual({ success: true }); cleanup();
        r.registerTool(next.viewInstanceId, spec('extra'), () => ({ success: true })); expect(r.listTools()[0].targets[0].bindingVersion).toBe(2);
    });
    it('A12 capacity precheck rejects huge mount text before encoding', () => {
        const r = createViewOwnedTools('a', 'i', { maxRetainedBytes: 100 }); const spy = vi.spyOn(TextEncoder.prototype, 'encode');
        expect(() => r.mount('v'.repeat(1000000), 'T')).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); expect(r.mount('v', 'T').viewInstanceId).toBe('vi:v1:["i",1]');
    });
    it('A13 cleanup returns bytes immediately and never deletes a same-name successor', () => {
        const r = createViewOwnedTools('a', 'i'), identityBytes = r.inspect().retainedBytes, v = r.mount('v', 'T'), before = r.inspect();
        const old = r.registerTool(v.viewInstanceId, spec(), () => ({ success: true }));
        expect(r.inspect().retainedBytes).toBe(before.retainedBytes + bytes(spec())); old(); expect(r.inspect()).toEqual(before);
        const fresh = r.registerTool(v.viewInstanceId, spec(), () => ({ success: true })); old(); expect(r.inspect().bindings).toBe(1);
        r.unmount(v.viewInstanceId); expect(r.inspect()).toMatchObject({ views: 0, bindings: 0, retainedBytes: identityBytes });
        fresh(); old(); r.unmount(v.viewInstanceId); expect(r.inspect().retainedBytes).toBe(identityBytes);
    });
    it('A11/A12 captures byte quota, charges identical bindings separately and leaves version intact on byte rejection', () => {
        const identity = { appId: 'a', appInstanceId: 'i' };
        const views = [1, 2].map(n => ({ viewId: 'v' + n, viewType: 'T', viewInstanceId: 'vi:v1:' + JSON.stringify(['i', n]) }));
        const quota = bytes(identity) + views.reduce((n, v) => n + bytes(v), 0) + 2 * bytes(spec());
        const limits = { maxRetainedBytes: quota }, r = createViewOwnedTools('a', 'i', limits); limits.maxRetainedBytes = 32 * 1024 * 1024;
        views.forEach(v => r.mount(v.viewId, v.viewType));
        const release = r.registerTool(views[0].viewInstanceId, spec(), () => ({ success: true }));
        r.registerTool(views[1].viewInstanceId, spec(), () => ({ success: true }));
        expect(r.inspect()).toMatchObject({ bindings: 2, retainedBytes: quota });
        expect(() => r.registerTool(views[0].viewInstanceId, spec('extra'), () => ({ success: true }))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(r.listTools()[0].targets.find(target => target.viewInstanceId === views[0].viewInstanceId)!.bindingVersion).toBe(1); release();
        r.registerTool(views[0].viewInstanceId, spec(), () => ({ success: true }));
        expect(r.listTools()[0].targets.map(t => t.bindingVersion)).toEqual([3, 2]); expect(r.inspect().retainedBytes).toBe(quota);
    });
    it('A14 permanent close refuses registration, inspection and both V2 callable families before reading hostile input', async () => {
        const r = createViewOwnedTools('a', 'i'), v = r.mount('v', 'T'), cleanup = r.registerTool(v.viewInstanceId, spec(), () => ({ success: true }));
        r.dispose(); r.dispose(); const hostile: any = new Proxy({}, { get() { throw Error('input read'); }, ownKeys() { throw Error('keys read'); } });
        expect(() => r.mount(hostile, hostile)).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
        expect(() => r.registerTool(hostile, hostile, hostile)).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
        for (const method of ['validate', 'validateOrdinaryParametersBinding', 'validateSnapshotValueParametersBinding'] as const)
            expect(r[method](hostile, hostile)).toMatchObject({ success: false, error: { code: 'VIEW_INSTANCE_REVOKED' } });
        for (const method of ['invokeOrdinaryParameters', 'invokeSnapshotValueParameters'] as const)
            expect(await r[method](hostile, hostile, hostile)).toMatchObject({ phase: 'not-entered', result: { error: { code: 'VIEW_INSTANCE_REVOKED' } } });
        cleanup(); r.unmount(v.viewInstanceId); expect(r.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
        expect(r.listViews()).toEqual([]); expect(r.listTools()).toEqual([]); expect(Object.isFrozen(r.listViews())).toBe(true); expect(Object.isFrozen(r.inspect())).toBe(true);
    });
    const families = ['parameters', 'snapshot'] as const;
    it.each(families.flatMap(family => ['success', 'business', 'throw'].map(outcome => ({ family, outcome }))))('A15 entered $family retains $outcome after disposal', async ({ family, outcome }) => {
        const r = createViewOwnedTools('a', 'i'), v = r.mount('v', 'T'), gate = deferred<void>(); let calls = 0;
        const result = outcome === 'business' ? { success: false, error: { code: 'BUSINESS', message: 'kept' } } : { success: true, data: 19 };
        const handler = async () => { calls++; await gate.promise; if (outcome === 'throw') throw Error('original failure'); return result; };
        let schema: JsonValue, options: any, method: any, args: any;
        if (family === 'parameters') { const c = compileOrdinaryParams({ n: { type: 'number', required: true } }, { additionalProperties: false }); if (!c.ok) throw Error(); schema = ordinaryParameterProfile(c.contract); options = { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }; method = 'invokeOrdinaryParameters'; args = { n: 1 }; }
        if (family === 'snapshot') { const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } }, { additionalProperties: false }); if (!c.ok) throw Error(); schema = c.contract.schema; options = { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }; method = 'invokeSnapshotValueParameters'; args = { file: {} }; }
        const safe: any = async () => { const returned = await handler(); return { phase: 'entered-returned', result: returned }; };
        r.registerTool(v.viewInstanceId, { ...spec(), inputSchema: schema }, handler, options, safe);
        const source = r.listTools()[0], target = source.targets[0]; const running = (r[method as keyof typeof r] as any)(source, target, args);
        expect(calls).toBe(1); r.dispose(); const late: any = await (r[method as keyof typeof r] as any)(source, target, args);
        expect(late.result.success).toBe(false); expect(calls).toBe(1);
        gate.resolve();
        if (outcome === 'throw') await expect(running).rejects.toThrow('original failure');
        else expect(await running).toEqual({ phase: 'entered-returned', result });
    });
});
