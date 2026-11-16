import * as SDK from '@aotui/sdk';
import { Type } from 'typebox';
import { h, Component } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';

let behaviour = 'normal', sequence = 0;
const held = new Map();
function enter(name, view, args, revision) {
  const id = ++sequence;
  parentPort.postMessage({ type: 'TEST_HANDLER_ENTER', id, name, view, args, revision,
    frozen: Object.isFrozen(args), nestedFrozen: !args.flags || Object.isFrozen(args.flags) });
  const result = () => behaviour === 'business' ? { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Controlled failure' }, data: { checked: true } }
    : behaviour === 'malformed' ? { success: true, data: [] }
    : behaviour === 'huge' ? { success: true, data: { text: 'x'.repeat(512 * 1024) } }
    : { success: true, data: name === 'flags' ? { count: args.flags.length, allTrue: args.flags.every(v => v === true) }
      : { view, revision, args, id } };
  if (behaviour === 'throw') throw Error('W07_PRIVATE_EXCEPTION');
  if (behaviour === 'hold') return new Promise(resolve => held.set(id, () => resolve(result())));
  return Promise.resolve(result());
}
class Boundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { parentPort.postMessage({ type: 'TEST_UNSUPPORTED', code: 'ORDINARY_PARAMETERS_UNSUPPORTED' }); }
  render() { return this.state.failed ? h('p', {}, 'ordinary-v2 unsupported') : this.props.children; }
}

const flagsSchema = Type.Object({
  flags: Type.Array(Type.Boolean(), { minItems: 1 }),
}, { additionalProperties: false });
const openSchema = Type.Object({ q: Type.String() }, { additionalProperties: true });
const zeroSchema = Type.Object({}, { additionalProperties: false });

function declareTools() {
  const findSchema = Type.Object({
    q: Type.String({ minLength: 1, maxLength: 1 }),
    e: Type.String({ enum: ['1', 'yes'] }),
    items: Type.Array(Type.String(), { minItems: 2, maxItems: 3 }),
    n: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 3 })),
    payload: Type.Optional(Type.Object({}, { additionalProperties: true, default: { note: 'annotation' } })),
  }, { additionalProperties: false });
  const contracts = [['find', 'Find current symbols.', findSchema],
    ['flags', 'Count flags.', flagsSchema], ['open', 'Preserve open input.', openSchema],
    ['zero', 'Read current state without extra parameters.', zeroSchema]];
  return ['File','OtherFile'].map(name => SDK.defineViewType()({
    name,
    tools: Object.fromEntries(contracts.map(([tool, description, inputSchema]) => [tool, {
      description, inputSchema,
      enabled: ({ state }) => state.enabled,
      execute: ({ input, context: { id, state } }) => enter(tool, id, input, state.revision),
    }])),
  }));
}
const [File,OtherFile] = declareTools();
function Detail({ state, viewId }) {
  if (state.bad) throw Error('Controlled render failure');
  return h('p', {}, `Business View ID: ${viewId}`);
}
function Root() {
  const [state, set] = useState({ revision: 1, enabled: true, show: true, rule: false, bad: false, tag: 0 });
  useLayoutEffect(() => {
    const receive = message => {
      if (message.type !== 'TEST_COMMAND') return;
      const { command: type, data } = message;
      if (type === 'mode') { behaviour = data.mode; parentPort.postMessage({ type: 'TEST_CONTROL_ACK', tag: data.tag }); }
      else if (type === 'release') { held.get(data.id)?.(); held.delete(data.id); parentPort.postMessage({ type: 'TEST_CONTROL_ACK', tag: data.tag }); }
      else if (type === 'state') set(current => ({ ...current, ...data.patch, tag: data.tag }));
    };
    parentPort.on('message', receive);
    return () => parentPort.off('message', receive);
  }, []);
  useLayoutEffect(() => { parentPort.postMessage({ type: 'TEST_COMMITTED', state, tag: state.tag }); }, [state]);

  const view = (id, type) => h(SDK.View, { kind: 'state', key: id + ':' + state.rule, id, type, context: { id, state } },
    h(Boundary, {}, h(Detail, { state, viewId: id })));
  return h('main',{},[state.show ? view('aa',File) : null,view('bb',OtherFile)]);
}
export default SDK.createTUIApp({ app_name: 'ordinary_v3_fixture', component: Root, viewTypes:[File,OtherFile] });
