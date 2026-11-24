import FixtureType from 'typebox';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { Component, h, options } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';

const sdkEntry = import.meta.resolve('@aotui/sdk');
const appPreact = realpathSync(createRequire(import.meta.url).resolve('preact/package.json'));
assert.equal(realpathSync(createRequire(sdkEntry).resolve('preact/package.json')), appPreact);
const version = JSON.parse(readFileSync(appPreact)).version;
const calls = new Set();
for (const name of ['__b', '__r', '__c', '__e', 'unmount']) {
  const previous = options[name];
  options[name] = function (...args) {
    calls.add(name);
    return previous?.apply(this, args);
  };
}
const queue = [];
options.debounceRendering = callback => queue.push(callback);

const { DynamicView, createTUIApp, defineViewType, useAppRuntimeContext, useDataRef } = await import(sdkEntry);
// The public Node Host puts each App in its own Worker. Use two installed
// kernels here to test both owners on the very same Preact render queue.
const { AppKernel } = await import(new URL('./worker-runtime/app-kernel/AppKernel.js', import.meta.resolve('@aotui/runtime')));
const File = defineViewType()({ multiplicity: 'multiple', name: 'File', tools: {
  edit: { description: 'Edit a visible value', enabled: state => state.value > 0,
    execute: ({ context }) => ({ success: true, data: { seen: context.value } }) },
} });
const checkDiagnostic = process.argv.includes('--assert-prepare-diagnostic');
class ClassCallback extends Component {
  componentDidMount() { throw new Error('class failed'); }
  render() { return null; }
}

function app(appId, fixedBody = false) {
  let update, prepareProjection, prepareOpeningProjection;
  function Body({ value, failure }) {
    const selected = useDataRef('selected', { value }, { schema: FixtureType.Object({}), scope: 'protected' });
    useLayoutEffect(() => { if (failure === 'layout') throw new Error('layout failed'); }, [failure]);
    if (failure === 'render' || value < 0) throw new Error('render failed');
    return [h('p', { key: 'body' }, selected(fixedBody ? 'Selected value' : `value:${value}`)),
      failure === 'class' && h(ClassCallback, { key: 'class' })];
  }
  function Root() {
    const [entry, set] = useState(0);
    const state = typeof entry === 'number' ? { value: entry } : entry;
    ({ prepareProjection, prepareOpeningProjection } = useAppRuntimeContext());
    update = set;
    return h(DynamicView, { idPrefix: 'file', type: File, context: state }, h(Body, state));
  }
  const factory = createTUIApp({ app_name: appId, viewTypes: [File], component: Root });
  const kernel = new AppKernel({ factory, appId, desktopId: 'desktop',
    instanceId: appId + '-run', projectionLimits: DEFAULT_PROJECTION_LIMITS });
  return { appId, kernel, open: () => kernel.onOpen(), update: state => update(state),
    prepare: state => prepareProjection(() => { if (state !== undefined) update(state); }),
    run: callback => prepareProjection(callback), openView: (callback, revert) => prepareOpeningProjection(callback, revert) };
}

const refValues = draft => Object.values(draft.refs).map(ref => ref.target.payload.value);

function healthy({ appId, kernel }, value) {
  const publication = kernel.getProjectionCoordinator().nextPublication();
  assert.equal(publication.draft?.appId, appId);
  assert.match(publication.draft.views[0].content.value, new RegExp(`value:${value}\\b`));
  assert.deepEqual(refValues(publication.draft), [value]);
  assert.deepEqual(Object.values(publication.draft.tools).map(tool => tool.name), value ? ['edit'] : []);
  return publication.draft;
}
async function commit(...apps) {
  const waits = apps.map(({ kernel }) => kernel.whenProjectionCommitted());
  assert.equal(queue.length, 1, 'both owners share one real queued Preact flush');
  queue.shift()();
  await Promise.all(waits);
}

const describeError = error => ({ code: error.code, path: error.path, message: error.message, cause: error.cause?.message });
async function runPreparation(run) {
  const result = run().then(value => ({ value }), error => ({ error }));
  await Promise.resolve();
  queue.shift()?.();
  return result;
}
const prepare = (app, state) => runPreparation(() => app.prepare(state));

const left = app('left'), right = app('right'), stable = app('stable', true);
const phases = ['render', 'layout', 'class'];
const faultDetails = [];
let preparation;
try {
  await left.open();
  await right.open();
  healthy(left, 0);
  healthy(right, 0);
  for (const [i, failure] of phases.entries()) {
    const projection = left.kernel.getProjectionCoordinator();
    const before = projection.token();
    left.update({ value: 99, failure });
    right.update({ value: i + 1 });
    await commit(left, right);
    assert.equal(projection.failure?.code, 'SNAPSHOT_INVALID');
    assert.deepEqual(projection.token(), before);
    assert.deepEqual(refValues(projection.prepared), [i]);
    const { error } = await prepare(left);
    const detail = describeError(error);
    assert.equal(detail.code, 'SNAPSHOT_INVALID');
    if (checkDiagnostic) assert.equal(detail.cause, failure + ' failed');
    faultDetails.push({ failure, ...detail });
    const { views: [peer], tools } = healthy(right, i + 1);
    const peerResult = await right.kernel.invokeBoundTypeTool(Object.values(tools)[0], {
      viewId: peer.id, viewInstanceId: peer.viewInstanceId, activationId: peer.toolBindings[0].activationId,
    }, {});
    assert.deepEqual(peerResult, { phase: 'entered-returned', result: { success: true, data: { seen: i + 1 } } });
    left.update({ value: i + 1 });
    await commit(left);
    healthy(left, i + 1);
  }
  await stable.open();
  const projection = stable.kernel.getProjectionCoordinator();
  const first = projection.nextPublication().draft;
  const { value: one } = await prepare(stable, 1);
  assert.deepEqual(one, { status: 'prepared' });
  const accepted = projection.nextPublication().draft;
  assert.equal(accepted.sourceEpoch, first.sourceEpoch + 1);
  const notices = [];
  const unsubscribe = projection.subscribe(token => notices.push(token.epoch));
  const { value: same } = await prepare(stable, 1);
  assert.deepEqual(same, one);
  const peer = right.kernel.getProjectionCoordinator();
  const peerEpoch = peer.token().epoch;
  const { value: onlyPeerCommitted } = await runPreparation(() => stable.run(() => { right.update(7); }));
  assert.deepEqual(onlyPeerCommitted, one);
  assert.equal(peer.token().epoch, peerEpoch + 1);
  healthy(right, 7);
  assert.deepEqual(notices, []);
  unsubscribe();
  assert.equal(projection.failure, undefined);
  assert.equal(projection.token().epoch, accepted.sourceEpoch);
  let reverted = 0;
  await assert.rejects(stable.openView(() => {}, () => { reverted++; }), { code: 'SNAPSHOT_INVALID', path: '$.views' });
  assert.equal(reverted, 0);
  const callbackError = new Error('failed before scheduling work');
  await assert.rejects(stable.run(() => { throw callbackError; }), error => error === callbackError);
  let nested;
  assert.deepEqual(await stable.run(() => {
    nested = stable.run(() => { throw Error('reentrant callback ran'); }).catch(error => error);
  }), one);
  assert.equal((await nested).code, 'PROJECTION_BUSY');
  assert.equal(projection.failure, undefined);
  const { error: fault } = await prepare(stable, -1);
  assert.equal(fault.code, 'SNAPSHOT_INVALID');
  assert.equal(fault.path, '$.views');
  assert.equal(projection.failure?.code, 'SNAPSHOT_INVALID');
  assert.equal(projection.token().epoch, accepted.sourceEpoch);
  assert.deepEqual(refValues(projection.prepared), [1]);
  assert.equal((await prepare(stable)).error, fault, 'Existing fault wins when the owner produces no work');
  if (checkDiagnostic) assert.equal(fault.cause?.message, 'render failed');
  const { value: two } = await prepare(stable, 2);
  assert.deepEqual(two, { status: 'prepared' });
  assert.equal(projection.failure, undefined);
  const repaired = projection.nextPublication().draft;
  assert.equal(repaired.sourceEpoch, accepted.sourceEpoch + 1);
  assert.equal(repaired.views[0].content.value, first.views[0].content.value);
  assert.deepEqual(repaired.views[0].toolBindings, accepted.views[0].toolBindings);
  assert.deepEqual(refValues(repaired), [2]);
  const [tool] = Object.values(accepted.tools);
  const { id, viewInstanceId, toolBindings: [{ activationId }] } = accepted.views[0];
  const invoked = await stable.kernel.invokeBoundTypeTool(tool, { viewId: id, viewInstanceId, activationId }, {});
  assert.deepEqual(invoked, { phase: 'entered-returned', result: { success: true, data: { seen: 2 } } });
  const disabled = await prepare(stable, 0);
  assert.deepEqual(disabled.value, { status: 'prepared' });
  const disabledDraft = projection.nextPublication().draft;
  assert.equal(disabledDraft.sourceEpoch, repaired.sourceEpoch + 1);
  assert.equal(disabledDraft.views[0].content.value, repaired.views[0].content.value);
  assert.equal(stable.kernel.validateBoundTypeTool(tool, { viewId: id, viewInstanceId, activationId }).success, false);

  const pending = stable.prepare(3).catch(error => error);
  await Promise.resolve();
  assert.equal(queue.length, 1, 'preparation is waiting for the custom scheduler');
  await stable.kernel.onClose();
  queue.shift()();
  const closed = await pending;
  assert.equal(closed.code, 'PROJECTION_CLOSED');
  preparation = { first: first.sourceEpoch, one, noRender: same, onlyPeerCommitted, fault: describeError(fault), two,
    identicalBody: repaired.views[0].content.value, latestHandlerValue: invoked.result.data.seen,
    disabled: disabled.value, closeWhileWaiting: closed.code };
} finally {
  await Promise.all([left.kernel.onClose(), right.kernel.onClose(), stable.kernel.onClose()]);
}

const unmountFailure = new Error('unmount failed');
class FailingUnmount extends Component {
  componentWillUnmount() { throw unmountFailure; }
  render() { return h('p', null, 'mounted'); }
}
const appId = 'reopen';
let closeError;
function reopenKernel(component, instanceId) {
  const factory = createTUIApp({ app_name: appId, viewTypes: [], component });
  return new AppKernel({ appId, desktopId: 'desktop', instanceId, projectionLimits: DEFAULT_PROJECTION_LIMITS,
    factory: { ...factory, async initialize(context) {
      const instance = await factory.initialize(context);
      return { ...instance, close() {
        try { return instance.close(); }
        catch (error) { closeError = error; throw error; }
      } };
    } },
  });
}
const failing = reopenKernel(FailingUnmount, 'first-run');
await failing.onOpen();
const retiredRoot = document.body.lastElementChild;
assert.ok(retiredRoot?.isConnected);
await assert.rejects(failing.onClose(), { code: 'APP_UNMOUNT_FAILED' });
assert.equal(closeError, unmountFailure);
assert.equal(retiredRoot.isConnected, false);

const reopened = reopenKernel(() => h('p', null, 'reopened'), 'second-run');
await reopened.onOpen();
try {
  const currentRoot = document.body.lastElementChild;
  assert.notEqual(currentRoot, retiredRoot);
  assert.equal(currentRoot.textContent, 'reopened');
} finally { await reopened.onClose(); }

assert.equal(document.body.childElementCount, 0);
assert.deepEqual([...calls].sort(), ['__b', '__c', '__e', '__r', 'unmount']);
console.log(JSON.stringify({ version, phases, faultDetails, preparation, sharedPreact: true, earlierHooks: [...calls].sort(),
  failedUnmountRemovedRoot: true, reopened: true, closed: true }));
