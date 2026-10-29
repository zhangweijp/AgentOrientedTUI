import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createViewOwnedTools as currentFactory } from '../../../runtime/dist/core/tool/view-owned-tools.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const packet=path.join(root,'Runtime Core Semantic Contract RFC/m4/wave2c-20261024T005534Z');
const relative='runtime/src/core/tool/view-owned-tools.ts';
const source=fs.readFileSync(path.join(packet,'baseline-readonly/sources',relative),'utf8');
const inventory=JSON.parse(fs.readFileSync(path.join(packet,'baseline-readonly/inventory.json'),'utf8'));
const sha=createHash('sha256').update(source).digest('hex');
if(sha!==inventory.files[relative].sha256)throw new Error('Baseline source fingerprint mismatch');
const require=createRequire(path.join(root,'runtime/package.json'));
const ts=require('typescript');
let code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const jsonUrl=pathToFileURL(path.join(root,'runtime/dist/core/snapshot/json.js')).href;
code=code.replaceAll("'../snapshot/json.js'",JSON.stringify(jsonUrl)).replaceAll('"../snapshot/json.js"',JSON.stringify(jsonUrl));
const {createViewOwnedTools:baselineFactory}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const results=[];
for(const keyword of ['dependencies','dependentRequired']){
 const inputSchema={type:'object',properties:{'x-aotui-ref':{type:'boolean'},file:{type:'string'}},[keyword]:{'x-aotui-ref':['file']}};
 for(const [version,factory] of [['wave2c-baseline',baselineFactory],['wave2c-current',currentFactory]]){
  const registry=factory('review-app','review-run');const view=registry.mount('view','Review');let calls=0;
  const result={keyword,version};
  try{
   registry.registerTool(view.viewInstanceId,{name:'inspect',description:'Plain dependency control',inputSchema,isMutating:false},async()=>{calls++;return{success:true};});
   const tool=registry.listTools()[0];result.registration='accepted';result.invocation=await registry.invoke(tool,tool.targets[0],{'x-aotui-ref':true,file:'file'});
  }catch(e){result.registration='rejected';result.error=e.code??String(e);}
  result.handlerCalls=calls;results.push(result);
 }
}
console.log(JSON.stringify({baselineSourceSha256:sha,method:'Only the saved baseline Registry module is transpiled in memory. It shares the unchanged current JSON codec. This is not a historical Host/Worker binary test.',results},null,2));
process.exitCode=results.filter(x=>x.version==='wave2c-current').some(x=>x.registration!=='accepted')?1:0;
