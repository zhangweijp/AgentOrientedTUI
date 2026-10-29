import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED';
export type ParameterDiagnostic = Readonly<{ parameter?: string; message: string }>;
export type OrdinaryValidation =
  | Readonly<{ ok: true; value: JsonObject }>
  | Readonly<{ ok: false; code: 'PARAMETER_INPUT_INVALID'; diagnostics: readonly ParameterDiagnostic[] }>;
export interface OrdinaryParameterContract {
  readonly revision: 'ordinary-params-v1';
  readonly schema: JsonObject;
  readonly fingerprint: string;
  validate(input: unknown): OrdinaryValidation;
}
export type CompileResult =
  | Readonly<{ ok: true; contract: OrdinaryParameterContract }>
  | Readonly<{ ok: false; issue: Readonly<{ code: DeclarationCode; message: string }> }>;

const DECLARATION = { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 };
const INPUT = { maxDepth: 24, maxNodes: 10_000, maxApproxBytes: 128 * 1024 };
const BASIC = ['string', 'number', 'boolean', 'object'];
const object = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: JsonObject, key: string) => Object.hasOwn(value, key);

class DeclarationError extends Error {
  constructor(readonly code: DeclarationCode, message: string) { super(message); }
}
function invalid(): never {
  throw new DeclarationError('PARAMETER_DECLARATION_INVALID', 'Expected a valid bounded ordinary parameter declaration.');
}
function unsupported(): never {
  throw new DeclarationError('PARAMETER_DECLARATION_UNSUPPORTED', 'Declaration uses unsupported ordinary parameter vocabulary.');
}
function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) unsupported();
}
function kind(value: JsonValue | undefined, allowed: readonly string[]): string {
  if (typeof value !== 'string') invalid();
  if (!allowed.includes(value)) unsupported();
  return value;
}
function bounded(input: unknown, limits: typeof DECLARATION): JsonValue {
  const value = copyJson(input, limits);
  if (utf8Size(canonicalJson(value)) > limits.maxApproxBytes) invalid();
  return value;
}
function basicMatches(value: JsonValue, type: JsonValue | undefined): boolean {
  return type === 'object' ? object(value) : typeof value === type;
}
function fieldIssue(field: JsonObject, value: JsonValue, pattern?: RegExp): string | undefined {
  if (field.type === 'array') {
    if (!Array.isArray(value)) return 'Expected an array.';
    if (value.some(item => !basicMatches(item, (field.items as JsonObject).type)))
      return 'Array item type does not match.';
    if ((has(field, 'minItems') && value.length < (field.minItems as number)) ||
        (has(field, 'maxItems') && value.length > (field.maxItems as number)))
      return 'Array length is outside the declared bounds.';
  } else {
    if (!basicMatches(value, field.type)) return 'Parameter type does not match.';
    if (typeof value === 'string') {
      if (has(field, 'enum') && !(field.enum as readonly JsonValue[]).includes(value))
        return 'Value is not a declared string option.';
      let length = 0;
      for (const _ of value) length++;
      if ((has(field, 'minLength') && length < (field.minLength as number)) ||
          (has(field, 'maxLength') && length > (field.maxLength as number)))
        return 'String length is outside the declared bounds.';
      if (pattern && !pattern.test(value)) return 'String does not match the declared pattern.';
    } else if (typeof value === 'number' &&
        ((has(field, 'minimum') && value < (field.minimum as number)) ||
         (has(field, 'maximum') && value > (field.maximum as number))))
      return 'Number is outside the declared bounds.';
  }
  return undefined;
}

function normalizeField(field: JsonValue): { schema: JsonObject; pattern?: RegExp } {
  if (!object(field)) invalid();
  keys(field, ['type', 'description', 'default', 'enum', 'minLength', 'maxLength', 'pattern',
    'minimum', 'maximum', 'items', 'minItems', 'maxItems']);
  const type = kind(field.type, [...BASIC, 'array']);
  const constraints = type === 'string' ? ['enum', 'minLength', 'maxLength', 'pattern']
    : type === 'number' ? ['minimum', 'maximum']
    : type === 'array' ? ['items', 'minItems', 'maxItems'] : [];
  keys(field, ['type', 'description', 'default', ...constraints]);
  if (has(field, 'description') && typeof field.description !== 'string') invalid();
  if (has(field, 'enum') && (!Array.isArray(field.enum) || field.enum.length === 0 ||
      field.enum.some(option => typeof option !== 'string') || new Set(field.enum).size !== field.enum.length)) invalid();
  if (type === 'array') {
    if (!object(field.items)) invalid();
    keys(field.items, ['type']);
    kind(field.items.type, BASIC);
  }
  const [min, max] = type === 'number' ? ['minimum', 'maximum']
    : type === 'array' ? ['minItems', 'maxItems'] : ['minLength', 'maxLength'];
  for (const name of [min, max]) {
    if (has(field, name) && (typeof field[name] !== 'number' ||
        (type !== 'number' && (!Number.isInteger(field[name]) || (field[name] as number) < 0)))) invalid();
  }
  if (has(field, min) && has(field, max) && (field[min] as number) > (field[max] as number)) invalid();
  let pattern: RegExp | undefined;
  if (has(field, 'pattern')) {
    if (typeof field.pattern !== 'string') invalid();
    try { pattern = new RegExp(field.pattern); } catch { invalid(); }
  }
  if (has(field, 'default') && fieldIssue(field, field.default!, pattern)) invalid();
  return { schema: field, pattern };
}

function finish(root: JsonObject): CompileResult {
  keys(root, ['type', 'properties', 'required', 'additionalProperties', 'description']);
  if (kind(root.type, ['object']) !== 'object' || !object(root.properties)) invalid();
  if (has(root, 'description') && typeof root.description !== 'string') invalid();
  if (has(root, 'additionalProperties') && typeof root.additionalProperties !== 'boolean') {
    if (object(root.additionalProperties)) unsupported();
    invalid();
  }
  const required = has(root, 'required') ? root.required : [];
  if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || !has(root.properties as JsonObject, name)) ||
      new Set(required).size !== required.length) invalid();
  const properties: Record<string, JsonValue> = Object.create(null);
  const patterns = new Map<string, RegExp>();
  for (const name of Object.keys(root.properties).sort()) {
    const field = normalizeField(root.properties[name]!);
    properties[name] = field.schema;
    if (field.pattern) patterns.set(name, field.pattern);
  }
  const schema = bounded({
    type: 'object', properties, required: [...required].sort(),
    additionalProperties: root.additionalProperties ?? true,
    ...(has(root, 'description') ? { description: root.description! } : {}),
  }, DECLARATION) as JsonObject;
  const fields = Object.entries(schema.properties as JsonObject);
  const requiredNames = new Set(schema.required as readonly string[]);
  const validate = (input: unknown): OrdinaryValidation => {
    const diagnostics: ParameterDiagnostic[] = [];
    const add = (message: string, parameter?: string) => {
      if (diagnostics.length < 16) diagnostics.push(Object.freeze({
        ...(parameter === undefined ? {} : { parameter: parameter.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, '?') }), message,
      }));
    };
    let value: JsonValue;
    try { value = bounded(input, INPUT); } catch { add('Expected bounded plain JSON parameters.'); }
    if (diagnostics.length === 0) {
      if (!object(value!)) add('Expected a parameter object.');
      else {
        for (const [name, field] of fields) {
          if (diagnostics.length >= 16) break;
          if (!has(value, name)) {
            if (requiredNames.has(name)) add('Required parameter is missing.', name);
          } else {
            const issue = fieldIssue(field as JsonObject, value[name]!, patterns.get(name));
            if (issue) add(issue, name);
          }
        }
        if (schema.additionalProperties === false && Object.keys(value).some(name => !has(schema.properties as JsonObject, name)))
          add('Additional parameters are not allowed.');
      }
    }
    return diagnostics.length ? Object.freeze({ ok: false, code: 'PARAMETER_INPUT_INVALID', diagnostics: Object.freeze(diagnostics) })
      : Object.freeze({ ok: true, value: value! as JsonObject });
  };
  const revision = 'ordinary-params-v1';
  return Object.freeze({ ok: true, contract: Object.freeze({
    revision, schema, fingerprint: canonicalJson({ revision, schema }), validate,
  }) });
}

function compile(input: unknown, convert: (captured: JsonValue) => JsonObject): CompileResult {
  try { return finish(convert(copyJson(input, DECLARATION))); }
  catch (error) {
    return Object.freeze({ ok: false, issue: Object.freeze({
      code: error instanceof DeclarationError ? error.code : 'PARAMETER_DECLARATION_INVALID',
      message: error instanceof DeclarationError ? error.message : 'Expected a valid bounded ordinary parameter declaration.',
    }) });
  }
}

/** Internal semantics only; this module neither grants execution eligibility nor changes a transport. */
export function compileOrdinarySchema(schema: unknown): CompileResult {
  return compile(schema, captured => { if (!object(captured)) invalid(); return captured; });
}

export function compileOrdinaryParams(params: unknown, options?: { additionalProperties?: boolean }): CompileResult {
  return compile(params, captured => {
    if (!object(captured)) invalid();
    const settings = copyJson(options === undefined ? {} : options, DECLARATION);
    if (!object(settings)) invalid();
    keys(settings, ['additionalProperties']);
    if (has(settings, 'additionalProperties') && typeof settings.additionalProperties !== 'boolean') invalid();
    const properties: Record<string, JsonValue> = Object.create(null);
    const required: string[] = [];
    for (const [name, field] of Object.entries(captured)) {
      if (!object(field)) invalid();
      keys(field, ['type', 'required', 'desc', 'default', 'constraints', 'options', 'itemType']);
      const type = kind(field.type, [...BASIC, 'enum', 'array']);
      keys(field, ['type', 'required', 'desc', 'default', 'constraints',
        ...(type === 'enum' ? ['options'] : []), ...(type === 'array' ? ['itemType'] : [])]);
      if (has(field, 'required') && typeof field.required !== 'boolean') invalid();
      if (field.required === true) required.push(name);
      const schema: Record<string, JsonValue> = { type: type === 'enum' ? 'string' : type };
      if (has(field, 'desc')) schema.description = field.desc!;
      if (has(field, 'default')) schema.default = field.default!;
      if (type === 'enum') {
        if (!has(field, 'options')) invalid();
        schema.enum = field.options!;
      }
      if (type === 'array') schema.items = { type: kind(field.itemType, BASIC) };
      if (has(field, 'constraints')) {
        if (!object(field.constraints)) invalid();
        const mapping: Record<string, string> = type === 'number' ? { min: 'minimum', max: 'maximum' }
          : type === 'array' ? { minLength: 'minItems', maxLength: 'maxItems' }
          : type === 'string' || type === 'enum' ? { minLength: 'minLength', maxLength: 'maxLength', pattern: 'pattern' } : {};
        keys(field.constraints, Object.keys(mapping));
        for (const [key, value] of Object.entries(field.constraints)) schema[mapping[key]!] = value;
      }
      properties[name] = schema;
    }
    return { type: 'object', properties, required, additionalProperties: settings.additionalProperties ?? true };
  });
}
