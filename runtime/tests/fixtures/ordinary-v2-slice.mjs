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
  const result = () => name === 'create' ? { status: 'succeeded', value: { recorded: true, id } }
    : behaviour === 'business' ? { success: false, error: { code: 'BUSINESS', message: 'Controlled failure' } }
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
  if (typeof SDK.experimental_useReadOnlyTool !== 'function') throw Error('ORDINARY_PARAMETERS_UNSUPPORTED');
  const useRead = SDK.experimental_useReadOnlyTool;
  const params = SDK.defineParams({
    q: { type: 'string', required: true, constraints: { minLength: 1, maxLength: state.rule ? 2 : 1 } },
    e: { type: 'enum', options: ['1', 'yes'], required: true },
    items: { type: 'array', itemType: 'string', required: true, constraints: { minLength: 2, maxLength: 3 } },
    n: { type: 'number', default: 2, constraints: { min: 1, max: 3 } },
    payload: { type: 'object', default: { note: 'annotation' } },
  });
  const [Find] = useRead('find', { description: 'Find current symbols', params, enabled: state.enabled },
    args => enter('find', view, args, state.revision));
  useRead('flags', { description: 'Count flags', params: { flags: { type: 'array', itemType: 'boolean', required: true } }, enabled: state.enabled },
    args => enter('flags', view, args, state.revision));
  useRead('open', { description: 'Preserve open input', params: { q: { type: 'string', required: true } }, additionalProperties: true },
    args => enter('open', view, args, state.revision));
  if (state.bad) throw Error('Controlled render failure');
  return h(Find, {}, 'Find symbols');
}
function LegacyTools({ view, state }) {
  SDK.useViewTypeTool('zero', { description: 'Old closed zero read', params: {}, isMutating: false }, args => enter('zero', view, args, state.revision));
  SDK.useViewTypeTool('legacy_arg', { description: 'Old ordinary declaration', params: { e: { type: 'enum', options: ['1'], required: true } }, isMutating: false }, args => enter('legacy_arg', view, args, state.revision));
  const ref = SDK.useDataRef('selected', { view, revision: state.revision });
  SDK.useViewTypeTool('ref_read', { description: 'Old single Ref read', params: {
    file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' },
    e: { type: 'enum', options: ['1'] },
  }, isMutating: false }, args => enter('ref_read', view, args, state.revision));
  SDK.experimental_useCreateIfAbsentTool('create', { description: 'Record creation protocol only', params: {
    relativePath: { type: 'string', required: true }, content: { type: 'string', required: true },
  } }, args => enter('create', view, args, state.revision));
  return h('p', {}, ref('Selected current value'));
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
  const view = (id, type) => h(SDK.View, { key: id, id, type }, [
    h(LegacyTools, { key: 'old', view: id, state }),
    process.env.AOTUI_W07_APP_KIND === 'legacy' ? null : h(Boundary, { key: 'new' }, h(NewTools, { view: id, state })),
  ]);
  return h('main', {}, [state.show ? view('aa', 'File') : null, view('bb', 'OtherFile')]);
}
export default SDK.createTUIApp({ app_name: 'ordinary_v2_fixture', component: Root });
