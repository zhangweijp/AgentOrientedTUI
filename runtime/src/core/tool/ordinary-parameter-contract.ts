export const ORDINARY_PARAMETER_REVISION = 'ordinary-params-v1' as const;
export const VIEW_TYPE_PARAMETERS_MODE = 'view-type-parameters-v1' as const;
import { canonicalJson, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED';
export type ParameterDiagnostic = Readonly<{ parameter?: string; message: string }>;
export type OrdinaryValidation =
  | Readonly<{ ok: true; value: JsonObject }>
  | Readonly<{ ok: false; code: 'PARAMETER_INPUT_INVALID'; diagnostics: readonly ParameterDiagnostic[] }>;
export interface OrdinaryParameterContract {
  readonly revision: typeof ORDINARY_PARAMETER_REVISION | 'ref-value-specimen' | typeof VIEW_TYPE_PARAMETERS_MODE;
  readonly schema: JsonObject;
  readonly fingerprint: string;
  validate(input: unknown): OrdinaryValidation;
  readonly validateModelInput?: (input: unknown) => OrdinaryValidation;
  readonly validateResolvedInput?: (input: unknown) => OrdinaryValidation;
}
export type CompileResult =
  | Readonly<{ ok: true; contract: OrdinaryParameterContract }>
  | Readonly<{ ok: false; issue: Readonly<{ code: DeclarationCode; message: string; path: string }> }>;

const DECLARATION = { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 };
const INPUT = { maxDepth: 24, maxNodes: 10_000, maxApproxBytes: 128 * 1024 };
const REF_VALUE = 'x-aotui-ref-value';
const REF_KIND = 'x-aotui-ref-kind';
const BASIC = ['string', 'number', 'boolean', 'object'];
const object = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: JsonObject, key: string) => Object.hasOwn(value, key);

class DeclarationError extends Error {
  constructor(readonly code: DeclarationCode, message: string, readonly path?: string) { super(message); }
}
function diagnosticPath(path: string): string {
  return path.length <= 512 ? path : path.slice(0, 256) + '…' + path.slice(-255);
}
function childPath(path: string, key: string): string {
  const segment = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']';
  return diagnosticPath(path + segment);
}
function invalid(path?: string): never {
  throw new DeclarationError('PARAMETER_DECLARATION_INVALID', 'Expected a valid bounded ordinary parameter declaration.', path);
}
function unsupported(path?: string): never {
  throw new DeclarationError('PARAMETER_DECLARATION_UNSUPPORTED', 'Declaration uses unsupported ordinary parameter vocabulary.', path);
}
function keys(value: JsonObject, allowed: readonly string[], path = '$'): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(childPath(path, key));
}
function kind(value: JsonValue | undefined, allowed: readonly string[], path = '$'): string {
  if (typeof value !== 'string') invalid(path);
  if (!allowed.includes(value)) unsupported(path);
  return value;
}
function bounded(input: unknown, limits: typeof DECLARATION): JsonValue {
  const value = copyJson(input, limits);
  if (utf8Size(canonicalJson(value)) > limits.maxApproxBytes) invalid();
  return value;
}
function basicMatches(value: JsonValue, type: JsonValue | undefined): boolean {
  return type === 'array' ? Array.isArray(value) : type === 'object' ? object(value) : typeof value === type;
}
function fieldIssue(field: JsonObject, value: JsonValue, structured = false, resolved = false): string | undefined {
  if (resolved && has(field, REF_VALUE)) return fieldIssue(field[REF_VALUE] as JsonObject, value, true);
  if (field.type === 'array') {
    if (!Array.isArray(value)) return 'Expected an array.';
    const items = field.items as JsonObject;
    const effectiveItems = resolved && has(items, REF_VALUE) ? items[REF_VALUE] as JsonObject : items;
    if (value.some(item => !basicMatches(item, effectiveItems.type)))
      return 'Array item type does not match.';
    if (structured || has(items, REF_VALUE)) for (const item of value) {
      const issue = fieldIssue(items, item, structured, resolved);
      if (issue) return 'Array item: ' + issue;
    }
    if ((has(field, 'minItems') && value.length < (field.minItems as number)) ||
        (has(field, 'maxItems') && value.length > (field.maxItems as number)))
      return 'Array length is outside the declared bounds.';
  } else {
    if (!basicMatches(value, field.type)) return 'Parameter type does not match.';
    if (structured && object(value) && object(field.properties)) {
      const properties = field.properties;
      for (const name of field.required as readonly string[]) if (!has(value, name))
        return 'Required object property is missing: ' + name.slice(0, 64);
      for (const [name, property] of Object.entries(properties)) if (has(value, name)) {
        const issue = fieldIssue(property as JsonObject, value[name]!, true);
        if (issue) return 'Property ' + name.slice(0, 64) + ': ' + issue;
      }
      if (field.additionalProperties === false && Object.keys(value).some(name => !has(properties, name)))
        return 'Additional object properties are not allowed.';
    }
    if (typeof value === 'string') {
      if (has(field, 'enum') && !(field.enum as readonly JsonValue[]).includes(value))
        return 'Value is not a declared string option.';
      if (has(field, 'minLength') || has(field, 'maxLength')) {
        let length = 0;
        for (const _ of value) length++;
        if ((has(field, 'minLength') && length < (field.minLength as number)) ||
            (has(field, 'maxLength') && length > (field.maxLength as number)))
          return 'String length is outside the declared bounds.';
      }
    } else if (typeof value === 'number' &&
        ((has(field, 'minimum') && value < (field.minimum as number)) ||
         (has(field, 'maximum') && value > (field.maximum as number))))
      return 'Number is outside the declared bounds.';
  }
  return undefined;
}

function normalizeField(field: JsonValue, path: string, structured = false, allowRef = false): JsonObject {
  if (!object(field)) invalid(path);
  if (allowRef && has(field, REF_VALUE)) {
    if (field.type !== 'string') unsupported(childPath(path, REF_VALUE));
    if (typeof field[REF_KIND] !== 'string' || field[REF_KIND].trim().length === 0) invalid(childPath(path, REF_KIND));
    const wire = { ...field }; delete wire[REF_VALUE]; delete wire[REF_KIND];
    const normalized = normalizeField(wire, path);
    if (typeof normalized.minLength !== 'number' || normalized.minLength < 1) invalid(childPath(path, 'minLength'));
    const payload = field[REF_VALUE];
    if (!object(payload) || !['object', 'array'].includes(String(payload.type))) unsupported(childPath(path, REF_VALUE));
    return { ...normalized, [REF_KIND]: field[REF_KIND], [REF_VALUE]: normalizeField(payload, childPath(path, REF_VALUE), true) };
  }
  if (structured && field.type === 'object' && has(field, 'properties')) return normalizeObject(field, path, true);
  keys(field, ['type', 'description', 'default', 'enum', 'minLength', 'maxLength',
    'minimum', 'maximum', 'items', 'minItems', 'maxItems'], path);
  const type = kind(field.type, [...BASIC, 'array'], childPath(path, 'type'));
  const constraints = type === 'string' ? ['enum', 'minLength', 'maxLength']
    : type === 'number' ? ['minimum', 'maximum']
    : type === 'array' ? ['items', 'minItems', 'maxItems'] : [];
  keys(field, ['type', 'description', 'default', ...constraints], path);
  if (has(field, 'description') && typeof field.description !== 'string') invalid(childPath(path, 'description'));
  if (has(field, 'enum') && (!Array.isArray(field.enum) || field.enum.length === 0 ||
      field.enum.some(option => typeof option !== 'string') || new Set(field.enum).size !== field.enum.length)) invalid(childPath(path, 'enum'));
  if (type === 'array') {
    if (!object(field.items)) invalid(childPath(path, 'items'));
    if (structured || allowRef && has(field.items, REF_VALUE)) {
      const items = normalizeField(field.items, childPath(path, 'items'), structured, allowRef);
      field = { ...field, items };
    } else {
      keys(field.items, ['type'], childPath(path, 'items'));
      kind(field.items.type, BASIC, childPath(childPath(path, 'items'), 'type'));
    }
  }
  const [min, max] = type === 'number' ? ['minimum', 'maximum']
    : type === 'array' ? ['minItems', 'maxItems'] : ['minLength', 'maxLength'];
  for (const name of [min, max]) {
    if (has(field, name) && (typeof field[name] !== 'number' ||
        (type !== 'number' && (!Number.isInteger(field[name]) || (field[name] as number) < 0)))) invalid(childPath(path, name));
  }
  if (has(field, min) && has(field, max) && (field[min] as number) > (field[max] as number)) invalid(childPath(path, max));
  if (has(field, 'default') && fieldIssue(field, field.default!, structured)) invalid(childPath(path, 'default'));
  return field;
}

function normalizeObject(root: JsonObject, path: string, structured = false, allowRef = false): JsonObject {
  keys(root, ['type', 'properties', 'required', 'additionalProperties', 'description'], path);
  if (kind(root.type, ['object'], childPath(path, 'type')) !== 'object' || !object(root.properties)) invalid(childPath(path, 'properties'));
  if (has(root, 'description') && typeof root.description !== 'string') invalid(childPath(path, 'description'));
  if (has(root, 'additionalProperties') && typeof root.additionalProperties !== 'boolean') {
    if (object(root.additionalProperties)) unsupported(childPath(path, 'additionalProperties'));
    invalid(childPath(path, 'additionalProperties'));
  }
  const required = has(root, 'required') ? root.required : [];
  if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || !has(root.properties as JsonObject, name)) ||
      new Set(required).size !== required.length) invalid(childPath(path, 'required'));
  const properties: Record<string, JsonValue> = Object.create(null);
  for (const name of Object.keys(root.properties).sort()) {
    properties[name] = normalizeField(root.properties[name]!, childPath(childPath(path, 'properties'), name), structured, allowRef);
  }
  return {
    type: 'object', properties, required: [...required].sort(),
    additionalProperties: root.additionalProperties ?? true,
    ...(has(root, 'description') ? { description: root.description! } : {}),
  };
}

function finish(root: JsonObject, allowRef = false, qualified = false): CompileResult {
  const schema = bounded(normalizeObject(root, '$', false, allowRef), DECLARATION) as JsonObject;
  const fields = Object.entries(schema.properties as JsonObject);
  const requiredNames = new Set(schema.required as readonly string[]);
  const hasRefs = fields.some(([, field]) => {
    const specification = field as JsonObject;
    return has(specification, REF_VALUE) || object(specification.items) && has(specification.items, REF_VALUE);
  });
  if (qualified) {
    const refs = fields.flatMap(([, field]) => object(field) && has(field, REF_VALUE) ? [field]
      : object(field) && object(field.items) && has(field.items, REF_VALUE) ? [field.items] : []);
    if (refs.some(field => {
      const payload = field[REF_VALUE];
      return !object(payload) ||
        !(payload.type === 'object' || payload.type === 'array' && object(payload.items) && payload.items.type === 'object');
    })) unsupported('$.properties');
  }
  const check = (input: unknown, resolved: boolean): OrdinaryValidation => {
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
            const specification = field as JsonObject;
            const issue = fieldIssue(specification, value[name]!, false, resolved);
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
  const validate = hasRefs ? (_input: unknown): OrdinaryValidation => Object.freeze({ ok: false, code: 'PARAMETER_INPUT_INVALID',
    diagnostics: Object.freeze([Object.freeze({ message: 'Ref parameters require qualified resolution; this is not an ordinary execution contract.' })]) })
    : (input: unknown) => check(input, false);
  const revision = qualified ? VIEW_TYPE_PARAMETERS_MODE : hasRefs ? 'ref-value-specimen' : ORDINARY_PARAMETER_REVISION;
  return Object.freeze({ ok: true, contract: Object.freeze({
    revision, schema, fingerprint: canonicalJson({ revision, schema }), validate,
    ...(hasRefs ? { validateModelInput: (input: unknown) => check(input, false), validateResolvedInput: (input: unknown) => check(input, true) } : {}),
  }) });
}

function compile(input: unknown, convert: (captured: JsonValue) => JsonObject, allowRef = false, qualified = false): CompileResult {
  try { return finish(convert(copyJson(input, DECLARATION)), allowRef, qualified); }
  catch (error) {
    const declaration = error instanceof DeclarationError ? error : undefined;
    const path = declaration?.path ?? (error instanceof SnapshotDataError ? error.path : '$');
    return Object.freeze({ ok: false, issue: Object.freeze({
      code: declaration?.code ?? 'PARAMETER_DECLARATION_INVALID',
      message: declaration?.message ?? 'Expected a valid bounded ordinary parameter declaration.',
      path: diagnosticPath(path),
    }) });
  }
}

/** Internal semantics only; this module neither grants execution eligibility nor changes a transport. */
export function compileOrdinarySchema(schema: unknown, profile?: 'ref-value-specimen' | typeof VIEW_TYPE_PARAMETERS_MODE): CompileResult {
  return compile(schema, captured => { if (!object(captured)) invalid(); return captured; }, profile === 'ref-value-specimen' || profile === VIEW_TYPE_PARAMETERS_MODE, profile === VIEW_TYPE_PARAMETERS_MODE);
}

export function compileOrdinaryParams(params: unknown, options?: { additionalProperties?: boolean }): CompileResult {
  return compile(params, captured => {
    if (!object(captured)) invalid();
    const settings = copyJson(options === undefined ? {} : options, DECLARATION);
    if (!object(settings)) invalid();
    keys(settings, ['additionalProperties'], '$options');
    if (has(settings, 'additionalProperties') && typeof settings.additionalProperties !== 'boolean') invalid();
    const properties: Record<string, JsonValue> = Object.create(null);
    const required: string[] = [];
    for (const [name, field] of Object.entries(captured)) {
      if (!object(field)) invalid();
      keys(field, ['type', 'required', 'desc', 'default', 'constraints', 'options', 'itemType'], childPath('$params', name));
      const type = kind(field.type, [...BASIC, 'enum', 'array'], childPath(childPath('$params', name), 'type'));
      keys(field, ['type', 'required', 'desc', 'default', 'constraints',
        ...(type === 'enum' ? ['options'] : []), ...(type === 'array' ? ['itemType'] : [])], childPath('$params', name));
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
          : type === 'string' || type === 'enum' ? { minLength: 'minLength', maxLength: 'maxLength' } : {};
        keys(field.constraints, Object.keys(mapping), childPath(childPath('$params', name), 'constraints'));
        for (const [key, value] of Object.entries(field.constraints)) schema[mapping[key]!] = value;
      }
      properties[name] = schema;
    }
    return { type: 'object', properties, required, additionalProperties: settings.additionalProperties ?? true };
  });
}
