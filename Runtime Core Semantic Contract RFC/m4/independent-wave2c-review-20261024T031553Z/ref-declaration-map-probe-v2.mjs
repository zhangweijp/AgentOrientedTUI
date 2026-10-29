import { createViewOwnedTools } from '../../../runtime/dist/core/tool/view-owned-tools.js';
import { validateToolRefDeclarations } from '../../../runtime/dist/core/tool/ref-declarations.js';
import { copyJson } from '../../../runtime/dist/core/snapshot/json.js';
import { validatePreparedV2Draft } from '../../../runtime/dist/core/snapshot/index.js';
const marker={version:1,kind:'snapshot-value',owner:'tool-target'};
const prop={type:'string','x-aotui-ref':marker};
const inputs=['ordinary','default','const','enum','examples'].map(name=>({name:'misplaced_dependency_'+name,expected:'reject',schema:{type:'object',properties:{file:{type:'string'},[name]:{type:'boolean'}},dependencies:{[name]:{type:'object',properties:{file:prop}}}},args:{file:'file',[name]:true}}));
inputs.push({name:'plain_dependency_named_reserved_key',expected:'plain',schema:{type:'object',properties:{'x-aotui-ref':{type:'boolean'},file:{type:'string'}},dependencies:{'x-aotui-ref':['file']}},args:{'x-aotui-ref':true,file:'file'}});
inputs.push({name:'genuine_literal_default',expected:'plain',schema:{type:'object',properties:{file:{type:'object',default:{'x-aotui-ref':{version:99}}}}},args:{file:{'x-aotui-ref':{version:99}}}});
inputs.push({name:'plain_property_named_reserved_key',expected:'plain',schema:{type:'object',properties:{'x-aotui-ref':{type:'string'}}},args:{'x-aotui-ref':'literal'}});
inputs.push({name:'valid_top_level_declaration',expected:'declared',schema:{type:'object',properties:{file:prop}},args:{}});
const results=[];
for(const input of inputs){
 const registry=createViewOwnedTools('review-app','review-run');
 const view=registry.mount('view','Review');
 const id=JSON.stringify(['review-app','Review','inspect']);
 const result={name:input.name,expected:input.expected,inputSchema:input.schema};
 try{result.semanticResult=validateToolRefDeclarations(copyJson(input.schema,{maxDepth:48,maxNodes:10000,maxApproxBytes:128*1024}),false);}catch(e){result.semanticError=e.code??String(e);}
 const draft={schemaVersion:2,appId:'review-app',instanceId:'review-run',producerSeq:1,sourceEpoch:1,capturedAt:1,views:[{id:'view',viewInstanceId:view.viewInstanceId,type:'Review',name:'Review',kind:'state',content:{format:'markdown-v1',value:'Synthetic review'}}],refs:{},tools:{[id]:{id,name:'inspect',viewType:'Review',description:'Synthetic declaration review',inputSchema:input.schema,isMutating:false,targets:[{viewId:'view',viewInstanceId:view.viewInstanceId,bindingVersion:1}]}}};
 const validation=validatePreparedV2Draft(draft);
 result.snapshotValidation=validation.ok?'accepted':validation.issue.code;
 let calls=0;
 try{
  registry.registerTool(view.viewInstanceId,{name:'inspect',description:'Synthetic declaration review',inputSchema:input.schema,isMutating:false},async()=>{calls++;return{success:true,data:'SYNTHETIC_HANDLER_RAN'};});
  result.registration='accepted';
  const tool=registry.listTools()[0];
  result.invocation=await registry.invoke(tool,tool.targets[0],input.args);
 }catch(e){result.registration='rejected';result.registrationError=e.code??String(e);}
 result.handlerCalls=calls;
 result.contractSatisfied=input.expected==='reject'?(result.registration==='rejected'&&result.snapshotValidation!=='accepted'&&calls===0):input.expected==='plain'?(result.registration==='accepted'&&result.snapshotValidation==='accepted'&&calls===1&&result.invocation?.success===true):(result.registration==='accepted'&&result.snapshotValidation==='accepted'&&calls===0&&result.invocation?.error?.code==='REF_CONTRACT_UNSUPPORTED');
 results.push(result);
}
const failures=results.filter(x=>!x.contractSatisfied);
console.log(JSON.stringify({cases:results,contractFailures:failures.length,totalCases:results.length},null,2));
process.exitCode=failures.length?1:0;
