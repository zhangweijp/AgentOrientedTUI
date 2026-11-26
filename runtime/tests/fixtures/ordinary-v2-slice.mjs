import * as SDK from '@aotui/sdk';
import { Type } from 'typebox';
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
  return ['File','OtherFile'].map(name => SDK.defineViewType()({ multiplicity: 'multiple',
    name,
    tools: Object.fromEntries(contracts.map(([tool, description, inputSchema]) => [tool, {
      description, inputSchema,
      enabled: ({ state }) => state.enabled,
      execute: ({ input, context: { id, state } }) => enter(tool, id, input, state.revision),
    }])),
  }));
}
const [File,OtherFile] = declareTools();
export default SDK.createApp({
  app_name: 'ordinary_v3_fixture', viewTypes: [File, OtherFile],
  initialize({ prepareProjection, registerCleanup }) {
    let state = { revision: 1, enabled: true, show: true, rule: false, bad: false, tag: 0 };
    const page = (id, type) => SDK.createView(type, { idPrefix: id, region: 'dynamic',
      render: () => ({ body: 'Business View ID: ' + id, context: { id, state } }) });
    let first = page('aa', File), second = page('bb', OtherFile);
    function publish() { prepareProjection({ views: first ? [first, second] : [second] }); }
    const receive = message => {
      if (message.type !== 'TEST_COMMAND') return;
      const { command: type, data } = message;
      if (type === 'mode') {
        behaviour = data.mode;
        parentPort.postMessage({ type: 'TEST_CONTROL_ACK', tag: data.tag });
      } else if (type === 'release') {
        held.get(data.id)?.(); held.delete(data.id);
        parentPort.postMessage({ type: 'TEST_CONTROL_ACK', tag: data.tag });
      } else if (type === 'state') {
        const previous = state;
        state = { ...state, ...data.patch, tag: data.tag };
        if (state.rule !== previous.rule) { first = page('aa', File); second = page('bb', OtherFile); }
        if (state.show) first ??= page('aa', File);
        else first = undefined;
        publish();
        parentPort.postMessage({ type: 'TEST_COMMITTED', state, tag: state.tag });
      }
    };
    parentPort.on('message', receive);
    registerCleanup({ stop() { parentPort.off('message', receive); } });
    publish();
    parentPort.postMessage({ type: 'TEST_COMMITTED', state, tag: state.tag });
  },
});
