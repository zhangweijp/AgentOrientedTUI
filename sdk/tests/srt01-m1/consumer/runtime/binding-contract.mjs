import test, { after } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import Type from 'typebox';
import { createViewOwnedTools } from '@aotui/runtime/core';
import { createToolBindings, defineToolSet, defineViewTypeTool, getToolCatalog } from '@aotui/sdk/tools';
import { fileTools } from '../results/runtime-build/types/m2-producer.js';

const facts = [];
after(async () => {
  const out = new URL('../results/', import.meta.url); await mkdir(out, { recursive: true });
  await writeFile(new URL('binding-facts.json', out), JSON.stringify(facts, null, 2) + '\n');
});

function handlers(owner, calls, options = {}) {
  const read = {
    execute(args) {
      calls.push({ owner, tool: 'read_file', filePath: args.filePath });
      return { success: true, data: { owner, filePath: args.filePath } };
    },
  };
  if (typeof options.readEnabled === 'boolean') read.enabled = options.readEnabled;
  return {
    readFile: read,
    editFile: {
      execute(args) {
        calls.push({ owner, tool: 'edit_file', filePath: args.filePath, mode: args.mode });
        return { success: true, data: { owner, filePath: args.filePath, mode: args.mode } };
      },
    },
  };
}

function makeController(registry, port = registry) {
  return createToolBindings({ definition: fileTools, appTypeTools: port });
}

function toolNamed(registry, name) {
  const tool = registry.listTools().find(item => item.name === name);
  assert.ok(tool, `expected ${name} in ${registry.listTools().map(item => item.name).join(', ')}`);
  assert.equal(tool.execution.kind, 'view-type');
  return tool;
}

async function invoke(registry, name, args, observed = toolNamed(registry, name)) {
  return registry.invokeTypeTool(observed, observed.execution, args);
}

test('one ToolSet serves isolated Apps, stable catalog, commit updates, activation and cleanup', async () => {
  const callsA = [];
  const callsB = [];
  const registryA = createViewOwnedTools('ide', 'app-a');
  const registryB = createViewOwnedTools('ide', 'app-b');
  const baselineBytesA = registryA.inspect().retainedBytes;
  const baselineBytesB = registryB.inspect().retainedBytes;
  let registerCountA = 0; const releasesA = [];
  const portA = { protocol: 'view-type-tools-v1', registerTypeTool(definition, options) {
    registerCountA++; const release = registryA.registerTypeTool(definition, options);
    return () => { releasesA.push(definition.name); release(); };
  } };
  const controllerA = makeController(registryA, portA);
  const controllerB = makeController(registryB);
  const catalogBefore = JSON.stringify(getToolCatalog(fileTools));
  const initialA = handlers('A-old', callsA);
  const initialB = handlers('B', callsB);

  assert.equal(Object.isFrozen(fileTools), true);
  assert.equal(Object.hasOwn(fileTools.editFile, 'execute'), false);
  assert.deepEqual(getToolCatalog(fileTools).map(item => item.name), ['edit_file', 'read_file']);
  assert.ok(getToolCatalog(fileTools).every(item => !Object.hasOwn(item, 'execute')));
  controllerA.commit(initialA);
  controllerB.commit(initialB);
  assert.equal(registryA.inspect().bindings, 2);
  assert.equal(registryB.inspect().bindings, 2);
  assert.deepEqual(registryA.listTools(), []);
  assert.deepEqual(registryB.listTools(), []);

  const viewsA = [registryA.mount('file_0', 'FileDetail')];
  const viewsB = [registryB.mount('file_0', 'FileDetail')];
  const firstA = toolNamed(registryA, 'read_file');
  const firstB = toolNamed(registryB, 'read_file');
  assert.equal(registryA.listTools().length, 2);
  assert.equal(registryB.listTools().length, 2);

  const firstActivationA = firstA.execution.activationId;
  for (let index = 1; index < 10; index++) viewsA.push(registryA.mount(`file_${index}`, 'FileDetail'));
  assert.equal(registryA.listTools().length, 2, 'ten matching Views still share two declarations');
  assert.equal(toolNamed(registryA, 'read_file').execution.activationId, firstActivationA);

  const uncommittedCandidate = handlers('A-new', callsA);
  const beforeCommit = await invoke(registryA, 'read_file', { filePath: 'before.txt' });
  assert.equal(beforeCommit.phase, 'entered-returned');
  assert.equal(beforeCommit.result.data.owner, 'A-old', 'constructing a candidate does not change the committed handler');
  controllerA.commit(uncommittedCandidate);
  assert.equal(registryA.inspect().bindings, 2, 'handler-only commit keeps Runtime registration count');
  assert.equal(toolNamed(registryA, 'read_file').execution.activationId, firstActivationA,
    'handler-only commit keeps activation identity');
  assert.equal(registerCountA, 2); assert.deepEqual(releasesA, [], 'handler updates retain their exact release handles');
  facts.push({ case: 'handler-only', registerCount: registerCountA, releases: [...releasesA], activation: toolNamed(registryA, 'read_file').execution.activationId });
  const afterCommit = await invoke(registryA, 'read_file', { filePath: 'after.txt' });
  assert.equal(afterCommit.result.data.owner, 'A-new');
  assert.equal((await invoke(registryB, 'read_file', { filePath: 'b.txt' })).result.data.owner, 'B',
    'the second App keeps its own handler');

  const invalidArgs = await invoke(registryA, 'read_file', {});
  assert.equal(invalidArgs.phase, 'not-entered');
  assert.equal(invalidArgs.result.error.code, 'E_INVALID_ARGS');
  assert.equal(callsA.filter(call => call.filePath === undefined).length, 0,
    'Runtime parameter validation rejects malformed input before handler entry');

  const invalidEnabled = handlers('bad-enabled', callsA);
  invalidEnabled.readFile.enabled = 'yes';
  assert.throws(() => controllerA.commit(invalidEnabled), error => error?.code === 'TOOL_BINDING_INVALID');
  let bindingGetterReads = 0;
  const bindingWithGetter = handlers('getter', callsA);
  Object.defineProperty(bindingWithGetter.readFile, 'enabled', {
    enumerable: true,
    get() { bindingGetterReads++; return true; },
  });
  assert.throws(() => controllerA.commit(bindingWithGetter));
  assert.equal(bindingGetterReads, 0, 'binding shape checks do not execute application getters');
  assert.equal(registryA.inspect().bindings, 2, 'invalid binding candidates do not alter live registrations');
  assert.equal((await invoke(registryA, 'read_file', { filePath: 'still-live.txt' })).result.data.owner, 'A-new');

  const extraCandidate = { ...handlers('unused', callsA), extra: { execute: () => ({ success: true }) } };
  assert.throws(() => controllerA.commit(extraCandidate), error => error?.code === 'TOOL_BINDING_INVALID');
  assert.equal(registryA.inspect().bindings, 2, 'bad candidate is rejected before registry changes');
  assert.equal((await invoke(registryA, 'read_file', { filePath: 'still-committed.txt' })).result.data.owner, 'A-new');

  const disabledCandidate = handlers('A-disabled', callsA, { readEnabled: false });
  controllerA.commit(disabledCandidate);
  assert.equal(registryA.inspect().bindings, 1);
  assert.deepEqual(registryA.listTools().map(item => item.name), ['edit_file']);
  const oldRead = firstA;
  const disabledCall = await invoke(registryA, 'read_file', { filePath: 'closed.txt' }, oldRead);
  assert.equal(disabledCall.phase, 'not-entered');
  assert.equal(disabledCall.result.error.code, 'TOOL_UNAVAILABLE');
  assert.equal((await invoke(registryB, 'read_file', { filePath: 'still-open.txt' }, firstB)).result.data.owner, 'B',
    'disabling one App does not affect another App using the same ToolSet');

  controllerA.commit(handlers('A-reenabled', callsA, { readEnabled: true }));
  assert.equal(registryA.inspect().bindings, 2);
  const reenabledRead = toolNamed(registryA, 'read_file');
  assert.notEqual(reenabledRead.execution.activationId, oldRead.execution.activationId,
    'true → false → true creates a new activation');
  const staleRead = await invoke(registryA, 'read_file', { filePath: 'stale.txt' }, oldRead);
  assert.equal(staleRead.phase, 'not-entered');
  assert.equal(staleRead.result.error.code, 'TOOL_UNAVAILABLE');
  assert.equal((await invoke(registryA, 'read_file', { filePath: 'new.txt' }, reenabledRead)).result.data.owner, 'A-reenabled');

  for (const view of viewsA) registryA.unmount(view.viewInstanceId);
  assert.deepEqual(registryA.listTools(), [], 'last same-type View removal withdraws type Tools');
  const reopened = registryA.mount('file_0', 'FileDetail');
  const reopenedRead = toolNamed(registryA, 'read_file');
  assert.notEqual(reopenedRead.execution.activationId, reenabledRead.execution.activationId,
    'reopening the same View ID does not restore an old activation');
  const oldAfterReopen = await invoke(registryA, 'read_file', { filePath: 'old.txt' }, reenabledRead);
  assert.equal(oldAfterReopen.phase, 'not-entered');
  assert.equal((await invoke(registryA, 'read_file', { filePath: 'reopened.txt' }, reopenedRead)).result.data.owner, 'A-reenabled');
  assert.equal(JSON.stringify(getToolCatalog(fileTools)), catalogBefore,
    'static catalog is independent of View count, handler, and enabled state');

  controllerA.dispose();
  controllerB.dispose();
  for (const view of viewsB) registryB.unmount(view.viewInstanceId);
  registryA.unmount(reopened.viewInstanceId);
  assert.deepEqual(registryA.inspect(), { state: 'active', views: 0, bindings: 0, retainedBytes: baselineBytesA });
  assert.deepEqual(registryB.inspect(), { state: 'active', views: 0, bindings: 0, retainedBytes: baselineBytesB });
  assert.equal(registryB.inspect().bindings, 0);
  registryA.dispose();
  registryB.dispose();
  assert.deepEqual(registryA.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
  assert.deepEqual(registryB.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
  facts.push({ case: 'two-apps-released', appA: registryA.inspect(), appB: registryB.inspect(), registerCountA, releasesA });
});

test('one port has one binding owner, including an all-disabled second owner', async () => {
  const calls = [];
  const registry = createViewOwnedTools('ide', 'owner-app');
  const view = registry.mount('file', 'FileDetail');
  const first = makeController(registry);
  first.commit(handlers('first', calls));

  const second = makeController(registry);
  const allDisabled = handlers('second', calls, { readEnabled: false });
  allDisabled.editFile.enabled = false;
  assert.throws(() => second.commit(allDisabled), error => error?.code === 'TOOL_BINDING_OWNER_CONFLICT');
  assert.equal(registry.inspect().bindings, 2);
  assert.equal((await invoke(registry, 'read_file', { filePath: 'first-owner.txt' })).result.data.owner, 'first');

  first.dispose();
  const successorDisabled = handlers('successor', calls, { readEnabled: false });
  successorDisabled.editFile.enabled = false;
  second.commit(successorDisabled);
  assert.equal(registry.inspect().bindings, 0);
  second.commit(handlers('successor', calls));
  assert.equal(registry.inspect().bindings, 2);
  assert.equal((await invoke(registry, 'read_file', { filePath: 'successor.txt' })).result.data.owner, 'successor');
  second.dispose();
  registry.unmount(view.viewInstanceId);
  assert.equal(registry.inspect().bindings, 0);
  assert.equal(registry.inspect().views, 0);
  registry.dispose();
  assert.deepEqual(registry.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
});

test('partial registration failure closes one controller and a stale dispose cannot release its successor', async () => {
  const registry = createViewOwnedTools('ide', 'failure-app');
  const view = registry.mount('file', 'FileDetail');
  const healthyCalls = [];
  const healthyRegistry = createViewOwnedTools('ide', 'healthy-app');
  const healthyView = healthyRegistry.mount('file', 'FileDetail');
  const healthyController = makeController(healthyRegistry);
  healthyController.commit(handlers('healthy', healthyCalls));
  let registrations = 0;
  const port = {
    protocol: 'view-type-tools-v1',
    registerTypeTool(definition, options) {
      registrations++;
      if (registrations === 2) throw Object.assign(new Error('injected registration failure'), { code: 'INJECTED_REGISTER_FAILURE' });
      return registry.registerTypeTool(definition, options);
    },
  };
  const failed = makeController(registry, port);
  const baseline = registry.inspect();
  assert.throws(() => failed.commit(handlers('failed', [])), error => error?.code === 'TOOL_BINDING_COMMIT_FAILED' && error.diagnostics.original.code === 'INJECTED_REGISTER_FAILURE');
  assert.equal(registry.inspect().bindings, baseline.bindings);
  assert.equal(registry.inspect().retainedBytes, baseline.retainedBytes,
    'successfully acquired Runtime registration is released after the next registration fails');
  assert.deepEqual(registry.listTools(), []);
  assert.equal((await invoke(healthyRegistry, 'read_file', { filePath: 'healthy.txt' })).result.data.owner, 'healthy',
    'one App registration failure does not affect another App port');

  const successor = makeController(registry, port);
  successor.commit(handlers('successor', []));
  assert.equal(registry.inspect().bindings, 2);
  failed.dispose();
  assert.equal(registry.inspect().bindings, 2, 'disposing the failed owner cannot release the successor');
  assert.equal(registry.listTools().length, 2);
  successor.dispose();
  registry.unmount(view.viewInstanceId);
  healthyController.dispose();
  healthyRegistry.unmount(healthyView.viewInstanceId);
  assert.equal(registry.inspect().bindings, 0);
  assert.equal(registry.inspect().views, 0);
  registry.dispose();
  assert.deepEqual(registry.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
  healthyRegistry.dispose();
  assert.deepEqual(healthyRegistry.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
});

test('release failure remains unavailable, retains the owner, and succeeds only after cleanup retry', async () => {
  const registry = createViewOwnedTools('ide', 'cleanup-failure-app');
  const view = registry.mount('file', 'FileDetail');
  let failReadRelease = true;
  const port = {
    protocol: 'view-type-tools-v1',
    registerTypeTool(definition, options) {
      const release = registry.registerTypeTool(definition, options);
      return () => {
        if (failReadRelease && definition.name === 'read_file') {
          throw Object.assign(new Error('injected release failure'), { code: 'INJECTED_RELEASE_FAILURE' });
        }
        release();
      };
    },
  };
  const controller = makeController(registry, port);
  controller.commit(handlers('cleanup', []));
  assert.equal(registry.inspect().bindings, 2);

  assert.throws(() => controller.dispose(), error => error?.code === 'TOOL_BINDING_CLEANUP_FAILED');
  assert.equal(registry.inspect().bindings, 1,
    'the failed release remains an actual Runtime registration rather than being reported as cleaned');
  const stillRegistered = toolNamed(registry, 'read_file');
  const unavailableCall = await invoke(registry, 'read_file', { filePath: 'unavailable.txt' }, stillRegistered);
  assert.equal(unavailableCall.phase, 'not-entered');
  assert.equal(unavailableCall.result.error.code, 'TOOL_UNAVAILABLE');
  const nextOwner = makeController(registry, port);
  assert.throws(() => nextOwner.commit(handlers('too-early', [])),
    error => error?.code === 'TOOL_BINDING_OWNER_CONFLICT');

  failReadRelease = false;
  controller.dispose();
  assert.equal(registry.inspect().bindings, 0);
  assert.equal(registry.listTools().length, 0);
  nextOwner.commit(handlers('successor', []));
  assert.equal(registry.inspect().bindings, 2);
  controller.dispose();
  assert.equal(registry.inspect().bindings, 2,
    'a successfully disposed old owner cannot release the new owner during a later dispose');

  nextOwner.dispose();
  registry.unmount(view.viewInstanceId);
  registry.dispose();
  assert.deepEqual(registry.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
});

test('committing reentry is unavailable and register-time dispose cannot resurrect a binding', async () => {
  const registry = createViewOwnedTools('ide', 'reentry-app');
  const view = registry.mount('file', 'FileDetail');
  let controller;
  let nestedError;
  let duringCommit;
  const outerCalls = [];
  let attempted = false;
  const reentrantPort = {
    protocol: 'view-type-tools-v1',
    registerTypeTool(definition, options) {
      if (!attempted) {
        attempted = true;
        try { controller.commit(handlers('nested', [])); } catch (error) { nestedError = error; }
      }
      const release = registry.registerTypeTool(definition, options);
      if (definition.name === 'read_file') {
        const tool = registry.listTools().find(item => item.name === 'read_file');
        assert.ok(tool, 'Runtime registration is visible inside the reentrant port boundary');
        duringCommit = registry.invokeTypeTool(tool, tool.execution, { filePath: 'during-commit.txt' });
      }
      return release;
    },
  };
  controller = makeController(registry, reentrantPort);
  controller.commit(handlers('outer', outerCalls));
  assert.ok(nestedError instanceof Error, 'a nested commit during registry registration is rejected');
  const rejectedDuringCommit = await duringCommit;
  assert.equal(rejectedDuringCommit.phase, 'not-entered');
  assert.equal(rejectedDuringCommit.result.error.code, 'TOOL_UNAVAILABLE');
  assert.deepEqual(outerCalls, [], 'a Runtime reentry during controller commit cannot enter the candidate handler');
  assert.equal(registry.inspect().bindings, 2);
  controller.dispose();

  let closingController;
  let disposedInRegister = false;
  const closeDuringRegister = {
    protocol: 'view-type-tools-v1',
    registerTypeTool(definition, options) {
      const release = registry.registerTypeTool(definition, options);
      if (!disposedInRegister) {
        disposedInRegister = true;
        closingController.dispose();
      }
      return release;
    },
  };
  closingController = makeController(registry, closeDuringRegister);
  assert.throws(() => closingController.commit(handlers('closing', [])), error => error?.code === 'TOOL_BINDING_CLOSED');
  assert.equal(registry.inspect().bindings, 0, 'a handle returned after reentrant dispose is immediately released');
  assert.deepEqual(registry.listTools(), []);
  registry.unmount(view.viewInstanceId);
  registry.dispose();
  assert.deepEqual(registry.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
});


test('construction is inert, validates ports even when disabled, and captures fixed options', () => {
  let registers = 0;
  let getterReads = 0;
  for (const port of [null, {}, { protocol: 'old', registerTypeTool() {} }, { protocol: 'view-type-tools-v1' }]) {
    assert.throws(() => createToolBindings({ definition: fileTools, appTypeTools: port }), error => error.code === 'TOOL_BINDING_PORT_INVALID');
  }
  const getterPort = { protocol: 'view-type-tools-v1', get registerTypeTool() { getterReads++; return () => () => {}; } };
  assert.throws(() => createToolBindings({ definition: fileTools, appTypeTools: getterPort }), error => error.code === 'TOOL_BINDING_PORT_INVALID');
  assert.equal(getterReads, 0);
  const registry = createViewOwnedTools('ide', 'inert');
  assert.throws(() => createToolBindings({ definition: { ...fileTools }, appTypeTools: registry }), error => error.code === 'TOOL_SET_INVALID');
  class Port {
    protocol = 'view-type-tools-v1';
    registerTypeTool(definition, options) { registers++; assert.equal(this, port); return registry.registerTypeTool(definition, options); }
  }
  const port = new Port();
  const options = { definition: fileTools, appTypeTools: port };
  const inert = createToolBindings(options);
  const active = createToolBindings(options);
  assert.equal(registers, 0);
  options.appTypeTools = { protocol: 'old' };
  active.commit(handlers('active', []));
  assert.equal(registers, 2);
  const allDisabled = handlers('disabled', [], { readEnabled: false }); allDisabled.editFile.enabled = false;
  assert.throws(() => inert.commit(allDisabled), error => error.code === 'TOOL_BINDING_OWNER_CONFLICT');
  active.dispose();
  inert.commit(allDisabled);
  assert.equal(registers, 2, 'all-disabled still owns the port without registering');
  const third = makeController(registry, port);
  assert.throws(() => third.commit(handlers('third', [])), error => error.code === 'TOOL_BINDING_OWNER_CONFLICT');
  inert.dispose(); third.commit(handlers('third', [])); third.dispose(); registry.dispose();
  assert.deepEqual(registry.inspect(), { state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
});

test('prepare rejects invalid shapes and accessors without changing the committed frame or App owner', async () => {
  const registry = createViewOwnedTools('ide', 'prepare'); const view = registry.mount('file', 'FileDetail');
  const controller = makeController(registry); const owner = { text: 'before' };
  const bindings = handlers('stable', []); bindings.readFile.execute = () => ({ success: true, data: { text: owner.text } });
  controller.commit(bindings); const activation = toolNamed(registry, 'read_file').execution.activationId;
  owner.text = 'after'; assert.equal(Object.isFrozen(owner), false);
  assert.equal(Object.isFrozen(bindings.readFile.execute), false);
  bindings.readFile.execute = () => ({ success: true, data: { text: 'uncommitted mutation' } });
  bindings.readFile.enabled = false;
  assert.equal((await invoke(registry, 'read_file', { filePath: 'a' })).result.data.text, 'after');
  const bad = [ {}, { ...bindings, extra: bindings.readFile }, { ...bindings, readFile: { enabled: false } }, { ...bindings, readFile: { execute: bindings.readFile.execute, enabled: undefined } } ];
  let reads = 0;
  const getter = { ...bindings }; Object.defineProperty(getter, 'readFile', { enumerable: true, get() { reads++; return bindings.readFile; } }); bad.push(getter);
  for (const candidate of bad) assert.throws(() => controller.commit(candidate), error => error.code === 'TOOL_BINDING_INVALID');
  assert.equal(reads, 0); assert.equal(registry.inspect().bindings, 2);
  assert.equal(toolNamed(registry, 'read_file').execution.activationId, activation);
  assert.equal((await invoke(registry, 'read_file', { filePath: 'a' })).result.data.text, 'after');
  controller.dispose(); registry.unmount(view.viewInstanceId); registry.dispose();
});

test('update registration failure closes old bindings, preserves bounded original and cleanup diagnostics, then retries', async () => {
  const registry = createViewOwnedTools('ide', 'update-failure'); const view = registry.mount('file', 'FileDetail');
  let refuseRegister = true, refuseRelease = true; const releases = [];
  const original = Object.assign(new Error('REGISTER_' + 'x'.repeat(1000)), { code: 'REGISTER_TEST' });
  const port = { protocol: 'view-type-tools-v1', registerTypeTool(def, options) {
    assert.deepEqual(Object.keys(def).sort(), ['description', 'inputSchema', 'name', 'viewType']);
    if (def.name === 'read_file' && refuseRegister) throw original;
    const release = registry.registerTypeTool(def, options);
    return () => { releases.push(def.name); if (refuseRelease) throw Object.assign(new Error('RELEASE_' + def.name), { code: 'RELEASE_TEST' }); release(); };
  } };
  const controller = makeController(registry, port); controller.commit(handlers('old', [], { readEnabled: false }));
  const editBefore = toolNamed(registry, 'edit_file'); let thrown;
  assert.throws(() => controller.commit(handlers('new', [])), error => { thrown = error; return error.code === 'TOOL_BINDING_CLEANUP_FAILED'; });
  assert.notEqual(thrown, original); assert.equal(Object.hasOwn(thrown, 'cause'), false);
  assert.equal(thrown.diagnostics.original.code, 'REGISTER_TEST'); assert.equal(thrown.diagnostics.original.message.length, 256); assert.equal(thrown.diagnostics.original.truncated, true);
  facts.push({ case: 'update-failure', code: thrown.code, diagnostics: thrown.diagnostics, resources: registry.inspect() });
  assert.equal(thrown.diagnostics.cleanupFailureCount, 1); assert.equal(thrown.diagnostics.cleanupErrors[0].error.code, 'RELEASE_TEST');
  assert.equal(registry.inspect().bindings, 1);
  assert.equal((await invoke(registry, 'edit_file', { filePath: 'a', mode: 'append', tags: [] }, editBefore)).phase, 'not-entered');
  const next = makeController(registry, port); assert.throws(() => next.commit(handlers('next', [])), error => error.code === 'TOOL_BINDING_OWNER_CONFLICT');
  assert.throws(() => controller.dispose(), error => error.code === 'TOOL_BINDING_CLEANUP_FAILED' && error.diagnostics.original.code === 'REGISTER_TEST');
  assert.throws(() => controller.commit(handlers('retry-illegal', [])), error => error.code === 'TOOL_BINDING_UNAVAILABLE');
  refuseRelease = false; refuseRegister = false; controller.dispose(); assert.equal(registry.inspect().bindings, 0);
  next.commit(handlers('next', [])); controller.dispose(); assert.equal(registry.inspect().bindings, 2);
  next.dispose(); registry.unmount(view.viewInstanceId); registry.dispose(); assert.equal(registry.inspect().retainedBytes, 0);
  assert.ok(releases.length >= 3);
});

test('cleanup attempts every handle, reports bounded counts, skips exception getters and retains the owner until retry', () => {
  const registry = createViewOwnedTools('ide', 'diagnostics');
  const baselineBytes = registry.inspect().retainedBytes;
  const defs = {}; for (let i = 0; i < 12; i++) defs[i === 0 ? 'local_' + 'k'.repeat(200) : 'local_' + i] = defineViewTypeTool({ viewType: 'FileDetail', name: 'tool_' + i, description: 'Test.', inputSchema: Type.Object({}) });
  const definition = defineToolSet(defs); const bindings = Object.fromEntries(Object.keys(defs).map(key => [key, { execute: () => ({ success: true }) }]));
  let failing = true, attempts = 0, getterReads = 0;
  const port = { protocol: 'view-type-tools-v1', registerTypeTool(def, options) {
    const release = registry.registerTypeTool(def, options);
    return () => {
      attempts++;
      if (failing) {
        if (def.name === 'tool_0') { const error = {}; Object.defineProperty(error, 'message', { get() { getterReads++; throw Error('bad getter'); } }); throw error; }
        throw Object.assign(new Error(def.name + '_' + 'e'.repeat(1000)), { name: 'n'.repeat(200), code: 'c'.repeat(200) });
      }
      release();
    };
  } };
  const controller = createToolBindings({ definition, appTypeTools: port }); controller.commit(bindings);
  assert.throws(() => controller.dispose(), error => {
    assert.equal(error.code, 'TOOL_BINDING_CLEANUP_FAILED'); const d = error.diagnostics;
    facts.push({ case: 'bounded-cleanup', code: error.code, diagnostics: d });
    assert.equal(d.cleanupErrors[0].toolKeyTruncated, true); assert.equal(d.cleanupErrors[0].toolKey.length, 64);
    assert.equal(d.cleanupFailureCount, 12); assert.equal(d.cleanupErrors.length, 8); assert.equal(d.omittedCleanupFailures, 4);
    assert.equal(Object.isFrozen(d), true); assert.equal(Object.isFrozen(d.cleanupErrors), true);
    for (const issue of d.cleanupErrors) {
      assert.ok(issue.error.message.length <= 256); assert.ok(issue.error.name.length <= 64); assert.ok((issue.error.code?.length ?? 0) <= 64);
      assert.ok(issue.toolKey.length <= 64); assert.equal(Object.isFrozen(issue.error), true);
    }
    return true;
  });
  assert.equal(attempts, 12); assert.equal(getterReads, 0); assert.equal(registry.inspect().bindings, 12);
  const successor = createToolBindings({ definition, appTypeTools: port }); assert.throws(() => successor.commit(bindings), error => error.code === 'TOOL_BINDING_OWNER_CONFLICT');
  failing = false; controller.dispose(); assert.equal(attempts, 24); assert.equal(registry.inspect().bindings, 0); assert.equal(registry.inspect().retainedBytes, baselineBytes);
  successor.commit(bindings); controller.dispose(); assert.equal(registry.inspect().bindings, 12);
  successor.dispose(); registry.dispose();
});

test('closed during prepare, release or register has a structured code and cannot revive registrations', async () => {
  for (const phase of ['prepare', 'release', 'register']) {
    const registry = createViewOwnedTools('ide', phase); const view = registry.mount('file', 'FileDetail');
    let controller, closeInRelease = false, closeInRegister = false, successor;
    let callbacks = 0;
    const port = { protocol: 'view-type-tools-v1', registerTypeTool(def, options) {
      const release = registry.registerTypeTool(def, options);
      if (closeInRegister) {
        closeInRegister = false; controller.dispose(); successor = makeController(registry, port);
        assert.throws(() => successor.commit(handlers('too-early', [])), error => error.code === 'TOOL_BINDING_OWNER_CONFLICT');
      }
      return () => { callbacks++; if (closeInRelease) { closeInRelease = false; controller.dispose(); } release(); };
    } };
    controller = makeController(registry, port);
    if (phase !== 'register') controller.commit(handlers('before', []));
    let candidate;
    if (phase === 'prepare') {
      candidate = new Proxy(handlers('candidate', []), { ownKeys(target) { controller.dispose(); return Reflect.ownKeys(target); } });
    } else if (phase === 'release') { closeInRelease = true; candidate = handlers('candidate', [], { readEnabled: false }); }
    else { closeInRegister = true; candidate = handlers('candidate', []); }
    assert.throws(() => controller.commit(candidate), error => error.code === 'TOOL_BINDING_CLOSED' && error.diagnostics.original.code === 'TOOL_BINDING_CLOSED' && error.diagnostics.original.message.includes(phase));
    assert.equal(registry.inspect().bindings, 0); assert.equal(registry.listTools().length, 0);
    successor ??= makeController(registry, port); successor.commit(handlers('successor', []));
    controller.dispose(); assert.equal(registry.inspect().bindings, 2);
    assert.equal((await invoke(registry, 'read_file', { filePath: phase })).result.data.owner, 'successor');
    successor.dispose(); registry.unmount(view.viewInstanceId); registry.dispose(); assert.equal(registry.inspect().retainedBytes, 0); assert.ok(callbacks > 0);
  }
});

test('cleanup reentrant dispose does not recurse or release a successor owner', () => {
  const registry = createViewOwnedTools('ide', 'cleanup-reentry'); let controller, depth = 0, maximum = 0, releases = 0;
  const port = { protocol: 'view-type-tools-v1', registerTypeTool(def, options) {
    const release = registry.registerTypeTool(def, options);
    return () => { depth++; maximum = Math.max(maximum, depth); releases++; controller.dispose(); release(); depth--; };
  } };
  controller = makeController(registry, port); controller.commit(handlers('old', [])); controller.dispose(); controller.dispose();
  assert.equal(maximum, 1); assert.equal(releases, 2); assert.equal(registry.inspect().bindings, 0);
  const successor = makeController(registry, port); successor.commit(handlers('new', [])); controller.dispose(); assert.equal(registry.inspect().bindings, 2);
  successor.dispose(); registry.dispose(); assert.equal(registry.inspect().retainedBytes, 0);
});

test('in-flight execution keeps its entered handler across updates, disabled state and successor ownership', async () => {
  const registry = createViewOwnedTools('ide', 'inflight'); const view = registry.mount('file', 'FileDetail');
  const controller = makeController(registry); let finish, entered = 0; const owner = { count: 0 };
  const old = handlers('old', []); old.readFile.execute = async () => { entered++; await new Promise(resolve => { finish = resolve; }); owner.count++; return { success: true, data: 'old' }; };
  controller.commit(old); const initial = toolNamed(registry, 'read_file');
  const pending = invoke(registry, 'read_file', { filePath: 'a' }, initial); assert.equal(entered, 1);
  controller.commit(handlers('new', [])); assert.equal((await invoke(registry, 'read_file', { filePath: 'a' })).result.data.owner, 'new');
  controller.commit(handlers('disabled', [], { readEnabled: false })); controller.dispose(); assert.equal(registry.inspect().bindings, 0);
  const next = makeController(registry); next.commit(handlers('successor', [])); const id = toolNamed(registry, 'read_file').execution.activationId;
  finish(); assert.equal((await pending).result.data, 'old'); assert.equal(owner.count, 1);
  controller.dispose(); assert.equal(toolNamed(registry, 'read_file').execution.activationId, id);
  assert.equal((await invoke(registry, 'read_file', { filePath: 'b' })).result.data.owner, 'successor');
  next.dispose(); registry.unmount(view.viewInstanceId); registry.dispose(); assert.equal(registry.inspect().retainedBytes, 0);
});

test('argument capture rechecks the business entry after close, handler update or disable/re-enable', async () => {
  for (const action of ['close', 'update', 'cycle']) {
    const registry = createViewOwnedTools('ide', 'capture_' + action); const view = registry.mount('file', 'FileDetail');
    let controller, duringCapture, called = 0;
    const port = { protocol: 'view-type-tools-v1', registerTypeTool(def, options) {
      return registry.registerTypeTool(def, { ...options, createSafeOrdinaryParametersInvoker(contract) {
        return options.createSafeOrdinaryParametersInvoker({ ...contract, validate(input) {
          const result = contract.validate(input); const callback = duringCapture; duringCapture = undefined; callback?.(); return result;
        } });
      } });
    } };
    controller = makeController(registry, port); const original = handlers('old', []); original.readFile.execute = () => { called++; return { success: true, data: 'old' }; }; controller.commit(original);
    duringCapture = () => {
      if (action === 'close') controller.dispose();
      else if (action === 'update') controller.commit(handlers('latest', []));
      else { controller.commit(handlers('off', [], { readEnabled: false })); controller.commit(handlers('on', [])); }
    };
    const result = await invoke(registry, 'read_file', { filePath: 'a' }); assert.equal(called, 0);
    if (action === 'update') { assert.equal(result.phase, 'entered-returned'); assert.equal(result.result.data.owner, 'latest'); }
    else assert.equal(result.phase, 'not-entered');
    controller.dispose(); registry.unmount(view.viewInstanceId); registry.dispose();
  }
});

test('business handler reentry sees only successful commits and preserves readonly input and failure semantics', async () => {
  const registry = createViewOwnedTools('ide', 'business'); const view = registry.mount('file', 'FileDetail'); const controller = makeController(registry);
  const initial = handlers('initial', []);
  initial.editFile.execute = args => {
    assert.equal(Object.isFrozen(args), true); assert.equal(Object.isFrozen(args.tags), true);
    controller.commit(handlers('after', [])); return { success: false, effects: 'partial', error: { code: 'BUSINESS', message: 'Partial business result.' } };
  };
  controller.commit(initial);
  const result = await invoke(registry, 'edit_file', { filePath: 'a', mode: 'append', tags: [1] });
  assert.equal(result.phase, 'entered-returned'); assert.equal(result.failureEffects, 'partial'); assert.equal(result.result.error.code, 'BUSINESS');
  assert.equal((await invoke(registry, 'read_file', { filePath: 'b' })).result.data.owner, 'after');
  controller.dispose(); registry.unmount(view.viewInstanceId); registry.dispose();
});

test('root and pure entry share ToolSet brands and binding ownership', async () => {
  const root = await import('@aotui/sdk'); const pure = await import('@aotui/sdk/tools');
  assert.equal(root.createToolBindings, pure.createToolBindings);
  const registry = createViewOwnedTools('ide', 'entries'); const first = root.createToolBindings({ definition: fileTools, appTypeTools: registry });
  const second = pure.createToolBindings({ definition: fileTools, appTypeTools: registry });
  first.commit(handlers('root', [])); assert.throws(() => second.commit(handlers('pure', [])), error => error.code === 'TOOL_BINDING_OWNER_CONFLICT');
  first.dispose(); second.commit(handlers('pure', [])); first.dispose(); assert.equal(registry.inspect().bindings, 2);
  second.dispose(); registry.dispose(); assert.equal(registry.inspect().retainedBytes, 0);
});
