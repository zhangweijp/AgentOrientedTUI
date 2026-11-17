import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';

const definition = { viewType:'Counter',name:'add',description:'Add',inputSchema:{
    type:'object',properties:{amount:{type:'integer'}},required:['amount'],additionalProperties:false,
} };
const a = {id:'a',type:'Counter',owner:{}}, b = {id:'b',type:'Counter',owner:{}};
const execute = () => ({success:true as const});
const bind = (view: typeof a, enabled=true, handler=execute) => ({
    ...view,bindings:[{name:'add',enabled,execute:handler}],
});

function fixture(limits = {}) {
    const registry = createViewOwnedTools('app','run',limits);
    registry.defineTools([definition]);
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
        const registry=fixture(), previous=registry.prepareFrame([bind(a)]);
        previous.accept();
        const next=registry.prepareFrame([bind({...a,owner:{}})]);
        expect(registry.getView('a')?.viewInstanceId).toBe(previous.instances[0]!.viewInstanceId);
        next.accept();
        expect(registry.getView('a')?.viewInstanceId).toBe(next.instances[0]!.viewInstanceId);
        expect(receiver(next.instances[0]!).viewInstanceId).not.toBe(receiver(previous.instances[0]!).viewInstanceId);
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
