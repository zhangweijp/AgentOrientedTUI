import { describe, it, expect } from 'vitest';
import {
  createIfAbsentSchema,
  isCreateIfAbsentSchema,
  matchesCreateIfAbsentInput,
} from './create-if-absent-contract.js';
const params = {
  relativePath: { type: 'string', required: true, desc: 'Path' },
  content: { type: 'string', required: true },
};
const schema = {
  type: 'object',
  properties: {
    relativePath: { type: 'string', description: 'Path' },
    content: { type: 'string' },
  },
  required: ['relativePath', 'content'],
  additionalProperties: false,
};
describe('W06 closed required string contract', () => {
  it('preserves exact declarations without alias/default/coercion', () => {
    expect(createIfAbsentSchema(params)).toEqual(schema);
    expect(isCreateIfAbsentSchema(schema)).toBe(true);
    expect(matchesCreateIfAbsentInput(schema, { relativePath: 'file', content: '' })).toBe(true);
    expect(
      matchesCreateIfAbsentInput(
        schema,
        Object.assign(Object.create(null), { relativePath: 'file', content: '文本😀' })
      )
    ).toBe(true);
  });
  it.each([
    'empty',
    'optional',
    'number',
    'default',
    'constraints',
    'enum',
    'ref',
    'extra',
    'getter',
    'symbol',
    'prototype',
    'undefined',
  ])('rejects params %s', (kind) => {
    const p: any = { value: { type: 'string', required: true } };
    if (kind === 'empty') delete p.value;
    if (kind === 'optional') p.value.required = false;
    if (kind === 'number') p.value.type = 'number';
    if (kind === 'default') p.value.default = 'x';
    if (kind === 'constraints') p.value.constraints = {};
    if (kind === 'enum') p.value.options = ['x'];
    if (kind === 'ref') p.value.refSource = 'snapshot-value-v1';
    if (kind === 'extra') p.value.description = 'alias';
    if (kind === 'getter')
      Object.defineProperty(p.value, 'desc', {
        enumerable: true,
        get() {
          throw Error('private');
        },
      });
    if (kind === 'symbol') p[Symbol()] = 1;
    if (kind === 'prototype') Object.setPrototypeOf(p, { inherited: true });
    if (kind === 'undefined') p.value.desc = undefined;
    expect(() => createIfAbsentSchema(p)).toThrow();
  });
  it.each([
    'open',
    'extra',
    'optional',
    'duplicate',
    'nested',
    'default',
    'constraints',
    'description',
    'getter',
    'symbol',
  ])('rejects schema %s', (kind) => {
    const s: any = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
      additionalProperties: false,
    };
    if (kind === 'open') s.additionalProperties = true;
    if (kind === 'extra') s.unknown = true;
    if (kind === 'optional') s.required = [];
    if (kind === 'duplicate') s.required = ['x', 'x'];
    if (kind === 'nested') s.properties.x = { type: 'object' };
    if (kind === 'default') s.properties.x.default = 'x';
    if (kind === 'constraints') s.properties.x.minLength = 0;
    if (kind === 'description') s.properties.x.description = 1;
    if (kind === 'getter')
      Object.defineProperty(s.properties.x, 'description', {
        enumerable: true,
        get() {
          throw Error('private');
        },
      });
    if (kind === 'symbol') s[Symbol()] = 1;
    expect(isCreateIfAbsentSchema(s)).toBe(false);
  });
  it.each([
    'null',
    'array',
    'extra',
    'missing',
    'number',
    'getter',
    'symbol',
    'hidden',
    'prototype',
    'undefined',
    'over-budget',
  ])('rejects args %s', (kind) => {
    let value: any = { relativePath: 'file', content: 'x' };
    if (kind === 'null') value = null;
    if (kind === 'array') value = [];
    if (kind === 'extra') value.root = '/elsewhere';
    if (kind === 'missing') delete value.content;
    if (kind === 'number') value.content = 1;
    if (kind === 'getter')
      Object.defineProperty(value, 'content', {
        enumerable: true,
        get() {
          throw Error('private');
        },
      });
    if (kind === 'symbol') value[Symbol()] = 1;
    if (kind === 'hidden') Object.defineProperty(value, 'hidden', { value: 1 });
    if (kind === 'prototype') Object.setPrototypeOf(value, { inherited: true });
    if (kind === 'undefined') value.content = undefined;
    if (kind === 'over-budget') value.content = 'x'.repeat(128 * 1024);
    expect(matchesCreateIfAbsentInput(schema, value)).toBe(false);
  });
  it('respects canonical and approximate input boundaries', () => {
    const overhead = Math.max(
      34,
      Buffer.byteLength(JSON.stringify({ relativePath: 'f', content: '' }))
    );
    expect(
      matchesCreateIfAbsentInput(schema, {
        relativePath: 'f',
        content: 'x'.repeat(128 * 1024 - overhead),
      })
    ).toBe(true);
    expect(
      matchesCreateIfAbsentInput(schema, {
        relativePath: 'f',
        content: 'x'.repeat(128 * 1024 - overhead + 1),
      })
    ).toBe(false);
    expect(
      matchesCreateIfAbsentInput(schema, { relativePath: 'f', content: '\u0000'.repeat(23000) })
    ).toBe(false);
  });
});
