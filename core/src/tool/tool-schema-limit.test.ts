import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import { DEFAULT_SNAPSHOT_LIMITS } from '../snapshot/snapshot-support.js';
import { createSnapshotCore } from '../snapshot/store.js';
import { SNAPSHOT_SCHEMA_VERSION, type JsonValue } from '../snapshot/types.js';
import { compileToolParameters } from './tool-parameters.js';
import { createViewOwnedTools } from './view-owned-tools.js';

const limit = DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes;
function boundarySchema(bytes: number) {
  const base = { type: 'object', properties: {}, required: [], additionalProperties: true, description: '' };
  const unit = '界😀\n"\\';
  const unitBytes = utf8Size(JSON.stringify(unit)) - 2;
  const fill = bytes - utf8Size(canonicalJson(base));
  return { ...base, description: unit.repeat(Math.floor(fill / unitBytes)) + 'x'.repeat(fill % unitBytes) };
}
const identity = { appId: 'app', instanceId: 'run' };
const toolId = JSON.stringify(['app', 'Note', 'read']);
const draft = (inputSchema: JsonValue, seq: number) => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...identity, producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
  views: [{ toolBindings: [{ toolId, activationId: 'active' }], id: 'note', viewInstanceId: 'mount', type: 'Note', name: 'Note', region: 'dynamic',
    content: { format: 'markdown-v1', value: String(seq) } }], refs: {},
  tools: { [toolId]: { multiplicity: 'multiple', id: toolId, name: 'read', viewType: 'Note',  description: 'Read', inputSchema } },
});

function compile(schema: unknown) {
  const result = compileToolParameters(schema);
  if (!result.ok) throw new Error(result.issue.message);
  return result.contract;
}

describe('Tool parameter Schema', () => {
  it('captures canonical Schema directly and accepts equivalent key insertion order', () => {
    const schema = compile({ type: 'object', properties: { z: { type: 'string' }, a: { type: 'number', default: 1 } }, required: ['z', 'a'] }).schema;
    const core = createSnapshotCore(identity);
    const reordered = Object.fromEntries(Object.entries(schema).reverse());
    const committed = core.committer.accept(draft(reordered, 1));
    expect(committed).toMatchObject({ status: 'published', snapshot: { tools: { [toolId]: { inputSchema: schema } } } });
    if (committed.status === 'published') expect(Object.isFrozen(committed.snapshot.tools[toolId]!.inputSchema)).toBe(true);
    core.lifecycle.dispose();
  });

  it.each(['extra', 'required-order', 'omitted-required', 'omitted-extra', 'tuple', 'format', 'pattern', 'obsolete-marker', 'getter'])(
      'rejects transported Schema with %s without normalizing input', kind => {
    const schema = JSON.parse(JSON.stringify(compile({
      type: 'object', properties: { z: { type: 'string' }, a: { type: 'number', default: 1 } }, required: ['z', 'a'],
    }).schema));
    let reads = 0;
    if (kind === 'extra') schema['x-aotui-other'] = true;
    if (kind === 'required-order') schema.required.reverse();
    if (kind === 'omitted-required') delete schema.required;
    if (kind === 'omitted-extra') delete schema.additionalProperties;
    if (kind === 'tuple') schema.properties.a = { type: 'array', items: [{ type: 'string' }] };
    if (kind === 'format') schema.properties.a = { type: 'string', format: 'date-time' };
    if (kind === 'pattern') schema.properties.z.pattern = '^file$';
    if (kind === 'obsolete-marker') schema['x-aotui-parameter-contract'] = 'view-type-parameters-v1';
    if (kind === 'getter') Object.defineProperty(schema, 'description', { enumerable: true, get() { reads++; return 'secret'; } });
    const core = createSnapshotCore(identity);
    expect(core.committer.accept(draft(schema, 1)).status).toBe('rejected');
    expect(reads).toBe(0);
    core.lifecycle.dispose();
  });

  it('enforces canonical UTF-8 bytes at the inclusive declaration and Snapshot boundary', () => {
    const atLimit = compile(boundarySchema(limit)).schema;
    const oversized = boundarySchema(limit + 1);
    expect(utf8Size(canonicalJson(atLimit))).toBe(limit);
    expect(canonicalJson(atLimit).length).toBeLessThan(limit);
    expect(utf8Size(canonicalJson(oversized))).toBe(limit + 1);
    expect(compileToolParameters(oversized)).toMatchObject({ ok: false, issue: { code: 'PARAMETER_DECLARATION_CAPACITY' } });

    const core = createSnapshotCore(identity);
    const restricted = createSnapshotCore({ ...identity, limits: { maxToolSchemaBytes: limit - 1 } });
    try {
      const first = core.committer.accept(draft(atLimit, 1));
      if (first.status !== 'published') throw new Error('Expected publication');
      const rejection = { status: 'rejected', issue: { path: expect.stringContaining('.inputSchema') } };
      expect(core.committer.accept(draft(oversized, 2))).toMatchObject(rejection);
      expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: first.snapshot });
      expect(core.committer.accept(draft(atLimit, 3))).toMatchObject({ status: 'published', snapshot: { revision: 2 } });
      expect(restricted.committer.accept(draft(atLimit, 1))).toMatchObject(rejection);
      expect(restricted.committer.accept(draft(compile(boundarySchema(limit - 1)).schema, 2))).toMatchObject({ status: 'published' });
    } finally {
      core.lifecycle.dispose();
      restricted.lifecycle.dispose();
    }
  });
});
