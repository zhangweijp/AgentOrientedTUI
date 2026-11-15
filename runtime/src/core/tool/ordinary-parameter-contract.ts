export const VIEW_TYPE_PARAMETERS_MODE = 'view-type-parameters-v1' as const;
import { canonicalJson, copyJson, JsonCopyLimitError, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { DEFAULT_SNAPSHOT_LIMITS, RAW_TOOL_ARGUMENT_LIMITS as INPUT, RESOLVED_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED' | 'PARAMETER_DECLARATION_CAPACITY';
export type ParameterDiagnostic = Readonly<{ parameter?: string; path?: string; message: string }>;
export type OrdinaryValidation =
  | Readonly<{ ok: true; value: JsonObject }>
  | Readonly<{ ok: false; code: 'PARAMETER_INPUT_INVALID'; diagnostics: readonly ParameterDiagnostic[] }>;
export interface OrdinaryParameterContract {
  readonly schema: JsonObject;
  readonly hasRefs: boolean;
  validateModelInput(input: unknown): OrdinaryValidation;
  validateResolvedInput(input: unknown): OrdinaryValidation;
}
export type CompileResult =
  | Readonly<{ ok: true; contract: OrdinaryParameterContract }>
  | Readonly<{ ok: false; issue: Readonly<{ code: DeclarationCode; message: string; path: string }> }>;

const DECLARATION = { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 };
const REF_VALUE = 'x-aotui-ref-value';
const REF_KIND = 'x-aotui-ref-kind';
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
  if (utf8Size(canonicalJson(value)) > limits.maxApproxBytes) {
    throw new DeclarationError('PARAMETER_DECLARATION_CAPACITY', 'Canonical JSON byte budget exceeded.', '$');
  }
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

function compileValue(field: JsonValue, path: string, position: Position): CompiledValue {
  if (!object(field)) invalid(path);
  if (has(field, REF_VALUE) || has(field, REF_KIND)) {
    if (position !== 'parameter' && position !== 'ref-item') unsupported(childPath(path, REF_VALUE));
    if (field.type !== 'string' || typeof field[REF_KIND] !== 'string' || field[REF_KIND].trim().length === 0) {
      invalid(childPath(path, REF_KIND));
    }
    if (typeof field.minLength !== 'number' || field.minLength < 1) invalid(childPath(path, 'minLength'));
    const wire = { ...field };
    delete wire[REF_VALUE];
    delete wire[REF_KIND];
    const model = compileValue(wire, path, 'nested');
    const target = compileValue(field[REF_VALUE]!, childPath(path, REF_VALUE), 'nested');
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
        position === 'root' ? 'parameter' : 'nested');
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
    const item = compileValue(field.items, childPath(path, 'items'), position === 'parameter' ? 'ref-item' : 'nested');
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
    const alternatives = field.anyOf.map((branch, index) => compileValue(branch, branchesPath + '[' + index + ']', 'nested'));
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
  if (error instanceof JsonCopyLimitError) {
    return Object.freeze({ code: 'PARAMETER_DECLARATION_CAPACITY' as const, message: error.message, path: diagnosticPath(error.path) });
  }
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
    const compiled = compileValue(bounded(input, DECLARATION), '$', 'nested');
    return Object.freeze({ ok: true, validate: (value: JsonValue) => compiled.check(value, '$', false) });
  } catch (error) { return Object.freeze({ ok: false, issue: declarationIssue(error) }); }
}

function finish(root: JsonValue): CompileResult {
  if (object(root) && object(root.properties) && has(root.properties, 'view_id')) {
    throw new DeclarationError('PARAMETER_DECLARATION_INVALID',
      'view_id is reserved for the receiving View. Declare only business parameters.', '$.properties.view_id');
  }
  // Compile fields once. The root assembles their diagnostics, retaining the
  // existing limit and the parameter name as well as the nested JSON path.
  const compiled = compileValue(root, '$', 'root');
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
    try { value = bounded(input, resolved && hasRefs ? RESOLVED_TOOL_ARGUMENT_LIMITS : INPUT); }
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
  return Object.freeze({ ok: true, contract: Object.freeze({
    schema, hasRefs,
    validateModelInput: (input: unknown) => check(input, false),
    validateResolvedInput: (input: unknown) => check(input, true),
  }) });
}

function stripInternalSchema(input: JsonValue): JsonValue {
  if (!object(input)) return input;
  const schema = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    if (key === MARKER || key === REF_KIND || key === REF_VALUE) return [];
    if (key === 'properties' && object(value)) {
      const properties = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, stripInternalSchema(schema)]));
      return [[key, Object.freeze(properties)]];
    }
    if (key === 'items') return [[key, stripInternalSchema(value)]];
    if (key === 'anyOf' && Array.isArray(value)) return [[key, Object.freeze(value.map(stripInternalSchema))]];
    return [[key, value]];
  }));
  if (typeof input[REF_KIND] === 'string') {
    const address = 'A visible Ref address as view_id.ref_id. Use the containing View id and the exact local Ref name, including any index.';
    schema.description = typeof input.description === 'string' && input.description
      ? input.description + ' ' + address : address;
  }
  return Object.freeze(schema);
}

/** Derive the one model schema for a page operation from its business contract. */
export function modelToolSchema(input: JsonValue, viewType: string, eligibleViewIds?: readonly string[]): JsonObject {
  const schema = stripInternalSchema(input);
  if (!object(schema) || !object(schema.properties) || !Array.isArray(schema.required) ||
      has(schema.properties, 'view_id') || eligibleViewIds?.length === 0) {
    throw new SnapshotDataError('TOOL_SCHEMA_INVALID', '$', 'Invalid View Tool model contract');
  }
  const result = Object.freeze({
    ...schema,
    properties: Object.freeze({
      view_id: Object.freeze({
        type: 'string',
        description: 'XML id of the observed ' + viewType + ' View that will execute this operation.',
        ...(eligibleViewIds === undefined ? {} : { enum: Object.freeze([...eligibleViewIds]) }),
      }),
      ...schema.properties,
    }),
    required: Object.freeze(['view_id', ...schema.required]),
  });
  if (utf8Size(canonicalJson(result)) > DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes) {
    throw new SnapshotDataError('TOOL_SCHEMA_CAPACITY', '$', 'View Tool model schema exceeds the byte limit');
  }
  return result;
}

/** Compile the ViewType Tool schema for model arguments and resolved handler input. */
export function compileOrdinarySchema(schema: unknown): CompileResult {
  try { return finish(copyJson(schema, DECLARATION)); }
  catch (error) { return Object.freeze({ ok: false, issue: declarationIssue(error) }); }
}
