import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPublicDocIdentity } from './verify-public-docs.mjs';
const execute = promisify(execFile);
const [consumer, evidence, profile = 'full'] = process.argv.slice(2);
assert.ok(consumer && evidence, 'consumer and evidence paths are required');
assert.ok(['plain', 'full'].includes(profile), 'Select the plain or full documentation profile');
const plain = profile === 'plain';
const output = path.join(consumer, 'documentation-checks');
await fs.mkdir(output, { recursive: true });
const facts = { consumer, profile, passed: false, commands: [], documents: [] };
async function checked(kind, args, details = {}) {
  const command = [process.execPath, ...args];
  try {
    const result = await execute(process.execPath, args, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
    facts.commands.push({ kind, command, exitCode: 0, ...details, ...result });
    return result;
  } catch (error) {
    facts.commands.push({ kind, command, exitCode: error.code, ...details, stdout: error.stdout, stderr: error.stderr });
    throw error;
  } finally { await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n'); }
}
const identity = await inspectPublicDocIdentity(path.join(consumer, 'node_modules/@aotui/sdk'));
facts.publicDocIdentity = identity;
await fs.writeFile(evidence, JSON.stringify(facts, null, 2)+'\n');
assert.ok(identity.passed, 'PUBLIC_DOC_IDENTITY: '+JSON.stringify(identity.references));
const sdkRoot = path.join(consumer, 'node_modules/@aotui/sdk');
const examples = ['work-items.ts', 'work-items-plain.ts'];
if (!plain) examples.push('file-app.tsx', 'file-tools.ts', 'ref-app.tsx', 'work-items-preact.tsx');
for (const name of examples) {
  await fs.copyFile(path.join(sdkRoot, 'docs/examples', name), path.join(output, name));
}
for (const [document, name, language] of plain ? [] : [
  ['README.md', 'readme-app.tsx', 'tsx'],
  ['docs/app-tools.md', 'app-tools.tsx', 'tsx'],
  ['docs/static-tools.md', 'static-tools.ts', 'ts'],
]) {
  const text = await fs.readFile(path.join(sdkRoot, document), 'utf8');
  const source = text.split('```' + language + '\n')[1]?.split('\n```')[0];
  assert.ok(source, document + ' has a public author example');
  await fs.writeFile(path.join(output, name), source);
}
const runtimeRoot = path.join(consumer, 'node_modules/@aotui/runtime');
const runtimeGuide = await fs.readFile(path.join(runtimeRoot, 'docs/runtime-app-interaction.md'), 'utf8');
const extract = (text, marker, language) => {
  const source = text.split(`<!-- ${marker}:start -->\n\`\`\`${language}\n`)[1]?.split(`\n\`\`\`\n<!-- ${marker}:end -->`)[0];
  assert.ok(source, marker + ' is an executable marked example'); return source;
};
const authorGuide = path.join(sdkRoot, 'docs/app-authoring.md');
const hostGuide = path.join(runtimeRoot, 'docs/semantic-host-integration.zh-CN.md');
const hostReference = '`@aotui/runtime` 包内 `docs/semantic-host-integration.zh-CN.md#source-host-example`';
assert.ok((await fs.readFile(authorGuide, 'utf8')).includes(hostReference), 'The SDK author guide locates the packaged Host example');
const hostGuideText = await fs.readFile(hostGuide, 'utf8');
assert.ok(hostGuideText.includes('<a id="source-host-example"></a>'));
const sourceHostExample = path.join(output, 'public-app-host.mjs');
if (!plain) {
  await fs.writeFile(sourceHostExample, extract(hostGuideText, 'source-host-example', 'js'));
  await checked('host-example-syntax', ['--check', sourceHostExample], { source: hostGuide });
  await fs.writeFile(path.join(output, 'runtime-app.mjs'), extract(runtimeGuide, 'b2-app', 'js'));
  await fs.writeFile(path.join(output, 'runtime-host.ts'), extract(runtimeGuide, 'b2-example', 'ts'));
}
const coreGuidePath = path.join(await fs.realpath(runtimeRoot), 'docs/core-public-entry.md');
const coreGuide = await fs.readFile(coreGuidePath, 'utf8');
const coreSource = extract(coreGuide, 'b1-example', 'ts');
await fs.writeFile(path.join(output, 'core-example.ts'), coreSource);
const digest = value => createHash('sha256').update(value).digest('hex');
facts.coreTutorial = { document: coreGuidePath, documentSha256: digest(coreGuide), sourceSha256: digest(coreSource) };
const compiler = path.join(consumer, 'node_modules/typescript/bin/tsc');
const version = JSON.parse(await fs.readFile(path.join(consumer, 'node_modules/typescript/package.json'), 'utf8')).version;
assert.equal(version, '7.0.2');
const strict = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false };
async function compile(kind, name, config) {
  const file = path.join(output, name);
  await fs.writeFile(file, JSON.stringify(config, null, 2));
  await checked(kind, [compiler, '-p', file, '--pretty', 'false'], { version });
}
if (!plain) {
  const config = { compilerOptions: { ...strict, lib: ['ES2022', 'DOM'], types: ['node'],
    jsx: 'react-jsx', jsxImportSource: 'preact', outDir: './out-' + version, rootDir: '.' }, files: ['./readme-app.tsx', './app-tools.tsx', './static-tools.ts', './file-app.tsx', './ref-app.tsx', './work-items-preact.tsx', './runtime-host.ts'] };
  await compile('compile', 'tsconfig-' + version + '.json', config);
}
await compile('core-compile', 'tsconfig-core.json', {
  compilerOptions: { ...strict, lib: ['ES2022'], types: [], outDir: './core-out' },
  files: ['./core-example.ts', './work-items-plain.ts'],
});
await checked('core-execution', [path.join(output, 'core-out/core-example.js')]);
facts.coreTutorial.moduleSha256 = digest(await fs.readFile(path.join(output, 'core-out/core-example.js')));
const fullAuthorExamples = String.raw`
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
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
 for (const id of ['docfilesa', 'docfilesb']) await runtime.installDynamicWorkerApp(desktop, url, { appId: id, config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
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
  const result = await c.executeTool(name(c,app,type,tool), { view_id: 'workspace', ...args }, 'docs-'+facts.calls.length);
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
 const edit = await call(current,'docfilesa','FileDetail','edit_file',{view_id:'file_a',content:'DOCUMENT_UPDATED_A'});
 assert.equal(edit.outcomeStatus,'succeeded'); assert.ok(!JSON.stringify(edit).includes('DOCUMENT_UPDATED_A'));
 assert.equal((await call(current,'docfilesa','Workspace','close_file',{filePath:'b.txt'})).outcomeStatus,'succeeded');
 const denied = await call(current,'docfilesa','FileDetail','edit_file',{view_id:'file_b',content:'MUST_NOT_APPEAR'});
 assert.equal(denied.outcomeStatus,'rejected');assert.equal(denied.error.code,'VIEW_INSTANCE_REVOKED');
 current = await capture(c=>views(c,'docfilesa','file_a')[0]?.includes('DOCUMENT_UPDATED_A') && views(c,'docfilesa','file_b').length===0);
 assert.ok(views(current,'docfilesb','file_a')[0].includes('Initial A'));
 assert.ok(!views(current,'docfilesb','file_a')[0].includes('DOCUMENT_UPDATED_A'));
 assert.equal(views(current,'docfilesa','root')[0],catalog);
 assert.equal((await call(current,'docfilesa','Workspace','close_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
 const stale = await call(observed,'docfilesa','FileDetail','edit_file',{view_id:'file_a',content:'STALE'});assert.equal(stale.outcomeStatus,'rejected');
 current = await capture(c=>!c.tools['docfilesa-FileDetail-edit_file'] && views(c,'docfilesa').length===2);
 assert.ok(current.tools['docfilesb-FileDetail-edit_file'],'Other App still active');
 assert.equal((await call(current,'docfilesa','Workspace','open_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
 current = await capture(c=>!!c.tools['docfilesa-FileDetail-edit_file']);
 assert.equal((await call(observed,'docfilesa','FileDetail','edit_file',{view_id:'file_a',content:'STALE_AGAIN'})).outcomeStatus,'rejected');
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
  { appId: 'notes', config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
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
 assert.equal((await context.executeTool('notes-Workspace-open_notes', { view_id: 'workspace' }, 'notes-open')).outcomeStatus, 'succeeded');
 context = await observe(c => c.tools['notes-NoteDetail-inspect_note'] && c.tools['notes-NoteDetail-inspect_notes']);
 for (const ref of ['Note:current', 'Note[]:notes', 'Note:notes[0]']) assert.ok(text(context).includes(ref));
 for (const [tool, args, expected] of [
  ['inspect_note', { note: 'detail.current' }, 'First note: First line'],
  ['inspect_notes', { notes: 'detail.notes' }, 'Second note: Another note'],
  ['inspect_note', { note: 'detail.notes[0]' }, 'First note: First line'],
  ['inspect_selection', { selected: ['detail.notes[1]', 'detail.notes[0]', 'detail.notes[1]'], primary: 'detail.current', whole: 'detail.notes' }, 'Second note: Another note'],
  ['inspect_selection', { selected: [] }, 'No notes selected.'],
 ]) {
  const result = await context.executeTool('notes-NoteDetail-' + tool, { view_id: 'detail', ...args }, 'ref-doc-' + facts.calls.length);
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
  const result = await context.executeTool('notes-NoteDetail-' + tool, { view_id: 'detail', ...args }, 'invalid-' + facts.calls.length);
  assert.equal(result.outcomeStatus, 'rejected');
  facts.calls.push({ app: 'notes', tool, args, result });
 }
 const old = context;
 assert.equal((await context.executeTool('notes-Workspace-close_notes', { view_id: 'workspace' }, 'notes-close')).outcomeStatus, 'succeeded');
 context = await observe(c => !c.tools['notes-NoteDetail-inspect_note']);
 assert.equal((await old.executeTool('notes-NoteDetail-inspect_note', { view_id: 'detail', note: 'detail.current' }, 'closed-note')).outcomeStatus, 'rejected');
 assert.ok(!text(context).includes('Note:notes[0]'));
 facts.refExample = true;
} finally {
 for (const c of refHeld) await c.release?.(); refSource?.dispose();
 const report = await refRuntime.beginShutdown().completion;
 facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
}
`;
const workItemsExamples = String.raw`
const workRuntime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
facts.workItemsExamples = [];
try {
 const desktop = await workRuntime.createDesktop('published-work-items');
 const examples = [['plain', './core-out/work-items-plain.js']];
 if (facts.profile === 'full') examples.push(['preact', './out-7.0.2/work-items-preact.js']);
 for (const [author, example] of examples) {
  const appId = 'work_' + author;
  const entry = new URL('./work-' + author + '.mjs', import.meta.url);
  await fs.writeFile(entry, 'import { workItemsApp } from ' + JSON.stringify(example) + ';\n' +
    'export default workItemsApp(' + JSON.stringify(appId) + ');\n');
  await workRuntime.installDynamicWorkerApp(desktop, entry.href, { appId, config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
  const desktopHandle = workRuntime.getDesktop(desktop);
  const instanceId = desktopHandle.getInstalledApps().find(app => app.appId === appId)?.appInstanceId;
  assert.ok(instanceId);
  const access = workRuntime.getAppInteraction(desktop, appId, instanceId);
  assert.equal(access.status, 'ready');
  const client = access.interaction;
  let observation;
  async function observe() {
   if (observation) client.releaseObservation(observation.observationId);
   const end = Date.now() + 15000;
   for (;;) {
    const captured = await client.observe({ all: true });
    if (captured.status === 'observed') {
     observation = captured.observation;
     assert.equal(client.adoptObservation(observation.observationId).status, 'adopted');
     return observation;
    }
    if (Date.now() > end) throw Error('Work Items projection unavailable: ' + JSON.stringify(captured.issue));
    await new Promise(resolve => setTimeout(resolve, 20));
   }
  }
  try {
   for (const [index, [id, expected]] of [[otherViewId, false], [selectedViewId, null]].entries()) {
    const current = observation ?? await observe();
    assert.deepEqual(current.views.filter(view => view.type === 'Item').map(view => view.id), [otherViewId, selectedViewId]);
    const tools = current.tools.filter(tool => tool.name === 'inspect');
    assert.equal(tools.length, 1);
    const result = await client.invoke({ observationId: current.observationId, toolId: tools[0].id,
     invocationId: 'docs-work-' + index, input: { view_id: id, selected: id + '.selected' } });
    assert.equal(result.receipt?.outcome.status, 'succeeded', JSON.stringify(result));
    const updated = await observe();
    const original = await client.readReceipt({ observationId: current.observationId, invocationId: 'docs-work-' + index });
    assert.deepEqual(original, result);
    assert.match(updated.views.find(view => view.id === 'workspace')?.content?.value ?? '',
      expected === false ? /"selected":false/ : /"selected":null/);
   }
   facts.workItemsExamples.push({ author, views: [otherViewId, selectedViewId], selectedValues: [false, null] });
  } finally {
   if (observation) client.releaseObservation(observation.observationId);
   await desktopHandle.closeApp(appId);
  }
 }
} finally {
 const report = await workRuntime.beginShutdown().completion;
 facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
}
`;
const neutralHostExample = String.raw`
import { runExample } from './out-7.0.2/runtime-host.js';
const data=await fs.mkdtemp(fileURLToPath(new URL('./runtime-doc-data-', import.meta.url)));
try {
 const result=await runExample(new URL('./runtime-app.mjs',import.meta.url).href,data);
 assert.equal(result.outcomes.length,2);assert.ok(result.outcomes.every(o=>o.status==='succeeded'));
 assert.equal(result.close.ok,true);assert.equal(result.close.resourcesReleased,true);
 facts.runtimeExample=true;facts.reports.push(result.close);facts.runtimeOutcomes=result.outcomes;
} finally { await fs.rm(data,{recursive:true,force:true}); }
`;
const test = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@aotui/runtime';
import { coreTutorialFacts } from './core-out/core-example.js';
import { selectedViewId, otherViewId } from './core-out/work-items.js';
const facts = { profile: ${JSON.stringify(profile)}, coreTutorialFacts, calls: [], reports: [] };
assert.equal(coreTutorialFacts.handlerEntries, 3);
assert.deepEqual(coreTutorialFacts.witness, [{ text: 'old!', frozen: true }, { text: 'new!', frozen: true }]);
for (const field of ['observationSlots', 'logicalBytes', 'leases', 'bindings', 'stateOwners']) assert.equal(coreTutorialFacts[field], 0, field);
assert.equal(coreTutorialFacts.restoredValue, 41);
assert.equal(coreTutorialFacts.storedKeys, 1);
${workItemsExamples}
${plain ? '' : fullAuthorExamples + neutralHostExample}
await fs.writeFile(new URL('./runtime-facts.json',import.meta.url),JSON.stringify(facts,null,2)+'\n');
console.log(JSON.stringify(facts));
`;
const workerExample = path.join(output, 'execute.mjs');
await fs.writeFile(workerExample, test);
await checked('worker-execution', [workerExample]);
facts.documents = JSON.parse(await fs.readFile(path.join(output, 'runtime-facts.json'), 'utf8'));
if (!plain) {
  const app = path.join(output, 'source-host-app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'index.mjs'), "import { workItemsApp } from '../core-out/work-items-plain.js';\nexport default workItemsApp('work_items');\n");
  const authorText = await fs.readFile(authorGuide, 'utf8');
  const manifest = JSON.parse(authorText.split('```json\n')[1]?.split('\n```')[0]);
  await fs.writeFile(path.join(app, 'aoapp.json'), JSON.stringify({ ...manifest, entry: { main: './index.mjs' } }));
  const result = await checked('source-host-execution', [sourceHostExample, app], { source: hostGuide });
  const { receipt, workspace } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.outcomeStatus, 'succeeded');
  assert.match(workspace, /Inspections: 1\b/);
  assert.match(workspace, /"selected":null/);
  assert.doesNotMatch(JSON.stringify(receipt), /Inspections:/);
  facts.documents.sourceHostExample = { receipt, workspace, resourcesReleased: true };
}
facts.passed = true;
await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n');
console.log(`Installed documentation (${profile}): strict TypeScript ${version}, pure Core and real Worker scenarios passed.`);
