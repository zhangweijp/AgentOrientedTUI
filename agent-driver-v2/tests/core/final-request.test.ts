import { afterEach, expect, it, vi } from 'vitest';
import { jsonSchema, type ModelMessage } from 'ai';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import { LLMClient } from '../../src/core/llm-client.js';
import type { ContextDrivenSource, DrivenSourceContext, LLMConfig } from '../../src/core/interfaces.js';

const messages = [{ role: 'user' as const, content: 'Check the current context.' }];
const schema = { type: 'object' as const, properties: { value: {type:'string' as const} }, required: ['value'], additionalProperties: false };
const tools = { apply: {inputSchema: jsonSchema(schema)} };
const chat: LLMConfig = { model: 'fixture', apiKey: 'test-only', provider: { id: 'compatible', baseURL: 'https://fixture.invalid/v1' } };
const limits = {contextWindow: 20000, maxOutputTokens: 256};
function frames(values: object[]) {
    return new Response(values.map(value => 'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n',
        {headers:{'content-type':'text/event-stream'}});
}
function chatReply(toolName?: string) {
    return frames([{id:'fixture',model:chat.model,created:1,choices:[{index:0,
        delta:toolName ? {tool_calls:[{index:0,type:'function',id:'call',function:{name:toolName,arguments:'{"value":"ok"}'}}]} : {content:'Done'},
        finish_reason:toolName?'tool_calls':'stop'}]}]);
}
function googleReply() {
    return frames([{candidates:[{content:{role:'model',parts:[{text:'Done'}]},finishReason:'STOP'}]}]);
}
function source(name: string, context: Partial<DrivenSourceContext> = {}) {
    const adopt = vi.fn(), release = vi.fn();
    const executeTool = vi.fn(async (toolName: string, _args: unknown, toolCallId: string) =>
        ({toolName,toolCallId,result:{owner:name}}));
    const captured: DrivenSourceContext = {messages:[{role:'user',content:name,timestamp:1,region:'dynamic'}],
        tools:{[name]:{inputSchema:jsonSchema(schema)}},adopt,release,executeTool,...context};
    const value: ContextDrivenSource = {name, getContext: vi.fn(async ()=>captured), onUpdate:()=>()=>{}};
    return {value,captured,adopt,release,executeTool};
}
const drivers: AgentDriverV2[] = [];
afterEach(() => { for(const driver of drivers.splice(0)) driver.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function driver(sources: ContextDrivenSource[], llm: LLMConfig = chat) {
    const onRunError=vi.fn(), onAssistantMessage=vi.fn(), onToolResult=vi.fn();
    const d=new AgentDriverV2({sources,llm,onRunError,onAssistantMessage,onToolResult});
    drivers.push(d);
    return {d,onRunError,onAssistantMessage,onToolResult,run:async()=>{await d.trigger();await d['runInFlight'];}};
}

it('C2-T01 adopts exactly the management context whose actual tools are sent and routed', async () => {
    const a=source('first',{managementOnly:true}), b=source('second',{managementOnly:true}), other=source('other');
    const fetch=vi.fn(async (_url: string, init:RequestInit)=> {
        expect(JSON.parse(String(init.body)).tools.map((tool:any)=>tool.function.name)).toEqual(['first']);
        return chatReply('first');
    });
    vi.stubGlobal('fetch',fetch);
    const f=driver([a.value,b.value,other.value]);
    await f.run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(a.adopt).toHaveBeenCalledOnce();
    expect(b.adopt).not.toHaveBeenCalled();
    expect(other.adopt).not.toHaveBeenCalled();
    expect(a.executeTool).toHaveBeenCalledOnce();
    expect(b.executeTool).not.toHaveBeenCalled();
    expect(other.executeTool).not.toHaveBeenCalled();
    for (const s of [a,b,other]) expect(s.release).toHaveBeenCalledOnce();
    expect(f.onRunError).not.toHaveBeenCalled();
});

it.each([false,true])('C2-T05 rejects the real Google mixed function/search encoder omission (budget=%s)', async budget=>{
    const llm: LLMConfig = { model:'gemini-2.5-flash',apiKey:'test-only',provider:{id:'google',baseURL:'https://google.invalid/v1beta'},
        ...(budget?{inputBudget:()=>limits}:{}) };
    const fetch=vi.fn(async()=>googleReply()), adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    const client=new LLMClient(llm);
    const openSchema={type:'object' as const,properties:{value:{type:'string' as const}},required:['value']};
    await expect(client.call(messages,{apply:{inputSchema:jsonSchema(openSchema)},google_search:google.tools.googleSearch({})},
        {beforeRequest:adopt,preserveTools:true})).rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',path:expect.any(String)});
    expect(adopt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

const strictChat: LLMConfig = {...chat, provider:{id:'openai',baseURL:'https://fixture.invalid/v1',toolSchemaMode:'strict'}};
const googleConfig: LLMConfig = {model:'gemini-2.5-flash',apiKey:'test-only',provider:{id:'google',baseURL:'https://google.invalid/v1beta'}};
const callPart = (id: string) => ({type:'tool-call' as const,toolCallId:id,toolName:'historical',input:{}});
const resultPart = (id: string) => ({type:'tool-result' as const,toolCallId:id,toolName:'historical',output:{type:'text' as const,value:'old-result-'+id}});

it('C2-T02 preserves only recovery history from nonselected sources, without their schema/protection policy',async()=>{
    const first=source('directory',{managementOnly:true,preserveTools:false});
    const hidden=source('hidden',{managementOnly:true,preserveTools:true,
        tools:{hidden:{inputSchema:jsonSchema({type:'object',properties:{optional:{type:'string'}},additionalProperties:false})}},
        messages:[
            {role:'system',content:'system instruction',timestamp:1,region:'static'},
            {role:'user',content:'old user',timestamp:2},
            {role:'assistant',content:[callPart('a'),callPart('b')],timestamp:3},
            {role:'tool',content:[resultPart('a'),resultPart('b')],timestamp:4},
            {role:'user',content:'last user',timestamp:5},
            {role:'user',content:'UNSELECTED PRIVATE VIEW',timestamp:6,region:'dynamic'},
            {role:'system',content:'UNSELECTED DYNAMIC SYSTEM VIEW',timestamp:7,region:'dynamic'},
        ]});
    const call=vi.spyOn(LLMClient.prototype,'call');
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        const body=JSON.parse(String(init.body)), text=JSON.stringify(body.messages);
        expect(body.tools.map((tool:any)=>tool.function.name)).toEqual(['directory']);
        for(const value of ['system instruction','last user','old-result-a','old-result-b','directory']) expect(text).toContain(value);
        for(const value of ['old user','UNSELECTED PRIVATE VIEW','UNSELECTED DYNAMIC SYSTEM VIEW']) expect(text).not.toContain(value);
        expect(body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.tool_call_id)).toEqual(['a','b']);
        return chatReply('directory');
    });
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value,hidden.value],strictChat);
    await f.run();
    expect(call.mock.calls[0]?.[2]?.preserveTools).toBe(false);
    expect(f.onRunError).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(first.adopt).toHaveBeenCalledOnce();
    expect(hidden.adopt).not.toHaveBeenCalled();
    expect(hidden.executeTool).not.toHaveBeenCalled();
    expect(first.executeTool).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(hidden.release).toHaveBeenCalledOnce();
});

it('C2-T02 does not keep an incomplete tool-call pair during recovery',async()=>{
    const first=source('directory',{managementOnly:true});
    const hidden=source('hidden',{messages:[
        {role:'assistant',content:[callPart('a'),callPart('b')],timestamp:1},
        {role:'tool',content:[resultPart('a')],timestamp:2},
        {role:'user',content:'latest user',timestamp:3},
    ]});
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        const body=JSON.parse(String(init.body));
        expect(JSON.stringify(body.messages)).toContain('latest user');
        expect(body.messages.some((m:any)=>m.role==='tool'||m.tool_calls)).toBe(false);
        return chatReply();
    });
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value,hidden.value]);
    await f.run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(hidden.adopt).not.toHaveBeenCalled();
    expect(hidden.release).toHaveBeenCalledOnce();
    expect(f.onRunError).not.toHaveBeenCalled();
});

it('C2-T02 adopts all normal selected sources, including an observation with no tools',async()=>{
    const first=source('first'), second=source('second',{tools:{},preserveTools:true});
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(first.adopt).toHaveBeenCalledOnce();
        expect(second.adopt).toHaveBeenCalledOnce();
        expect(JSON.parse(String(init.body)).tools.map((t:any)=>t.function.name)).toEqual(['first']);
        expect(String(init.body)).toContain('second');
        return chatReply('first');
    });
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value,second.value]);
    await f.run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.onRunError).not.toHaveBeenCalled();
    expect(first.executeTool).toHaveBeenCalledOnce();
    for(const s of [first,second]) expect(s.release).toHaveBeenCalledOnce();
});

it('C2-T02 rejects a route collision that would leave a wider adopted grant',async()=>{
    const first=source('first',{tools,preserveTools:true}),second=source('second',{tools,preserveTools:true});
    const fetch=vi.fn(async()=>chatReply());
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value,second.value]);
    await f.run();
    expect(f.onRunError).toHaveBeenCalledWith(expect.objectContaining({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'apply',path:'$.tools'}));
    expect(fetch).not.toHaveBeenCalled();
    for(const s of [first,second]) {
        expect(s.adopt).not.toHaveBeenCalled();
        expect(s.release).toHaveBeenCalledOnce();
    }
});

it('C2-T02 does not conceal a capture error just because an earlier management context was selected',async()=>{
    const first=source('directory',{managementOnly:true}), second=source('failed');
    const error=new Error('capture failed');
    vi.mocked(second.value.getContext).mockRejectedValueOnce(error);
    const fetch=vi.fn(async()=>chatReply());
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value,second.value]);
    await f.run();
    expect(f.onRunError.mock.calls[0]?.[0]).toBe(error);
    expect(first.adopt).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
});

it('C2-T02 capability filtering cannot send a narrower list while adopting an original wider context',async()=>{
    const first=source('first');
    const fetch=vi.fn(async()=>chatReply());
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value],{...chat,modelCapabilities:{toolCall:false}});
    await f.run();
    expect(f.onRunError).toHaveBeenCalledWith(expect.objectContaining({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'first'}));
    expect(first.adopt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledOnce();
});

it('C2-T03 checks each candidate with its own selection and adopts/dispatches the final fit context',async()=>{
    const initial=source('initial'), other=source('other',{preserveTools:true});
    const final=source('final',{managementOnly:true,preserveTools:false});
    const fetched: string[]=[];
    const trials: string[]=[];
    // Observe the actual encoder inputs at its transport seam, both trials and real send.
    const encode = LLMClient.prototype['createProvider'];
    vi.spyOn(LLMClient.prototype as any,'createProvider').mockImplementation(function(this:LLMClient,chatFetch?:typeof fetch,httpFetch?:typeof fetch){
        const tap=(send:typeof fetch|undefined):typeof fetch|undefined=>send && ((url,init)=>{
            trials.push(String(init?.body));
            return send(url,init);
        });
        return encode.call(this,tap(chatFetch),tap(httpFetch));
    });
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        fetched.push(String(init.body));
        expect(final.adopt).toHaveBeenCalledOnce();
        expect(initial.adopt).not.toHaveBeenCalled();
        expect(other.adopt).not.toHaveBeenCalled();
        return chatReply('final');
    });
    vi.stubGlobal('fetch',fetch);
    let measuredBytes=0;
    const adoption=final.captured.adopt!;
    final.captured.adopt=function(){
        expect(this).toBe(final.captured);
        return adoption();
    };
    const execute=final.captured.executeTool!;
    final.captured.executeTool=function(...args:Parameters<typeof execute>){
        expect(this).toBe(final.captured);
        return execute(...args);
    };
    initial.captured.fitModelBudget=async measure=>{
        const first=await measure(initial.captured);
        expect(first.inputBytes).toBeGreaterThan(0);
        const next=await measure(final.captured);
        measuredBytes=next.inputBytes;
        expect(fetch).not.toHaveBeenCalled();
        expect(final.adopt).not.toHaveBeenCalled();
        expect(initial.adopt).not.toHaveBeenCalled();
        expect(other.adopt).not.toHaveBeenCalled();
        return {measurement:next,context:final.captured};
    };
    const f=driver([initial.value,other.value],{...chat,inputBudget:()=>limits});
    await f.run();
    expect(f.onRunError).not.toHaveBeenCalled();
    expect(trials).toHaveLength(3);
    expect(trials.map(value=>JSON.parse(value).tools.map((tool:any)=>tool.function.name))).toEqual([['initial','other'],['final'],['final']]);
    expect(fetched).toEqual([trials[1]]);
    expect(Buffer.byteLength(fetched[0]!)).toBe(measuredBytes);
    expect(JSON.stringify(JSON.parse(fetched[0]!).messages)).not.toMatch(/initial|other/);
    expect(final.executeTool).toHaveBeenCalledOnce();
    expect(initial.executeTool).not.toHaveBeenCalled();
    expect(other.executeTool).not.toHaveBeenCalled();
    expect(initial.release).toHaveBeenCalledOnce();
    expect(other.release).toHaveBeenCalledOnce();
    expect(final.release).not.toHaveBeenCalled(); // the initial capture owns the entire fit scope
});

type WireMutation = (body: any, attempt: number) => void;
function injectEncodedMutation(mutate:WireMutation) {
    const create=LLMClient.prototype['createProvider'];
    let attempt=0;
    vi.spyOn(LLMClient.prototype as any,'createProvider').mockImplementation(function(this:LLMClient,chatFetch?:typeof fetch,httpFetch?:typeof fetch){
        const wrap=(send:typeof fetch|undefined):typeof fetch|undefined=>send && ((url,init)=>{
            const body=JSON.parse(String(init?.body));
            mutate(body,++attempt);
            return send(url,{...init,body:JSON.stringify(body)});
        });
        return create.call(this,wrap(chatFetch),wrap(httpFetch));
    });
}

const wireFaults: [string,WireMutation,string,string][]=[
    ['missing',body=>{body.tools=[];},'apply','$.tools'],
    ['extra',body=>{body.tools.push({type:'function',function:{...body.tools[0].function,name:'extra'}});},'extra','$.tools'],
    ['same-count rename',body=>{body.tools[0].function.name='renamed';},'renamed','$.tools'],
    ['duplicate',body=>{body.tools.push(body.tools[0]);},'apply','$.tools'],
    ['field presence',body=>{body.tools[0].function.parameters.required=[];},'apply','$.required'],
    ['field type',body=>{body.tools[0].function.parameters.properties.value.type='integer';},'apply','$.properties.value.type'],
    ['object relaxation',body=>{delete body.tools[0].function.parameters.additionalProperties;},'apply','$.additionalProperties'],
    ['unreachable',body=>{body.tool_choice='none';},'request','$.tool_choice'],
];
for(const [label,mutate,tool,path] of wireFaults) {
    it.each([false,true])('C2-T04 rejects '+label+' from the actual encoded list before adopting or sending (budget=%s)',async budget=>{
        injectEncodedMutation(mutate);
        const captured=source('source',{tools,preserveTools:true});
        const fetch=vi.fn(async()=>chatReply());
        vi.stubGlobal('fetch',fetch);
        const f=driver([captured.value],{...strictChat,...(budget?{inputBudget:()=>limits}:{})});
        await f.run();
        expect(f.onRunError).toHaveBeenCalledOnce();
        expect(f.onRunError).toHaveBeenCalledWith(expect.objectContaining({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool,path}));
        expect(captured.adopt).not.toHaveBeenCalled();
        expect(captured.executeTool).not.toHaveBeenCalled();
        expect(captured.release).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    });
}

it('C2-T04 checks local trial encoding without adoption or network traffic',async()=>{
    injectEncodedMutation(body=>{body.tools=[];});
    const fetch=vi.fn(async()=>chatReply());
    vi.stubGlobal('fetch',fetch);
    const measure=await new LLMClient({...chat,inputBudget:()=>limits}).createInputMeasurement();
    await expect(measure!(messages,tools,true)).rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'apply',path:'$.tools'});
    expect(fetch).not.toHaveBeenCalled();
});

it('C2-T04 no-budget inline media still reaches the real encoder; budgeted media remains rejected',async()=>{
    const input:ModelMessage[]=[{role:'user',content:[{type:'text',text:'Look'},{type:'image',image:new Uint8Array([137,80,78,71,13,10,26,10]),mediaType:'image/png'}]}];
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(String(init.body)).toContain('data:image/png;base64,');
        return chatReply();
    }),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await new LLMClient(chat).call(input,tools,{beforeRequest:adopt});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
    await expect(new LLMClient({...chat,inputBudget:()=>limits}).call(input,tools,{beforeRequest:adopt}))
        .rejects.toMatchObject({code:'MODEL_INPUT_UNMEASURABLE'});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
});

it.each([false,true])('C2-T05 retains a supported native Google search in the actual wire body (budget=%s)',async budget=>{
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(JSON.parse(String(init.body)).tools).toEqual([{googleSearch:{}}]);
        return googleReply();
    }),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await new LLMClient({...googleConfig,...(budget?{inputBudget:()=>limits}:{})})
        .call(messages,{google_search:google.tools.googleSearch({})},{beforeRequest:adopt,preserveTools:true});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
});

it('C2-T06 accepts only schema-node annotation/key-order changes and const to singleton enum',async()=>{
    const declaration={type:'object' as const,properties:{value:{type:'string' as const,const:'yes',description:'label'}},required:['value']};
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(JSON.parse(String(init.body)).tools[0].functionDeclarations[0].parameters.properties.value.enum).toEqual(['yes']);
        return googleReply();
    }),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    // Actual installed Google OpenAPI encoder converts const to enum.
    await new LLMClient(googleConfig).call(messages,{apply:{inputSchema:jsonSchema(declaration)}},{beforeRequest:adopt,preserveTools:true});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();

    injectEncodedMutation(body=>{
        const fn=body.tools[0].function, original=fn.parameters;
        fn.parameters={required:original.required,properties:{value:{description:'renamed annotation',type:'string'}},
            additionalProperties:false,type:'object'};
    });
    const chatFetch=vi.fn(async()=>chatReply());
    vi.stubGlobal('fetch',chatFetch);
    await new LLMClient(strictChat).call(messages,tools,{beforeRequest:adopt,preserveTools:true});
    expect(chatFetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledTimes(2);
});

it.each([
    ['enum', (body:any)=>{delete body.tools[0].function.parameters.properties.value.enum[0].description;}],
    ['default', (body:any)=>{body.tools[0].function.parameters.properties.value.default.const='other';}],
] as const)('C2-T06 treats business %s JSON as opaque data, not schema nodes',async (field,mutate)=>{
    const value={const:'literal',description:'business',additionalProperties:false};
    const declaration={type:'object' as const,properties:{value:{type:'object' as const,enum:[value],default:value}}};
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(JSON.parse(String(init.body)).tools[0].function.parameters.properties.value).toEqual(declaration.properties.value);
        return chatReply();
    }),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    const input={apply:{inputSchema:jsonSchema(declaration)}};
    await new LLMClient(chat).call(messages,input,{beforeRequest:adopt,preserveTools:true});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
    injectEncodedMutation(mutate);
    await expect(new LLMClient(chat).call(messages,input,{beforeRequest:adopt,preserveTools:true}))
        .rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'apply',path:'$.properties.value.'+field});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
});

it.each([
    ['pattern',{type:'string',pattern:'^literal$'},(body:any)=>{delete body.tools[0].function.parameters.properties.value.pattern;},'$.properties.value.pattern'],
    ['tuple',{type:'array',prefixItems:[{type:'string'},{type:'integer'}],items:false},(body:any)=>{const v=body.tools[0].function.parameters.properties.value;delete v.prefixItems;v.items={};},'$.properties.value.prefixItems'],
    ['optional to nullable',{type:'string'},(body:any)=>{const v=body.tools[0].function.parameters;v.required=['value'];v.properties.value={anyOf:[{type:'string'},{type:'null'}]};},'$.properties.value.type'],
] as const)('C2-T06 rejects unapproved %s lowering',async(_label,value,mutate,path)=>{
    injectEncodedMutation(mutate);
    const fetch=vi.fn(async()=>chatReply()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    const input={apply:{inputSchema:jsonSchema({type:'object',properties:{value},additionalProperties:false} as any)}};
    await expect(new LLMClient(chat).call(messages,input,{beforeRequest:adopt,preserveTools:true}))
        .rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'apply',path});
    expect(adopt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

it('C2-T06 rejects a real Google omission of the open-object parameter schema',async()=>{
    const fetch=vi.fn(async()=>googleReply()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await expect(new LLMClient(googleConfig).call(messages,{apply:{inputSchema:jsonSchema({type:'object'})}},{beforeRequest:adopt}))
        .rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'apply',path:'$'});
    expect(adopt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

it('C2-T08 preserves the original partial-adoption fact and error while suppressing the actual send',async()=>{
    const first=source('first'),second=source('second'),third=source('third');
    const events:string[]=[];
    const failure=new Error('second adoption rejected');
    first.adopt.mockImplementation(()=>{events.push('adopt:first');});
    second.adopt.mockImplementation(()=>{events.push('adopt:second');throw failure;});
    for(const s of [first,second,third]) s.release.mockImplementation(()=>{events.push('release:'+s.value.name);});
    const fetch=vi.fn(async()=>chatReply());
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value,second.value,third.value]);
    await f.run();
    expect(f.onRunError.mock.calls[0]?.[0]).toBe(failure);
    expect(events).toEqual(['adopt:first','adopt:second','release:third','release:second','release:first']);
    expect(third.adopt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.onAssistantMessage).not.toHaveBeenCalled();
});

function deferred() {
    let resolve!:()=>void;
    const promise=new Promise<void>(done=>{resolve=done;});
    return {promise,resolve};
}

it.each([false,true])('C2-T09 blocks pre-encoding cancellation even if the real provider discards the signal (budget=%s)',async budget=>{
    const entered=deferred(),proceed=deferred(),exited=deferred();
    const create=LLMClient.prototype['createProvider'];
    const seam=vi.spyOn(LLMClient.prototype as any,'createProvider').mockImplementation(function(this:LLMClient,...args:Parameters<typeof create>){
        const provider=create.apply(this,args);
        const doStream=provider.doStream.bind(provider);
        vi.spyOn(provider,'doStream').mockImplementation(async params=>{
            entered.resolve();
            await proceed.promise;
            try{return await doStream({...params,abortSignal:undefined});}
            finally{exited.resolve();}
        });
        return provider;
    });
    const first=source('first'),fetch=vi.fn(async()=>chatReply('first'));
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value],{...chat,...(budget?{inputBudget:()=>limits}:{})});
    await f.d.trigger();
    const work=f.d['runInFlight']!;
    await entered.promise;
    try {
        f.d.stop(); f.d.start();
        proceed.resolve();
        await exited.promise; await work;
        expect(seam).toHaveBeenCalledOnce();
        expect(first.adopt).not.toHaveBeenCalled();
        expect(first.release).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        expect(first.executeTool).not.toHaveBeenCalled();
        expect(f.onAssistantMessage).not.toHaveBeenCalled();
        expect(f.onToolResult).not.toHaveBeenCalled();
        expect(f.onRunError).not.toHaveBeenCalled();
    } finally {proceed.resolve();}
});

it.each([false,true])('C2-T09 checks a changed retry request without undoing its first adoption (budget=%s)',async budget=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const retry=deferred(),setTimeout=globalThis.setTimeout;
    vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:any,delay?:number,...args:any[])=>{
        if(delay===1370) retry.resolve();
        return setTimeout(fn,delay,...args);
    }) as typeof setTimeout);
    injectEncodedMutation((body,attempt)=>{if(attempt>1) body.messages[0].content='different logical request';});
    const first=source('first');
    const fetch=vi.fn(async()=>Response.json({error:{message:'temporary',type:'server_error'}},{status:503,headers:{'retry-after-ms':'1370'}}));
    vi.stubGlobal('fetch',fetch);
    const f=driver([first.value],{...chat,...(budget?{inputBudget:()=>limits}:{})});
    await f.d.trigger();
    const work=f.d['runInFlight']!;
    await retry.promise;
    expect(first.adopt).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1370);
    await work;
    expect(f.onRunError).toHaveBeenCalledWith(expect.objectContaining({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'request',path:'$'}));
    expect(first.adopt).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(first.executeTool).not.toHaveBeenCalled();
    expect(f.onAssistantMessage).not.toHaveBeenCalled();
});

const responsesConfig: LLMConfig={model:'gpt-5.4',apiKey:'test-only',provider:{id:'openai',baseURL:'https://api.openai.com/v1'}};
function responseItems(items:object[]) {
    return frames([...items.flatMap((item,output_index)=>[
        {type:'response.output_item.added',output_index,item},
        {type:'response.output_item.done',output_index,item},
    ]),{type:'response.completed',response:{usage:{input_tokens:11,output_tokens:7,total_tokens:18}}}]);
}
function responsesText() {
    return frames([
        {type:'response.output_item.added',output_index:0,item:{type:'message',id:'message-1'}},
        {type:'response.output_text.delta',item_id:'message-1',delta:'Done'},
        {type:'response.output_item.done',output_index:0,item:{type:'message',id:'message-1'}},
        {type:'response.completed',response:{usage:{input_tokens:11,output_tokens:7,total_tokens:18}}},
    ]);
}

it.each([['hosted',true],['hosted',false],['client',true],['client',false]] as const)('C2-T07 preserves Responses %s search and encoded history without extra Source dispatch (budget=%s)',async (mode,budget)=>{
    const config: LLMConfig={...responsesConfig,provider:{...responsesConfig.provider,
        openaiResponsesTools:{search:mode,deferredTools:['lookup'],additionalTools:['apply']}},...(budget?{inputBudget:()=>limits}:{})};
    const catalog={lookup:{description:'Lookup a record',inputSchema:jsonSchema(schema)},...tools};
    const lookup={type:'function',name:'lookup',description:'Lookup a record',parameters:schema,strict:false,defer_loading:true};
    const execution=mode==='hosted'?'server':'client';
    const searchCall={type:'tool_search_call',id:'ts_fixture',status:'completed',execution,
        call_id:mode==='hosted'?null:'call_search',arguments:mode==='hosted'?{paths:['lookup']}:{names:['lookup','not_available']}};
    const searchOutput={type:'tool_search_output',id:'tso_fixture',status:'completed',execution,call_id:null,tools:[lookup]};
    const wires:string[]=[];
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        wires.push(String(init.body));
        if(wires.length===1) return responseItems([searchCall,...(mode==='hosted'?[searchOutput]:[])]);
        return responsesText();
    }),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    const client=new LLMClient(config);
    const measure=await client.createInputMeasurement();
    const firstCost=await measure?.(messages,catalog,true);
    expect(fetch).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    const first=await client.call(messages,catalog,{beforeRequest:adopt,preserveTools:true});
    expect(first.toolCalls).toEqual([]); // search execution belongs to the SDK/provider, not Source
    expect(first.toolMessages?.length??0).toBe(mode==='client'?1:0);
    const wire=JSON.parse(wires[0]!);
    expect(wire.tools.find((t:any)=>t.type==='tool_search').execution).toBe(execution);
    expect(wire.tools.some((t:any)=>t.name==='lookup')).toBe(mode==='hosted');
    if(mode==='hosted') expect(wire.tools.find((t:any)=>t.name==='lookup')).toEqual(lookup);
    expect(wire.input.filter((item:any)=>item.type==='additional_tools').map((item:any)=>item.tools.map((t:any)=>t.name))).toEqual([['apply']]);
    if(budget) expect(firstCost?.inputBytes).toBe(Buffer.byteLength(wires[0]!));
    expect(adopt).toHaveBeenCalledOnce();

    const history:ModelMessage[]=[...messages,first.assistantMessage!,...(first.toolMessages??[]),{role:'user',content:'Continue'}];
    const secondCost=await measure?.(history,catalog,true);
    expect(fetch).toHaveBeenCalledOnce();
    const second=await client.call(history,catalog,{beforeRequest:adopt,preserveTools:true});
    expect(second.toolCalls).toEqual([]);
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    if(budget) expect(secondCost?.inputBytes).toBe(Buffer.byteLength(wires[1]!));
    const replay=JSON.parse(wires[1]!).input;
    const calls=replay.filter((item:any)=>item.type==='tool_search_call');
    const outputs=replay.filter((item:any)=>item.type==='tool_search_output');
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(calls[0]).toMatchObject({execution,call_id:searchCall.call_id});
    expect(outputs[0]).toMatchObject({execution,call_id:searchCall.call_id,tools:[lookup]});
    expect(replay.indexOf(calls[0])).toBeLessThan(replay.indexOf(outputs[0]));
    expect(replay.filter((item:any)=>item.type==='additional_tools')).toHaveLength(1);
});

it('C2-T07 verifies rewritten historical tool definitions, not just the pre-rewrite registration list',async()=>{
    const config: LLMConfig={...responsesConfig,provider:{...responsesConfig.provider,
        openaiResponsesTools:{search:'hosted',additionalTools:['apply']}},inputBudget:()=>limits};
    const past={type:'function',name:'apply',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false},strict:false};
    const history:ModelMessage[]=[...messages,{role:'assistant',content:[
        {type:'text',text:'',providerOptions:{openai:{aotuiToolsLoaded:[past]}}},
        {type:'text',text:'Earlier response'},
    ]},{role:'user',content:'Continue'}];
    const wires:string[]=[];
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{wires.push(String(init.body));return responsesText();}),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    const client=new LLMClient(config);
    const measure=(await client.createInputMeasurement())!;
    const cost=await measure(history,tools,true);
    await client.call(history,tools,{beforeRequest:adopt,preserveTools:true});
    expect(fetch).toHaveBeenCalledOnce();
    expect(cost.inputBytes).toBe(Buffer.byteLength(wires[0]!));
    expect(wires[0]).not.toContain('aotui_previous_');
    const groups=JSON.parse(wires[0]!).input.filter((item:any)=>item.type==='additional_tools');
    expect(groups.map((group:any)=>group.tools[0].parameters.properties.value.type)).toEqual(['integer','string']);
    expect(groups.map((group:any)=>group.tools[0].name)).toEqual(['apply','apply']);
    injectEncodedMutation(body=>{
        const older=body.input.find((item:any)=>item.type==='additional_tools'&&item.tools[0].name.startsWith('aotui_previous_'));
        expect(older).toBeDefined();
        older.tools[0].parameters.properties.value.type='boolean';
    });
    await expect(client.call(history,tools,{beforeRequest:adopt,preserveTools:true}))
        .rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'apply',path:'$.properties.value.type'});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
});

it('C2-T05 preserves a compatible Responses web search and function combination',async()=>{
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(JSON.parse(String(init.body)).tools).toEqual([
            expect.objectContaining({type:'function',name:'apply',parameters:schema}),
            expect.objectContaining({type:'web_search_preview'}),
        ]);
        return responsesText();
    }),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await new LLMClient(responsesConfig).call(messages,{...tools,web_search:openai.tools.webSearchPreview({})},{beforeRequest:adopt,preserveTools:true});
    expect(fetch).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
});

it('C2-T04 also checks the actual budgeted output limit before adopting',async()=>{
    injectEncodedMutation(body=>{body.max_tokens=limits.maxOutputTokens*2;});
    const fetch=vi.fn(async()=>chatReply()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await expect(new LLMClient({...chat,inputBudget:()=>limits}).call(messages,tools,{beforeRequest:adopt}))
        .rejects.toMatchObject({code:'MODEL_INPUT_UNMEASURABLE'});
    expect(adopt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

it('C2-T04 refuses an unselected function list outside the normal tools field',async()=>{
    injectEncodedMutation(body=>{body.functions=[{name:'hidden',parameters:{type:'object'}}];});
    const fetch=vi.fn(async()=>chatReply()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await expect(new LLMClient(chat).call(messages,tools,{beforeRequest:adopt}))
        .rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',path:'$.tools'});
    expect(fetch).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
});

it('C2-T07 refuses a current positioned tool definition moved before its intended input',async()=>{
    const config:LLMConfig={...responsesConfig,provider:{...responsesConfig.provider,openaiResponsesTools:{search:'hosted',additionalTools:['apply']}}};
    injectEncodedMutation(body=>{body.input.unshift(body.input.pop());});
    const fetch=vi.fn(async()=>responsesText()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await expect(new LLMClient(config).call(messages,tools,{beforeRequest:adopt}))
        .rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',path:'$.input'});
    expect(fetch).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
});

it('C2-T05 refuses a function colliding with a native capability name after provider mapping',async()=>{
    const fetch=vi.fn(async()=>responsesText()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await expect(new LLMClient(responsesConfig).call(messages,{
        web_search_preview:tools.apply, search:openai.tools.webSearchPreview({}),
    },{beforeRequest:adopt})).rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'search',path:'$.tools'});
    expect(fetch).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
});

it('C2-T03 a final fit may select a different captured management owner, not the planner',async()=>{
    const planner=source('planner',{managementOnly:true,preserveTools:true});
    const other=source('other',{managementOnly:true,preserveTools:false});
    const candidate=source('candidate',{managementOnly:false,preserveTools:true});
    const call=vi.spyOn(LLMClient.prototype,'call');
    const fetch=vi.fn(async (_url:string,init:RequestInit)=>{
        expect(JSON.parse(String(init.body)).tools.map((tool:any)=>tool.function.name)).toEqual(['other']);
        expect(other.adopt).toHaveBeenCalledOnce();
        expect(candidate.adopt).not.toHaveBeenCalled();
        expect(planner.adopt).not.toHaveBeenCalled();
        return chatReply('other');
    });
    vi.stubGlobal('fetch',fetch);
    planner.captured.fitModelBudget=async measure=>{
        const initial=await measure(planner.captured);
        const final=await measure(candidate.captured);
        expect(initial.inputBytes).toBeGreaterThan(0);
        expect(fetch).not.toHaveBeenCalled();
        expect(other.adopt).not.toHaveBeenCalled();
        return {measurement:final,context:candidate.captured};
    };
    const f=driver([planner.value,other.value],{...chat,inputBudget:()=>limits});
    await f.run();
    expect(f.onRunError).not.toHaveBeenCalled();
    expect(call.mock.calls[0]?.[2]?.preserveTools).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(other.executeTool).toHaveBeenCalledOnce();
    expect(candidate.executeTool).not.toHaveBeenCalled();
    expect(planner.executeTool).not.toHaveBeenCalled();
    expect(planner.release).toHaveBeenCalledOnce();
    expect(other.release).toHaveBeenCalledOnce();
    expect(candidate.release).not.toHaveBeenCalled();
});

it('C2-T05 refuses native search options that the selected Google encoder cannot preserve',async()=>{
    const fetch=vi.fn(async()=>googleReply()),adopt=vi.fn();
    vi.stubGlobal('fetch',fetch);
    await expect(new LLMClient(googleConfig).call(messages,{
        google_search:google.tools.googleSearch({dynamicThreshold:1}),
    },{beforeRequest:adopt,preserveTools:true})).rejects.toMatchObject({code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',tool:'google_search',path:'$.tools'});
    expect(fetch).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
});
