import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import type { AppTypeToolDefinition } from '../../spi/runtime/app-type-tools.interface.js';
import type { SafeOrdinaryInvoker, ViewToolInvocationTerminal } from './invocation-terminal.js';

const emptyContract = compileOrdinarySchema({ type: 'object', properties: {}, additionalProperties: false }, 'view-type-parameters-v1');
if (!emptyContract.ok) throw new Error('Fixture schema must compile');
const emptySchema = emptyContract.contract.schema;
const typeDefinition = (name = 'read', viewType = 'T', description = 'Read'): AppTypeToolDefinition => ({
    viewType, name, description, inputSchema: emptySchema, 
});
const publicDefinition = (definition: AppTypeToolDefinition): JsonValue => ({
    ...definition, inputSchema: ordinaryParameterProfile(emptyContract.contract),
});
const size = (value: unknown) => utf8Size(canonicalJson(value as JsonValue));
function register(r: ReturnType<typeof createViewOwnedTools>, definition = typeDefinition(), invoke?: SafeOrdinaryInvoker) {
    return r.registerTypeTool(definition, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: () => invoke ?? (async () => ({
            phase: 'entered-returned', result: { success: true },
        })),
    });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('ViewType Tool Registry bounded retention and release lifecycle', () => {
    it.each([
        ['maxViews', 1000], ['maxBindings', 10000], ['maxRetainedBytes', 32 * 1024 * 1024],
    ] as const)('captures and enforces the %s hard ceiling', (key, hard) => {
        const accepted = key === 'maxRetainedBytes' ? 1024 : hard;
        expect(() => createViewOwnedTools('a', 'i', { [key]: accepted })).not.toThrow();
        for (const value of [-1, 0.5, NaN, Infinity, hard + 1]) {
            expect(() => createViewOwnedTools('a', 'i', { [key]: value })).toThrow(RangeError);
        }
    });

    it('charges App identity immediately and rejects unknown limit keys', () => {
        expect(() => createViewOwnedTools('a', 'i', { typo: 1 } as never)).toThrow(RangeError);
        expect(() => createViewOwnedTools('a', 'i', { [Symbol()]: 1 } as never)).toThrow(RangeError);
        const need = size({ appId: 'a', appInstanceId: 'i' });
        expect(() => createViewOwnedTools('a', 'i', { maxRetainedBytes: need - 1 })).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        expect(createViewOwnedTools('a', 'i', { maxRetainedBytes: need }).inspect()).toEqual({
            state: 'active', views: 0, bindings: 0, retainedBytes: need,
        });
    });

    it('reaches the 1000 mounted View and 10000 App Tool limits', () => {
        const r = createViewOwnedTools('a', 'i');
        for (let n = 0; n < 1000; n++) r.mount('v' + n, 'T');
        expect(() => r.mount('extra', 'T')).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        for (let n = 0; n < 10000; n++) register(r, typeDefinition('t' + n));
        expect(() => register(r, typeDefinition('extra'))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(r.inspect()).toMatchObject({ views: 1000, bindings: 10000 });
        expect(r.listTools()).toHaveLength(10000);
        const first = r.listViews()[0]!;
        r.unmount(first.viewInstanceId);
        expect(r.inspect()).toMatchObject({ views: 999, bindings: 10000 });
        expect(r.listTools()).toHaveLength(10000);
    });

    it.each([-1, 0, 1])('charges UTF-8 View bytes exactly at quota delta %i', delta => {
        const identity = { appId: '中', appInstanceId: '😀' };
        const view = { viewId: 'v\n', viewType: 'T中', viewInstanceId: 'vi:v1:' + JSON.stringify(['😀', 1]) };
        const need = size(identity) + size(view);
        const r = createViewOwnedTools('中', '😀', { maxRetainedBytes: need + delta });
        if (delta < 0) expect(() => r.mount(view.viewId, view.viewType)).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        else {
            expect(r.mount(view.viewId, view.viewType)).toEqual(view);
            expect(r.inspect().retainedBytes).toBe(need);
        }
    });

    it.each([-1, 0, 1])('charges normalized Tool contract bytes exactly at quota delta %i', delta => {
        const definition = typeDefinition('读', 'T中', '😀\n');
        const base = size({ appId: 'a', appInstanceId: 'i' }) + size({ viewId: 'v', viewType: 'T中', viewInstanceId: 'vi:v1:["i",1]' });
        const need = base + size(publicDefinition(definition)) + utf8Size('ta:v1:["i",1]');
        const r = createViewOwnedTools('a', 'i', { maxRetainedBytes: need + delta });
        r.mount('v', 'T中');
        if (delta < 0) {
            expect(() => register(r, definition)).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
            expect(r.inspect().retainedBytes).toBe(base);
        } else {
            const release = register(r, definition);
            expect(r.inspect().retainedBytes).toBe(need);
            release();
            expect(r.inspect().retainedBytes).toBe(base);
        }
    });

    it('charges the long Unicode activation before committing the first matching View', () => {
        const appInstanceId = '😀'.repeat(256), definition = typeDefinition('read', 'File');
        const base = size({ appId: 'a', appInstanceId });
        const viewBytes = size({ viewId: 'v', viewType: 'File', viewInstanceId: 'vi:v1:' + JSON.stringify([appInstanceId, 1]) });
        const declarationBytes = size(publicDefinition(definition));
        const r = createViewOwnedTools('a', appInstanceId, { maxRetainedBytes: base + declarationBytes + viewBytes });
        const release = register(r, definition);
        expect(r.inspect().retainedBytes).toBe(base + declarationBytes);
        expect(r.listTools()).toEqual([]);
        expect(() => r.mount('v', 'File')).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(r.inspect()).toMatchObject({ views: 0, bindings: 1, retainedBytes: base + declarationBytes });
        expect(r.listTools()).toEqual([]);
        release();
        expect(r.inspect().retainedBytes).toBe(base);
    });

    it('rejects a long Unicode activation when registering after mount before calling the invoker factory', () => {
        const appInstanceId = '界'.repeat(256), definition = typeDefinition('read', 'File');
        const base = size({ appId: 'a', appInstanceId });
        const view = { viewId: 'v', viewType: 'File', viewInstanceId: 'vi:v1:' + JSON.stringify([appInstanceId, 1]) };
        const viewBytes = size(view);
        const declarationBytes = size(publicDefinition(definition));
        const r = createViewOwnedTools('a', appInstanceId, { maxRetainedBytes: base + viewBytes + declarationBytes });
        r.mount('v', 'File');
        const createInvoker = vi.fn(() => async () => ({ phase: 'entered-returned' as const, result: { success: true } }));
        expect(() => r.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: createInvoker,
        })).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(createInvoker).not.toHaveBeenCalled();
        expect(r.inspect()).toMatchObject({ views: 1, bindings: 0, retainedBytes: base + viewBytes });
        expect(r.listTools()).toEqual([]);
    });

    it('failed mount and failed registration do not consume View or Tool activation identities', () => {
        const r = createViewOwnedTools('a', 'i', { maxViews: 1, maxBindings: 1 });
        const first = r.mount('v', 'T');
        expect(() => r.mount('other', 'T')).toThrow();
        r.unmount(first.viewInstanceId);
        expect(r.mount('v', 'T').viewInstanceId).toBe('vi:v1:["i",2]');
        register(r);
        const observed = r.listTools()[0]!;
        expect(() => register(r, typeDefinition('extra'))).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
        expect(r.listTools()[0]).toEqual(observed);
    });

    it('prechecks huge View text before UTF-8 encoding', () => {
        const r = createViewOwnedTools('a', 'i', { maxRetainedBytes: 100 });
        const spy = vi.spyOn(TextEncoder.prototype, 'encode');
        expect(() => r.mount('v'.repeat(1_000_000), 'T')).toThrow(expect.objectContaining({ code: 'VIEW_CAPACITY' }));
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        expect(r.mount('v', 'T').viewInstanceId).toBe('vi:v1:["i",1]');
    });

    it('releases bytes idempotently and an old release cannot remove its successor', async () => {
        const r = createViewOwnedTools('a', 'i');
        r.mount('v', 'T');
        const base = r.inspect().retainedBytes;
        const oldRelease = register(r);
        expect(r.inspect().retainedBytes).toBe(base + size(publicDefinition(typeDefinition())) + utf8Size('ta:v1:["i",1]'));
        oldRelease(); oldRelease();
        expect(r.inspect().retainedBytes).toBe(base);
        const newRelease = register(r);
        oldRelease();
        const tool = r.listTools()[0]!;
        expect(await r.invokeTypeTool(tool, tool.execution, {})).toMatchObject({ phase: 'entered-returned', result: { success: true } });
        expect(r.inspect().bindings).toBe(1);
        newRelease();
        expect(r.listTools()).toEqual([]);
        r.unmount(r.listViews()[0]!.viewInstanceId);
        expect(r.inspect().retainedBytes).toBe(base - size({ viewId: 'v', viewType: 'T', viewInstanceId: 'vi:v1:["i",1]' }));
    });

    it('disposal permanently rejects new registration and invocation before reading hostile inputs', async () => {
        const r = createViewOwnedTools('a', 'i');
        r.mount('v', 'T');
        const release = register(r);
        r.dispose(); r.dispose();
        release(); release();
        const hostile = new Proxy({}, { get() { throw new Error('input read'); }, ownKeys() { throw new Error('keys read'); } });
        expect(() => r.mount(hostile as string, hostile as string)).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
        expect(() => register(r, hostile as AppTypeToolDefinition)).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
        expect(r.validateTypeToolBinding(hostile as never, hostile as never)).toMatchObject({ success: false,
            error: { code: 'VIEW_INSTANCE_REVOKED' } });
        expect(await r.invokeTypeTool(hostile as never, hostile as never, hostile as never)).toMatchObject({ phase: 'not-entered',
            result: { error: { code: 'VIEW_INSTANCE_REVOKED' } } });
        expect(r.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
        expect(r.listViews()).toEqual([]); expect(r.listTools()).toEqual([]);
        expect(Object.isFrozen(r.listViews())).toBe(true); expect(Object.isFrozen(r.inspect())).toBe(true);
    });

    it.each(['success', 'business', 'throw'] as const)('preserves an already-entered %s result after dispose', async outcome => {
        const r = createViewOwnedTools('a', 'i');
        r.mount('v', 'T');
        const gate = deferred<void>(); let calls = 0;
        const terminal: ViewToolInvocationTerminal = outcome === 'business'
            ? { phase: 'entered-returned', result: { success: false, error: { code: 'BUSINESS', message: 'kept' } } }
            : { phase: 'entered-returned', result: { success: true, data: 19 } };
        const invoker: SafeOrdinaryInvoker = async () => {
            calls++;
            await gate.promise;
            if (outcome === 'throw') throw new Error('original failure');
            return terminal;
        };
        register(r, typeDefinition(), invoker);
        const tool = r.listTools()[0]!;
        const running = r.invokeTypeTool(tool, tool.execution, {});
        expect(calls).toBe(1);
        r.dispose();
        expect(await r.invokeTypeTool(tool, tool.execution, {})).toMatchObject({ phase: 'not-entered' });
        expect(calls).toBe(1);
        gate.resolve();
        if (outcome === 'throw') await expect(running).rejects.toThrow('original failure');
        else expect(await running).toEqual(terminal);
    });
});
