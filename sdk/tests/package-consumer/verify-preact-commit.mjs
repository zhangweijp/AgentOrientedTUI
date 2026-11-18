import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const { View, createTUIApp, defineViewType, useAppRuntimeContext, useDataRef } = await import(sdkEntry);
// The public Node Host puts each App in its own Worker. Use two installed
// kernels here to test both owners on the very same Preact render queue.
const { DEFAULT_PROJECTION_LIMITS } = await import(new URL('./core/invocation/observation-registry.js', import.meta.resolve('@aotui/runtime')));
const { AppKernel } = await import(new URL('./worker-runtime/app-kernel/AppKernel.js', import.meta.resolve('@aotui/runtime')));
const File = defineViewType()({ name: 'File', tools: {
  edit: { description: 'Edit a visible value', enabled: state => state.value > 0,
    execute: ({ context }) => ({ success: true, data: { seen: context.value } }) },
} });
const checkDiagnostic = process.argv.includes('--assert-prepare-diagnostic');
class ClassCallback extends Component {
  componentDidMount() { throw new Error('class failed'); }
  render() { return null; }
}

function app(appId, fixedBody = false) {
  let update, prepareProjection;
  function Body({ value, failure }) {
    const selected = useDataRef('selected', { value });
    useLayoutEffect(() => { if (failure === 'layout') throw new Error('layout failed'); }, [failure]);
    if (failure === 'render' || value < 0) throw new Error('render failed');
    return [h('p', { key: 'body' }, selected(fixedBody ? 'Selected value' : `value:${value}`)),
      failure === 'class' && h(ClassCallback, { key: 'class' })];
  }
  function Root() {
    const [entry, set] = useState(0);
    const state = typeof entry === 'number' ? { value: entry } : entry;
    prepareProjection = useAppRuntimeContext().prepareProjection;
    update = set;
    return h(View, { id: 'file', kind: 'state', type: File, context: state }, h(Body, state));
  }
  const factory = createTUIApp({ app_name: appId, viewTypes: [File], component: Root });
  const kernel = new AppKernel({ ...factory.kernelConfig, factory, appId, desktopId: 'desktop',
    instanceId: appId + '-run', projectionLimits: DEFAULT_PROJECTION_LIMITS });
  return { appId, kernel, open: () => kernel.onOpen(), update: state => update(state),
    prepare: state => prepareProjection(() => { if (state !== undefined) update(state); }) };
}

function healthy({ appId, kernel }, value) {
  const publication = kernel.getProjectionCoordinator().nextPublication();
  assert.equal(publication.draft?.appId, appId);
  assert.match(publication.draft.views[0].content.value, new RegExp(`value:${value}\\b`));
  assert.deepEqual(kernel.getViewRefs().map(ref => ref.value.value), [value]);
  assert.deepEqual(Object.values(publication.draft.tools).map(tool => tool.name), value ? ['edit'] : []);
}
async function commit(...apps) {
  const waits = apps.map(({ kernel }) => kernel.whenProjectionCommitted());
  assert.equal(queue.length, 1, 'both owners share one real queued Preact flush');
  queue.shift()();
  await Promise.all(waits);
}

const describeError = error => ({ code: error.code, path: error.path, message: error.message, cause: error.cause?.message });
async function prepare(app, state) {
  const result = app.prepare(state).then(value => ({ value }), error => ({ error }));
  await Promise.resolve();
  queue.shift()?.();
  return result;
}

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
    assert.deepEqual(left.kernel.getViewRefs().map(ref => ref.value.value), [i]);
    const { error } = await prepare(left);
    const detail = describeError(error);
    assert.equal(detail.code, 'SNAPSHOT_INVALID');
    if (checkDiagnostic) assert.equal(detail.cause, failure + ' failed');
    faultDetails.push({ failure, ...detail });
    healthy(right, i + 1);
    left.update({ value: i + 1 });
    await commit(left);
    healthy(left, i + 1);
  }
  await stable.open();
  const projection = stable.kernel.getProjectionCoordinator();
  const first = projection.nextPublication().draft;
  const { value: one } = await prepare(stable, 1);
  assert.deepEqual(one, { status: 'prepared', sourceEpoch: first.sourceEpoch + 1 });
  const accepted = projection.nextPublication().draft;
  const { error: same } = await prepare(stable, 1);
  assert.equal(same.code, 'SNAPSHOT_INVALID');
  assert.equal(same.path, '$.views');
  if (checkDiagnostic) assert.match(same.message, /did not observe a Preact commit for this App/);
  assert.equal(projection.failure, undefined);
  assert.equal(projection.token().epoch, one.sourceEpoch);
  const { error: fault } = await prepare(stable, -1);
  assert.equal(fault.code, 'SNAPSHOT_INVALID');
  assert.equal(fault.path, '$.views');
  assert.equal(projection.failure?.code, 'SNAPSHOT_INVALID');
  assert.equal(projection.token().epoch, one.sourceEpoch);
  assert.deepEqual(stable.kernel.getViewRefs().map(ref => ref.value.value), [1]);
  assert.equal((await prepare(stable)).error, fault, 'Existing fault wins when the owner produces no work');
  if (checkDiagnostic) assert.equal(fault.cause?.message, 'render failed');
  const { value: two } = await prepare(stable, 2);
  assert.deepEqual(two, { status: 'prepared', sourceEpoch: one.sourceEpoch + 1 });
  assert.equal(projection.failure, undefined);
  const repaired = projection.nextPublication().draft;
  assert.equal(repaired.views[0].content.value, first.views[0].content.value);
  assert.deepEqual(repaired.views[0].toolBindings, accepted.views[0].toolBindings);
  assert.deepEqual(stable.kernel.getViewRefs().map(ref => ref.value.value), [2]);
  const [tool] = Object.values(accepted.tools);
  const { id, viewInstanceId, toolBindings: [{ activationId }] } = accepted.views[0];
  const invoked = await stable.kernel.invokeBoundTypeTool(tool, { viewId: id, viewInstanceId, activationId }, {});
  assert.deepEqual(invoked, { phase: 'entered-returned', result: { success: true, data: { seen: 2 } } });
  preparation = { first: first.sourceEpoch, one, noRender: describeError(same), fault: describeError(fault), two,
    identicalBody: repaired.views[0].content.value, latestHandlerValue: invoked.result.data.seen };
} finally {
  await Promise.all([left.kernel.onClose(), right.kernel.onClose(), stable.kernel.onClose()]);
}
assert.equal(document.querySelectorAll('[data-app-root]').length, 0);
assert.deepEqual([...calls].sort(), ['__b', '__c', '__e', '__r', 'unmount']);
console.log(JSON.stringify({ version, phases, faultDetails, preparation, sharedPreact: true, earlierHooks: [...calls].sort(), closed: true }));
