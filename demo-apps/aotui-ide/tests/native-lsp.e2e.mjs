import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScopedLSP } from '../dist/core/scoped-lsp.js';
import { LSPClient } from '../dist/core/lsp/client.js';
import { spawnLSPServer } from '../dist/core/lsp/server.js';
import { directoryIdentity } from '../dist/core/versioned-file-write.js';

const requested = process.argv[3] ?? await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-native-ide-'));
await fs.mkdir(requested, { recursive: true });
const working = await fs.realpath(requested);
const factsPath = process.argv[2] ?? path.join(working, 'facts.json');
const facts = { working, cases: [], processes: [], passed: false };
const services = [], clients = new Set();
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const gone = pid => { try { process.kill(-pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } };
async function test(name, action) { if (process.env.AOTUI_NATIVE_CASE && !name.includes(process.env.AOTUI_NATIVE_CASE)) return; const details = await action(); facts.cases.push({ name, passed: true, details }); console.log('PASS', name); }
async function make(name) {
 const root = path.join(working, name); await fs.mkdir(root, { recursive: true });
 await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', types: [] } }));
 const service = new ScopedLSP(); service.setRoots([{ path: root, identity: await directoryIdentity(root) }]); services.push(service); return { root, service };
}
async function clientFor(service) { const client = await [...service.clients.values()][0]; clients.add(client); return client; }
async function heldHover(client, action) {
 const send = client.connection.sendRequest.bind(client.connection), entered = gate(), released = gate(); let armed = true;
 client.connection.sendRequest = async (method, ...args) => { const value = await send(method, ...args); if (method === 'textDocument/hover' && armed) { armed = false; entered.resolve(); await released.promise; } return value; };
 try { return await action(entered.promise, released.resolve); }
 finally { released.resolve(); client.connection.sendRequest = send; }
}
try {
 await test('UTF-16 input and one-based exact output around a non-BMP character', async () => {
  const {root,service}=await make('utf16'), file=path.join(root,'file.ts');
  const text='export const emoji = "😀"; export const count = 1;'; await fs.writeFile(file,text);
  const start=text.indexOf('count')+1;const hover=await service.query('hover',file,text,1,start);
  assert.deepEqual(hover.value.range,{start:{line:1,character:start},end:{line:1,character:start+5}});
  const client=await clientFor(service);assert.equal(client.capabilities.positionEncoding,'utf-16');assert.equal(client.capabilities.diagnosticProvider,true);
  const consumer=path.join(root,'consumer.ts'), body='import { count } from "./file"; const lead="😀"; count;';await fs.writeFile(consumer,body);
  const definition=await service.query('definition',consumer,body,1,body.lastIndexOf('count')+1);
  const found=definition.value.find(x=>x.filePath===file);assert.ok(found);
  assert.deepEqual(found.range,{start:{line:1,character:start},end:{line:1,character:start+5}});
  return {inputColumn:start,range:hover.value.range};
 });
 await test('real old document-version and same-kind generation responses are rejected',async()=>{
  const {root,service}=await make('stale'),file=path.join(root,'file.ts'),text='export const value = 1;';await fs.writeFile(file,text);
  await service.query('hover',file,text,1,15);const client=await clientFor(service);
  for(const mode of ['document-version','generation']) await heldHover(client,async(entered,release)=>{
   const old=service.query('hover',file,text,1,15);void old.catch(()=>{});await Promise.race([entered,old]);
   if(mode==='document-version')await service.query('symbols',file,text+'\nexport const next = 2;');
   else await service.query('hover',file,text,1,15);
   release();await assert.rejects(old,{code:'LSP_RESULT_STALE'});
  });
  assert.ok((await service.query('hover',file,text,1,15)).value);
  await assert.rejects(client.connection.sendRequest('aotuiIntegration/unsupported',{}),e=>e.code===-32600&&e.message==='InvalidRequest');
  assert.ok((await service.query('hover',file,text,1,15)).value);return {oldVersionRejected:true,oldGenerationRejected:true,unknownCode:-32600,recovered:true};
 });
 await test('native OS watch updates an unopened dependency without didChange or restart',async()=>{
  const {root,service}=await make('external'),dep=path.join(root,'dependency.ts'),file=path.join(root,'consumer.ts');
  const text='import { dependency } from "./dependency";\nexport const answer: number = dependency;\n';await fs.writeFile(dep,'export const dependency = 1;\n');await fs.writeFile(file,text);
  const before=await service.query('hover',file,text,2,31);assert.match(JSON.stringify(before.value),/dependency/);
  const initial=await service.query('diagnostics',file,text);assert.equal(initial.value.length,0);const client=await clientFor(service);assert.equal(client.versionFor(dep),undefined);
  const version=client.versionFor(file),pid=client.process.pid,send=client.connection.sendNotification.bind(client.connection),notifications=[];
  client.connection.sendNotification=async(method,...args)=>{notifications.push({method,args});return send(method,...args);};
  let changed,hover;const end=Date.now()+12000;
  try {
   await fs.writeFile(dep,'export const dependency = "changed-on-disk";\n');
   do {changed=await service.query('diagnostics',file,text);hover=await service.query('hover',file,text,2,31);if(changed.value.some(x=>x.code===2322)&&JSON.stringify(hover.value).includes('changed-on-disk'))break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<end);
   assert.ok(changed.value.some(x=>x.code===2322),'unopened dependency diagnostics did not update');assert.match(JSON.stringify(hover.value),/changed-on-disk/);
   assert.equal(client.versionFor(dep),undefined);assert.equal(client.versionFor(file),version);assert.equal(client.process.pid,pid);
   assert.ok(!notifications.some(x=>['textDocument/didChange','textDocument/didOpen'].includes(x.method)&&x.args[0]?.textDocument?.uri===pathToFileURL(dep).href));
  } finally {client.connection.sendNotification=send;}
  return {dependencyOpened:false,consumerVersionUnchanged:true,samePID:true,diagnostic:2322,changedHover:true,notifications:notifications.map(x=>x.method),logs:client.inspect().logs};
 });
 await test('pull capability and malformed/full/oversize reports reject explicitly, then recover',async()=>{
  const {root,service}=await make('diagnostic-boundaries'),file=path.join(root,'file.ts'),text='export const value: number = "wrong";';await fs.writeFile(file,text);
  assert.ok((await service.query('diagnostics',file,text)).value.some(x=>x.code===2322));const client=await clientFor(service);
  client.capabilities.diagnosticProvider=false;
  try {await assert.rejects(service.query('diagnostics',file,text),{code:'LSP_DIAGNOSTICS_UNAVAILABLE'});}finally{client.capabilities.diagnosticProvider=true;}
  const send=client.connection.sendRequest.bind(client.connection);
  for(const [report,code] of [
   [{kind:'unchanged',resultId:'unsupported'},'LSP_DIAGNOSTICS_INVALID'],
   [{kind:'full',items:{}},'LSP_DIAGNOSTICS_INVALID'],
   [{kind:'full',items:[{message:'missing range'}]},'LSP_DIAGNOSTICS_INVALID'],
   [{kind:'full',items:[{message:'x'.repeat(300000)}]},'IDE_RESULT_TOO_LARGE'],
  ]) {
   client.connection.sendRequest=async(method,...args)=>{const actual=await send(method,...args);return method==='textDocument/diagnostic'?report:actual;};
   try{await assert.rejects(service.query('diagnostics',file,text),{code});}finally{client.connection.sendRequest=send;}
  }
  assert.ok((await service.query('diagnostics',file,text)).value.some(x=>x.code===2322));return {missingCapabilityRejected:true,invalidReports:4,recovered:true};
 });
 await test('client never certifies normal shutdown when a responding child exits code 1',async()=>{
  const root=path.join(working,'nonzero');await fs.mkdir(root,{recursive:true});const entry=path.join(root,'server.cjs');
  await fs.writeFile(entry,String.raw`let b=Buffer.alloc(0);function send(id,result){const s=JSON.stringify({jsonrpc:'2.0',id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(s)+'\r\n\r\n'+s);}process.stdin.on('data',x=>{b=Buffer.concat([b,x]);for(;;){const end=b.indexOf('\r\n\r\n');if(end<0)return;const size=Number(/Content-Length: (\d+)/i.exec(b.subarray(0,end).toString())[1]);if(b.length<end+4+size)return;const m=JSON.parse(b.subarray(end+4,end+4+size));b=b.subarray(end+4+size);if(m.method==='initialize')send(m.id,{capabilities:{}});else if(m.method==='shutdown')send(m.id,null);else if(m.method==='exit')process.exit(1);}});`);
  const handle=await spawnLSPServer(root,process.execPath,[entry]);handle.processGroupVerified=true; // Test-only fixture to isolate the exit-code check.
  const client=await LSPClient.create({serverID:'nonzero-test',server:handle,root});
  await assert.rejects(client.shutdown(),{code:'LSP_SHUTDOWN_FAILED'});assert.equal(client.process.exitCode,1);assert.equal(client.process.signalCode,null);assert.ok(gone(client.process.pid));
  return {expectedFailure:true,exitCode:1,signal:null,groupGone:true,productionProfile:false};
 });
 for(const service of services)await service.close();
 for(const client of clients){const value=client.inspect();assert.equal(value.exitCode,0);assert.equal(value.signalCode,null);assert.equal(value.terminationSignalled,false);assert.equal(value.documentCount,0);assert.equal(value.pendingDocuments,0);assert.ok(gone(client.process.pid));facts.processes.push(value);}
 facts.passed=true;
}catch(error){facts.failure={message:error.message,code:error.code,stack:error.stack,clients:[...clients].map(client=>client.inspect())};console.error(error);process.exitCode=1;}
finally{for(const service of services)await service.close().catch(()=>{});await fs.writeFile(factsPath,JSON.stringify(facts,null,2));console.log('NATIVE_IDE_FACTS',JSON.stringify({working,factsPath,passed:facts.passed,cases:facts.cases.length}));}
