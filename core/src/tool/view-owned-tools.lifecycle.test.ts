import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';

const definition = { name:'add',description:'Add',inputSchema:{
    type:'object',properties:{amount:{type:'integer'}},required:['amount'],additionalProperties:false,
} };
const a = {idPrefix:'a',type:'Counter',owner:{}}, b = {idPrefix:'b',type:'Counter',owner:{}};
const execute = () => ({success:true as const});
const bind = (view: typeof a, enabled=true, handler=execute) => ({
    ...view,bindings:[{name:'add',enabled,execute:handler}],
});

function fixture(limits = {}) {
    const registry = createViewOwnedTools('app','run',limits);
    registry.defineViewTypes([{ name: 'Counter', multiplicity: 'multiple', tools: [definition] }]);
    return registry;
}
function receiver(instance: ReturnType<ReturnType<typeof fixture>['prepareFrame']>['instances'][number]) {
    return {viewId:instance.viewId,viewInstanceId:instance.viewInstanceId,activationId:instance.toolBindings[0]!.activationId};
}

describe('View instances and bounded committed Tool bindings', () => {
    it('publishes one definition and keeps independent View and activation identities', async () => {
        const registry=fixture();
        const left=vi.fn(execute),right=vi.fn(execute), updated=vi.fn(execute);
        const first=registry.prepareFrame([bind(a,true,left),bind(b,true,right)]);
        expect(first.tools).toHaveLength(1);
        expect(registry.inspect()).toMatchObject({views:0,bindings:0});
        first.accept();
        const [tool]=first.tools, [x,y]=first.instances.map(receiver);
        expect(x!.activationId).not.toBe(y!.activationId);
        await registry.invokeTypeTool(tool!,x!,{amount:1});
        expect(left).toHaveBeenCalledWith({amount:1});
        expect(right).not.toHaveBeenCalled();
        const candidate=registry.prepareFrame([bind(a,true,updated),bind(b,true,right)]);
        await registry.invokeTypeTool(tool!,x!,{amount:2});
        expect(updated).not.toHaveBeenCalled();
        candidate.accept();
        expect(receiver(candidate.instances[0]!)).toEqual(x);
        await registry.invokeTypeTool(tool!,x!,{amount:3});
        expect(updated).toHaveBeenCalledWith({amount:3});
        expect(await registry.invokeTypeTool(tool!,y!,{amount:'invalid'})).toMatchObject({phase:'not-entered'});
        expect(right).not.toHaveBeenCalled();
    });

    it('revokes one binding on disable, replacement and a same-owner close/reopen', () => {
        const registry=fixture(), first=registry.prepareFrame([bind(a),bind(b)]);
        first.accept();
        const tool=first.tools[0]!, x=receiver(first.instances[0]!), y=receiver(first.instances[1]!);
        registry.prepareFrame([bind(a,false),bind(b)]).accept();
        expect(registry.validateTypeToolBinding(tool,x).success).toBe(false);
        expect(registry.validateTypeToolBinding(tool,y).success).toBe(true);
        const enabled=registry.prepareFrame([bind(a),bind(b)]);
        enabled.accept();
        const current=receiver(enabled.instances[0]!);
        expect(current.viewInstanceId).toBe(x.viewInstanceId);
        expect(current.activationId).not.toBe(x.activationId);
        const replaced=registry.prepareFrame([bind({...a,owner:{}}),bind(b)]);
        replaced.accept();
        expect(registry.validateTypeToolBinding(tool,current)).toMatchObject({error:{code:'VIEW_INSTANCE_REVOKED'}});
        registry.prepareFrame([bind(b)]).accept();
        const reopened=registry.prepareFrame([bind(a),bind(b)]);
        reopened.accept();
        expect(receiver(reopened.instances[0]!).viewInstanceId).not.toBe(x.viewInstanceId);
        expect(receiver(reopened.instances[1]!)).toEqual(y);
    });

    it('counts every candidate binding and retains only successful inventories', () => {
        const registry=fixture({maxBindings:1});
        const plan=registry.prepareFrame([bind(a)]);
        plan.accept();
        const before=registry.inspect();
        expect(() => registry.prepareFrame([bind(a),bind(b,false)])).toThrow(/TOOL_CAPACITY/);
        expect(() => registry.prepareFrame([bind(a),bind(a)])).toThrow();
        expect(() => registry.prepareFrame([{...a,bindings:[]}])).toThrow(expect.objectContaining({ code: 'TOOL_BINDING_INVALID' }));
        expect(registry.inspect()).toEqual(before);
        expect(registry.validateTypeToolBinding(plan.tools[0]!,receiver(plan.instances[0]!)).success).toBe(true);
    });

    it('counts retained metadata bytes and prevents stale accepts', () => {
        const probe=fixture();
        probe.prepareFrame([bind(a)]).accept();
        const bytes=probe.inspect().retainedBytes;
        const registry=fixture({maxRetainedBytes:bytes-1});
        expect(() => registry.prepareFrame([bind(a)])).toThrow(/TOOL_CAPACITY/);
        const pending=probe.prepareFrame([bind(b)]);
        probe.prepareFrame([]).accept();
        expect(() => pending.accept()).toThrow(/superseded/);
        probe.dispose();
        expect(probe.inspect()).toMatchObject({state:'disposed',views:0,bindings:0,retainedBytes:0});
        expect(() => probe.prepareFrame([bind(a)])).toThrow(/VIEW_REGISTRY_CLOSED/);
    });

    it('keeps the old owner live until a same-ID replacement is accepted', () => {
        const registry = createViewOwnedTools('app', 'run');
        registry.defineViewTypes([{ name: 'SingleCounter', multiplicity: 'single', tools: [definition] }]);
        const singleView = { id: 'a', type: 'SingleCounter', owner: {}, bindings: [{ name: 'add', enabled: true, execute }] };
        const previous = registry.prepareFrame([singleView]);
        previous.accept();
        const next = registry.prepareFrame([{ ...singleView, owner: {} }]);
        expect(registry.getView('a')?.viewInstanceId).toBe(previous.instances[0]!.viewInstanceId);
        next.accept();
        expect(registry.getView('a')?.viewInstanceId).toBe(next.instances[0]!.viewInstanceId);
        expect(receiver(next.instances[0]!).viewInstanceId).not.toBe(receiver(previous.instances[0]!).viewInstanceId);
    });

    it('skips occupied fixed single IDs in either frame order, stays stable on reorder, and never leaks sequence numbers on reject', () => {
        for (const singleFirst of [true, false]) {
            const registry = createViewOwnedTools('app', 'run');
            registry.defineViewTypes([
                { name: 'Tab', multiplicity: 'multiple', tools: [] },
                { name: 'Guide', multiplicity: 'single', tools: [] },
            ]);
            const guide = { type: 'Guide', id: '3view_1', owner: {}, bindings: [] };
            const tab = { type: 'Tab', idPrefix: '3view', owner: {}, bindings: [] };
            const first = registry.prepareFrame(singleFirst ? [guide, tab] : [tab, guide]);
            expect(first.instances.map(view => view.viewId)).toEqual(singleFirst ? ['3view_1', '3view_2'] : ['3view_2', '3view_1']);
            first.accept();
            const reordered = registry.prepareFrame(singleFirst ? [tab, guide] : [guide, tab]);
            expect(reordered.instances).toEqual([...first.instances].reverse());
            reordered.accept();

            // A frame rejected during prepareFrame (without accept()) must not advance sequences.
            const collidingSingle = { type: 'Guide', id: 'bad', owner: {}, bindings: [] };
            const nextTab = { type: 'Tab', idPrefix: '3view', owner: {}, bindings: [] };
            expect(() => registry.prepareFrame([tab, nextTab, guide, collidingSingle])).toThrow();
            const recovered = registry.prepareFrame([guide, tab, nextTab]);
            expect(recovered.instances.map(view => view.viewId)).toEqual(['3view_1', '3view_2', '3view_3']);
            registry.dispose();
        }
    });

    it('rejects ViewType names without an ASCII letter while preserving ID naming rules', () => {
        for (const badType of ['4_2', '___', '123', '']) {
            const registry = createViewOwnedTools('app', 'run');
            expect(() => registry.defineViewTypes([{ name: badType, multiplicity: 'single', tools: [] }]))
                .toThrow(expect.objectContaining({ code: 'VIEW_INVALID' }));
            registry.dispose();
        }
        const registry = createViewOwnedTools('app', 'run');
        registry.defineViewTypes([
            { name: 'x_y', multiplicity: 'single', tools: [] },
            { name: 'x_4', multiplicity: 'single', tools: [] },
            { name: 'xy', multiplicity: 'multiple', tools: [] },
        ]);
        const frame = registry.prepareFrame([
            { type: 'x_y', id: '4_2', owner: {}, bindings: [] },
            { type: 'x_4', id: '___', owner: {}, bindings: [] },
            { type: 'xy', idPrefix: '4_2', owner: {}, bindings: [] },
        ]);
        expect(frame.instances.map(v => v.viewId)).toEqual(['4_2', '___', '4_2_1']);
        registry.dispose();
    });

    it.each(['success','failure','throw'])('lets a running %s settle after the registry is disposed', async kind => {
        let release!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const registry=fixture(), accepted=registry.prepareFrame([{
            ...a,bindings:[{name:'add',enabled:true,async execute() {
                await gate;
                if(kind==='throw') throw Error('Handler threw');
                if(kind==='failure') return {success:false,error:{code:'EXPECTED',message:'Expected'}};
                return {success:true};
            }}],
        }]);
        const tool=accepted.tools[0]!, selected=receiver(accepted.instances[0]!);
        accepted.accept();
        const running=registry.invokeTypeTool(tool,selected,{amount:1});
        registry.dispose();
        release();
        if(kind==='throw') await expect(running).rejects.toThrow('Handler threw');
        else expect(await running).toMatchObject({phase:'entered-returned',result:{success:kind==='success'}});
        expect(await registry.invokeTypeTool(tool,selected,{amount:1})).toMatchObject({phase:'not-entered'});
    });
});


describe('Historical prefix retention', () => {
    // Prefixes and positive integer counters use the canonical JSON tuple encoding.
    const counterBytes = (prefix: string, counter: number) => new TextEncoder().encode(JSON.stringify([prefix, counter])).length;
    const tab = (prefix: string) => ({ type: 'Tab', idPrefix: prefix, owner: {}, bindings: [] });
    function tabs(maxRetainedBytes: number) {
        const registry = createViewOwnedTools('probe', 'instance', { maxViews: 1, maxRetainedBytes });
        registry.defineViewTypes([{ name: 'Tab', multiplicity: 'multiple', tools: [] }]);
        return registry;
    }

    it('bounds the CR probe even when at most one View is mounted, retaining old prefixes through empty frames', () => {
        const registry = tabs(2048);
        let expected = registry.inspect().retainedBytes;
        let accepted = 0;
        try {
            for (let i = 0; i < 1000; i++) {
                const prefix = 'p' + i + 'x'.repeat(100);
                const before = registry.inspect();
                try {
                    const plan = registry.prepareFrame([tab(prefix)]);
                    expect(plan.instances[0]?.viewId).toBe(prefix + '_1');
                    plan.accept();
                } catch (error) {
                    expect(error).toMatchObject({ code: 'TOOL_CAPACITY' });
                    expect(registry.inspect()).toEqual(before);
                    break;
                }
                expect(registry.inspect().retainedBytes).toBeLessThanOrEqual(2048);
                registry.prepareFrame([]).accept();
                accepted++;
                expected += counterBytes(prefix, 1);
                expect(registry.inspect()).toMatchObject({ views: 0, bindings: 0, retainedBytes: expected });
            }
            expect(accepted).toBeGreaterThan(0);
            expect(accepted).toBeLessThan(1000);
            const firstPrefix = 'p0' + 'x'.repeat(100);
            const reopened = registry.prepareFrame([tab(firstPrefix)]);
            expect(reopened.instances[0]).toMatchObject({ viewId: firstPrefix + '_2', viewInstanceId: 'm:' + (accepted + 1) });
            reopened.accept();
            registry.prepareFrame([]).accept();
            expect(registry.inspect()).toMatchObject({ views: 0, bindings: 0, retainedBytes: expected });
        } finally { registry.dispose(); }
        expect(registry.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
    });

    it('does not spend rejected prefix, mount or Tool/close activation numbers and permits a smaller retry', async () => {
        const left = vi.fn(execute), right = vi.fn(execute), closeLeft = vi.fn(execute), closeRight = vi.fn(execute);
        const old = { ...bind(a, true, left), onClose: closeLeft };
        const added = { ...bind(b, true, right), onClose: closeRight };
        // Set the cap to the measured one-View replacement, including both historical prefixes.
        const probe = fixture();
        probe.prepareFrame([old]).accept();
        probe.prepareFrame([added]).accept();
        const limit = probe.inspect().retainedBytes;
        probe.dispose();

        const registry = fixture({ maxRetainedBytes: limit });
        try {
            const first = registry.prepareFrame([old]);
            first.accept();
            const before = registry.inspect(), selected = receiver(first.instances[0]!);
            const closeActivationId = first.instances[0]!.closeActivationId!;
            expect(() => registry.prepareFrame([old, added])).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
            expect(registry.inspect()).toEqual(before);
            expect(registry.readViewId(added.owner)).toBeUndefined();
            expect(registry.getView('a_1')?.viewInstanceId).toBe(selected.viewInstanceId);
            expect(await registry.invokeTypeTool(first.tools[0]!, selected, { amount: 1 }))
                .toMatchObject({ phase: 'entered-returned', result: { success: true } });
            expect(await registry.closeView(selected.viewId, selected.viewInstanceId, closeActivationId))
                .toMatchObject({ phase: 'entered-returned', result: { success: true } });
            expect(left).toHaveBeenCalledOnce();
            expect(closeLeft).toHaveBeenCalledOnce();
            expect(right).not.toHaveBeenCalled();
            expect(closeRight).not.toHaveBeenCalled();

            const retry = registry.prepareFrame([added]);
            expect(retry.instances[0]).toMatchObject({ viewId: 'b_1', viewInstanceId: 'm:2',
                toolBindings: [{ activationId: 'a:3' }], closeActivationId: 'a:4' });
            retry.accept();
            expect(registry.inspect().retainedBytes).toBe(limit);
            expect(await registry.invokeTypeTool(first.tools[0]!, selected, { amount: 2 })).toMatchObject({ phase: 'not-entered' });
            expect(await registry.closeView(selected.viewId, selected.viewInstanceId, closeActivationId)).toMatchObject({ phase: 'not-entered' });
            expect(await registry.invokeTypeTool(retry.tools[0]!, receiver(retry.instances[0]!), { amount: 3 })).toMatchObject({ phase: 'entered-returned' });
            expect(right).toHaveBeenCalledOnce();
        } finally { registry.dispose(); }
    });

    it('charges counter digit growth on reopen, with exact-fit acceptance and one-byte-short rejection', () => {
        const prefix = 'page';
        const probe = tabs(2048);
        const base = probe.inspect().retainedBytes;
        let tenthBytes = 0;
        try {
            for (let i = 1; i <= 10; i++) {
                const plan = probe.prepareFrame([tab(prefix)]);
                expect(plan.instances[0]?.viewId).toBe(prefix + '_' + i);
                plan.accept();
                if (i === 10) tenthBytes = probe.inspect().retainedBytes;
                probe.prepareFrame([]).accept();
                expect(probe.inspect().retainedBytes).toBe(base + counterBytes(prefix, i));
            }
        } finally { probe.dispose(); }
        expect(counterBytes(prefix, 10)).toBe(counterBytes(prefix, 9) + 1);
        for (const limit of [tenthBytes - 1, tenthBytes]) {
            const registry = tabs(limit);
            try {
                for (let i = 1; i <= 9; i++) {
                    const plan = registry.prepareFrame([tab(prefix)]);
                    expect(plan.instances[0]?.viewId).toBe(prefix + '_' + i);
                    plan.accept();
                    registry.prepareFrame([]).accept();
                }
                const before = registry.inspect();
                expect(before.retainedBytes).toBe(base + counterBytes(prefix, 9));
                if (limit < tenthBytes) {
                    expect(() => registry.prepareFrame([tab(prefix)])).toThrow(expect.objectContaining({ code: 'TOOL_CAPACITY' }));
                    expect(registry.inspect()).toEqual(before);
                } else {
                    const tenth = registry.prepareFrame([tab(prefix)]);
                    expect(tenth.instances[0]?.viewId).toBe(prefix + '_10');
                    tenth.accept();
                    expect(registry.inspect().retainedBytes).toBe(limit);
                    registry.prepareFrame([]).accept();
                    expect(registry.inspect().retainedBytes).toBe(before.retainedBytes + 1);
                }
            } finally { registry.dispose(); }
        }
    });
});
