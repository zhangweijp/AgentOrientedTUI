import assert from 'node:assert/strict';

export function staticCases(api, Type) {
  const inputSchema = Type.Object({ path: Type.String() });
  const execute = () => ({ success: true });
  const declaration = () => ({ description: 'Inspect a working object.', inputSchema, execute });
  const defineWithContext = api.defineViewType();
  const define = declaration => defineWithContext({ multiplicity: 'multiple', ...declaration });
  const make = (name = 'File', names = ['read']) => define({
    name, tools: Object.fromEntries(names.map(tool => [tool, declaration()])),
  });
  const register = viewTypes => api.createApp({ app_name: 'files', viewTypes, initialize() {} });
  const code = expected => error => error?.code === expected;
  const frozen = value => {
    if (value !== null && typeof value === 'object') {
      assert.equal(Object.isFrozen(value), true);
      for (const child of Object.values(value)) frozen(child);
    }
  };
  return [
    ['captures detached, normalized and deeply frozen static metadata', () => {
      const schema = Type.Object({ zeta: Type.String(), alpha: Type.Array(Type.String()) });
      const input = { description: 'Original.', inputSchema: schema, execute };
      const descriptor = define({ name: 'File', tools: { read: input } });
      const definition = descriptor.tools.read;
      assert.deepEqual(Object.keys(definition).sort(), ['description', 'inputSchema']);
      assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(define({
        name: 'Open',
        tools: { read: { description: 'Read.', inputSchema: Type.Object({ x: Type.String() }, { additionalProperties: true }), execute } },
      }).tools.read.inputSchema.additionalProperties, true);
      assert.deepEqual(definition.inputSchema.required, ['alpha', 'zeta']);
      frozen(descriptor);
      input.description = 'Changed.';
      schema.properties.zeta.description = 'Changed schema.';
      assert.equal(definition.description, 'Original.');
      assert.equal(definition.inputSchema.properties.zeta.description, undefined);
      assert.equal(Object.isFrozen(input), false);
      assert.equal(Object.isFrozen(schema), false);
    }],
    ['rejects retired fields and invalid metadata before construction', () => {
      for (const extra of [{ execute: undefined }, { enabled: true }, { owner: {} }, { isMutating: true }]) {
        assert.throws(() => define({ name: 'File', tools: { read: { ...declaration(), ...extra } } }),
          code('TOOL_DEFINITION_INVALID'));
      }
      for (const invalid of [
        { name: '', tools: { read: declaration() } },
        { name: 'File', tools: { '': declaration() } },
        { name: 'File', tools: { read: { ...declaration(), description: ' ' } } },
      ]) assert.throws(() => define(invalid), code('TOOL_DEFINITION_INVALID'));
    }],
    ['does not execute Tool, schema or collection accessors', () => {
      let reads = 0;
      const getter = { enumerable: true, get() { reads++; return 'unexpected'; } };
      const input = Object.defineProperty(declaration(), 'description', getter);
      const schema = Type.Object({ path: Type.String() });
      Object.defineProperty(schema.properties.path, 'description', getter);
      const tools = Object.defineProperty({}, 'read', getter);
      assert.throws(() => define({ name: 'File', tools: { read: input } }), code('TOOL_DEFINITION_INVALID'));
      assert.throws(() => define({ name: 'File', tools: { read: { ...declaration(), inputSchema: schema } } }), code('TOOL_SCHEMA_INVALID'));
      assert.throws(() => define({ name: 'File', tools }), code('TOOL_DEFINITION_INVALID'));
      assert.equal(reads, 0);
    }],
    ['captures Tool metadata with ordinary string property keys', () => {
      const tools = Object.assign(Object.create(null), { constructor: declaration() });
      tools.__proto__ = { ...declaration(), description: 'Prototype-shaped name' };
      const descriptor = define({ name: 'File', tools });
      delete tools.__proto__;
      tools.constructor.description = 'Changed';
      assert.equal(descriptor.tools.constructor.description, 'Inspect a working object.');
      assert.equal(descriptor.tools.__proto__.description, 'Prototype-shaped name');
      assert.equal(Object.getPrototypeOf(descriptor.tools), null);
      assert.doesNotThrow(() => register([descriptor]));
    }],
    ['rejects cloned descriptors and duplicate type declarations', () => {
      const page = make();
      for (const value of [{ ...page }, JSON.parse(JSON.stringify(page)), Object.create(page), {}, null]) {
        assert.throws(() => register([value]), code('VIEW_TYPE_INVALID'));
      }
      assert.throws(() => register([page, make()]), code('VIEW_TYPE_DUPLICATE'));
      assert.doesNotThrow(() => register([make('A'), make('B'), make('A_B', ['c']), make('C', ['A-B'])]));
    }],
    ['supports empty types and the business parameter pattern, and rejects unsupported schema', () => {
      const empty = api.defineViewType({ multiplicity: 'multiple', name: 'Empty' });
      assert.doesNotThrow(() => register([empty]));
      const search = inputSchema => define({ name: 'Search', tools: { search: { ...declaration(), inputSchema } } });
      assert.throws(() => search(Type.Object({ path: Type.String({ format: 'email' }) })), code('TOOL_SCHEMA_UNSUPPORTED'));
      for (const path of [Type.String({ pattern: '^file$' }), Type.TemplateLiteral('file-${number}')]) {
        assert.throws(() => search(Type.Object({ path })), { code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.pattern' });
      }
      assert.equal(search(Type.Object({ pattern: Type.String() })).tools.search.inputSchema.properties.pattern.type, 'string');
    }],
  ];
}
