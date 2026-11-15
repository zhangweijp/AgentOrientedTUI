import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import { DEFAULT_SNAPSHOT_LIMITS } from '../snapshot/snapshot-support.js';
import { createSnapshotCore } from '../snapshot/store.js';
import type { JsonValue } from '../snapshot/types.js';
import { compileOrdinaryParams, compileOrdinarySchema, VIEW_TYPE_PARAMETERS_MODE } from './ordinary-parameter-contract.js';
import { compileOrdinaryProfile, ordinaryParameterProfile, ORDINARY_PARAMETER_MARKER as marker } from './ordinary-parameter-profile.js';
import { createViewOwnedTools, ViewToolContractError } from './view-owned-tools.js';
const make = () => {
  const result = compileOrdinaryParams({ z: { type: 'string', required: true }, a: { type: 'number', required: true, default: 1 } }, { additionalProperties: false });
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

  it('checks complete canonical UTF-8 at the inclusive boundary in generation, consumption and Snapshot commit', () => {
    const compile = (bytes: number) => {
      const result = compileOrdinarySchema(boundarySchema(bytes), VIEW_TYPE_PARAMETERS_MODE);
      if (!result.ok) throw new Error('Bare boundary schema must compile: ' + result.issue.message);
      return result.contract;
    };
    const exact = compile(limit), above = compile(limit + 1);
    const profile = ordinaryParameterProfile(exact);
    const oversized = { ...above.schema, [marker]: above.revision };
    expect(utf8Size(canonicalJson(profile))).toBe(limit);
    expect(canonicalJson(profile).length).toBeLessThan(limit);
    expect(utf8Size(canonicalJson(oversized))).toBe(limit + 1);
    expect(utf8Size(canonicalJson(above.schema))).toBeLessThan(limit);
    expect(() => ordinaryParameterProfile(above)).toThrow(SnapshotDataError);
    expect(() => ordinaryParameterProfile(above)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY', path: '$' }));
    expect(compileOrdinaryProfile(profile)?.fingerprint).toBe(exact.fingerprint);
    expect(compileOrdinaryProfile(oversized)).toBeNull();

    const toolId = JSON.stringify(['app', 'Note', 'read']);
    const draft = (inputSchema: JsonValue, seq: number) => ({
      schemaVersion: 3, appId: 'app', instanceId: 'run', producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
      views: [{ id: 'note', viewInstanceId: 'mount', type: 'Note', name: 'Note', kind: 'state',
        content: { format: 'markdown-v1', value: String(seq) } }], refs: {},
      tools: { [toolId]: { id: toolId, name: 'read', viewType: 'Note', description: 'Read', inputSchema,
        execution: { kind: 'view-type', activationId: 'active' } } },
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
    registry.mount('note', 'Note');
    const before = registry.inspect();
    const factory = vi.fn(() => async () => ({ phase: 'entered-returned' as const, result: { success: true } }));
    const register = (inputSchema: JsonValue, description = 'Read') => registry.registerTypeTool({ viewType: 'Note', name: 'read', description, inputSchema }, {
      safeOrdinaryParametersInvocationMode: 'ordinary-invoker/v3', createSafeOrdinaryParametersInvoker: factory,
    });
    const expensive = { type: 'object', properties: { xs: { type: 'array', items: { type: 'number' }, default: Array(3_000).fill(0) } } };
    for (const schema of [boundarySchema(limit + 1), expensive]) {
      expect(() => register(schema)).toThrow(expect.objectContaining({ name: ViewToolContractError.name, code: 'TOOL_SCHEMA_CAPACITY' }));
    }
    expect(() => register({ type: 'object', properties: { value: { type: 'string', minLength: -1 } } }))
      .toThrow(expect.objectContaining({ code: 'PARAMETER_DECLARATION_INVALID' }));
    expect(() => register({ type: 'object', properties: { value: { type: 'string', format: 'email' } } }))
      .toThrow(expect.objectContaining({ code: 'PARAMETER_DECLARATION_UNSUPPORTED' }));
    expect(() => register(boundarySchema(limit), 'x'.repeat(128 * 1024 + 1)))
      .toThrow(expect.objectContaining({ name: 'SnapshotDataError', code: 'SNAPSHOT_SERIALIZATION_ERROR' }));
    expect(factory).not.toHaveBeenCalled();
    expect(registry.inspect()).toEqual(before);
    expect(registry.listTools()).toEqual([]);
    const release = register(boundarySchema(limit));
    expect(factory).toHaveBeenCalledOnce();
    expect(registry.listTools()).toMatchObject([{ execution: { activationId: 'ta:v1:["run",1]' } }]);
    release();
    expect(registry.inspect()).toEqual(before);
  });
});
