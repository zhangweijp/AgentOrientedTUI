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
  const result = () => behaviour === 'business' ? { success: false, error: { code: 'BUSINESS', message: 'Controlled failure' } }
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
  view_id: Type.String(),
  flags: Type.Array(Type.Boolean(), { minItems: 1 }),
}, { additionalProperties: false });
const openSchema = Type.Object({ view_id: Type.String(), q: Type.String() }, { additionalProperties: true });
const zeroSchema = Type.Object({ view_id: Type.String() }, { additionalProperties: false });

function declareTools(rule) {
  const findSchema = Type.Object({
    view_id: Type.String({ description: '当前应用内可见 View 的业务 ID。' }),
    q: Type.String({ minLength: 1, maxLength: rule ? 2 : 1 }),
    e: Type.String({ enum: ['1', 'yes'] }),
    items: Type.Array(Type.String(), { minItems: 2, maxItems: 3 }),
    n: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 3 })),
    payload: Type.Optional(Type.Object({}, { additionalProperties: true, default: { note: 'annotation' } })),
  }, { additionalProperties: false });
  const contracts = [['find', 'Find current symbols.', findSchema],
    ['flags', 'Count flags.', flagsSchema], ['open', 'Preserve open input.', openSchema],
    ['zero', 'Read current state without extra parameters.', zeroSchema]];
  return SDK.defineToolSet(Object.fromEntries(['File', 'OtherFile'].flatMap(viewType =>
    contracts.map(([name, description, inputSchema]) => [viewType + '_' + name,
      SDK.defineViewTypeTool({ viewType, name, description, inputSchema })]))));
}
const toolSets = [declareTools(false), declareTools(true)];
function bindAction(viewType, name, state) {
  return args => {
    const view = args.view_id;
    if ((view !== 'aa' && view !== 'bb') || (view === 'aa' && (!state.show || viewType !== 'File')) ||
        (view === 'bb' && viewType !== 'OtherFile')) {
      return { success: false, error: { code: 'VIEW_NOT_OPEN', message: 'The selected business View is not open.' } };
    }
    return enter(name, view, args, state.revision);
  };
}
function Detail({ state, viewId }) {
  if (state.bad) throw Error('Controlled render failure');
  return h('p', {}, `Business View ID: ${viewId}`);
}
function Root() {
  const [state, set] = useState({ revision: 1, enabled: true, show: true, rule: false, bad: false, tag: 0 });
  useLayoutEffect(() => {
    const receive = event => {
      const { type, data } = event.detail;
      if (type === 'mode') { behaviour = data.mode; parentPort.postMessage({ type: 'TEST_CONTROL_ACK', tag: data.tag }); }
      else if (type === 'release') { held.get(data.id)?.(); held.delete(data.id); parentPort.postMessage({ type: 'TEST_CONTROL_ACK', tag: data.tag }); }
      else if (type === 'state') set(current => ({ ...current, ...data.patch, tag: data.tag }));
    };
    document.body.addEventListener('aotui:external-event', receive);
    return () => document.body.removeEventListener('aotui:external-event', receive);
  }, []);
  useLayoutEffect(() => { parentPort.postMessage({ type: 'TEST_COMMITTED', state, tag: state.tag }); }, [state]);

  const tools = toolSets[Number(state.rule)];
  const bindings = Object.fromEntries(Object.entries(tools).map(([key, tool]) => [key,
    { enabled: state.enabled, execute: bindAction(tool.viewType, tool.name, state) }]));
  const view = (id, type) => h(SDK.View, {kind: 'state', key: id, id, type }, h(Boundary, {}, h(Detail, { state, viewId: id })));
  return h(SDK.AppTools, { key: String(state.rule), definition: tools, bindings },
    h('main', {}, [state.show ? view('aa', 'File') : null, view('bb', 'OtherFile')]));
}
export default SDK.createTUIApp({ app_name: 'ordinary_v3_fixture', component: Root });
