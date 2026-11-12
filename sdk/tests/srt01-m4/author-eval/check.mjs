import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createViewOwnedTools } from '@aotui/runtime/core';
import { createAppId, createDesktopId } from '@aotui/runtime/spi';
const task = Number(process.argv[2]);
const facts = { task, passed: false, critical: [], resources: [] };
const cleanups = [];
function requireCritical(name, condition) { assert.ok(condition, name); facts.critical.push(name); }
function tool(registry, name) { const item = registry.listTools().find(t => t.name === name); assert.ok(item, 'Tool active: ' + name); return item; }
async function invoke(registry, name, input, observed = tool(registry, name)) { return registry.invokeTypeTool(observed, observed.execution, input); }
try {
 if (task === 2) {
  const app = await import('./out/app.js');
  const a = createViewOwnedTools('counter_a', 'run_a'), b = createViewOwnedTools('counter_b', 'run_b');
  cleanups.push(() => a.dispose(), () => b.dispose());
  const oa = { value: 0, label: 'owner_a' }, ob = { value: 100, label: 'owner_b' };
  const ca = app.createCounterBindings(a, oa), cb = app.createCounterBindings(b, ob);
  cleanups.push(() => ca.dispose(), () => cb.dispose());
  assert.equal(a.inspect().bindings, 0); assert.equal(b.inspect().bindings, 0);
  const before = JSON.stringify(app.catalog()); ca.commit(true, 'A1'); cb.commit(true, 'B1');
  const va = a.mount('counter', 'Counter'), vb = b.mount('counter', 'Counter');
  const first = tool(a, 'increment');
  const one = await invoke(a, 'increment', { amount: 2 });
  assert.equal(one.phase, 'entered-returned'); assert.equal(one.result.success, true);
  assert.deepEqual(one.result.data, { label: 'A1', value: 2 });
  assert.equal((await invoke(b, 'increment', { amount: 3 })).result.data.value, 103);
  requireCritical('App owners isolated', oa.value === 2 && ob.value === 103);
  requireCritical('business owners not frozen', !Object.isFrozen(oa) && !Object.isFrozen(ob));
  ca.commit(true, 'A2'); assert.equal(tool(a, 'increment').execution.activationId, first.execution.activationId);
  assert.equal((await invoke(a, 'increment', { amount: 1 }, first)).result.data.label, 'A2');
  ca.commit(false, 'disabled'); requireCritical('disabled qualification rejected before entry', (await invoke(a, 'increment', { amount: 100 }, first)).phase === 'not-entered');
  ca.commit(true, 'A3'); assert.notEqual(tool(a, 'increment').execution.activationId, first.execution.activationId);
  requireCritical('old qualification stays revoked', (await invoke(a, 'increment', { amount: 100 }, first)).phase === 'not-entered');
  const other = app.createCounterBindings(a, { value: 0, label: 'other' });
  assert.throws(() => other.commit(false, 'blocked'), e => e.code === 'TOOL_BINDING_OWNER_CONFLICT'); other.dispose();
  requireCritical('second disabled owner rejected without harming first', (await invoke(a, 'increment', { amount: 1 })).result.data.label === 'A3');
  assert.equal(JSON.stringify(app.catalog()), before);
  ca.dispose(); const next = app.createCounterBindings(a, oa); next.commit(true, 'successor');
  ca.dispose(); assert.equal((await invoke(a, 'increment', { amount: 1 })).result.data.label, 'successor'); next.dispose(); cb.dispose();
  a.unmount(va.viewInstanceId); b.unmount(vb.viewInstanceId); a.dispose(); b.dispose();
  facts.resources.push(a.inspect(), b.inspect());
 } else {
  const { JSDOM } = await import('jsdom'); const dom = new JSDOM('<!doctype html><body></body>');
  cleanups.push(() => dom.window.close());
  for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Event']) globalThis[key] = dom.window[key];
  const { act } = await import('preact/test-utils'); const app = await import('./out/app.js');
  const registry = createViewOwnedTools('author_app', 'author_run'); cleanups.push(() => registry.dispose());
  let depth = 0, lifecycle;
  const context = { appId: createAppId('author_app'), desktopId: createDesktopId('author_desktop'), markDirty() {},
   projection: { beginCommit() { depth++; }, endCommit() { assert.ok(depth > 0); depth--; }, recordMutation() { return 0; }, token() { return { epoch: 0, ready: depth === 0 }; }, subscribe() { return () => {}; } },
   refExporter: { registerRef() { throw new Error('Ref not part of this task'); } },
   appLifecycle: { protocol: 'app-lifecycle-v2', register(callbacks) { assert.equal(lifecycle, undefined); lifecycle = callbacks; return () => { callbacks.stop?.(); callbacks.close?.(); }; } },
   appTypeTools: registry, viewTools: { mount(id, type) { return registry.mount(id, type).viewInstanceId; }, unmount(id) { registry.unmount(id); }, },
  };
  let renderer; await act(async () => { renderer = await app.default.initialize(context); });
  const container = document.getElementById('app-root-author_app');
  cleanups.push(() => renderer.close());
  const catalog = () => { const node = container.querySelector('[data-role="tool-catalog"]'); assert.ok(node, 'Static ToolCatalog is present'); return node.outerHTML; };
  const before = catalog();
  const call = async (name, input, observed) => { let result; await act(async () => { result = await invoke(registry, name, input, observed); }); return result; };
  if (task === 1) {
   assert.equal(registry.listTools().filter(t => t.name === 'edit_file').length, 1);
   assert.equal(container.querySelectorAll('[data-view-type="FileDetail"]').length, 2);
   assert.ok(container.textContent.includes('INITIAL_A') && container.textContent.includes('INITIAL_B'));
   assert.ok(container.querySelector('[data-view-id="file_a"] tool-ref'));
   const first = tool(registry, 'edit_file');
   const edited = await call('edit_file', { filePath: 'a.txt', content: 'UPDATED_A' }); assert.equal(edited.result.success, true);
   requireCritical('receipt does not duplicate current file data', !JSON.stringify(edited.result).includes('UPDATED_A'));
   assert.ok(container.textContent.includes('UPDATED_A') && !container.textContent.includes('INITIAL_A'));
   assert.equal((await call('close_file', { filePath: 'b.txt' })).result.success, true);
   requireCritical('closing one file preserves shared type qualification', tool(registry, 'edit_file').execution.activationId === first.execution.activationId);
   const denied = await call('edit_file', { filePath: 'b.txt', content: 'MUST_NOT_APPEAR' }, first);
   requireCritical('closed business object rejected by App', denied.phase === 'entered-returned' && !denied.result.success && denied.result.error.code === 'FILE_NOT_OPEN');
   assert.ok(!container.textContent.includes('MUST_NOT_APPEAR'));
   assert.equal((await call('edit_file', { filePath: 'a.txt', content: 'LATEST_A' }, first)).result.success, true);
   assert.equal((await call('close_file', { filePath: 'a.txt' })).result.success, true);
   requireCritical('last View close revokes old qualification', (await call('edit_file', { filePath: 'a.txt', content: 'STALE' }, first)).phase === 'not-entered');
   assert.equal((await call('open_file', { filePath: 'a.txt' })).result.success, true);
   requireCritical('reopen does not revive prior qualification', tool(registry, 'edit_file').execution.activationId !== first.execution.activationId);
   assert.equal(container.querySelector('[data-view-id="file_a"]').getAttribute('data-view-type'), 'FileDetail');
  } else {
   assert.equal(Object.keys(app.repairTools).length, 1); assert.equal(registry.listTools().length, 1);
   assert.ok(container.textContent.includes('INITIAL_RECORD'));
   const invalid = await call('rename', { code: 7 }); requireCritical('corrected Schema rejects numeric code before entry', invalid.phase === 'not-entered');
   const changed = await call('rename', { code: 'new_record' }); assert.equal(changed.result.success, true);
   requireCritical('receipt does not duplicate current record', !JSON.stringify(changed.result).includes('NEW_RECORD'));
   assert.ok(container.textContent.includes('NEW_RECORD') && !container.textContent.includes('INITIAL_RECORD'));
  }
  requireCritical('catalog bytes independent of dynamic state', catalog() === before);
  await act(async () => renderer.close()); assert.equal(depth, 0); assert.equal(registry.inspect().bindings, 0); assert.equal(registry.inspect().views, 0);
  registry.dispose(); facts.resources.push(registry.inspect());
 }
 requireCritical('Framework retained bytes released', facts.resources.every(r => r.retainedBytes === 0 && r.bindings === 0));
 facts.passed = true;
} catch (error) { facts.error = { message: String(error?.message ?? error), stack: error?.stack }; process.exitCode = 1; }
finally {
 for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { facts.cleanupError = String(error); process.exitCode = 1; facts.passed = false; } }
 await writeFile('author-facts.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts));
}
