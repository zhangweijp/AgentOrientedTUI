import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@aotui/runtime';
import { coreFixtureFacts } from './core-out/public-core.js';
import { selectedViewId, otherViewId } from './core-out/work-items.js';

const profile = process.argv[2];
const facts = { profile, core: coreFixtureFacts, calls: [], reports: [] };

assert.equal(coreFixtureFacts.handlerEntries, 3);
assert.deepEqual(coreFixtureFacts.witness, [{ text: 'old!', frozen: true }, { text: 'new!', frozen: true }]);
for (const field of ['observationSlots', 'logicalBytes', 'leases', 'bindings', 'stateOwners']) {
  assert.equal(coreFixtureFacts[field], 0, field);
}
assert.equal(coreFixtureFacts.restoredValue, 41);
assert.equal(coreFixtureFacts.storedKeys, 1);

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
   const first = await observe();
   const selectedView = first.views.find(view => view.id === selectedViewId);
   for (const marker of ['(Data:selected)', '(Data[]:items)', '(Data:items[0])']) {
    assert.ok(selectedView.content.value.includes(marker), marker);
   }
   const selections = [
    [otherViewId, otherViewId + '.selected', false],
    [selectedViewId, selectedViewId + '.selected', null],
    [otherViewId, selectedViewId + '.items[0]', 0],
    [otherViewId, selectedViewId + '.items', [0, false, '', null, { nested: [1, [false]] }]],
   ];
   for (const [index, [id, selected, expected]] of selections.entries()) {
    const current = observation ?? await observe();
    assert.deepEqual(current.views.filter(view => view.type === 'Item').map(view => view.id), [otherViewId, selectedViewId]);
    const tools = current.tools.filter(tool => tool.name === 'inspect');
    assert.equal(tools.length, 1);
    const result = await client.invoke({ observationId: current.observationId, toolId: tools[0].id,
     invocationId: 'work-' + index, input: { view_id: id, selected } });
    assert.equal(result.receipt?.outcome.status, 'succeeded', JSON.stringify(result));
    const updated = await observe();
    const original = await client.readReceipt({ observationId: current.observationId, invocationId: 'work-' + index });
    assert.deepEqual(original, result);
    const workspace = updated.views.find(view => view.id === 'workspace').content.value;
    assert.deepEqual(JSON.parse(workspace.trim().split('\n').at(-1)).selected, expected);
   }
   facts.workItemsExamples.push({ author, views: [otherViewId, selectedViewId],
    selectedValues: selections.map(([, , value]) => value) });
  } finally {
   if (observation) client.releaseObservation(observation.observationId);
   await desktopHandle.closeApp(appId);
  }
 }
} finally {
 const report = await workRuntime.beginShutdown().completion;
 facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
}

if (profile === 'full') {
  const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
  const runtime = createRuntime({ worker: { timeoutMs: 45000, maxWorkers: 2 } });
  const held = [];
  let source;
  try {
   const desktop = await runtime.createDesktop('file-apps');
   const url = new URL('./full-out/file-app.js', import.meta.url).href;
   for (const id of ['filesa', 'filesb']) await runtime.installDynamicWorkerApp(desktop, url, { appId: id, config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
   source = new SemanticAOTUIDrivenSource(runtime.getDesktop(desktop), runtime, { includeInstruction: false });
   const messages = c => c.messages.map(m => String(m.content));
   const views = (c, app, id) => messages(c).filter(m => m.startsWith('<view ') && m.includes('app_id="'+app+'"') && (!id || m.includes('id="'+id+'"')));
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
    const result = await c.executeTool(name(c,app,tool), { view_id: 'workspace', ...args }, 'files-'+facts.calls.length);
    facts.calls.push({ app, tool, result }); return result;
   }
   let current = await capture(c => ['filesa','filesb'].every(app=>c.tools[app+'-open_file']));
   const catalog = views(current,'filesa','root')[0]; assert.ok(catalog);
   assert.ok(catalog.includes('edit_file'));
   assert.ok(!catalog.includes('Edit an opened demo file and read its updated View.'));
   assert.ok(!catalog.includes('inputSchema') && !catalog.includes('additionalProperties'));
   assert.equal(Object.keys(current.tools).filter(n=>n.endsWith('-edit_file')).length,0);
   for (const [app, file] of [['filesa','a.txt'],['filesa','b.txt'],['filesb','a.txt']]) assert.equal((await call(current,app,'open_file',{filePath:file})).outcomeStatus,'succeeded');
   current = await capture(c=>views(c,'filesa').length===4 && c.tools['filesa-edit_file'] && c.tools['filesb-edit_file']);
   const observed = current;
   assert.equal(Object.keys(current.tools).filter(n=>n==='filesa-edit_file').length,1);
   const edit = await call(current,'filesa','edit_file',{view_id:'file_a',content:'UPDATED_A'});
   assert.equal(edit.outcomeStatus,'succeeded'); assert.ok(!JSON.stringify(edit).includes('UPDATED_A'));
   assert.equal((await call(current,'filesa','close_file',{filePath:'b.txt'})).outcomeStatus,'succeeded');
   const denied = await call(current,'filesa','edit_file',{view_id:'file_b',content:'MUST_NOT_APPEAR'});
   assert.equal(denied.outcomeStatus,'rejected');assert.equal(denied.error.code,'VIEW_INSTANCE_REVOKED');
   current = await capture(c=>views(c,'filesa','file_a')[0]?.includes('UPDATED_A') && views(c,'filesa','file_b').length===0);
   assert.ok(views(current,'filesb','file_a')[0].includes('Initial A'));
   assert.ok(!views(current,'filesb','file_a')[0].includes('UPDATED_A'));
   assert.equal(views(current,'filesa','root')[0],catalog);
   assert.equal((await call(current,'filesa','close_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
   const stale = await call(observed,'filesa','edit_file',{view_id:'file_a',content:'STALE'});assert.equal(stale.outcomeStatus,'rejected');
   current = await capture(c=>!c.tools['filesa-edit_file'] && views(c,'filesa').length===2);
   assert.ok(current.tools['filesb-edit_file'],'Other App still active');
   assert.equal((await call(current,'filesa','open_file',{filePath:'a.txt'})).outcomeStatus,'succeeded');
   current = await capture(c=>!!c.tools['filesa-edit_file']);
   assert.equal((await call(observed,'filesa','edit_file',{view_id:'file_a',content:'STALE_AGAIN'})).outcomeStatus,'rejected');
   assert.equal(views(current,'filesa','root')[0],catalog);
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
   const desktop = await refRuntime.createDesktop('ref-app');
   await refRuntime.installDynamicWorkerApp(desktop, new URL('./full-out/ref-app.js', import.meta.url).href,
    { appId: 'notes', config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
   refSource = new SemanticAOTUIDrivenSource(refRuntime.getDesktop(desktop), refRuntime, { includeInstruction: false });
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
   let context = await observe(c => c.tools['notes-open_notes']);
   assert.ok(!context.tools['notes-inspect_note']);
   assert.equal((await context.executeTool('notes-open_notes', { view_id: 'workspace' }, 'notes-open')).outcomeStatus, 'succeeded');
   context = await observe(c => c.tools['notes-inspect_note'] && c.tools['notes-inspect_notes']);
   for (const ref of ['Note:current', 'Note[]:notes', 'Note:notes[0]']) assert.ok(text(context).includes(ref));
   for (const [tool, args, expected] of [
    ['inspect_note', { note: 'detail.current' }, 'First note: First line'],
    ['inspect_notes', { notes: 'detail.notes' }, 'Second note: Another note'],
    ['inspect_note', { note: 'detail.notes[0]' }, 'First note: First line'],
    ['inspect_selection', { selected: ['detail.notes[1]', 'detail.notes[0]', 'detail.notes[1]'], primary: 'detail.current', whole: 'detail.notes' }, 'Second note: Another note'],
    ['inspect_selection', { selected: [] }, 'No notes selected.'],
   ]) {
    const result = await context.executeTool('notes-' + tool, { view_id: 'detail', ...args }, 'ref-' + facts.calls.length);
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
    const result = await context.executeTool('notes-' + tool, { view_id: 'detail', ...args }, 'invalid-' + facts.calls.length);
    assert.equal(result.outcomeStatus, 'rejected');
    facts.calls.push({ app: 'notes', tool, args, result });
   }
   const old = context;
   assert.equal((await context.executeTool('notes-close_notes', { view_id: 'workspace' }, 'notes-close')).outcomeStatus, 'succeeded');
   context = await observe(c => !c.tools['notes-inspect_note']);
   assert.equal((await old.executeTool('notes-inspect_note', { view_id: 'detail', note: 'detail.current' }, 'closed-note')).outcomeStatus, 'rejected');
   assert.ok(!text(context).includes('Note:notes[0]'));
   facts.refExample = true;
  } finally {
   for (const c of refHeld) await c.release?.(); refSource?.dispose();
   const report = await refRuntime.beginShutdown().completion;
   facts.reports.push(report); assert.equal(report.ok, true); assert.equal(report.resourcesReleased, true);
  }

  const { runManagedHost } = await import('./full-out/managed-host.js');
  const data=await fs.mkdtemp(fileURLToPath(new URL('./managed-host-data-', import.meta.url)));
  try {
   const result=await runManagedHost(new URL('./managed-host-app.mjs',import.meta.url).href,data);
   assert.equal(result.outcomes.length,2);assert.ok(result.outcomes.every(o=>o.status==='succeeded'));
   assert.equal(result.close.ok,true);assert.equal(result.close.resourcesReleased,true);
   facts.runtimeExample=true;facts.reports.push(result.close);facts.runtimeOutcomes=result.outcomes;
  } finally { await fs.rm(data,{recursive:true,force:true}); }
}
console.log(JSON.stringify(facts));
