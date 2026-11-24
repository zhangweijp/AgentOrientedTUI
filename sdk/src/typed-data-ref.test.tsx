import { mountedViews, preparedRefs } from './__tests__/projection-facts.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { describe, expect, it } from 'vitest';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { useMemo, useState } from 'preact/hooks';
import Type from 'typebox';
import { compileToolParameters } from '@aotui/core';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp, DynamicView, useArrayRef, useDataRef, refParam, defineViewType } from './index.js';
import { arrayRef, createApp, createView, formatRef, ref, refParam as plainRefParam } from './app.js';

const Detail=defineViewType({ multiplicity: 'multiple', name:'Detail'});
function setup(Content: () => any) {
 const factory = createTUIApp({ app_name: 'typed_refs', viewTypes:[Detail], component: () => h(DynamicView, {idPrefix:'detail',type:Detail},h(Content, {})) });
 const kernel = new AppKernel({ factory,
     appId: createAppId('app'), desktopId: createDesktopId('desktop'),
     instanceId: 'typed-data-ref-run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
 });
 let container: Element;
 return {kernel,get container(){return container;},async open(){await kernel.onOpen();container=document.body.lastElementChild!;},
 async close(){await kernel.onClose();}};
}
const schema=Type.Object({id:Type.String(),title:Type.String()},{additionalProperties:false});
const define = (parameter: Type.TSchema) => defineViewType<object>()({ multiplicity: 'multiple', name: 'Detail', tools: {
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
   expect(parameter).toEqual({'x-aotui-ref-kind':'Plan','x-aotui-ref-value':schema});
   const exported = define(parameter).inputSchema.properties as Record<string, any>;
   expect(exported.plan).toEqual({'x-aotui-ref-kind':'Plan','x-aotui-ref-value':{type:'object',properties:{id:{type:'string'},title:{type:'string'}},required:['id','title'],additionalProperties:false}});
   expect(exported.plan).not.toHaveProperty('type');
   expect(exported.plan).not.toHaveProperty('minLength');
 });
 it('keeps display type separate from local registration, metadata and payload, updates in place, and releases renamed/retyped/unmounted bindings',async()=>{
   let set!:(state:{id:string;refId:string;refType:string})=>void;
   function Content(){const [state,update]=useState({id:'one',refId:'current_plan',refType:'Plan'});set=update;
     const data=useMemo(()=>({id:state.id,title:'Plan title'}),[state.id]);
     const ref=useDataRef(state.refId,data,{ schema: Type.Object({}), scope: 'protected',refType:state.refType});return h('p',{},ref('Selected'));
   }
   const x=setup(Content);
   try{
    await x.open();expect(x.container.textContent).toContain('[Selected](protected current_plan: Plan)');
    expect(preparedRefs(x.kernel)).toEqual([{viewId:'detail_1',refId:'current_plan',refType:'Plan',value:{id:'one',title:'Plan title'}}]);
    await act(async()=>set({id:'two',refId:'current_plan',refType:'Plan'}));
    expect(preparedRefs(x.kernel)).toEqual([{viewId:'detail_1',refId:'current_plan',refType:'Plan',value:{id:'two',title:'Plan title'}}]);
    await act(async()=>set({id:'two',refId:'renamed',refType:'Plan'}));
    expect(preparedRefs(x.kernel).map(ref => ref.refId)).toEqual(['renamed']);
    await act(async()=>set({id:'two',refId:'renamed',refType:'DraftPlan'}));
    expect(preparedRefs(x.kernel)).toEqual([{viewId:'detail_1',refId:'renamed',refType:'DraftPlan',value:{id:'two',title:'Plan title'}}]);
    expect(x.container.textContent).toContain('[Selected](protected renamed: DraftPlan)');
   }finally{await x.close();}expect(preparedRefs(x.kernel)).toEqual([]);
 });
 it('uses the declared value type when no nominal label is given',async()=>{
   const x=setup(()=>{const mark=useDataRef('raw',{id:'one'}, { schema: Type.Object({}), scope: 'protected' });return h('p',{},mark('Raw'));});
   try{await x.open();expect(preparedRefs(x.kernel)).toEqual([{viewId:'detail_1',refId:'raw',refType:'object',value:{id:'one'}}]);expect(x.container.textContent).toContain('[Raw](protected raw: object)');}finally{await x.close();}
 });
 it.each(['file)', 'Plan:raw', 'name with spaces', 'file\\name', 'name&amp;other',
   Symbol('invalid') as unknown as string])(
   'rejects invalid Ref ID %s in the descriptor formatter and during Hook publication', async id => {
     const path = typeof id === 'string' ? 'Ref ' + id : '$.refs.id';
     const issue = expect.objectContaining({ code: 'SNAPSHOT_INVALID', path });
     expect(() => formatRef('Label', ref(id, false, { schema: Type.Boolean(), scope: 'protected' }))).toThrow(issue);
     const x = setup(() => { useDataRef(id, false, { schema: Type.Boolean(), scope: 'protected' }); return null; });
     try {
       await expect(x.open()).rejects.toMatchObject(issue);
       expect(preparedRefs(x.kernel)).toEqual([]);
     } finally { await x.close(); }
   },
 );
 it('formats a plain descriptor and only addresses present array elements', () => {
   const list = arrayRef('items', ['file (draft).txt'], { schema: Type.Array(Type.String()), scope: 'protected', itemType: 'Doc.版本' });
   expect(formatRef('All', list)).toBe('[All](protected items: Doc.版本[])');
   expect(formatRef('One [draft]', list, 0)).toBe('[One \\[draft\\]](items[0])');
   expect(formatRef('Name', ref('文件-1', null, { schema: Type.Null(), scope: 'protected' }))).toBe('[Name](protected ["文件-1"]: null)');
   expect(formatRef('Empty', arrayRef('items', [], { schema: Type.Array(Type.String()), scope: 'protected' }))).toBe('[Empty](protected items: string[])');
   expect(() => formatRef('Missing', list, 1)).toThrow(expect.objectContaining({
     code: 'SNAPSHOT_INVALID', path: 'Ref items', message: expect.stringContaining('index'),
   }));
 });
 it('rejects duplicate typed publishers without replacing the first owner',async()=>{
   function Publisher(){useDataRef('current_plan',{id:'one'},{ schema: Type.Object({}), scope: 'protected',refType:'Plan'});return null;}
   const x=setup(()=>h('section',{},[h(Publisher,{key:'one'}),h(Publisher,{key:'two'})]));
   try{await expect(x.open()).rejects.toMatchObject({code:'REF_ALREADY_REGISTERED'});expect(preparedRefs(x.kernel)).toEqual([]);}finally{await x.close();}
 });
 it('rejects same local ID even when publishers use different display types',async()=>{
   function PlanPublisher(){useDataRef('selected',{id:'one'},{ schema: Type.Object({}), scope: 'protected',refType:'Plan'});return null;}
   function PhasePublisher(){useDataRef('selected',{id:'two'},{ schema: Type.Object({}), scope: 'protected',refType:'Phase'});return null;}
   const x=setup(()=>h('section',{},[h(PlanPublisher,{}),h(PhasePublisher,{})]));
   try{await expect(x.open()).rejects.toMatchObject({code:'REF_ALREADY_REGISTERED'});expect(preparedRefs(x.kernel)).toEqual([]);}finally{await x.close();}
 });
 it('does not let a typed publisher cleanup delete a successor with the same full ID',async()=>{
   let show!:(id: string | null)=>void;
   function Publisher({id}: {id: string}){useDataRef('current_plan',{id},{ schema: Type.Object({}), scope: 'protected',refType:'Plan'});return null;}
   function Content(){const [id,set]=useState<string | null>('first');show=set;return id === null ? null : h(Publisher,{id,key:id});}
   const x=setup(Content);
   try{
     await x.open();
     const instance = mountedViews(x.kernel)[0]!.viewInstanceId;
     await act(() => show('successor'));
     expect(preparedRefs(x.kernel)).toEqual([{viewId:'detail_1',refId:'current_plan',refType:'Plan',value:{id:'successor'}}]);
     expect(mountedViews(x.kernel)[0]!.viewInstanceId).toBe(instance);
     await act(() => show(null));
     expect(preparedRefs(x.kernel)).toEqual([]);
   }finally{await x.close();}
 });
 it.each(['', '   ', 'Plan)', 'Type:Plan', 42, null])('rejects invalid explicit refType %s',async refType=>{
   const x=setup(()=>{useDataRef('current_plan',{id:'one'},{ schema: Type.Object({}), scope: 'protected', refType } as any);return null;});
   try {
     await expect(x.open()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'Ref current_plan' });
     expect(preparedRefs(x.kernel)).toEqual([]);
   } finally { await x.close(); }
 });
 it.each([null,42,false,'',[],['one']].map(value => [value]))('captures typed JSON payload %j',async value=>{
   const x=setup(()=>{useDataRef('current_plan',value,{ schema: Type.Union([Type.Null(), Type.Number(), Type.Boolean(), Type.String(), Type.Array(Type.String())]), scope: 'protected',refType:'Plan'});return null;});
   try{await x.open();expect(preparedRefs(x.kernel)[0]?.value).toEqual(value);}finally{await x.close();}
 });
 it('leaves empty/wrong type and unsupported Schema diagnostics to existing declaration capture',()=>{
   for(const [type,value,code] of [['',schema,'TOOL_SCHEMA_INVALID'],[42,schema,'TOOL_SCHEMA_INVALID'],['Plan',Type.String({ pattern: '^a' }),'TOOL_SCHEMA_UNSUPPORTED']] as const){
     expect(()=>define(refParam(type as any,value))).toThrow(expect.objectContaining({code}));
   }
 });
 it('does not evaluate a business Schema getter in the helper or existing safe exporter',()=>{
   let reads=0;const getterSchema=Object.create(null);Object.defineProperty(getterSchema,'type',{enumerable:true,get(){reads++;throw new Error('probe-sentinel');}});
   const parameter=refParam('Plan',getterSchema);expect(reads).toBe(0);
   expect(()=>define(parameter)).toThrow(expect.objectContaining({code:'TOOL_SCHEMA_INVALID'}));expect(reads).toBe(0);
 });
 it('rejects a pattern in the Ref target Schema at Tool declaration', () => {
   const value = Type.Object({ title: Type.String({ pattern: '^plan$' }) });
   expect(() => define(refParam('Plan', value))).toThrow(expect.objectContaining({
     code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.plan["x-aotui-ref-value"].properties.title.pattern',
   }));
 });
 it('rejects a pattern in the Ref source Schema before registering a value', async () => {
   const value = Type.Array(Type.String({ pattern: '^plan$' }));
   const x = setup(() => { useDataRef('plans', ['plan'], { scope: 'protected', schema: value }); return null; });
   try {
     await expect(x.open()).rejects.toMatchObject({ code: 'TOOL_SCHEMA_UNSUPPORTED', path: 'Ref plans.schema.items.pattern' });
     expect(preparedRefs(x.kernel)).toEqual([]);
   } finally { await x.close(); }
 });
 it('reports a standalone Ref schema copy limit at publication without registering the value', async () => {
   const schema = Type.Array(Type.Number(), { default: Array(3_000).fill(0) });
   const x = setup(() => { useDataRef('values', [], { scope: 'protected', refType: 'Numbers', schema }); return null; });
   try {
     await expect(x.open()).rejects.toMatchObject({ code: 'TOOL_SCHEMA_CAPACITY', path: expect.stringContaining('default') });
     expect(preparedRefs(x.kernel)).toEqual([]);
   } finally { await x.close(); }
 });
 it('checks whole-array constraints on untyped input at publication', async () => {
   const options = { scope: 'protected' as const, itemType: 'Plan', schema: Type.Array(schema, { minItems: 1 }) };
   const x = setup(() => { useArrayRef('plans', JSON.parse('[]'), options); return null; });
   try {
     await x.open();
     const projection = x.kernel.getProjectionCoordinator();
     expect(projection.nextPublication()).toMatchObject({
       failure: { issue: { code: 'SNAPSHOT_INVALID', path: 'Ref detail.plans $' } },
     });
     expect(preparedRefs(x.kernel)).toEqual([]);
   } finally { await x.close(); }
 });
 it('captures arrays of Ref names and preserves exact resolved value witnesses',()=>{
   const input=Type.Object({plans:Type.Array(refParam('Plan',schema),{maxItems:3}),
     optional:Type.Optional(refParam('Plan',schema))},{additionalProperties:false});
   const tool=defineViewType<object>()({ multiplicity: 'multiple', name:'Plan',tools:{choose:{description:'Choose Plans',inputSchema:input,execute:()=>({success:true})}}}).tools.choose;
   const compiled=compileToolParameters(tool.inputSchema);
   expect(compiled.ok).toBe(true);if(!compiled.ok)throw Error('contract');
   expect(compiled.contract.validateResolvedInput({plans:[{id:'a',title:'A'},{id:'b',title:'B'}]}).ok).toBe(true);
   expect(Object.isFrozen(tool.inputSchema)).toBe(true);
   expect(()=>define(Type.Array(refParam(' ',schema)))).toThrow(expect.objectContaining({code:'TOOL_SCHEMA_INVALID'}));
 });

 it('requires Ref root shapes and matching payloads across plain and Preact publication', async () => {
   const numSchema = Type.Number();
   const listSchema = Type.Array(Type.Integer(), { minItems: 1 });
   const openUnion = Type.Union([Type.Object({ email: Type.String() }), Type.Unknown()]);
   const unionIssue = { code: 'TOOL_SCHEMA_INVALID', path: 'Ref broad_contact.schema.anyOf[1]' };

   expect(() => define(refParam('Contact', openUnion))).toThrow(expect.objectContaining({
     ...unionIssue, path: '$.properties.plan["x-aotui-ref-value"].anyOf[1]',
   }));

   const runPlain = async (publish: () => unknown[]) => {
     const factory = createApp({
       app_name: 'plain_ref_check',
       viewTypes: [Detail],
       initialize({ prepareProjection }) {
         prepareProjection({
           views: [createView(Detail, { idPrefix: 'detail', region: 'dynamic', render: () => ({ body: 'ok', refs: publish() as any }) })],
         });
       },
     });
     const kernel = new AppKernel({
       factory,
       appId: createAppId('app'),
       desktopId: createDesktopId('desktop'),
       instanceId: 'plain-ref-validation',
       projectionLimits: DEFAULT_PROJECTION_LIMITS,
     });
     try {
       await kernel.onOpen();
       return kernel.getProjectionCoordinator().nextPublication();
     } finally {
       await kernel.onClose();
     }
   };

   await expect(runPlain(() => [ref('bad', 'x' as any, { scope: 'protected', schema: Type.Unknown() })]))
     .rejects.toMatchObject({ code: 'TOOL_SCHEMA_INVALID' });
   await expect(runPlain(() => [ref('broad_contact', 17, { scope: 'protected', schema: openUnion })]))
     .rejects.toMatchObject(unionIssue);
   await expect(runPlain(() => [ref('mismatch', 'text' as any, { scope: 'protected', schema: numSchema })]))
     .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
   await expect(runPlain(() => [arrayRef('bad_list', [1], { scope: 'protected', schema: Type.Unknown() as any })]))
     .rejects.toMatchObject({ code: 'TOOL_SCHEMA_INVALID' });
   await expect(runPlain(() => [ref('omitted', 'anything', { scope: 'protected' } as any)]))
     .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'Ref omitted.schema' });
   const validPlain = await runPlain(() => [
     ref('ok', 42, { scope: 'protected', schema: numSchema }),
     arrayRef('ok_list', [1, 2], { scope: 'protected', schema: listSchema }),
   ]);
   expect('draft' in validPlain).toBe(true);
   if (!('draft' in validPlain)) throw new Error('Expected prepared draft');
   const plainRefs = Object.values(validPlain.draft.refs) as Array<Record<string, any>>;
   expect(plainRefs.find(item => item.id === 'ok')).toMatchObject({
     id: 'ok',
     target: { kind: 'snapshot-value', payload: 42 },
     valueSchema: { type: 'number' },
   });
   expect(plainRefs.find(item => item.id === 'ok_list')).toMatchObject({
     id: 'ok_list',
     array: true,
     target: { kind: 'snapshot-value', payload: [1, 2] },
     valueSchema: { type: 'array', items: { type: 'integer' }, minItems: 1 },
   });

   const emptyHook = setup(() => { useDataRef('bad', 'x' as any, { scope: 'protected', schema: Type.Unknown() }); return null; });
   try {
     await expect(emptyHook.open()).rejects.toMatchObject({ code: 'TOOL_SCHEMA_INVALID' });
     expect(preparedRefs(emptyHook.kernel)).toEqual([]);
   } finally { await emptyHook.close(); }

   const unionHook = setup(() => { useDataRef('broad_contact', 17, { scope: 'protected', schema: openUnion }); return null; });
   try {
     await expect(unionHook.open()).rejects.toMatchObject(unionIssue);
     expect(preparedRefs(unionHook.kernel)).toEqual([]);
   } finally { await unionHook.close(); }

   const mismatchHook = setup(() => { useDataRef('mismatch', 'text' as any, { scope: 'protected', schema: numSchema }); return null; });
   try {
     await mismatchHook.open();
     expect(mismatchHook.kernel.getProjectionCoordinator().nextPublication()).toMatchObject({
       failure: { issue: { code: 'SNAPSHOT_INVALID', path: 'Ref detail.mismatch $' } },
     });
     expect(preparedRefs(mismatchHook.kernel)).toEqual([]);
   } finally { await mismatchHook.close(); }

   const validHook = setup(() => {
     useDataRef('ok', 42, { scope: 'protected', schema: numSchema });
     useArrayRef('ok_list', [1], { scope: 'protected', schema: listSchema });
     return null;
   });
   try {
     await validHook.open();
     expect(preparedRefs(validHook.kernel).map(({ refId, value }) => ({ refId, value }))).toEqual([
       { refId: 'ok', value: 42 },
       { refId: 'ok_list', value: [1] },
     ]);
   } finally { await validHook.close(); }
 });
});
