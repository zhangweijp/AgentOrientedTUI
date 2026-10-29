/*
 * M0 SP-03: serialization compatibility samples.
 * This is a serializer behavior exploration (not production Core/SDK code).
 * Run: node "Runtime Core Semantic Contract RFC/m0/probes/ref-wire-compat.cjs"
 */
let getterReads = 0;
const getter = Object.defineProperty({}, 'secret', {
  enumerable: true, get() { getterReads++; return 'accessed'; },
});
const cycle = { id: 'cycle' }; cycle.self = cycle;
class DomainEntity { constructor() { this.id = 'class'; } action() { return 1; } }

const cases = [
  ['plain-record', { id: 'a', nested: { status: 'ok' } }],
  ['date', { when: new Date('2026-10-21T00:00:00Z') }],
  ['map', { values: new Map([['a', 1]]) }],
  ['class-instance', { value: new DomainEntity() }],
  ['getter', getter],
  ['circular', cycle],
  ['function-field', { id: 'fn', handler() {} }],
  ['bigint-field', { id: 'big', n: 1n }],
  ['nan-field', { id: 'nan', n: NaN }],
];
function describe(value) {
  try {
    const data = JSON.stringify(value);
    return { ok: true, json: (data || '').slice(0, 120) };
  } catch (e) { return { ok: false, error: e.name }; }
}
function clone(value) {
  try {
    const data = structuredClone(value);
    return {
      ok: true,
      json: describe(data),
      resultTypes: {
        whenIsDate: data.when instanceof Date,
        valuesIsMap: data.values instanceof Map,
        classPrototypePreserved: data.value instanceof DomainEntity,
        circularPreserved: data.self === data,
      },
    };
  } catch (e) { return { ok: false, error: e.name }; }
}
const results = cases.map(([name, value]) => ({
  name, json: describe(value), structuredClone: clone(value),
}));
console.log(JSON.stringify({ getterReads, results }, null, 2));
