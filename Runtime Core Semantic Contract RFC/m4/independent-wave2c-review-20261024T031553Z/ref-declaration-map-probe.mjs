import { createViewOwnedTools } from '../../../runtime/dist/core/tool/view-owned-tools.js';
import { validateToolRefDeclarations } from '../../../runtime/dist/core/tool/ref-declarations.js';
import { copyJson } from '../../../runtime/dist/core/snapshot/json.js';
import { validatePreparedV2Draft } from '../../../runtime/dist/core/snapshot/index.js';
const marker = { version: 1, kind: 'snapshot-value', owner: 'tool-target' };
const results = [];
for (const name of ['ordinary', 'default', 'const', 'enum', 'examples']) {
 const schema = {type:'object',properties:{file:{type:'string'},[name]:{type:'boolean'}},dependencies:{[name]:{type:'object',properties:{file:{type:'string','x-aotui-ref':marker}}}}};
 const registry = createViewOwnedTools('review-app','review-run');
 const view = registry.mount('view','Review');
 const result = {dependencyProperty:name,inputSchema:schema};
 try { result.semanticValidator = validateToolRefDeclarations(copyJson(schema),false); } catch (e) { result.semanticError = e.code; }
 let calls=0;
 try {
  registry.registerTool(view.viewInstanceId,{name:'inspect',description:'Review synthetic declaration',inputSchema:schema,isMutating:false},async()=>{calls++;return {success:true,data:'SYNTHETIC_HANDLER_RAN'};});
  result.registration='accepted';
  const tool=registry.listTools()[0];
  const draft={schemaVersion:2,appId:'review-app',instanceId:'review-run',producerSeq:1,sourceEpoch:1,capturedAt:1,views:[{id:'view',viewInstanceId:view.viewInstanceId,type:'Review',name:'Review',kind:'state',content:{format:'markdown-v1',value:'Synthetic review'}}],refs:{},tools:{[tool.id]:{id:tool.id,name:tool.name,viewType:tool.viewType,description:tool.description,inputSchema:tool.inputSchema,isMutating:tool.isMutating,targets:tool.targets}}};
  const validation=validatePreparedV2Draft(draft);
  result.snapshotValidation=validation.ok ? 'accepted' : validation.issue.code;
  result.invocation=await registry.invoke(tool,tool.targets[0],{file:'file',[name]:true});
 } catch (e) { result.registration='rejected';result.registrationError=e.code; }
 result.handlerCalls=calls;
 results.push(result);
}
console.log(JSON.stringify(results,null,2));
const bypasses=results.filter(r=>r.handlerCalls>0);
console.log('INVALID_PLACEMENT_HANDLER_EXECUTIONS='+bypasses.length+'/'+results.length);
process.exitCode=bypasses.length ? 1 : 0;
