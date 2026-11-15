import Type from 'typebox';
import { View, createTUIApp, defineViewType, refParam } from '../src/index.js';
import { createApp, createView, type ViewHandle } from '../src/app.js';

const Detail = defineViewType({ name:'Detail', tools:{
    use: { description:'Use a ref',
        inputSchema:Type.Object({ selected:refParam('Item',Type.Object({ id:Type.String() })),
            many:Type.Optional(Type.Array(refParam('Item',Type.Object({ name:Type.String() })))) }) },
} });
const Empty = defineViewType({ name:'Empty', tools:{} });

const detail = createView(Detail,{id:'one',kind:'state',render:() => ({body:'Rows',bindings:{
    use:{ execute({ selected, many }) {
        const id: string = selected.id;
        const name: string | undefined = many?.[0]?.name;
        // @ts-expect-error Observed values are deeply readonly
        selected.id = 'new';
        // @ts-expect-error Resolved optional Ref arrays are readonly
        many?.push({name:'another'});
        return {success:true,data:{id,name:name ?? ''}};
    } },
}})});
const empty = createView(Empty,{id:'empty',kind:'instruction',render:() => ({body:'Hello'})});
const views: readonly ViewHandle[] = [detail,empty];
export const plain = createApp({app_name:'plain',viewTypes:[Detail,Empty],initialize({publish}) {
    const ready: 'prepared' = publish({views}).status;
    void ready;
    // @ts-expect-error No App-wide binding map
    publish({views,bindings:{}});
}});
export const preact = createTUIApp({app_name:'preact',viewTypes:[Detail,Empty],component:() =>
    <View id="b" kind="state" type={Detail} bindings={{use:{execute(args) {
        const id: string = args.selected.id;
        // @ts-expect-error The framework-only receiver is not a business argument
        const view_id = args.view_id;
        return {success:true,data:{id}};
    }}}}/>});
export const noTools = <View id="empty" kind="instruction" type={Empty}/>;
// @ts-expect-error Bindings are required for a type with Tools
export const missing = <View id="x" type={Detail} kind="state"/>;
// @ts-expect-error Unknown binding
export const extra = <View id="x" type={Detail} kind="state" bindings={{use:{execute:() => ({success:true})},extra:{execute:() => ({success:true})}}}/>;
// @ts-expect-error A View uses a descriptor
export const legacy = <View id="x" type="Detail" kind="state"/>;
// @ts-expect-error Static Tool declarations do not contain handlers
defineViewType({name:'Invalid',tools:{change:{description:'Modify state',inputSchema:Type.Object({}),execute(){ return {success:true}; }}}});
