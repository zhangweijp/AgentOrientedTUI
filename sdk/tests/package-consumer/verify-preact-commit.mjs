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

const { View, createTUIApp, defineViewType, useDataRef } = await import(sdkEntry);
// The public Node Host puts each App in its own Worker. Use two installed
// kernels here to test both owners on the very same Preact render queue.
const { DEFAULT_PROJECTION_LIMITS } = await import(new URL('./core/invocation/observation-registry.js', import.meta.resolve('@aotui/runtime')));
const { AppKernel } = await import(new URL('./worker-runtime/app-kernel/AppKernel.js', import.meta.resolve('@aotui/runtime')));
const File = defineViewType()({ name: 'File', tools: {
  edit: { description: 'Edit a visible value', enabled: state => state.value > 0, execute: () => ({ success: true }) },
} });
class ClassCallback extends Component {
  componentDidMount() { throw new Error('class failed'); }
  render() { return null; }
}

function app(appId) {
  let update;
  function Body({ value, failure }) {
    const selected = useDataRef('selected', { value });
    useLayoutEffect(() => { if (failure === 'layout') throw new Error('layout failed'); }, [failure]);
    if (failure === 'render') throw new Error('render failed');
    return [h('p', { key: 'body' }, selected(`value:${value}`)),
      failure === 'class' && h(ClassCallback, { key: 'class' })];
  }
  function Root() {
    const [state, set] = useState({ value: 0 });
    update = set;
    return h(View, { id: 'file', kind: 'state', type: File, context: state }, h(Body, state));
  }
  const factory = createTUIApp({ app_name: appId, viewTypes: [File], component: Root });
  const kernel = new AppKernel({ ...factory.kernelConfig, factory, appId, desktopId: 'desktop',
    instanceId: appId + '-run', projectionLimits: DEFAULT_PROJECTION_LIMITS });
  return { appId, kernel, open: () => kernel.onOpen(), update: state => update(state) };
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

const left = app('left'), right = app('right');
const phases = ['render', 'layout', 'class'];
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
    healthy(right, i + 1);
    left.update({ value: i + 1 });
    await commit(left);
    healthy(left, i + 1);
  }
} finally {
  await Promise.all([left.kernel.onClose(), right.kernel.onClose()]);
}
assert.equal(document.querySelectorAll('[data-app-root]').length, 0);
assert.deepEqual([...calls].sort(), ['__b', '__c', '__e', '__r', 'unmount']);
console.log(JSON.stringify({ version, phases, sharedPreact: true, earlierHooks: [...calls].sort(), closed: true }));
