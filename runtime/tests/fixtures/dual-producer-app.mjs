// Private dual-producer contract fixture; returned data is a test witness, not an App authoring example.
import { h } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { createTUIApp, View, useDataRef, AppTools, ToolRef } from '@aotui/sdk';
import { initialBusiness, applyBusiness, businessResult, tools,
  fileLabel, filePayload, selectedBusinessSession } from './dual-producer-business.mjs';

let handlerSequence = 0, entrySequence = 0, projection;
async function execute(name, args, state) {
  // First handler action, before any App guard. DUAL_HANDLER_ENTER below is business entry only.
  parentPort.postMessage({ type: 'DUAL_HANDLER_ENTRY', sequence: ++entrySequence, name });
  const stateBefore = JSON.stringify(state), id = selectedBusinessSession(state, name, args);
  if (!id) {
    parentPort.postMessage({ type: 'DUAL_BUSINESS_REJECTED', name, stateBefore, stateAfter: JSON.stringify(state),
      sessionId: name === 'read_ref' ? `${args.file.view}@${args.file.session}` : args.view_id });
    return { success: false, error: { code: 'VIEW_NOT_OPEN', message: 'The requested business session is not open and enabled.' } };
  }
  const sequence = ++handlerSequence;
  parentPort.postMessage({ type: 'DUAL_HANDLER_ENTER', sequence, name, viewId: id, args, q: args.q, fileText: args.file?.text ?? null });
  if (state.holdHandler) await new Promise(() => {});
  return businessResult(id, args);
}
function Detail({ id, state }) {
  const file = useDataRef(state.ambiguous ? 'shared' : fileLabel(id), filePayload(state, id), { refType: 'File' });
  useDataRef('private_' + fileLabel(id), filePayload(state, id, 'private-' + id), { refType: 'File' });
  return h('section', {}, [
    h('p', {}, [`File View session ID: ${id}@${state.mounts[id]}. Stable File value. `, file('File value')]),
    h(ToolRef, { tool: tools.Read }, 'Private ordinary-parameter comparison'),
    h(ToolRef, { tool: tools.ReadRef }, 'Read the granted original file Ref'),
  ]);
}
function Root() {
  const [state, setState] = useState(initialBusiness);
  useLayoutEffect(() => {
    const receive = message => { if (message.type === 'DUAL_CONTROL') setState(previous => applyBusiness(previous, message.command)); };
    parentPort.on('message', receive); return () => parentPort.off('message', receive);
  }, []);
  useLayoutEffect(() => {
    queueMicrotask(() => parentPort.postMessage({ type: 'DUAL_COMMITTED', sequence: state.sequence,
      order: state.order, projectionEpoch: projection.token().epoch }));
  }, [state]);
  const enabled = state.order.some(id => state.enabled[id]);
  return h(AppTools, { definition: tools, bindings: {
    Read: { execute: args => execute('read', args, state), enabled },
    ReadRef: { execute: args => execute('read_ref', args, state), enabled },
  } }, h('main', { 'data-dual-sequence': state.sequence }, state.order.map(id =>
    h(View, {kind: 'state', key: id + ':' + state.mounts[id], id, type: 'File' }, h(Detail, { id, state })))));
}
const factory = createTUIApp({ app_name: 'dual_producer', component: Root });
const initialize = factory.initializeComponent;
factory.initializeComponent = (container, context) => { projection = context.projection; return initialize.call(factory, container, context); };
export default factory;
