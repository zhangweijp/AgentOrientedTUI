import * as SDK from '@aotui/sdk';
import { Type } from 'typebox';
import { parentPort } from 'node:worker_threads';

let mode = 'normal', sequence = 0;
const held = new Map(), literal = { 'x-aotui-ref': { kind: 'DATA' }, 'x-aotui-parameter-contract': 'DATA', refSource: 'DATA' };
function enter(name, view, args, revision, refName = 'file') {
    const id = ++sequence;
    parentPort.postMessage({ type: 'REF_V2_HANDLER_ENTER', id, name, view, revision,
        args: name === 'capacity' ? { count: args.file.list.length } : args,
        frozen: Object.isFrozen(args), refFrozen: !args[refName] || Object.isFrozen(args[refName]),
        nestedFrozen: !args[refName]?.list || Object.isFrozen(args[refName].list) });
    if (mode === 'throw') throw Error('REF_V2_PRIVATE_EXCEPTION');
    const result = () => mode === 'business' ? { success: false, data: { retained: true }, error: { code: 'BUSINESS', message: 'Controlled business failure' } }
        : mode === 'malformed' ? { success: true, data: [] }
        : mode === 'huge' ? { success: true, data: { value: 'x'.repeat(600000) } }
        : { success: true, data: name === 'capacity' ? { nodes: args.file.list.length + 4, view, id } : { args, view, revision, id } };
    if (mode === 'hold') return new Promise(resolve => held.set(id, () => resolve(result())));
    return Promise.resolve(result());
}
// Private protocol fixture: returned arguments are controlled witnesses, not a public App data pattern.
const labelFor = view => view === 'aa' ? 'alpha' : 'beta';
const valueSchema = () => Type.Object({}, { additionalProperties: true });
const specialNames = ['', '__proto__', 'constructor', 'x-aotui-ref', 'x-aotui-parameter-contract', 'line\nname'];
function makeTools() {
    const ref = kind => SDK.refParam(kind, valueSchema());
    const declare = (name, fields, additionalProperties = false) => ({
        description: 'Inspect an explicitly granted original value for the protocol fixture.',
        inputSchema: Type.Object(fields, { additionalProperties }),
        enabled: ({ state }) => state.enabled,
        execute({ input: args, context: { id, state } }) {
            parentPort.postMessage({ type: 'REF_HANDLER_ENTRY', name, receiver:id });
            const param = name.startsWith('special_') ? specialNames[Number(name.slice(8))] : 'file';
            const view = name === 'plain' ? id : args[param].view;
            if (view !== 'aa' && view !== 'bb' || view === 'aa' && !state.show || view === 'bb' && !state.showSecond) {
                parentPort.postMessage({ type: 'REF_APP_GUARD', name, view });
                return { success: false, error: { code: 'VIEW_NOT_OPEN', message: 'The selected fixture object is not open.' } };
            }
            return enter(name, view, args, state.revision, param);
        },
    });
    const definitions = {
        inspect: declare('inspect', { file: ref('Data'), choice: Type.String({ enum: ['7', 'ok'] }),
            text: Type.Optional(Type.String({ maxLength: 1 })),
            tags: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 3 })),
            n: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 3 })),
            meta: Type.Optional(Type.Object({}, { additionalProperties: true, default: literal })) }),
        capacity: declare('capacity', { file: ref('Data') }),
        open_ref: declare('open_ref', { file: ref('Data') }, true),
        typed: declare('typed', { file: ref('File') }),
        plain: declare('plain', {}),
    };
    for (const [index, param] of specialNames.entries())
        definitions['special_' + index] = declare('special_' + index, Object.fromEntries([[param, ref('Data')]]));
    return SDK.defineViewType()({ multiplicity: 'multiple', name:"File",tools:definitions});
}
const File = makeTools();
const Guide = SDK.defineViewType({ multiplicity: 'multiple', name:"Root"});
export default SDK.createApp({
  app_name: 'ref_v2_fixture', viewTypes: [Guide, File],
  initialize({ publish: commit, registerLifecycle }) {
    let state = { text: 'A', revision: 1, rule: false, defaultValue: 2, enabled: true,
      show: true, showSecond: true, refType: '', capacityNodes: 8, tag: 0 };
    const root = (() => { const handle = SDK.createView(Guide, { idPrefix: 'root', region: 'static' }); return { handle, frame: () => handle.frame({ body: '# Reference Inspector Application Instruction\n\nInspect displayed values from their original file views.' +
            ((state.show || state.showSecond) ? '\n\n## File\nOriginal values and available tools: inspect, capacity, open_ref, typed and plain.' : '') }) }; })();
    const makeFile = id => (() => { const handle = SDK.createView(File, { idPrefix: id, region: 'dynamic' }); return { handle, frame: () => {
      const label = labelFor(id);
      const schema = Type.Object({});
      const options = { schema, scope: 'protected', refType: 'Data' };
      const file = SDK.ref(label, { label: state.text, view: id, literal }, options);
      // The fixture sizes the complete decoded request by the published list's node count.
      const big = SDK.ref('capacity_' + label, { view: id, list: Array(Math.max(0, state.capacityNodes - 4)).fill(null) }, options);
      const foreign = SDK.ref('private_' + label, { view: id }, options);
      return handle.frame({ refs: [file, big, foreign], context: { id, state }, body: [
        'Private fixture object: ' + id, SDK.formatRef('Original file value', file),
        SDK.formatRef('List value', big), SDK.formatRef('View-specific value', foreign),
        'Private protocol tools: inspect and plain; availability is supplied by the committed Tool catalog.',
      ].join('\n\n') });
    } }; })();
    let first = makeFile('aa'), second = makeFile('bb');
    const mountKey = () => JSON.stringify([state.rule, state.defaultValue, state.refType]);
    function publish() { commit(() => ([root, ...(first ? [first] : []), ...(second ? [second] : [])]).map(page => page.frame())); }
    const receive = message => {
      if (message.type !== 'TEST_COMMAND') return;
      const { command: type, data } = message;
      if (type === 'state') {
        const key = mountKey();
        state = { ...state, ...data.patch, tag: data.tag };
        if (key !== mountKey()) { first = undefined; second = undefined; }
        first = state.show ? first ?? makeFile('aa') : undefined;
        second = state.showSecond ? second ?? makeFile('bb') : undefined;
        try { publish(); } catch { /* Runtime reports fixture limits. */ }
        parentPort.postMessage({ type: 'REF_V2_COMMITTED', state, tag: state.tag });
      } else if (type === 'mode') {
        mode = data.mode; parentPort.postMessage({ type: 'REF_V2_CONTROL_ACK', tag: data.tag });
      } else if (type === 'release') {
        held.get(data.id)?.(); held.delete(data.id);
        parentPort.postMessage({ type: 'REF_V2_CONTROL_ACK', tag: data.tag });
      }
    };
    parentPort.on('message', receive);
    registerLifecycle({ stop() { parentPort.off('message', receive); } });
    publish();
    parentPort.postMessage({ type: 'REF_V2_COMMITTED', state, tag: state.tag });
  },
});
