export const ORDINARY_PARAMETER_REVISION = 'ordinary-params-v1' as const;
export const VIEW_TYPE_PARAMETERS_MODE = 'view-type-parameters-v1' as const;
import { canonicalJson, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { RAW_TOOL_ARGUMENT_LIMITS as INPUT, RESOLVED_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED';
export type ParameterDiagnostic = Readonly<{ parameter?: string; path?: string; message: string }>;
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
type ValueIssue = Readonly<{ path: string; message: string }>;
type Check = (value: JsonValue, path: string, resolved: boolean) => ValueIssue | undefined;
type Position = 'root' | 'parameter' | 'ref-item' | 'nested';

const TYPE_RULES: Readonly<Record<string, readonly string[]>> = {
  string: ['minLength', 'maxLength', 'pattern'],
  number: ['minimum', 'maximum'],
  integer: ['minimum', 'maximum'],
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems'],
  boolean: [],
  null: [],
};
const MARKER = 'x-aotui-parameter-contract';

function issue(path: string, message: string): ValueIssue {
  return { path: diagnosticPath(path), message };
}

function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'object': return object(value);
    case 'null': return value === null;
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: return typeof value === type;
  }
}

function bounds(field: JsonObject, min: string, max: string, path: string, integral = false) {
  for (const key of [min, max]) {
    const value = field[key];
    if (has(field, key) && (typeof value !== 'number' || integral && (!Number.isInteger(value) || value < 0))) {
      invalid(childPath(path, key));
    }
  }
  const lower = field[min] as number | undefined;
  const upper = field[max] as number | undefined;
  if (lower !== undefined && upper !== undefined && lower > upper) invalid(childPath(path, max));
  return (value: number) => (lower === undefined || value >= lower) && (upper === undefined || value <= upper);
}

interface CompiledValue {
  readonly schema: JsonObject;
  readonly check: Check;
  readonly hasRefs: boolean;
  readonly members?: readonly (readonly [string, Check])[];
}

function compileValue(field: JsonValue, path: string, position: Position, allowRefs: boolean): CompiledValue {
  if (!object(field)) invalid(path);
  if (has(field, REF_VALUE) || has(field, REF_KIND)) {
    if (!allowRefs || position !== 'parameter' && position !== 'ref-item') unsupported(childPath(path, REF_VALUE));
    if (field.type !== 'string' || typeof field[REF_KIND] !== 'string' || field[REF_KIND].trim().length === 0) {
      invalid(childPath(path, REF_KIND));
    }
    if (typeof field.minLength !== 'number' || field.minLength < 1) invalid(childPath(path, 'minLength'));
    const wire = { ...field };
    delete wire[REF_VALUE];
    delete wire[REF_KIND];
    const model = compileValue(wire, path, 'nested', false);
    const target = compileValue(field[REF_VALUE]!, childPath(path, REF_VALUE), 'nested', false);
    return {
      schema: { ...model.schema, [REF_KIND]: field[REF_KIND], [REF_VALUE]: target.schema },
      check: (value, location, resolved) => (resolved ? target : model).check(value, location, false),
      hasRefs: true,
    };
  }

  const type = position === 'root'
    ? kind(field.type, ['object'], childPath(path, 'type'))
    : has(field, 'type') ? kind(field.type, Object.keys(TYPE_RULES), childPath(path, 'type')) : undefined;
  const choices = position === 'root' ? [] : ['enum', 'const', 'anyOf'];
  keys(field, ['type', 'description', 'default', ...choices, ...(type ? TYPE_RULES[type]! : [])], path);
  if (has(field, 'description') && typeof field.description !== 'string') invalid(childPath(path, 'description'));
  const schema: Record<string, JsonValue> = { ...field };
  const checks: Check[] = [];
  let hasRefs = false;
  let rootMembers: CompiledValue['members'];

  if (type !== undefined) checks.push((value, location) =>
    matchesType(value, type) ? undefined : issue(location, 'Parameter type does not match.'));

  if (type === 'object') {
    const declared = field.properties;
    if ((position === 'root' || has(field, 'properties')) && !object(declared)) invalid(childPath(path, 'properties'));
    const properties: Record<string, JsonValue> = Object.create(null);
    const members = Object.keys(declared ?? {}).sort().map(name => {
      const member = compileValue((declared as JsonObject)[name]!, childPath(childPath(path, 'properties'), name),
        position === 'root' ? 'parameter' : 'nested', allowRefs);
      properties[name] = member.schema;
      hasRefs ||= member.hasRefs;
      return [name, member.check] as const;
    });
    if (position === 'root') rootMembers = members;
    if (position === 'root' || declared !== undefined) schema.properties = properties;
    const required = has(field, 'required') ? field.required : [];
    if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || !has(properties, name)) ||
        new Set(required).size !== required.length) invalid(childPath(path, 'required'));
    const requiredNames = [...required as string[]].sort();
    if (position === 'root' || has(field, 'required')) schema.required = requiredNames;
    if (has(field, 'additionalProperties') && typeof field.additionalProperties !== 'boolean') {
      if (object(field.additionalProperties)) unsupported(childPath(path, 'additionalProperties'));
      invalid(childPath(path, 'additionalProperties'));
    }
    if (position === 'root') schema.additionalProperties = field.additionalProperties ?? true;
    checks.push((value, location, resolved) => {
      const record = value as JsonObject;
      for (const name of requiredNames) if (!has(record, name)) {
        return issue(childPath(location, name), 'Required object property is missing.');
      }
      for (const [name, check] of members) if (has(record, name)) {
        const failure = check(record[name]!, childPath(location, name), resolved);
        if (failure) return failure;
      }
      if (field.additionalProperties === false && Object.keys(record).some(name => !has(properties, name))) {
        return issue(location, 'Additional object properties are not allowed.');
      }
    });
  }

  if (type === 'array') {
    if (!object(field.items)) invalid(childPath(path, 'items'));
    const item = compileValue(field.items, childPath(path, 'items'), position === 'parameter' ? 'ref-item' : 'nested', allowRefs);
    schema.items = item.schema;
    hasRefs = item.hasRefs;
    const validLength = bounds(field, 'minItems', 'maxItems', path, true);
    checks.push((value, location, resolved) => {
      const values = value as readonly JsonValue[];
      if (!validLength(values.length)) return issue(location, 'Array length is outside the declared bounds.');
      for (let index = 0; index < values.length; index++) {
        const failure = item.check(values[index]!, location + '[' + index + ']', resolved);
        if (failure) return failure;
      }
    });
  }
  if (type === 'string') {
    const validLength = bounds(field, 'minLength', 'maxLength', path, true);
    if (has(field, 'minLength') || has(field, 'maxLength')) checks.push((value, location) => {
      let length = 0;
      for (const _ of value as string) length++;
      if (!validLength(length)) return issue(location, 'String length is outside the declared bounds.');
    });
    if (has(field, 'pattern')) {
      if (typeof field.pattern !== 'string') invalid(childPath(path, 'pattern'));
      let pattern: RegExp;
      try { pattern = new RegExp(field.pattern, 'u'); }
      catch { invalid(childPath(path, 'pattern')); }
      checks.push((value, location) => pattern.test(value as string) ? undefined : issue(location, 'String does not match the declared pattern.'));
    }
  }
  if (type === 'number' || type === 'integer') {
    const inRange = bounds(field, 'minimum', 'maximum', path);
    if (has(field, 'minimum') || has(field, 'maximum')) checks.push((value, location) =>
      inRange(value as number) ? undefined : issue(location, 'Number is outside the declared bounds.'));
  }
  if (has(field, 'const')) {
    const expected = canonicalJson(field.const!);
    checks.push((value, location) => canonicalJson(value) === expected ? undefined : issue(location, 'Value does not match the declared constant.'));
  }
  if (has(field, 'enum')) {
    if (!Array.isArray(field.enum) || field.enum.length === 0) invalid(childPath(path, 'enum'));
    const options = new Set(field.enum.map(canonicalJson));
    if (options.size !== field.enum.length || type !== undefined && field.enum.some(value => !matchesType(value, type))) {
      invalid(childPath(path, 'enum'));
    }
    checks.push((value, location) => options.has(canonicalJson(value)) ? undefined : issue(location, 'Value is not a declared option.'));
  }
  if (has(field, 'anyOf')) {
    const branchesPath = childPath(path, 'anyOf');
    if (!Array.isArray(field.anyOf) || field.anyOf.length === 0) invalid(branchesPath);
    const alternatives = field.anyOf.map((branch, index) => compileValue(branch, branchesPath + '[' + index + ']', 'nested', false));
    schema.anyOf = alternatives.map(alternative => alternative.schema);
    checks.push((value, location, resolved) => alternatives.some(alternative => !alternative.check(value, location, resolved))
      ? undefined : issue(location, 'Value does not match any declared alternative.'));
  }

  const check: Check = (value, location, resolved) => {
    for (const test of checks) {
      const failure = test(value, location, resolved);
      if (failure) return failure;
    }
  };
  if (has(field, 'default') && check(field.default!, path, false)) invalid(childPath(path, 'default'));
  return { schema, check, hasRefs, members: rootMembers };
}

function declarationIssue(error: unknown) {
  return Object.freeze({
    code: error instanceof DeclarationError ? error.code : 'PARAMETER_DECLARATION_INVALID' as const,
    message: error instanceof DeclarationError ? error.message : 'Expected a valid bounded ordinary parameter declaration.',
    path: diagnosticPath(error instanceof DeclarationError || error instanceof SnapshotDataError ? error.path ?? '$' : '$'),
  });
}

/** Compile a standalone TypeBox-exported value schema for captured Ref values. */
export function compileValueSchema(input: unknown): Readonly<
  { ok: true; validate(value: JsonValue): ValueIssue | undefined } | { ok: false; issue: ReturnType<typeof declarationIssue> }
> {
  try {
    const compiled = compileValue(bounded(input, DECLARATION), '$', 'nested', false);
    return Object.freeze({ ok: true, validate: (value: JsonValue) => compiled.check(value, '$', false) });
  } catch (error) { return Object.freeze({ ok: false, issue: declarationIssue(error) }); }
}

function finish(root: JsonObject, allowRefs: boolean, qualified: boolean): CompileResult {
  // Compile fields once. The root assembles their diagnostics, retaining the
  // existing limit and the parameter name as well as the nested JSON path.
  if (root.type !== 'object') kind(root.type, ['object'], '$.type');
  if (!object(root.properties)) invalid('$.properties');
  const compiled = compileValue(root, '$', 'root', allowRefs);
  const schema = bounded(compiled.schema, DECLARATION) as JsonObject;
  const fields = compiled.members!;
  const hasRefs = compiled.hasRefs;
  const requiredNames = new Set(schema.required as readonly string[]);
  const check = (input: unknown, resolved: boolean): OrdinaryValidation => {
    const diagnostics: ParameterDiagnostic[] = [];
    const add = (failure: ValueIssue, parameter?: string) => {
      if (diagnostics.length < 16) diagnostics.push(Object.freeze({
        ...failure,
        ...(parameter === undefined ? {} : { parameter: parameter.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, '?') }),
      }));
    };
    let value: JsonValue | undefined;
    try { value = bounded(input, resolved ? RESOLVED_TOOL_ARGUMENT_LIMITS : INPUT); }
    catch { add(issue('$', 'Expected bounded plain JSON parameters.')); }
    if (diagnostics.length === 0) {
      if (!object(value)) add(issue('$', 'Expected a parameter object.'));
      else {
        for (const [name, field] of fields) {
          if (diagnostics.length >= 16) break;
          const path = childPath('$', name);
          const failure = has(value, name) ? field(value[name]!, path, resolved)
            : requiredNames.has(name) ? issue(path, 'Required parameter is missing.') : undefined;
          if (failure) add(failure, name);
        }
        if (schema.additionalProperties === false && Object.keys(value).some(name => !has(schema.properties as JsonObject, name))) {
          add(issue('$', 'Additional parameters are not allowed.'));
        }
      }
    }
    return diagnostics.length ? Object.freeze({ ok: false, code: 'PARAMETER_INPUT_INVALID', diagnostics: Object.freeze(diagnostics) })
      : Object.freeze({ ok: true, value: value as JsonObject });
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
  catch (error) { return Object.freeze({ ok: false, issue: declarationIssue(error) }); }
}

/** Derive the model descriptor without walking defaults, constants, or property names as keywords. */
export function modelToolSchema(input: JsonValue): JsonValue {
  if (!object(input)) return input;
  const schema = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    if (key === MARKER || key === REF_KIND || key === REF_VALUE) return [];
    if (key === 'properties' && object(value)) {
      return [[key, Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, modelToolSchema(schema)]))]];
    }
    if (key === 'items') return [[key, modelToolSchema(value)]];
    if (key === 'anyOf' && Array.isArray(value)) return [[key, value.map(modelToolSchema)]];
    return [[key, value]];
  }));
  if (typeof input[REF_KIND] === 'string') {
    const address = 'A visible Ref address as view_id.ref_id. Use the containing View id and the exact local Ref name, including any index.';
    schema.description = typeof input.description === 'string' && input.description
      ? input.description + ' ' + address : address;
  }
  return schema;
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
