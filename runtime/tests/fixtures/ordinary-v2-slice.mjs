import * as SDK from '@aotui/sdk';
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
function NewTools({ view, state }) {
  const params = SDK.defineParams({
    q: { type: 'string', required: true, constraints: { minLength: 1, maxLength: state.rule ? 2 : 1 } },
    e: { type: 'enum', options: ['1', 'yes'], required: true },
    items: { type: 'array', itemType: 'string', required: true, constraints: { minLength: 2, maxLength: 3 } },
    n: { type: 'number', default: 2, constraints: { min: 1, max: 3 } },
    payload: { type: 'object', default: { note: 'annotation' } },
  });
  const [Find] = SDK.useViewTypeTool('find', { description: 'Find current symbols', params, isMutating: false },
    args => enter('find', view, args, state.revision), { enabled: state.enabled });
  SDK.useViewTypeTool('flags', { description: 'Count flags', params: { flags: { type: 'array', itemType: 'boolean', required: true } }, isMutating: false },
    args => enter('flags', view, args, state.revision), { enabled: state.enabled });
  SDK.useViewTypeTool('open', { description: 'Preserve open input', params: { q: { type: 'string', required: true } }, additionalProperties: true, isMutating: false },
    args => enter('open', view, args, state.revision));
  SDK.useViewTypeTool('zero', { description: 'Read current state without parameters', params: {}, isMutating: false },
    args => enter('zero', view, args, state.revision));
  if (state.bad) throw Error('Controlled render failure');
  return h(Find, {}, 'Find symbols');
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
  const view = (id, type) => h(SDK.View, { key: id, id, type }, h(Boundary, {}, h(NewTools, { view: id, state })));
  return h('main', {}, [state.show ? view('aa', 'File') : null, view('bb', 'OtherFile')]);
}
export default SDK.createTUIApp({ app_name: 'ordinary_v2_fixture', component: Root });
