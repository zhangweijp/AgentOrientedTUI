// Shared business inputs and expected values, independent of either Producer.
export const ordinaryParams = Object.freeze({ q: { type: 'string', required: true },
  n: { type: 'number', default: 2, constraints: { min: 1, max: 4 } },
  choice: { type: 'enum', options: ['yes', 'no'], default: 'yes' } });
export const refParams = Object.freeze({ ...ordinaryParams, file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });
export const description = 'Read shared business data';
export function initialBusiness() { return { order: [], values: { aa: 'A', bb: 'B' }, enabled: { aa: true, bb: true },
  mounts: { aa: 0, bb: 0 }, registrations: { aa: 0, bb: 0 }, sequence: 0, holdHandler: false }; }
export function applyBusiness(previous, command) {
  const state = { ...previous, order: [...previous.order], values: { ...previous.values }, enabled: { ...previous.enabled },
    mounts: { ...previous.mounts }, registrations: { ...previous.registrations }, sequence: previous.sequence + 1 };
  if (command.op === 'mount') { for (const id of command.ids) if (!state.order.includes(id)) { state.order.push(id);state.mounts[id]++; } }
  else if (command.op === 'remove') state.order = state.order.filter(id => !command.ids.includes(id));
  else if (command.op === 'order') state.order = [...command.ids];
  else if (command.op === 'value') state.values[command.id] = command.value;
  else if (command.op === 'enabled') state.enabled[command.id] = command.value;
  else if (command.op === 'register') state.registrations[command.id]++;
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
  { name: 'ordinary-defaults', kind: 'invoke', view: 'aa', tool: 'read', input: { q: 'hello' }, result: expectedRead('aa', 'hello'), handlers: 1 },
  { name: 'explicit-values', kind: 'invoke', view: 'aa', tool: 'read', input: { q: 'explicit', n: 3, choice: 'no' }, result: expectedRead('aa', 'explicit', null, 3, 'no'), handlers: 1 },
  { name: 'other-target', kind: 'invoke', view: 'bb', tool: 'read', input: { q: 'other' }, result: expectedRead('bb', 'other'), handlers: 1 },
  { name: 'invalid-type', kind: 'refuse', view: 'aa', tool: 'read', input: { q: 7 }, handlers: 0 },
  { name: 'unknown-field', kind: 'refuse', view: 'aa', tool: 'read', input: { q: 'x', extra: true }, handlers: 0 },
  { name: 'invalid-range', kind: 'refuse', view: 'aa', tool: 'read', input: { q: 'x', n: 5 }, handlers: 0 },
  { name: 'ref-original', kind: 'invoke', view: 'aa', tool: 'read_ref', input: { q: 'ref', file: 'file' }, result: expectedRead('aa', 'ref', 'A'), handlers: 1 },
  { name: 'foreign-ref', kind: 'refuse', view: 'aa', tool: 'read_ref', input: { q: 'ref', file: 'private-bb' }, handlers: 0 },
  { name: 'forged-ref', kind: 'refuse', view: 'aa', tool: 'read_ref', input: { q: 'ref', file: 'forged' }, handlers: 0 },
  { name: 'business-failed', kind: 'business-failed', view: 'bb', tool: 'read', input: { q: 'business-failed' },
    result: { success: false, data: { viewId: 'bb', retained: 'business-data' }, error: { code: 'BUSINESS_REJECTED', message: 'Shared controlled failure' } }, handlers: 1 },
]);
