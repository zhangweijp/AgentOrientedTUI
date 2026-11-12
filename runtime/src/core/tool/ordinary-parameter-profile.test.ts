import { describe, expect, it } from 'vitest';
import { compileOrdinaryParams } from './ordinary-parameter-contract.js';
import { compileOrdinaryProfile, ordinaryParameterProfile, ORDINARY_PARAMETER_MARKER as marker } from './ordinary-parameter-profile.js';
const make = () => {
  const result = compileOrdinaryParams({ z: { type: 'string', required: true }, a: { type: 'number', required: true, default: 1 } }, { additionalProperties: false });
  if (!result.ok) throw Error('Fixture declaration');
  return result.contract;
};
describe('R01 ordinary-v2 declaration profile', () => {
  it('roundtrips exact immutable B1 Schema and its complete identity', () => {
    const c = make(), tagged = ordinaryParameterProfile(c), result = compileOrdinaryProfile(tagged)!;
    expect(result.fingerprint).toBe(c.fingerprint);
    expect(result.schema).toEqual(c.schema);
    expect(result.schema).not.toBe(c.schema);
    expect(Object.isFrozen(tagged)).toBe(true);
    expect(result.validate({ z: 'x', a: 1 })).toMatchObject({ ok: true });
  });
  it.each(['missing', 'future', 'extra', 'ref', 'required-order', 'omitted-required', 'omitted-extra', 'tuple', 'format'])('rejects %s without silently normalizing it', kind => {
    const p: any = JSON.parse(JSON.stringify(ordinaryParameterProfile(make())));
    if (kind === 'missing') delete p[marker];
    if (kind === 'future') p[marker] = 'ordinary-params-v2';
    if (kind === 'extra') p['x-aotui-other'] = true;
    if (kind === 'ref') p.properties.z['x-aotui-ref'] = { version: 1 };
    if (kind === 'required-order') p.required.reverse();
    if (kind === 'omitted-required') delete p.required;
    if (kind === 'omitted-extra') delete p.additionalProperties;
    if (kind === 'tuple') p.properties.a = { type: 'array', items: [{ type: 'string' }] };
    if (kind === 'format') p.properties.a = { type: 'string', format: 'date-time' };
    expect(compileOrdinaryProfile(p)).toBeNull();
  });
  it('rejects invalid patterns in transported profiles', () => {
    const p: any = JSON.parse(JSON.stringify(ordinaryParameterProfile(make())));
    p.properties.query = { type: 'string', pattern: '[' };
    expect(compileOrdinaryProfile(p)).toBeNull();
  });
  it('accepts equivalent object key insertion order without broadening required order', () => {
    const p: any = ordinaryParameterProfile(make());
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(compileOrdinaryProfile(reordered)?.fingerprint).toBe(make().fingerprint);
  });
  it('rejects getters without reading them and preserves both capacity layers', () => {
    let reads = 0;
    const p = { get [marker]() { reads++; return 'ordinary-params-v1'; } };
    expect(compileOrdinaryProfile(p)).toBeNull();
    expect(reads).toBe(0);
    const tagged: any = JSON.parse(JSON.stringify(ordinaryParameterProfile(make())));
    tagged.description = 'x'.repeat(64 * 1024);
    expect(compileOrdinaryProfile(tagged)).toBeNull();
    tagged.description = 'x'.repeat(128 * 1024);
    expect(compileOrdinaryProfile(tagged)).toBeNull();
    let nested: any = true;
    for (let i = 0; i < 49; i++) nested = { x: nested };
    expect(compileOrdinaryProfile(nested)).toBeNull();
  });
});
