import { Compile, type XSchema } from 'typebox/schema';
import { canonicalJson, checkJsonLimits, checkWireJson, copyJson, copyWireJson, JsonCopyLimitError, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { RESOLVED_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED' | 'PARAMETER_DECLARATION_CAPACITY';
export type ParameterDiagnostic = Readonly<{ parameter?: string; path?: string; message: string }>;
export type ToolParameterValidation =
  | Readonly<{ ok: true; value: JsonObject }>
  | Readonly<{ ok: false; code: 'PARAMETER_INPUT_INVALID' | 'PARAMETER_INPUT_CAPACITY'; diagnostics: readonly ParameterDiagnostic[] }>;
export interface ToolParameterContract {
  readonly schema: JsonObject;
  validateResolvedInput(input: unknown): ToolParameterValidation;
}
export type ToolParameterCompileResult =
  | Readonly<{ ok: true; contract: ToolParameterContract }>
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
  throw new DeclarationError('PARAMETER_DECLARATION_INVALID', 'Expected a valid bounded tool parameter declaration.', path);
}
function unsupported(path?: string): never {
  throw new DeclarationError('PARAMETER_DECLARATION_UNSUPPORTED', 'Declaration uses unsupported tool parameter vocabulary.', path);
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
type Check = (value: JsonValue, path: string) => ValueIssue | undefined;
type Position = 'root' | 'parameter' | 'ref-item' | 'nested' | 'ref-value';

const TYPE_RULES: Readonly<Record<string, readonly string[]>> = {
  string: ['minLength', 'maxLength'],
  number: ['minimum', 'maximum'],
  integer: ['minimum', 'maximum'],
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'prefixItems', 'minItems', 'maxItems'],
  boolean: [],
  null: [],
};

function issue(path: string, message: string): ValueIssue {
  return { path: diagnosticPath(path), message };
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
}

/** Compile only plain, admitted Schema nodes. Diagnostics disclose paths and rules, never values. */
function valueCheck(schema: JsonObject): Check {
  const validator = Compile(schema as XSchema);
  return (value, path) => {
    if (validator.Check(value)) return;
    const [, [error]] = validator.Errors(value);
    if (!error) return issue(path, 'Value does not match its declaration.');
    let location = path;
    let input: JsonValue | undefined = value;
    const segments = error.instancePath.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    // Errors inside an anyOf branch describe that branch alone. Report at the
    // outer union, including when the validator omits its aggregate diagnostic.
    let depth = 0;
    let union = false;
    const rules = error.schemaPath.split('/').slice(1);
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (rule === 'anyOf') { union = true; break; }
      if (rule === 'items') { depth++; continue; }
      if (rule !== 'properties' && rule !== 'prefixItems') break;
      depth++;
      index++; // The next key identifies a property or a tuple position.
    }
    if (union) segments.splice(depth);
    // The library reports a false schema at the offending extra key or tuple index.
    // Keep the old containing-object/list path and avoid disclosing unknown keys.
    const parent = !union && error.keyword === 'boolean' && /\/(additionalProperties|items)$/.exec(error.schemaPath)?.[1];
    if (parent) segments.pop();
    for (const part of segments) {
      if (Array.isArray(input)) {
        location = diagnosticPath(location + '[' + part + ']');
        input = input[Number(part)];
      } else {
        location = childPath(location, part);
        input = object(input) && has(input, part) ? input[part] : undefined;
      }
    }
    if (union || error.keyword === 'anyOf') return issue(location, 'Value does not match any declared alternative.');
    if (parent === 'additionalProperties') return issue(location, 'Additional object properties are not allowed.');
    if (parent === 'items') return issue(location, 'Tuple length does not match its declaration.');
    switch (error.keyword) {
      case 'type': {
        const type = error.params.type;
        return issue(location, typeof type === 'string' && has(TYPE_RULES, type) ? 'Expected type ' + type + '.' : 'Parameter type does not match.');
      }
      case 'required': {
        const missing = error.params.requiredProperties;
        return issue(Array.isArray(missing) && typeof missing[0] === 'string' ? childPath(location, missing[0]) : location,
          'Required object property is missing.');
      }
      case 'additionalProperties': return issue(location, 'Additional object properties are not allowed.');
      case 'minItems': case 'maxItems': return issue(location, 'Array length is outside the declared bounds.');
      case 'minLength': case 'maxLength': return issue(location, 'String length is outside the declared bounds.');
      case 'minimum': case 'maximum': return issue(location, 'Number is outside the declared bounds.');
      case 'const': return issue(location, 'Value does not match the declared constant.');
      case 'enum': return issue(location, 'Value is not a declared option.');
      default: return issue(location, 'Value does not match its declaration.');
    }
  };
}

function resolvedField(field: JsonObject): JsonObject {
  if (has(field, REF_KIND)) return field[REF_VALUE] as JsonObject;
  if (field.type === 'array' && object(field.items) && has(field.items, REF_KIND)) {
    return Object.freeze({ ...field, items: resolvedField(field.items) });
  }
  return field;
}

function compileValue(field: JsonValue, path: string, position: Position): JsonObject {
  if (!object(field)) invalid(path);
  if (has(field, REF_VALUE) || has(field, REF_KIND)) {
    if (position !== 'parameter' && position !== 'ref-item') unsupported(childPath(path, REF_VALUE));
    keys(field, [REF_KIND, REF_VALUE, 'description'], path);
    if (typeof field[REF_KIND] !== 'string' || field[REF_KIND].trim().length === 0) {
      invalid(childPath(path, REF_KIND));
    }
    if (!has(field, REF_VALUE)) invalid(childPath(path, REF_VALUE));
    if (has(field, 'description') && typeof field.description !== 'string') invalid(childPath(path, 'description'));
    const target = compileValue(field[REF_VALUE]!, childPath(path, REF_VALUE), 'ref-value');
    return Object.freeze({
      ...(has(field, 'description') ? { description: field.description! } : {}),
      [REF_KIND]: field[REF_KIND]!,
      [REF_VALUE]: target,
    });
  }

  const type = position === 'root'
    ? kind(field.type, ['object'], childPath(path, 'type'))
    : has(field, 'type') ? kind(field.type, Object.keys(TYPE_RULES), childPath(path, 'type')) : undefined;
  const choices = position === 'root' ? [] : ['enum', 'const', 'anyOf'];
  keys(field, ['type', 'description', 'default', ...choices, ...(type ? TYPE_RULES[type]! : [])], path);
  const refShapeDependsOnUnion = position === 'ref-value' && type === undefined && !has(field, 'enum') && !has(field, 'const');
  if (refShapeDependsOnUnion && !has(field, 'anyOf')) {
    throw new DeclarationError('PARAMETER_DECLARATION_INVALID', 'A Ref value schema needs a type, enum, const or anyOf.', path);
  }
  if (has(field, 'description') && typeof field.description !== 'string') invalid(childPath(path, 'description'));
  const schema: Record<string, JsonValue> = { ...field };

  if (type === 'object') {
    const declared = field.properties;
    if ((position === 'root' || has(field, 'properties')) && !object(declared)) invalid(childPath(path, 'properties'));
    const properties: Record<string, JsonValue> = Object.create(null);
    for (const name of Object.keys(declared ?? {}).sort()) {
      properties[name] = compileValue((declared as JsonObject)[name]!, childPath(childPath(path, 'properties'), name),
        position === 'root' ? 'parameter' : 'nested');
    }
    if (position === 'root' || declared !== undefined) schema.properties = Object.freeze(properties);
    const required = has(field, 'required') ? field.required : [];
    if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || !has(properties, name)) ||
        new Set(required).size !== required.length) invalid(childPath(path, 'required'));
    if (position === 'root' || has(field, 'required')) schema.required = Object.freeze([...required as string[]].sort());
    if (has(field, 'additionalProperties') && typeof field.additionalProperties !== 'boolean') {
      if (object(field.additionalProperties)) unsupported(childPath(path, 'additionalProperties'));
      invalid(childPath(path, 'additionalProperties'));
    }
    if (position === 'root') schema.additionalProperties = field.additionalProperties ?? true;
  }

  if (type === 'array') {
    const itemPath = childPath(path, 'items');
    const prefixPath = childPath(path, 'prefixItems');
    const prefix = field.prefixItems;
    bounds(field, 'minItems', 'maxItems', path, true);
    if (field.items === false) {
      if (prefix !== undefined && (!Array.isArray(prefix) || !prefix.length)) invalid(prefixPath);
      const length = Array.isArray(prefix) ? prefix.length : 0;
      if (field.minItems !== length) invalid(childPath(path, 'minItems'));
      if (field.maxItems !== undefined && field.maxItems !== length) invalid(childPath(path, 'maxItems'));
      if (Array.isArray(prefix)) schema.prefixItems = Object.freeze(prefix.map((item, index) => compileValue(item, prefixPath + '[' + index + ']', 'nested')));
    } else {
      if (prefix !== undefined) invalid(prefixPath);
      if (!object(field.items)) invalid(itemPath);
      schema.items = compileValue(field.items, itemPath, position === 'parameter' ? 'ref-item' : 'nested');
    }
  }
  if (type === 'string') bounds(field, 'minLength', 'maxLength', path, true);
  if (type === 'number' || type === 'integer') bounds(field, 'minimum', 'maximum', path);
  if (has(field, 'enum')) {
    if (!Array.isArray(field.enum) || field.enum.length === 0) invalid(childPath(path, 'enum'));
    const options = new Set(field.enum.map(canonicalJson));
    const typed = type === undefined ? undefined : Compile({ type } as XSchema);
    if (options.size !== field.enum.length || typed && field.enum.some(value => !typed.Check(value))) {
      invalid(childPath(path, 'enum'));
    }
  }
  if (has(field, 'anyOf')) {
    const branchesPath = childPath(path, 'anyOf');
    if (!Array.isArray(field.anyOf) || field.anyOf.length === 0) invalid(branchesPath);
    const branchPosition = refShapeDependsOnUnion ? 'ref-value' : 'nested';
    schema.anyOf = Object.freeze(field.anyOf.map((branch, index) => compileValue(branch, branchesPath + '[' + index + ']', branchPosition)));
  }

  const result = Object.freeze(schema);
  if (has(field, 'default')) {
    const defaultSchema = position === 'root' ? Object.freeze({ ...result, properties: Object.freeze(Object.fromEntries(
      Object.entries(result.properties as JsonObject).map(([name, property]) => [name, resolvedField(property as JsonObject)]))) })
      : resolvedField(result);
    if (!Compile(defaultSchema as XSchema).Check(field.default)) invalid(childPath(path, 'default'));
  }
  return result;
}

function declarationIssue(error: unknown) {
  if (error instanceof JsonCopyLimitError) {
    return Object.freeze({ code: 'PARAMETER_DECLARATION_CAPACITY' as const, message: error.message, path: diagnosticPath(error.path) });
  }
  return Object.freeze({
    code: error instanceof DeclarationError ? error.code : 'PARAMETER_DECLARATION_INVALID' as const,
    message: error instanceof DeclarationError ? error.message : 'Expected a valid bounded tool parameter declaration.',
    path: diagnosticPath(error instanceof DeclarationError || error instanceof SnapshotDataError ? error.path ?? '$' : '$'),
  });
}

/** Compile a standalone TypeBox-exported value schema for captured Ref values. */
export function compileValueSchema(input: unknown): Readonly<
  { ok: true; validate(value: JsonValue): ValueIssue | undefined } | { ok: false; issue: ReturnType<typeof declarationIssue> }
> {
  try {
    const validate = valueCheck(compileValue(bounded(input, DECLARATION), '$', 'ref-value'));
    return Object.freeze({ ok: true, validate: (value: JsonValue) => validate(value, '$') });
  } catch (error) { return Object.freeze({ ok: false, issue: declarationIssue(error) }); }
}

function finish(root: JsonValue): ToolParameterCompileResult {
  if (object(root) && object(root.properties) && has(root.properties, 'view_id')) {
    throw new DeclarationError('PARAMETER_DECLARATION_INVALID',
      'view_id is reserved for the receiving View. Declare only business parameters.', '$.properties.view_id');
  }
  // Compile fields once. The root assembles their diagnostics, retaining the
  // existing limit and the parameter name as well as the nested JSON path.
  const schema = bounded(compileValue(root, '$', 'root'), DECLARATION) as JsonObject;
  const fields = Object.entries(schema.properties as JsonObject).map(([name, declaration]) => {
    const field = declaration as JsonObject, business = resolvedField(field);
    const resolved = valueCheck(business);
    return { name, resolved };
  });
  const requiredNames = new Set(schema.required as readonly string[]);
  const check = (input: unknown): ToolParameterValidation => {
    const diagnostics: ParameterDiagnostic[] = [];
    const add = (failure: ValueIssue, parameter?: string) => {
      if (diagnostics.length < 16) diagnostics.push(Object.freeze({
        ...failure,
        ...(parameter === undefined ? {} : { parameter: parameter.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, '?') }),
      }));
    };
    let value: JsonValue | undefined;
    let frozen = false;
    try {
      frozen = checkWireJson(input, RESOLVED_TOOL_ARGUMENT_LIMITS);
      value = frozen ? input as JsonValue : copyWireJson(input, RESOLVED_TOOL_ARGUMENT_LIMITS);
    }
    catch (error) {
      add(issue('$', 'Expected bounded plain JSON parameters.'));
      return Object.freeze({ ok: false, code: error instanceof JsonCopyLimitError ? 'PARAMETER_INPUT_CAPACITY' : 'PARAMETER_INPUT_INVALID',
        diagnostics: Object.freeze(diagnostics) });
    }
    if (diagnostics.length === 0) {
      if (!object(value)) add(issue('$', 'Expected a parameter object.'));
      else {
        for (const field of fields) {
          const { name } = field;
          if (diagnostics.length >= 16) break;
          const path = childPath('$', name);
          const failure = has(value, name) ? field.resolved(value[name]!, path)
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
    schema, validateResolvedInput: check,
  }) });
}

/** Compile the ViewType Tool schema for resolved business input. */
export function compileToolParameters(schema: unknown): ToolParameterCompileResult {
  try { return finish(copyJson(schema, DECLARATION)); }
  catch (error) { return Object.freeze({ ok: false, issue: declarationIssue(error) }); }
}

const capturedContracts = new WeakMap<JsonObject, { canonical: string; contract: ToolParameterContract }>();

/** Only accept schemas from the Core's strict, immutable Snapshot capture. */
export function compileCapturedToolParameters(schema: JsonObject, canonical: string, previous?: JsonValue): ToolParameterContract | null {
  const prior = object(previous) ? capturedContracts.get(previous) : undefined;
  if (prior?.canonical === canonical) {
    capturedContracts.set(schema, prior);
    return prior.contract;
  }
  try {
    checkJsonLimits(schema, DECLARATION);
    const compiled = finish(schema);
    if (!compiled.ok || canonicalJson(compiled.contract.schema) !== canonical) return null;
    capturedContracts.set(schema, { canonical, contract: compiled.contract });
    return compiled.contract;
  } catch { return null; }
}

export function getCapturedToolParameters(schema: JsonValue): ToolParameterContract | undefined {
  return object(schema) ? capturedContracts.get(schema)?.contract : undefined;
}
