import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@aotui/runtime';
import { coreFixtureFacts } from './core-out/public-core.js';
import { stateFixtureFacts } from './core-out/public-memory-state.js';
import { selectedViewId, otherViewId } from './core-out/work-items.js';

const profile = process.argv[2];
const facts = { profile, core: coreFixtureFacts, state: stateFixtureFacts, calls: [], reports: [] };

assert.equal(coreFixtureFacts.handlerEntries, 3);
assert.deepEqual(coreFixtureFacts.witness, [{ text: 'old!', frozen: true }, { text: 'new!', frozen: true }]);
for (const field of ['observationSlots', 'leases', 'bindings']) {
  assert.equal(coreFixtureFacts[field], 0, field);
}
assert.deepEqual(stateFixtureFacts, { restoredValue: 41, stateOwners: 0, storedKeys: 1 });

const workRuntime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
facts.workItemsExamples = [];
try {
 const desktop = await workRuntime.createDesktop('work-items');
 const examples = [['plain', './core-out/work-items-plain.js']];
 if (facts.profile === 'full') examples.push(['preact', './full-out/work-items-preact.js']);
 for (const [author, example] of examples) {
  const appId = 'work_' + author;
  const entry = new URL('./work-' + author + '.mjs', import.meta.url);
  await fs.writeFile(entry, 'import { workItemsApp } from ' + JSON.stringify(example) + ';\n' +
    'export default workItemsApp(' + JSON.stringify(appId) + ');\n');
  const app = await desktop.installDynamicWorkerApp(entry.href, { installationId: appId, name: appId,
    config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
  let observation, turn;
  async function observe() {
   const end = Date.now() + 15000;
   for (;;) {
    const captured = await app.observe();
    if (captured.status === 'prepared') {
     const adopted = desktop.adoptTurn({ apps: [{ candidate: captured.candidate }] });
     assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
     observation = captured.candidate.observation;
     turn = adopted.turn;
     return observation;
    }
    if (Date.now() > end) throw Error('Work Items projection unavailable: ' + JSON.stringify(captured.issue));
    await new Promise(resolve => setTimeout(resolve, 20));
   }
  }
  try {
   const first = await observe();
   const selectedView = first.views.find(view => view.id === selectedViewId);
   for (const marker of ['(protected selected: Data)', '(protected items: Data[])', '(items[0])']) {
    assert.ok(selectedView.content.value.includes(marker), marker);
   }
   const selections = [
    [otherViewId, '$ref.' + appId + '.' + otherViewId + '.selected', false],
    [selectedViewId, '$ref.' + appId + '.' + selectedViewId + '.selected', null],
    [otherViewId, '$ref.' + appId + '.' + selectedViewId + '.items[0]', 0],
    [otherViewId, '$ref.' + appId + '.' + selectedViewId + '.items', [0, false, '', null, { nested: [1, [false]] }]],
   ];
   for (const [index, [id, selected, expected]] of selections.entries()) {
    const current = observation ?? await observe();
    assert.deepEqual(current.views.filter(view => view.type === 'Item').map(view => view.id), [otherViewId, selectedViewId]);
    const tools = current.tools.filter(tool => tool.name === 'inspect');
    assert.equal(tools.length, 1);
    const result = await turn.invoke(appId, { observationId: current.observationId, toolId: tools[0].id,
     invocationId: 'work-' + index, viewId: id, input: {  selected } });
    assert.equal(result.receipt?.outcome.status, 'succeeded', JSON.stringify(result));
    const updated = await observe();
    const original = await app.readReceipt({ observationId: current.observationId, invocationId: 'work-' + index });
    assert.deepEqual(original, result);
    const workspace = updated.views.find(view => view.id === 'workspace_1').content.value;
    assert.deepEqual(JSON.parse(workspace.trim().split('\n').at(-1)).selected, expected);
   }
   facts.workItemsExamples.push({ author, views: [otherViewId, selectedViewId],
    selectedValues: selections.map(([, , value]) => value) });
  } finally {
   turn?.release();
   assert.equal((await app.beginClose().completion).ok, true);
  }
 }
} finally {
 const report = await workRuntime.beginClose().completion;
 facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
}

if (profile === 'full') {
  const sdk = await import('@aotui/sdk');
  const copy = await import('@aotui/sdk-copy');
  assert.notEqual(await fs.realpath(fileURLToPath(import.meta.resolve('@aotui/sdk'))),
    await fs.realpath(fileURLToPath(import.meta.resolve('@aotui/sdk-copy'))));
  assert.notEqual(sdk.defineViewType, copy.defineViewType);
  assert.equal(sdk.useState, copy.useState, 'Both SDK copies use the same physical Preact');
  const primaryCore = import.meta.resolve('@aotui/core', import.meta.resolve('@aotui/sdk'));
  const primaryProducer = import.meta.resolve('@aotui/core/producer', import.meta.resolve('@aotui/sdk'));
  const secondCore = import.meta.resolve('@aotui/core', import.meta.resolve('@aotui/sdk-copy'));
  assert.notEqual(primaryCore, secondCore);
  assert.deepEqual(await fs.readFile(new URL(primaryCore)), await fs.readFile(new URL(secondCore)));
  facts.coreCopies = [primaryCore, secondCore];
  const { SnapshotDataError } = await import(primaryCore);
  const { SemanticProjectionCoordinator } = await import(primaryProducer);
  const { SnapshotDataError: CopyDataError } = await import(secondCore);
  const projection = new SemanticProjectionCoordinator({ identity: () => ({ appId: 'copy_views', instanceId: 'diagnostic' }) });
  const issue = { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.refs.example', message: 'Invalid Ref from the other Core' };
  const error = new CopyDataError(issue.code, issue.path, issue.message);
  assert.equal(error instanceof SnapshotDataError, false);
  const rejectedProjection = projection.commit(() => { throw error; });
  assert.deepEqual(rejectedProjection.issue, issue);
  projection.close();
  facts.copyDiagnostic = rejectedProjection.issue;
  const copiesRuntime = createRuntime();
  facts.preactCopies = [];
  try {
   const desktop = await copiesRuntime.createDesktop('preact-copies');
   async function install(mode) {
    const entry = new URL('./copy-' + mode + '.mjs', import.meta.url);
    await fs.writeFile(entry, 'import { copyApp } from "./full-out/preact-sdk-copies.js";\n' +
      'export default copyApp(' + JSON.stringify(mode) + ');\n');
    const appFolder = new URL('./copy-manifest-' + mode + '/', import.meta.url);
    await fs.mkdir(appFolder, { recursive: true });
    await fs.writeFile(new URL('aoapp.json', appFolder), JSON.stringify({
     app_name: 'copy_views', version: '0.1.0', entry: { main: '../copy-' + mode + '.mjs' },
     toolAuthoringProtocol: 'view-type-tools-v7', appLifecycleSupport: 'app-lifecycle-v2',
    }));
    const installationId = await desktop.registerPendingApp({
     installationId: mode, localPath: fileURLToPath(appFolder), config: { word: mode },
    });
    return desktop.openApp(installationId);
   }
   async function capture(app) {
    const result = await app.observe();
    assert.equal(result.status, 'prepared', JSON.stringify(result));
    return result.candidate;
   }
   const pages = [];
   for (const mode of ['local', 'direct', 'explicit']) {
    const app = await install(mode);
    const { appId } = app;
    const candidate = await capture(app);
    const current = candidate.observation;
    assert.deepEqual(current.views.map(view => [view.id, view.type]), [['detail', 'file']]);
    assert.match(current.views[0].content.value, /\[Select\]\(private value: CopyValue\)/);
    assert.match(current.views[0].content.value, /Selected none/);
    assert.ok(current.views[0].content.value.includes(appId));
    assert.equal(current.refs[0].refId, 'value');
    const [tool] = current.tools;
    assert.equal(tool.name, 'choose');
    assert.deepEqual(tool.inputSchema.required, ['value']);
    pages.push({ mode, app, appId, candidate, current, tool });
   }
   assert.deepEqual(pages.map(page => page.appId), ['copy_views', 'copy_views_1', 'copy_views_2']);
   const adopted = desktop.adoptTurn({ apps: pages.map(({ candidate }) => ({ candidate })) });
   assert.equal(adopted.status, 'adopted');
   for (const { mode, app, appId, current, tool } of pages) {
    const request = { observationId: current.observationId, toolId: tool.id,
      invocationId: 'select-' + mode, input: { value: '$ref.' + appId + '.detail.value' } };
    const result = await adopted.turn.invoke(appId, request);
    assert.equal(result.receipt?.outcome.status, 'succeeded', JSON.stringify(result));
    const nextCandidate = await capture(app);
    const next = nextCandidate.observation;
    assert.ok(next.views[0].content.value.includes('Selected ' + mode), 'Only this App receives its page value');
    assert.equal(next.views[0].viewInstanceId, current.views[0].viewInstanceId);
    nextCandidate.discard();
    facts.preactCopies.push({ mode, appId, view: next.views[0], receipt: result.receipt });
   }
   facts.rejectedCopyDeclarations = [];
   for (const mode of ['same-name', 'other-name']) {
    await assert.rejects(install(mode), error => {
     assert.equal(error.code, 'INSTALL_FAILED');
     const open = error.cause;
     assert.equal(open?.code, 'E_OPEN_FAILED');
     assert.equal(open?.cause?.code, 'VIEW_TYPE_INVALID');
     assert.match(open.cause.message, /App.s declared descriptor/);
     facts.rejectedCopyDeclarations.push({ mode, code: open.cause.code });
     return true;
    });
   }
  } finally {
   const report = await copiesRuntime.beginClose().completion;
   facts.reports.push(report);
   assert.equal(report.ok, true);
   assert.equal(report.resourcesReleased, true);
  }

  const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
  const runtime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 2 } });
  const held = [];
  let source;
  try {
   const desktop = await runtime.createDesktop('file-apps');
   const url = new URL('./full-out/file-app.js', import.meta.url).href;
   for (const id of ['file_demo', 'file_demo_1']) await desktop.installDynamicWorkerApp(url, { installationId: id, name: 'file_demo', config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
   source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
   const messages = c => c.messages.map(m => String(m.content));
   const views = (c, app, id) => messages(c).filter(m => m.startsWith('<view ') && m.includes('app_id="'+app+'"') && (!id || m.includes('view_id="'+id+'"')));
   const name = (c, app, tool) => { const n = app+'-'+tool; assert.ok(c.tools[n], 'Tool available: '+n); return n; };
   async function capture(ready) {
    const end = Date.now()+15000;
    for (;;) {
     const c = await source.getContext();
     if (ready(c)) { await c.adopt(); held.push(c); return c; }
     await c.release?.();
     if (Date.now()>end) throw Error('File App did not reach expected projection');
     await new Promise(r=>setTimeout(r,20));
    }
   }
   async function call(c, app, tool, args) {
    const result = await c.executeTool(name(c,app,tool), { view_id: 'workspace_1', ...args }, 'files-'+facts.calls.length);
    facts.calls.push({ app, tool, result }); return result;
   }
   let current = await capture(c => ['file_demo','file_demo_1'].every(app=>c.tools[app+'-open_file']));
   const catalog = views(current,'file_demo','root_1')[0]; assert.ok(catalog);
   assert.ok(catalog.includes('edit_file'));
   assert.ok(!catalog.includes('Edit an opened demo file and read its updated View.'));
   assert.ok(!catalog.includes('inputSchema') && !catalog.includes('additionalProperties'));
   assert.equal(Object.keys(current.tools).filter(n=>n.endsWith('-edit_file')).length,0);
   for (const [app, file] of [['file_demo','a.txt'],['file_demo','b.txt'],['file_demo_1','a.txt']]) assert.equal((await call(current,app,'open_file',{filePath:file})).outcomeStatus,'succeeded');
   current = await capture(c=>views(c,'file_demo').length===4 && c.tools['file_demo-edit_file'] && c.tools['file_demo_1-edit_file']);
   const observed = current;
   assert.equal(Object.keys(current.tools).filter(n=>n==='file_demo-edit_file').length,1);
   const edit = await call(current,'file_demo','edit_file',{view_id:'file_a_1',content:'UPDATED_A'});
   assert.equal(edit.outcomeStatus,'succeeded'); assert.ok(!JSON.stringify(edit).includes('UPDATED_A'));
   assert.equal((await call(current,'file_demo','close_file',{filePath:'b.txt'})).outcomeStatus,'succeeded');
   const denied = await call(current,'file_demo','edit_file',{view_id:'file_b_1',content:'MUST_NOT_APPEAR'});
   assert.equal(denied.outcomeStatus,'rejected');assert.equal(denied.error.code,'VIEW_INSTANCE_REVOKED');
   current = await capture(c=>views(c,'file_demo','file_a_1')[0]?.includes('UPDATED_A') && views(c,'file_demo','file_b_1').length===0);
   assert.ok(views(current,'file_demo_1','file_a_1')[0].includes('Initial A'));
   assert.ok(!views(current,'file_demo_1','file_a_1')[0].includes('UPDATED_A'));
   assert.equal(views(current,'file_demo','root_1')[0],catalog);
   assert.equal((await call(current,'file_demo','close_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
   const stale = await call(observed,'file_demo','edit_file',{view_id:'file_a_1',content:'STALE'});assert.equal(stale.outcomeStatus,'rejected');
   current = await capture(c=>!c.tools['file_demo-edit_file'] && views(c,'file_demo').length===2);
   assert.ok(current.tools['file_demo_1-edit_file'],'Other App still active');
   assert.equal((await call(current,'file_demo','open_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
   current = await capture(c=>!!c.tools['file_demo-edit_file']);
   assert.equal((await call(observed,'file_demo','edit_file',{view_id:'file_a_1',content:'STALE_AGAIN'})).outcomeStatus,'rejected');
   assert.equal(views(current,'file_demo','root_1')[0],catalog);
   facts.fileExample = true;
  } finally {
   for (const c of held) await c.release?.();source?.dispose();
   const report=await runtime.beginClose().completion;facts.reports.push(report);
   assert.equal(report.ok,true);assert.equal(report.resourcesReleased,true);
  }
  const refRuntime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 1 } });
  const refHeld = [];
  let refSource;
  try {
   const desktop = await refRuntime.createDesktop('ref-app');
   await desktop.installDynamicWorkerApp(new URL('./full-out/ref-app.js', import.meta.url).href,
    { name: 'notes_example', config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
   refSource = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
   const text = c => c.messages.map(m => String(m.content)).join('\n');
   async function observe(ready) {
    const end = Date.now() + 15000;
    for (;;) {
     const c = await refSource.getContext();
     if (ready(c)) { await c.adopt(); refHeld.push(c); return c; }
     await c.release?.();
     if (Date.now() > end) throw Error('Ref App projection did not become visible');
     await new Promise(r => setTimeout(r, 20));
    }
   }
   let context = await observe(c => c.tools['notes_example-open_notes']);
   assert.ok(!context.tools['notes_example-inspect_note']);
   assert.equal((await context.executeTool('notes_example-open_notes', { view_id: 'workspace_1' }, 'notes-open')).outcomeStatus, 'succeeded');
   context = await observe(c => c.tools['notes_example-inspect_note'] && c.tools['notes_example-inspect_notes']);
   for (const ref of ['private current: Note', 'private notes: Note[]', '(notes[0])']) assert.ok(text(context).includes(ref));
   for (const [tool, args, expected] of [
    ['inspect_note', { note: '$ref.notes_example.detail_1.current' }, 'First note: First line'],
    ['inspect_notes', { notes: '$ref.notes_example.detail_1.notes' }, 'Second note: Another note'],
    ['inspect_note', { note: '$ref.notes_example.detail_1.notes[0]' }, 'First note: First line'],
    ['inspect_selection', { selected: ['$ref.notes_example.detail_1.notes[1]', '$ref.notes_example.detail_1.notes[0]', '$ref.notes_example.detail_1.notes[1]'], primary: '$ref.notes_example.detail_1.current', whole: '$ref.notes_example.detail_1.notes' }, 'Second note: Another note'],
    ['inspect_selection', { selected: [] }, 'No notes selected.'],
   ]) {
    const result = await context.executeTool('notes_example-' + tool, { view_id: 'detail_1', ...args }, 'ref-' + facts.calls.length);
    facts.calls.push({ app: 'notes', tool, args, result });
    assert.equal(result.outcomeStatus, 'succeeded');
    assert.ok(!JSON.stringify(result).includes('First line'), 'Business content stays in the View');
    context = await observe(c => c.messages.some(m => String(m.content).startsWith('<view view_id="detail_1"') && String(m.content).split('## Inspection')[1]?.includes(expected)));
    if (tool === 'inspect_selection' && args.selected.length) {
     const projection = context.messages.map(m => String(m.content)).find(m => m.startsWith('<view view_id="detail_1"'))?.split('## Inspection')[1];
     assert.match(projection, /Second note: Another note[\s\S]*First note: First line[\s\S]*Second note: Another note[\s\S]*First note: First line[\s\S]*First note: First line[\s\S]*Second note: Another note/);
    }
   }
   for (const [tool, args] of [
    ['inspect_notes', { notes: '$ref.notes_example.detail_1.current' }],
    ['inspect_note', { note: 'Note:current' }],
    ['inspect_selection', { selected: [], primary: null }],
    ['inspect_selection', { selected: ['$ref.notes_example.detail_1.missing'] }],
   ]) {
    const result = await context.executeTool('notes_example-' + tool, { view_id: 'detail_1', ...args }, 'invalid-' + facts.calls.length);
    assert.equal(result.outcomeStatus, 'rejected');
    facts.calls.push({ app: 'notes', tool, args, result });
   }
   const old = context;
   assert.equal((await context.executeTool('notes_example-close_notes', { view_id: 'workspace_1' }, 'notes-close')).outcomeStatus, 'succeeded');
   context = await observe(c => !c.tools['notes_example-inspect_note']);
   assert.equal((await old.executeTool('notes_example-inspect_note', { view_id: 'detail_1', note: '$ref.notes_example.detail_1.current' }, 'closed-note')).outcomeStatus, 'rejected');
   assert.ok(!text(context).includes('(notes[0])'));
   facts.refExample = true;
  } finally {
   for (const c of refHeld) await c.release?.(); refSource?.dispose();
   const report = await refRuntime.beginClose().completion;
   facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
  }

  const { runManagedHost } = await import('./full-out/managed-host.js');
  const data=await fs.mkdtemp(fileURLToPath(new URL('./managed-host-data-', import.meta.url)));
  try {
   const localPath = new URL('./managed-host-app/', import.meta.url);
   await fs.mkdir(localPath, { recursive: true });
   await fs.writeFile(new URL('aoapp.json', localPath), JSON.stringify({
    app_name: 'interaction_example', version: '0.1.0', entry: { main: '../managed-host-app.mjs' },
    toolAuthoringProtocol: 'view-type-tools-v7', appLifecycleSupport: 'app-lifecycle-v2',
   }));
   const result = await runManagedHost(fileURLToPath(localPath), data);
   assert.equal(result.outcomes.length,2);assert.ok(result.outcomes.every(o=>o.status==='succeeded'));
   assert.equal(result.close.ok,true);assert.equal(result.close.resourcesReleased,true);
   facts.runtimeExample=true;facts.reports.push(result.close);facts.runtimeOutcomes=result.outcomes;
  } finally { await fs.rm(data,{recursive:true,force:true}); }
}
console.log(JSON.stringify(facts));
