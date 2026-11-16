import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { useMemo, useState } from 'preact/hooks';
import Type from 'typebox';
import { compileOrdinarySchema } from '@aotui/runtime/core';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp, View, useArrayRef, useDataRef, refParam, defineViewType } from './index.js';
import { arrayRef, formatRef, ref, refParam as plainRefParam } from './app.js';

const Detail=defineViewType({name:'Detail'});
function setup(Content: () => any) {
 const factory = createTUIApp({ app_name: 'typed_refs', viewTypes:[Detail], component: () => h(View, {kind: 'state',id:'detail',type:Detail},h(Content, {})) });
 const kernel = new AppKernel({...factory.kernelConfig,factory} as any);
 kernel.setId('app' as any);
 kernel.enableAppLifecycle();
 return {kernel,get container(){return document.getElementById('app-root-app')!;},open:()=>kernel.onOpen({appId:'app' as any,desktopId:'desktop' as any}),
 async close(){await kernel.onClose();}};
}
const schema=Type.Object({id:Type.String(),title:Type.String()},{additionalProperties:false});
const define = (parameter: Type.TSchema) => defineViewType<object>()({ name: 'Detail', tools: {
    edit: {
        description: 'Edit selected Plan',
        inputSchema: Type.Object({ plan: parameter, title: Type.String() }, { additionalProperties: false }),
        execute: () => ({ success: true }),
    },
} }).tools.edit;

describe('Ref authoring and value contracts',()=>{
 it('shares refParam implementation across public entries and preserves the business Schema witness',()=>{
   expect(plainRefParam).toBe(refParam);
   const parameter=refParam('Plan',schema);
   expect(parameter['x-aotui-ref-value']).toBe(schema);
   expect(parameter).toMatchObject({type:'string',minLength:1,'x-aotui-ref-kind':'Plan'});
   expect(define(parameter).inputSchema.properties).toMatchObject({plan:{type:'string','x-aotui-ref-kind':'Plan','x-aotui-ref-value':{type:'object',required:['id','title']}}});
 });
 it('keeps display type separate from local registration, metadata and payload, updates in place, and releases renamed/retyped/unmounted bindings',async()=>{
   let set!:(state:{id:string;refId:string;refType:string})=>void;
   function Content(){const [state,update]=useState({id:'one',refId:'current_plan',refType:'Plan'});set=update;
     const data=useMemo(()=>({id:state.id,title:'Plan title'}),[state.id]);
     const ref=useDataRef(state.refId,data,{refType:state.refType});return h('p',{},ref('Selected'));
   }
   const x=setup(Content);const register=vi.spyOn(x.kernel.getProjectionCoordinator(),'registerRef');
   try{
    await x.open();expect(x.container.textContent).toContain('[Selected](Plan:current_plan)');
    expect(x.kernel.getViewRefs()).toEqual([{viewId:'detail',refId:'current_plan',refType:'Plan',value:{id:'one',title:'Plan title'}}]);
    const initial=register.mock.results[0]!.value;const update=vi.spyOn(initial,'update'),release=vi.spyOn(initial,'release');
    await act(async()=>set({id:'two',refId:'current_plan',refType:'Plan'}));
    expect(register).toHaveBeenCalledOnce();expect(update).toHaveBeenCalledOnce();expect(x.kernel.getViewRefs()[0]!.value).toEqual({id:'two',title:'Plan title'});
    await act(async()=>set({id:'two',refId:'renamed',refType:'Plan'}));expect(release).toHaveBeenCalledOnce();
    const renamed=register.mock.results[1]!.value;const releaseRenamed=vi.spyOn(renamed,'release');
    await act(async()=>set({id:'two',refId:'renamed',refType:'DraftPlan'}));
    expect(releaseRenamed).toHaveBeenCalledOnce();expect(x.kernel.getViewRefs()).toEqual([{viewId:'detail',refId:'renamed',refType:'DraftPlan',value:{id:'two',title:'Plan title'}}]);
    expect(x.container.textContent).toContain('[Selected](DraftPlan:renamed)');
    initial.release();renamed.release();expect(x.kernel.getViewRefs()).toHaveLength(1);
   }finally{await x.close();}expect(x.kernel.getViewRefs()).toEqual([]);
 });
 it('keeps a two-argument Ref untyped through registration and display',async()=>{
   const x=setup(()=>{const mark=useDataRef('raw',{id:'one'});return h('p',{},mark('Raw'));});
   const register=vi.spyOn(x.kernel.getProjectionCoordinator(),'registerRef');
   try{await x.open();expect(x.kernel.getViewRefs()).toEqual([{viewId:'detail',refId:'raw',value:{id:'one'}}]);expect(x.container.textContent).toContain('[Raw](raw)');expect(register.mock.calls[0]).toEqual([expect.objectContaining({viewId:'detail'}),'raw',expect.any(Object),undefined]);}finally{await x.close();}
 });
 it.each(['file)', 'Plan:raw', 'name with spaces', 'file\\name', 'name&amp;other', 'file.txt',
   Symbol('invalid') as unknown as string])(
   'rejects invalid Ref ID %s in the descriptor formatter and during Hook publication', async id => {
     const path = typeof id === 'string' ? 'Ref ' + id : '$.refs.id';
     const issue = expect.objectContaining({ code: 'SNAPSHOT_INVALID', path });
     expect(() => formatRef('Label', ref(id, false))).toThrow(issue);
     const x = setup(() => { useDataRef(id, false); return null; });
     try {
       await expect(x.open()).rejects.toMatchObject(issue);
       expect(x.kernel.getViewRefs()).toEqual([]);
     } finally { await x.close(); }
   },
 );
 it('formats a plain descriptor and only addresses present array elements', () => {
   const list = arrayRef('items', ['file (draft).txt'], { itemType: 'Doc.版本' });
   expect(formatRef('All', list)).toBe('[All](Doc.版本[]:items)');
   expect(formatRef('One [draft]', list, 0)).toBe('[One \\[draft\\]](Doc.版本:items[0])');
   expect(formatRef('Name', ref('文件-1', null))).toBe('[Name](文件-1)');
   expect(formatRef('Empty', arrayRef('items', []))).toBe('[Empty](items)');
   expect(() => formatRef('Missing', list, 1)).toThrow(expect.objectContaining({
     code: 'SNAPSHOT_INVALID', path: 'Ref items', message: expect.stringContaining('index'),
   }));
 });
 it('rejects duplicate typed publishers without replacing the first owner',async()=>{
   function Publisher(){useDataRef('current_plan',{id:'one'},{refType:'Plan'});return null;}
   const x=setup(()=>h('section',{},[h(Publisher,{key:'one'}),h(Publisher,{key:'two'})]));
   try{await expect(x.open()).rejects.toMatchObject({code:'REF_ALREADY_REGISTERED'});expect(x.kernel.getViewRefs()).toEqual([]);}finally{await x.close();}
 });
 it('rejects same local ID even when publishers use different display types',async()=>{
   function PlanPublisher(){useDataRef('selected',{id:'one'},{refType:'Plan'});return null;}
   function PhasePublisher(){useDataRef('selected',{id:'two'},{refType:'Phase'});return null;}
   const x=setup(()=>h('section',{},[h(PlanPublisher,{}),h(PhasePublisher,{})]));
   try{await expect(x.open()).rejects.toMatchObject({code:'REF_ALREADY_REGISTERED'});expect(x.kernel.getViewRefs()).toEqual([]);}finally{await x.close();}
 });
 it('does not let a typed publisher cleanup delete a successor with the same full ID',async()=>{
   let hide!:()=>void;
   function Publisher(){useDataRef('current_plan',{id:'first'},{refType:'Plan'});return null;}
   function Content(){const [show,set]=useState(true);hide=()=>set(false);return show?h(Publisher,{}):null;}
   const x=setup(Content);const register=vi.spyOn(x.kernel.getProjectionCoordinator(),'registerRef');
   try{await x.open();const first=register.mock.results[0]!.value;first.release();
     const projection=x.kernel.getProjectionCoordinator();
     let successor!: ReturnType<typeof projection.registerRef>;
     projection.commit(() => { successor=projection.registerRef(x.kernel.getViewOwnedViewInstances()[0]!,'current_plan',{id:'successor'},'Plan'); });
     await act(hide);expect(x.kernel.getViewRefs()).toEqual([{viewId:'detail',refId:'current_plan',refType:'Plan',value:{id:'successor'}}]);
     successor.release();expect(x.kernel.getViewRefs()).toEqual([]);
   }finally{await x.close();}
 });
 it.each(['', '   ', 'Plan)', 'Type:Plan', 42, null])('rejects invalid explicit refType %s',async refType=>{
   const x=setup(()=>{useDataRef('current_plan',{id:'one'},{refType} as any);return null;});
   try {
     await expect(x.open()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'Ref current_plan' });
     expect(x.kernel.getViewRefs()).toEqual([]);
   } finally { await x.close(); }
 });
 it.each([null,42,false,'',[],['one']].map(value => [value]))('captures typed JSON payload %j',async value=>{
   const x=setup(()=>{useDataRef('current_plan',value,{refType:'Plan'});return null;});
   try{await x.open();expect(x.kernel.getViewRefs()[0]?.value).toEqual(value);}finally{await x.close();}
 });
 it('leaves empty/wrong type and unsupported Schema diagnostics to existing declaration capture',()=>{
   for(const [type,value,code] of [['',schema,'TOOL_SCHEMA_INVALID'],[42,schema,'TOOL_SCHEMA_INVALID'],['Plan',Type.Tuple([Type.String()]),'TOOL_SCHEMA_UNSUPPORTED']] as const){
     expect(()=>define(refParam(type as any,value))).toThrow(expect.objectContaining({code}));
   }
 });
 it('does not evaluate a business Schema getter in the helper or existing safe exporter',()=>{
   let reads=0;const getterSchema=Object.create(null);Object.defineProperty(getterSchema,'type',{enumerable:true,get(){reads++;throw new Error('probe-sentinel');}});
   const parameter=refParam('Plan',getterSchema);expect(reads).toBe(0);
   expect(()=>define(parameter)).toThrow(expect.objectContaining({code:'TOOL_SCHEMA_INVALID'}));expect(reads).toBe(0);
 });
 it('reports a standalone Ref schema copy limit at publication without registering the value', async () => {
   const schema = Type.Array(Type.Number(), { default: Array(3_000).fill(0) });
   const x = setup(() => { useDataRef('values', [], { refType: 'Numbers', schema }); return null; });
   try {
     await expect(x.open()).rejects.toMatchObject({ code: 'TOOL_SCHEMA_CAPACITY', path: expect.stringContaining('default') });
     expect(x.kernel.getViewRefs()).toEqual([]);
   } finally { await x.close(); }
 });
 it('checks whole-array constraints on untyped input at publication', async () => {
   const options = { itemType: 'Plan', schema: Type.Array(schema, { minItems: 1 }) };
   const x = setup(() => { useArrayRef('plans', JSON.parse('[]'), options); return null; });
   try {
     await x.open();
     const projection = x.kernel.getProjectionCoordinator();
     expect(projection.nextPublication()).toMatchObject({
       failure: { issue: { code: 'SNAPSHOT_INVALID', path: 'Ref detail.plans $' } },
     });
     expect(x.kernel.getViewRefs()).toEqual([]);
   } finally { await x.close(); }
 });
 it('captures arrays of Ref names and preserves exact resolved value witnesses',()=>{
   const input=Type.Object({plans:Type.Array(refParam('Plan',schema),{maxItems:3}),
     optional:Type.Optional(refParam('Plan',schema))},{additionalProperties:false});
   const tool=defineViewType<object>()({name:'Plan',tools:{choose:{description:'Choose Plans',inputSchema:input,execute:()=>({success:true})}}}).tools.choose;
   const compiled=compileOrdinarySchema(tool.inputSchema);
   expect(compiled.ok).toBe(true);if(!compiled.ok)throw Error('contract');
   expect(compiled.contract.validateModelInput({plans:['detail.a','detail.b']}).ok).toBe(true);
   expect(compiled.contract.validateResolvedInput({plans:[{id:'a',title:'A'},{id:'b',title:'B'}]}).ok).toBe(true);
   expect(Object.isFrozen(tool.inputSchema)).toBe(true);
   expect(()=>define(Type.Array(refParam(' ',schema)))).toThrow(expect.objectContaining({code:'TOOL_SCHEMA_INVALID'}));
 });
});
