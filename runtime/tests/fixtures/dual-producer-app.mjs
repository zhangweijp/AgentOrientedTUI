import { h } from 'preact';
import { useCallback, useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { createTUIApp, View, useDataRef, experimental_useReadOnlyTool } from '@aotui/sdk';
import { initialBusiness, applyBusiness, businessResult, ordinaryParams, refParams, description } from './dual-producer-business.mjs';

let handlerSequence = 0, projection;
function Tools({ id, state }) {
  const handler = useCallback(async args => {
    const sequence = ++handlerSequence;
    parentPort.postMessage({ type: 'DUAL_HANDLER_ENTER', sequence, viewId: id, args, q: args.q, fileText: args.file?.text ?? null });
    if (state.holdHandler) await new Promise(() => {});
    return businessResult(id, args);
  }, [id, state.registrations[id], state.holdHandler]);
  experimental_useReadOnlyTool('read', { description, params: ordinaryParams, additionalProperties: false, enabled: state.enabled[id] }, handler);
  experimental_useReadOnlyTool('read_ref', { description, params: refParams, additionalProperties: false, enabled: state.enabled[id] }, handler);
  return null;
}
function Detail({ id, state }) {
  const file = useDataRef('file', { text: state.values[id] });
  useDataRef('private-' + id, { text: 'private-' + id });
  return h('section', {}, [h(Tools, { key: state.registrations[id], id, state }), h('p', {}, [id, ' stable ', file('File value')])]);
}
function Root() {
  const [state, setState] = useState(initialBusiness);
  useLayoutEffect(() => {
    const receive = message => {
      if (message.type === 'DUAL_CONTROL') setState(previous => applyBusiness(previous, message.command));
    };
    parentPort.on('message', receive);return () => parentPort.off('message', receive);
  }, []);
  useLayoutEffect(() => { queueMicrotask(() => parentPort.postMessage({ type: 'DUAL_COMMITTED', sequence: state.sequence,
    order: state.order, projectionEpoch: projection.token().epoch })); }, [state]);
  return h('main', { 'data-dual-sequence': state.sequence }, state.order.map(id => h(View, { key: id + ':' + state.mounts[id], id, type: 'File' }, h(Detail, { id, state }))));
}
const factory = createTUIApp({ app_name: 'dual_producer', component: Root });
const initialize = factory.initializeComponent;
factory.initializeComponent = (container, context) => { projection = context.projection;return initialize.call(factory, container, context); };
export default factory;
