import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPublicDocIdentity } from './verify-public-docs.mjs';
const execute = promisify(execFile);
const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer && evidence, 'consumer and evidence paths are required');
const output = path.join(consumer, 'documentation-checks');
await fs.mkdir(output, { recursive: true });
const facts = { consumer, passed: false, commands: [], documents: [] };
const identity = await inspectPublicDocIdentity(path.join(consumer, 'node_modules/@aotui/sdk'));
facts.publicDocIdentity = identity;
await fs.writeFile(evidence, JSON.stringify(facts, null, 2)+'\n');
assert.ok(identity.passed, 'PUBLIC_DOC_IDENTITY: '+JSON.stringify(identity.references));
const sdkRoot = path.join(consumer, 'node_modules/@aotui/sdk');
for (const name of ['file-app.tsx', 'file-tools.ts', 'ref-app.tsx', 'work-items.ts', 'work-items-plain.ts', 'work-items-preact.tsx']) {
  await fs.copyFile(path.join(sdkRoot, 'docs/examples', name), path.join(output, name));
}
for (const [document, name, language] of [
  ['README.md', 'readme-app.tsx', 'tsx'],
  ['docs/app-tools.md', 'app-tools.tsx', 'tsx'],
  ['docs/static-tools.md', 'static-tools.ts', 'ts'],
  ['docs/app-authoring.md', 'public-app-host.mjs', 'js'],
]) {
  const text = await fs.readFile(path.join(sdkRoot, document), 'utf8');
  const source = text.split('```' + language + '\n')[1]?.split('\n```')[0];
  assert.ok(source, document + ' has a public author example');
  await fs.writeFile(path.join(output, name), source);
}
await execute(process.execPath, ['--check', path.join(output, 'public-app-host.mjs')]);
const runtimeRoot = path.join(consumer, 'node_modules/@aotui/runtime');
const runtimeGuide = await fs.readFile(path.join(runtimeRoot, 'docs/runtime-app-interaction.md'), 'utf8');
const extract = (text, marker, language) => {
  const source = text.split(`<!-- ${marker}:start -->\n\`\`\`${language}\n`)[1]?.split(`\n\`\`\`\n<!-- ${marker}:end -->`)[0];
  assert.ok(source, marker + ' is an executable marked example'); return source;
};
await fs.writeFile(path.join(output, 'runtime-app.mjs'), extract(runtimeGuide, 'b2-app', 'js'));
await fs.writeFile(path.join(output, 'runtime-host.ts'), extract(runtimeGuide, 'b2-example', 'ts'));
const coreGuide = await fs.readFile(path.join(runtimeRoot, 'docs/core-public-entry.md'), 'utf8');
await fs.writeFile(path.join(output, 'core-example.ts'), extract(coreGuide, 'b1-example', 'ts'));
for (const [alias, version] of [['typescript', '7.0.2']]) {
  const config = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, lib: ['ES2022', 'DOM'], types: ['node'],
    jsx: 'react-jsx', jsxImportSource: 'preact', outDir: './out-' + version, rootDir: '.' }, files: ['./readme-app.tsx', './app-tools.tsx', './static-tools.ts', './file-app.tsx', './ref-app.tsx', './work-items-preact.tsx', './runtime-host.ts'] };
  const file = path.join(output, 'tsconfig-' + version + '.json'); await fs.writeFile(file, JSON.stringify(config, null, 2));
  const command = [path.join(consumer, 'node_modules', alias, 'bin/tsc'), '-p', file, '--pretty', 'false'];
  try { const result = await execute(process.execPath, command, { cwd: consumer }); facts.commands.push({ kind: 'compile', version, command: [process.execPath, ...command], exitCode: 0, ...result }); }
  catch (error) { facts.commands.push({ kind: 'compile', version, command: [process.execPath, ...command], exitCode: error.code, stdout: error.stdout, stderr: error.stderr }); }
  await fs.writeFile(evidence, JSON.stringify(facts, null, 2)+'\n');
}
assert.ok(facts.commands.some(command => command.kind === 'compile' && command.version === '7.0.2' && command.exitCode === 0),
 'TS 7.0.2 tutorial compilation failed; no emitted tutorial may execute. The compiler result was saved.');
const coreConfig = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, lib: ['ES2022'], types: [],
  outDir: './core-out' }, files: ['./core-example.ts', './work-items-plain.ts'] };
await fs.writeFile(path.join(output, 'tsconfig-core.json'), JSON.stringify(coreConfig, null, 2));
const coreCommand = [path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', path.join(output, 'tsconfig-core.json'), '--pretty', 'false'];
try {
  const result = await execute(process.execPath, coreCommand, { cwd: consumer });
  facts.commands.push({ kind: 'core-compile', command: [process.execPath, ...coreCommand], exitCode: 0, ...result });
} catch (error) {
  facts.commands.push({ kind: 'core-compile', command: [process.execPath, ...coreCommand], exitCode: error.code, stdout: error.stdout, stderr: error.stderr });
  await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n'); throw error;
}
const test = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { runExample } from './out-7.0.2/runtime-host.js';
import { coreTutorialFacts } from './core-out/core-example.js';
const facts = { coreTutorialFacts, minimalExample: false, fileExample: false, refExample: false, runtimeExample: false, calls: [], reports: [] };
const minimalRuntime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
let minimalSource;
try {
 const desktop = await minimalRuntime.createDesktop('readme-example');
 await minimalRuntime.installDynamicWorkerApp(desktop, new URL('./out-7.0.2/readme-app.js', import.meta.url).href,
  { appId: 'minimal', config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
 minimalSource = new SemanticAOTUIDrivenSource(minimalRuntime.getDesktop(desktop), minimalRuntime, { includeInstruction: false });
 const deadline = Date.now() + 15000;
 for (;;) {
  const context = await minimalSource.getContext();
  try {
   if (context.messages.some(message => String(message.content).includes('Example Application Instruction'))) {
    await context.adopt(); assert.equal(Object.keys(context.tools).filter(name => name.startsWith('minimal-')).length, 0); facts.minimalHostTools = Object.keys(context.tools); facts.minimalExample = true; break;
   }
  } finally { await context.release?.(); }
  if (Date.now() > deadline) throw Error('README app did not publish Root');
  await new Promise(resolve => setTimeout(resolve, 20));
 }
} finally {
 minimalSource?.dispose(); const close = await minimalRuntime.beginShutdown().completion;
 assert.equal(close.ok, true); assert.equal(close.resourcesReleased, true); facts.reports.push(close);
}
const runtime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 2 } });
const held = [];
let source;
try {
 const desktop = await runtime.createDesktop('published-docs');
 const url = new URL('./out-7.0.2/file-app.js', import.meta.url).href;
 for (const id of ['docfilesa', 'docfilesb']) await runtime.installDynamicWorkerApp(desktop, url, { appId: id, interactionModes: ['view-type-parameters-v1'], config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
 source = new SemanticAOTUIDrivenSource(runtime.getDesktop(desktop), runtime, { includeInstruction: false });
 const messages = c => c.messages.map(m => String(m.content));
 const views = (c, app, id) => messages(c).filter(m => m.startsWith('<view ') && m.includes('app_id="'+app+'"') && (!id || m.includes('id="'+id+'"')));
 const name = (c, app, type, tool) => { const n = app+'-'+type+'-'+tool; assert.ok(c.tools[n], 'Tool available: '+n); return n; };
 async function capture(ready) {
  const end = Date.now()+15000;
  for (;;) {
   const c = await source.getContext();
   if (ready(c)) { await c.adopt(); held.push(c); return c; }
   await c.release?.();
   if (Date.now()>end) throw Error('Document example did not reach expected projection');
   await new Promise(r=>setTimeout(r,20));
  }
 }
 async function call(c, app, type, tool, args) {
  const result = await c.executeTool(name(c,app,type,tool),args,'docs-'+facts.calls.length);
  facts.calls.push({ app, tool, result }); return result;
 }
 let current = await capture(c => ['docfilesa','docfilesb'].every(app=>c.tools[app+'-Workspace-open_file']));
 const catalog = views(current,'docfilesa','root')[0]; assert.ok(catalog);
 assert.ok(catalog.includes('edit_file'));
 assert.ok(!catalog.includes('Edit an opened demo file and read its updated View.'));
 assert.ok(!catalog.includes('inputSchema') && !catalog.includes('additionalProperties'));
 assert.equal(Object.keys(current.tools).filter(n=>n.endsWith('-edit_file')).length,0);
 for (const [app, file] of [['docfilesa','a.txt'],['docfilesa','b.txt'],['docfilesb','a.txt']]) assert.equal((await call(current,app,'Workspace','open_file',{filePath:file})).outcomeStatus,'succeeded');
 current = await capture(c=>views(c,'docfilesa').length===4 && c.tools['docfilesa-FileDetail-edit_file'] && c.tools['docfilesb-FileDetail-edit_file']);
 const observed = current;
 assert.equal(Object.keys(current.tools).filter(n=>n==='docfilesa-FileDetail-edit_file').length,1);
 const edit = await call(current,'docfilesa','FileDetail','edit_file',{filePath:'a.txt',content:'DOCUMENT_UPDATED_A'});
 assert.equal(edit.outcomeStatus,'succeeded'); assert.ok(!JSON.stringify(edit).includes('DOCUMENT_UPDATED_A'));
 assert.equal((await call(current,'docfilesa','Workspace','close_file',{filePath:'b.txt'})).outcomeStatus,'succeeded');
 const denied = await call(current,'docfilesa','FileDetail','edit_file',{filePath:'b.txt',content:'MUST_NOT_APPEAR'});
 assert.equal(denied.outcomeStatus,'failed');assert.equal(denied.error.code,'FILE_NOT_OPEN');
 current = await capture(c=>views(c,'docfilesa','file_a')[0]?.includes('DOCUMENT_UPDATED_A') && views(c,'docfilesa','file_b').length===0);
 assert.ok(views(current,'docfilesb','file_a')[0].includes('Initial A'));
 assert.ok(!views(current,'docfilesb','file_a')[0].includes('DOCUMENT_UPDATED_A'));
 assert.equal(views(current,'docfilesa','root')[0],catalog);
 assert.equal((await call(current,'docfilesa','Workspace','close_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
 const stale = await call(observed,'docfilesa','FileDetail','edit_file',{filePath:'a.txt',content:'STALE'});assert.equal(stale.outcomeStatus,'rejected');
 current = await capture(c=>!c.tools['docfilesa-FileDetail-edit_file'] && views(c,'docfilesa').length===2);
 assert.ok(current.tools['docfilesb-FileDetail-edit_file'],'Other App still active');
 assert.equal((await call(current,'docfilesa','Workspace','open_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
 current = await capture(c=>!!c.tools['docfilesa-FileDetail-edit_file']);
 assert.equal((await call(observed,'docfilesa','FileDetail','edit_file',{filePath:'a.txt',content:'STALE_AGAIN'})).outcomeStatus,'rejected');
 assert.equal(views(current,'docfilesa','root')[0],catalog);
 facts.fileExample = true;
} finally {
 for (const c of held) await c.release?.();source?.dispose();
 const report=await runtime.beginShutdown().completion;facts.reports.push(report);
 assert.equal(report.ok,true);assert.equal(report.resourcesReleased,true);
}
const refRuntime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
const refHeld = [];
let refSource;
try {
 const desktop = await refRuntime.createDesktop('published-ref-doc');
 await refRuntime.installDynamicWorkerApp(desktop, new URL('./out-7.0.2/ref-app.js', import.meta.url).href,
  { appId: 'notes', interactionModes: ['view-type-parameters-v1'], config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
 refSource = new SemanticAOTUIDrivenSource(refRuntime.getDesktop(desktop), refRuntime, { includeInstruction: false });
 const text = c => c.messages.map(m => String(m.content)).join('\n');
 async function observe(ready) {
  const end = Date.now() + 15000;
  for (;;) {
   const c = await refSource.getContext();
   if (ready(c)) { await c.adopt(); refHeld.push(c); return c; }
   await c.release?.();
   if (Date.now() > end) throw Error('Ref tutorial projection did not become visible');
   await new Promise(r => setTimeout(r, 20));
  }
 }
 let context = await observe(c => c.tools['notes-Workspace-open_notes']);
 assert.ok(!context.tools['notes-NoteDetail-inspect_note']);
 assert.equal((await context.executeTool('notes-Workspace-open_notes', {}, 'notes-open')).outcomeStatus, 'succeeded');
 context = await observe(c => c.tools['notes-NoteDetail-inspect_note'] && c.tools['notes-NoteDetail-inspect_notes']);
 for (const ref of ['Note:current', 'Note[]:notes', 'Note:notes[0]']) assert.ok(text(context).includes(ref));
 for (const [tool, args, expected] of [
  ['inspect_note', { note: 'detail.current' }, 'First note: First line'],
  ['inspect_notes', { notes: 'detail.notes' }, 'Second note: Another note'],
  ['inspect_note', { note: 'detail.notes[0]' }, 'First note: First line'],
  ['inspect_selection', { selected: ['detail.notes[1]', 'detail.notes[0]', 'detail.notes[1]'], primary: 'detail.current', whole: 'detail.notes' }, 'Second note: Another note'],
  ['inspect_selection', { selected: [] }, 'No notes selected.'],
 ]) {
  const result = await context.executeTool('notes-NoteDetail-' + tool, args, 'ref-doc-' + facts.calls.length);
  facts.calls.push({ app: 'notes', tool, args, result });
  assert.equal(result.outcomeStatus, 'succeeded');
  assert.ok(!JSON.stringify(result).includes('First line'), 'Business content stays in the View');
  context = await observe(c => c.messages.some(m => String(m.content).startsWith('<view id="detail"') && String(m.content).split('## Inspection')[1]?.includes(expected)));
  if (tool === 'inspect_selection' && args.selected.length) {
   const projection = context.messages.map(m => String(m.content)).find(m => m.startsWith('<view id="detail"'))?.split('## Inspection')[1];
   assert.match(projection, /Second note: Another note[\s\S]*First note: First line[\s\S]*Second note: Another note[\s\S]*First note: First line[\s\S]*First note: First line[\s\S]*Second note: Another note/);
  }
 }
 for (const [tool, args] of [
  ['inspect_notes', { notes: 'detail.current' }],
  ['inspect_note', { note: 'Note:current' }],
  ['inspect_selection', { selected: [], primary: null }],
  ['inspect_selection', { selected: ['detail.missing'] }],
 ]) {
  const result = await context.executeTool('notes-NoteDetail-' + tool, args, 'invalid-' + facts.calls.length);
  assert.equal(result.outcomeStatus, 'rejected');
  facts.calls.push({ app: 'notes', tool, args, result });
 }
 const old = context;
 assert.equal((await context.executeTool('notes-Workspace-close_notes', {}, 'notes-close')).outcomeStatus, 'succeeded');
 context = await observe(c => !c.tools['notes-NoteDetail-inspect_note']);
 assert.equal((await old.executeTool('notes-NoteDetail-inspect_note', { note: 'detail.current' }, 'closed-note')).outcomeStatus, 'rejected');
 assert.ok(!text(context).includes('Note:notes[0]'));
 facts.refExample = true;
} finally {
 for (const c of refHeld) await c.release?.(); refSource?.dispose();
 const report = await refRuntime.beginShutdown().completion;
 facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
}
const data=await fs.mkdtemp(path.join(path.dirname(new URL(import.meta.url).pathname),'runtime-doc-data-'));
try {
 const result=await runExample(new URL('./runtime-app.mjs',import.meta.url).href,data);
 assert.equal(result.outcomes.length,2);assert.ok(result.outcomes.every(o=>o.status==='succeeded'));
 assert.equal(result.close.ok,true);assert.equal(result.close.resourcesReleased,true);
 facts.runtimeExample=true;facts.reports.push(result.close);facts.runtimeOutcomes=result.outcomes;
} finally { await fs.rm(data,{recursive:true,force:true}); }
await fs.writeFile(new URL('./runtime-facts.json',import.meta.url),JSON.stringify(facts,null,2)+'\n');
console.log(JSON.stringify(facts));
`;
await fs.writeFile(path.join(output, 'execute.mjs'), test);
const command = [path.join(output, 'execute.mjs')];
try {
 const result = await execute(process.execPath, command, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
 facts.commands.push({ command: [process.execPath, ...command], exitCode: 0, ...result });
 facts.documents = JSON.parse(await fs.readFile(path.join(output, 'runtime-facts.json'), 'utf8'));
 facts.passed = facts.commands.every(command => command.exitCode === 0);
 if (!facts.passed) process.exitCode = 1;
} catch (error) { facts.commands.push({ command: [process.execPath, ...command], exitCode: error.code, stdout: error.stdout, stderr: error.stderr }); throw error; }
finally { await fs.writeFile(evidence, JSON.stringify(facts, null, 2)+'\n'); }
console.log(facts.passed
 ? 'Installed SDK and Runtime documentation: strict TypeScript 7.0.2 and real Worker scenarios passed.'
 : 'Documentation behavior passed using TS 7.0.2 output; a required compiler gate failed. See the preserved compiler results.');
