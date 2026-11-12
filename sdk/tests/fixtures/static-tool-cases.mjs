import assert from 'node:assert/strict';

export function staticCases(api, Type) {
  const make = (name = 'read', viewType = 'File') => api.defineViewTypeTool({
    viewType, name, description: 'Inspect a working object.', inputSchema: Type.Object({ path: Type.String() }),
  });
  const code = expected => error => error?.code === expected;
  const frozen = value => {
    if (value !== null && typeof value === 'object') {
      assert.equal(Object.isFrozen(value), true);
      for (const child of Object.values(value)) frozen(child);
    }
  };
  const jsonData = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { assert.equal(Number.isFinite(value), true); return; }
    assert.equal(typeof value, 'object');
    if (Array.isArray(value)) { for (const item of value) jsonData(item); return; }
    assert.ok(Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype);
    assert.deepEqual(Reflect.ownKeys(value), Object.keys(value));
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      assert.ok('value' in descriptor && descriptor.enumerable);
      jsonData(descriptor.value);
    }
  };
  return [
    ['captures detached, normalized and deeply frozen static metadata', () => {
      const schema = Type.Object({ zeta: Type.String(), alpha: Type.Array(Type.String()) });
      const input = { viewType: 'File', name: 'read', description: 'Original.', inputSchema: schema };
      const definition = api.defineViewTypeTool(input);
      assert.deepEqual(Object.keys(definition).sort(), ['description', 'inputSchema', 'name', 'viewType']);
      assert.ok(Object.getOwnPropertySymbols(definition).every(key => !Object.getOwnPropertyDescriptor(definition, key).enumerable));
      assert.equal(definition.inputSchema.additionalProperties, true);
      assert.deepEqual(definition.inputSchema.required, ['alpha', 'zeta']);
      frozen(definition);
      input.description = 'Changed.';
      schema.properties.zeta.description = 'Changed schema.';
      assert.equal(definition.description, 'Original.');
      assert.equal(definition.inputSchema.properties.zeta.description, undefined);
      assert.equal(Object.isFrozen(input), false);
      assert.equal(Object.isFrozen(schema), false);
      assert.equal(api.defineViewTypeTool({ ...input }).description, 'Changed.');
    }],
    ['rejects retired fields and invalid metadata before construction', () => {
      const valid = { viewType: 'File', name: 'read', description: 'Read.', inputSchema: Type.Object({}) };
      for (const extra of [{ execute() {} }, { execute: undefined }, { enabled: true }, { owner: {} }, { isMutating: true }]) {
        assert.throws(() => api.defineViewTypeTool({ ...valid, ...extra }), code('TOOL_DEFINITION_INVALID'));
      }
      for (const field of ['viewType', 'name', 'description']) {
        assert.throws(() => api.defineViewTypeTool({ ...valid, [field]: '' }), code('TOOL_DEFINITION_INVALID'));
      }
    }],
    ['does not execute declaration, Schema or ToolSet accessors', () => {
      let reads = 0;
      const input = { viewType: 'File', name: 'read', description: 'Read.', inputSchema: Type.Object({}) };
      Object.defineProperty(input, 'description', { enumerable: true, get() { reads++; return 'unexpected'; } });
      assert.throws(() => api.defineViewTypeTool(input), code('TOOL_DEFINITION_INVALID'));
      const schema = Type.Object({ path: Type.String() });
      Object.defineProperty(schema.properties.path, 'description', { enumerable: true, get() { reads++; return 'secret'; } });
      assert.throws(() => api.defineViewTypeTool({ viewType: 'File', name: 'read', description: 'Read.', inputSchema: schema }), code('TOOL_SCHEMA_INVALID'));
      const tools = {};
      Object.defineProperty(tools, 'read', { enumerable: true, get() { reads++; return make(); } });
      assert.throws(() => api.defineToolSet(tools), code('TOOL_SET_INVALID'));
      assert.equal(reads, 0);
    }],
    ['captures ToolSet input and permits ordinary string property keys', () => {
      const original = make();
      const input = Object.assign(Object.create(null), { constructor: original });
      Object.defineProperty(input, '__proto__', { value: make('write'), enumerable: true, configurable: true, writable: true });
      const tools = api.defineToolSet(input);
      input.constructor = make('replacement');
      delete input.__proto__;
      assert.equal(tools.constructor, original);
      assert.equal(tools.__proto__.name, 'write');
      assert.equal(Object.getPrototypeOf(tools), null);
      assert.equal(Object.isFrozen(tools), true);
      assert.equal(api.getToolCatalog(tools).length, 2);
    }],
    ['rejects forged and cloned definitions and ToolSets', () => {
      const definition = make();
      for (const value of [{ ...definition }, JSON.parse(JSON.stringify(definition)), Object.create(definition)]) {
        assert.throws(() => api.defineToolSet({ read: value }), code('TOOL_SET_INVALID'));
      }
      const tools = api.defineToolSet({ read: definition });
      for (const value of [{ ...tools }, JSON.parse(JSON.stringify(tools)), {}, null]) {
        assert.throws(() => api.getToolCatalog(value), code('TOOL_SET_INVALID'));
      }
    }],
    ['uses structured tuple identity and permits equal names across ViewTypes', () => {
      assert.throws(() => api.defineToolSet({ first: make(), second: make() }), code('TOOL_SET_DUPLICATE'));
      const tools = api.defineToolSet({ a: make('read', 'A'), b: make('read', 'B'), c: make('C', 'A-B'), d: make('B-C', 'A') });
      assert.equal(api.getToolCatalog(tools).length, 4);
    }],
    ['produces stable, sorted, frozen four-field JSON catalog data', () => {
      const tools = api.defineToolSet({ z: make('z', 'B'), a: make('z', 'A'), b: make('a', 'A') });
      const first = api.getToolCatalog(tools);
      const second = api.getToolCatalog(tools);
      assert.deepEqual(first.map(item => [item.viewType, item.name]), [['A', 'a'], ['A', 'z'], ['B', 'z']]);
      for (const item of first) assert.deepEqual(Object.keys(item).sort(), ['description', 'inputSchema', 'name', 'viewType']);
      assert.equal(JSON.stringify(first), JSON.stringify(second));
      jsonData(first);
      assert.deepEqual(JSON.parse(JSON.stringify(first))[0].inputSchema, {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: true,
      });
      frozen(first);
    }],
    ['accepts an empty static collection without an App or registration port', () => {
      const empty = api.defineToolSet({});
      assert.deepEqual(api.getToolCatalog(empty), []);
      assert.equal(Object.isFrozen(empty), true);
      assert.throws(() => api.defineToolSet({ '': make() }), code('TOOL_SET_INVALID'));
    }],
    ['preserves unsupported Schema rejection and business parameters named pattern', () => {
      assert.throws(() => api.defineViewTypeTool({ viewType: 'File', name: 'read', description: 'Read.', inputSchema: Type.Object({ path: Type.String({ format: 'email' }) }) }), code('TOOL_SCHEMA_UNSUPPORTED'));
      const definition = api.defineViewTypeTool({ viewType: 'Search', name: 'search', description: 'Search.', inputSchema: Type.Object({ pattern: Type.String() }) });
      assert.equal(definition.inputSchema.properties.pattern.type, 'string');
      assert.deepEqual(Object.keys(definition.inputSchema.properties.pattern), ['type']);
    }],
  ];
}
