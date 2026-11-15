import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import { DEFAULT_SNAPSHOT_LIMITS } from '../snapshot/snapshot-support.js';
import { createSnapshotCore } from '../snapshot/store.js';
import type { JsonValue } from '../snapshot/types.js';
import { compileOrdinarySchema, VIEW_TYPE_PARAMETERS_MODE } from './ordinary-parameter-contract.js';
import { compileOrdinaryProfile, ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import { createViewOwnedTools } from './view-owned-tools.js';
const marker = 'x-aotui-parameter-contract';
const make = () => {
  const result = compileOrdinarySchema({ type: 'object', properties: { z: { type: 'string' }, a: { type: 'number', default: 1 } },
    required: ['z', 'a'], additionalProperties: false });
  if (!result.ok) throw Error('Fixture declaration');
  return result.contract;
};

const limit = DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes;
function boundarySchema(bytes: number) {
  const base = { type: 'object', properties: {}, required: [], additionalProperties: true, description: '' };
  const overhead = utf8Size(canonicalJson({ ...base, [marker]: VIEW_TYPE_PARAMETERS_MODE }));
  const unit = '界😀\n"\\';
  const unitBytes = utf8Size(JSON.stringify(unit)) - 2;
  const fill = bytes - overhead;
  return { ...base, description: unit.repeat(Math.floor(fill / unitBytes)) + 'x'.repeat(fill % unitBytes) };
}

describe('ViewType parameter profile', () => {
  it('roundtrips exact immutable B1 Schema and its complete identity', () => {
    const c = make(), tagged = ordinaryParameterProfile(c), result = compileOrdinaryProfile(tagged)!;
    expect(result.schema).toEqual(c.schema);
    expect(result.schema).not.toBe(c.schema);
    expect(Object.isFrozen(tagged)).toBe(true);
    expect(result.validateModelInput({ z: 'x', a: 1 })).toMatchObject({ ok: true });
  });
  it.each(['missing', 'retired', 'future', 'extra', 'ref', 'required-order', 'omitted-required', 'omitted-extra', 'tuple', 'format'])('rejects %s without silently normalizing it', kind => {
    const p: any = JSON.parse(JSON.stringify(ordinaryParameterProfile(make())));
    if (kind === 'missing') delete p[marker];
    if (kind === 'retired') p[marker] = 'ordinary-params-v1';
    if (kind === 'future') p[marker] = 'view-type-parameters-v2';
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
    expect(compileOrdinaryProfile(reordered)?.schema).toEqual(make().schema);
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

  it('checks complete canonical UTF-8 at the inclusive boundary in generation, consumption and Snapshot commit', () => {
    const compile = (bytes: number) => {
      const result = compileOrdinarySchema(boundarySchema(bytes));
      if (!result.ok) throw new Error('Bare boundary schema must compile: ' + result.issue.message);
      return result.contract;
    };
    const exact = compile(limit), above = compile(limit + 1);
    const profile = ordinaryParameterProfile(exact);
    const oversized = { ...above.schema, [marker]: VIEW_TYPE_PARAMETERS_MODE };
    expect(utf8Size(canonicalJson(profile))).toBe(limit);
    expect(canonicalJson(profile).length).toBeLessThan(limit);
    expect(utf8Size(canonicalJson(oversized))).toBe(limit + 1);
    expect(utf8Size(canonicalJson(above.schema))).toBeLessThan(limit);
    expect(() => ordinaryParameterProfile(above)).toThrow(SnapshotDataError);
    expect(() => ordinaryParameterProfile(above)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY', path: '$' }));
    expect(compileOrdinaryProfile(profile)?.schema).toEqual(exact.schema);
    expect(compileOrdinaryProfile(oversized)).toBeNull();

    const toolId = JSON.stringify(['app', 'Note', 'read']);
    const draft = (inputSchema: JsonValue, seq: number) => ({
      schemaVersion: 4, appId: 'app', instanceId: 'run', producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
      views: [{ toolBindings: [{ toolId, activationId: 'active' }], id: 'note', viewInstanceId: 'mount', type: 'Note', name: 'Note', kind: 'state',
        content: { format: 'markdown-v1', value: String(seq) } }], refs: {},
      tools: { [toolId]: { id: toolId, name: 'read', viewType: 'Note', description: 'Read', inputSchema } },
    });
    const core = createSnapshotCore();
    const restricted = createSnapshotCore({ limits: { maxToolSchemaBytes: limit - 1 } });
    core.lifecycle.startApp('app', 'run');
    restricted.lifecycle.startApp('app', 'run');
    try {
      const first = core.committer.accept(draft(profile, 1));
      if (first.status !== 'published') throw new Error('Expected publication');
      const rejection = { status: 'rejected', issue: { path: expect.stringContaining('.inputSchema') } };
      expect(core.committer.accept(draft(oversized, 2))).toMatchObject(rejection);
      expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: first.snapshot });
      expect(core.committer.accept(draft(profile, 3))).toMatchObject({ status: 'published', snapshot: { revision: 2 } });
      expect(restricted.committer.accept(draft(profile, 1))).toMatchObject(rejection);
      expect(restricted.committer.accept(draft(ordinaryParameterProfile(compile(limit - 1)), 2))).toMatchObject({ status: 'published' });
    } finally {
      core.lifecycle.dispose();
      restricted.lifecycle.dispose();
    }
  });

  it('rejects profile and declaration capacity before registering or allocating an activation', () => {
    const registry = createViewOwnedTools('app', 'run');
    const before = registry.inspect();
    const execute = vi.fn(() => ({ success: true }));
    const register = (inputSchema: Readonly<Record<string, unknown>>, description = 'Read') =>
      registry.defineTools([{ viewType: 'Note', name: 'read', description, inputSchema }]);
    const expensive = { type: 'object', properties: { xs: { type: 'array', items: { type: 'number' }, default: Array(3_000).fill(0) } } };
    for (const schema of [boundarySchema(limit + 1), expensive]) {
      expect(() => register(schema)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
    }
    expect(() => register({ type: 'object', properties: { value: { type: 'string', minLength: -1 } } }))
      .toThrow(expect.objectContaining({ code: 'PARAMETER_DECLARATION_INVALID' }));
    expect(() => register({ type: 'object', properties: { value: { type: 'string', format: 'email' } } }))
      .toThrow(expect.objectContaining({ code: 'PARAMETER_DECLARATION_UNSUPPORTED' }));
    expect(() => register(boundarySchema(limit), 'x'.repeat(128 * 1024 + 1)))
      .toThrow(expect.objectContaining({ name: 'SnapshotDataError', code: 'SNAPSHOT_SERIALIZATION_ERROR' }));
    expect(execute).not.toHaveBeenCalled();
    expect(registry.inspect()).toEqual(before);
    expect(() => register(boundarySchema(limit))).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
    register({ type: 'object', properties: {} });
    const frame = registry.prepareFrame([{ id: 'note', type: 'Note', owner: {}, bindings: [{ name: 'read', execute, enabled: true }] }]);
    frame.accept();
    expect(frame.instances[0]!.toolBindings).toEqual([{ toolId: frame.tools[0]!.id, activationId: 'ta:v2:1' }]);
    expect(execute).not.toHaveBeenCalled();
    registry.dispose();
  });
});
