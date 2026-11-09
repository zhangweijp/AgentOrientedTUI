// Shared business inputs and expected values, independent of either Producer.
import Type from 'typebox';
import { refParam, defineViewTypeTool, defineToolSet } from '@aotui/sdk';
export const description = 'Read shared business data';
const ordinaryFields = {
  q: Type.String(),
  n: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 4 })),
  choice: Type.Optional(Type.String({ enum: ['yes', 'no'], default: 'yes' })),
};
const ordinarySchema = Type.Object({
  view_id: Type.String({ description: 'Private fixture business session, not a model-facing Ref substitute.' }),
  ...ordinaryFields,
}, { additionalProperties: false });
const referenceSchema = Type.Object({
  ...ordinaryFields,
  file: refParam('File', Type.Object({ view: Type.String(), session: Type.Number(), text: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
// Both Producers consume the same publicly captured declaration, including the TypeBox export boundary.
export const tools = defineToolSet({
  Read: defineViewTypeTool({ viewType: 'File', name: 'read', description, inputSchema: ordinarySchema }),
  ReadRef: defineViewTypeTool({ viewType: 'File', name: 'read_ref', description: `${description} from the original granted Ref.`, inputSchema: referenceSchema }),
});
export const ordinaryInputSchema = tools.Read.inputSchema;
export const referenceInputSchema = tools.ReadRef.inputSchema;
export const fileLabel = id => id === 'aa' ? 'alpha' : 'beta';
export const fileRef = (id, ambiguous = false) => id + '.' + (ambiguous ? 'shared' : fileLabel(id));
export const privateRef = id => id + '.private_' + fileLabel(id);
export const filePayload = (state, id, text = state.values[id]) => ({ view: id, session: state.mounts[id], text });
export function selectedBusinessSession(state, name, args) {
  const selected = name === 'read_ref' ? `${args.file.view}@${args.file.session}` : args.view_id;
  return state.order.find(id => selected === `${id}@${state.mounts[id]}` && state.enabled[id]);
}
export function initialBusiness() { return { order: [], values: { aa: 'A', bb: 'B' }, enabled: { aa: true, bb: true },
  mounts: { aa: 0, bb: 0 }, sequence: 0, holdHandler: false, ambiguous: false }; }
export function applyBusiness(previous, command) {
  const state = { ...previous, order: [...previous.order], values: { ...previous.values }, enabled: { ...previous.enabled },
    mounts: { ...previous.mounts }, sequence: previous.sequence + 1 };
  if (command.op === 'mount') { for (const id of command.ids) if (!state.order.includes(id)) { state.order.push(id);state.mounts[id]++; } }
  else if (command.op === 'remove') state.order = state.order.filter(id => !command.ids.includes(id));
  else if (command.op === 'order') state.order = [...command.ids];
  else if (command.op === 'value') state.values[command.id] = command.value;
  else if (command.op === 'enabled') state.enabled[command.id] = command.value;
  else if (command.op === 'ambiguity') state.ambiguous = command.value;
  else if (command.op === 'hold') state.holdHandler = command.value;
  else throw Error('Unknown business command');
  return state;
}
export function businessResult(viewId, args) {
  if (args.q === 'business-failed') return { success: false, data: { viewId, retained: 'business-data' },
    error: { code: 'BUSINESS_REJECTED', message: 'Shared controlled failure' } };
  return { success: true, data: { viewId, q: args.q, n: args.n ?? 2, choice: args.choice ?? 'yes', fileText: args.file?.text ?? null } };
}
export const expectedRead = (viewId, q, fileText = null, n = 2, choice = 'yes') => ({ success: true, data: { viewId, q, n, choice, fileText } });
export const businessSequence = Object.freeze([
  { name: 'initial-empty', kind: 'empty' },
  { name: 'two-views', kind: 'change', command: { op: 'mount', ids: ['aa', 'bb'] }, views: ['aa', 'bb'] },
  { name: 'ordinary-defaults', kind: 'invoke', view: 'aa', tool: 'read', input: { view_id: 'aa@1', q: 'hello' }, result: expectedRead('aa', 'hello'), handlers: 1 },
  { name: 'explicit-values', kind: 'invoke', view: 'aa', tool: 'read', input: { view_id: 'aa@1', q: 'explicit', n: 3, choice: 'no' }, result: expectedRead('aa', 'explicit', null, 3, 'no'), handlers: 1 },
  { name: 'other-target', kind: 'invoke', view: 'bb', tool: 'read', input: { view_id: 'bb@1', q: 'other' }, result: expectedRead('bb', 'other'), handlers: 1 },
  { name: 'invalid-type', kind: 'refuse', view: 'aa', tool: 'read', input: { view_id: 'aa@1', q: 7 }, handlers: 0 },
  { name: 'unknown-field', kind: 'refuse', view: 'aa', tool: 'read', input: { view_id: 'aa@1', q: 'x', extra: true }, handlers: 0 },
  { name: 'invalid-range', kind: 'refuse', view: 'aa', tool: 'read', input: { view_id: 'aa@1', q: 'x', n: 5 }, handlers: 0 },
  { name: 'ref-original', kind: 'invoke', view: 'aa', tool: 'read_ref', input: { q: 'ref', file: fileRef('aa') }, result: expectedRead('aa', 'ref', 'A'), handlers: 1 },
  { name: 'foreign-ref', kind: 'refuse', view: 'aa', tool: 'read_ref', input: { q: 'ref', file: privateRef('bb') }, handlers: 0 },
  { name: 'forged-ref', kind: 'refuse', view: 'aa', tool: 'read_ref', input: { q: 'ref', file: 'forged' }, handlers: 0 },
  { name: 'business-failed', kind: 'business-failed', view: 'bb', tool: 'read', input: { view_id: 'bb@1', q: 'business-failed' },
    result: { success: false, data: { viewId: 'bb', retained: 'business-data' }, error: { code: 'BUSINESS_REJECTED', message: 'Shared controlled failure' } }, handlers: 1 },
]);
