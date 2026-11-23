import { Compile, type XSchema } from 'typebox/schema';
import { canonicalJson, checkJsonLimits, copyJson, JsonCopyLimitError, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue, ViewMultiplicity } from '../snapshot/types.js';
import type { ProgramToolInput } from '../invocation/observation-types.js';
import { DEFAULT_SNAPSHOT_LIMITS, RAW_TOOL_ARGUMENT_LIMITS as INPUT, RESOLVED_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED' | 'PARAMETER_DECLARATION_CAPACITY';
export type ParameterDiagnostic = Readonly<{ parameter?: string; path?: string; message: string }>;
export type ToolParameterValidation =
  | Readonly<{ ok: true; value: JsonObject }>
  | Readonly<{ ok: false; code: 'PARAMETER_INPUT_INVALID'; diagnostics: readonly ParameterDiagnostic[] }>;
export interface ToolParameterContract {
  readonly schema: JsonObject;
  readonly hasRefs: boolean;
  validateModelInput(input: unknown): ToolParameterValidation;
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
type Position = 'root' | 'parameter' | 'ref-item' | 'nested';

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
    if (field.type !== 'string' || typeof field[REF_KIND] !== 'string' || field[REF_KIND].trim().length === 0) {
      invalid(childPath(path, REF_KIND));
    }
    if (typeof field.minLength !== 'number' || field.minLength < 1) invalid(childPath(path, 'minLength'));
    const { [REF_VALUE]: value, [REF_KIND]: refKind, ...wire } = field;
    const model = compileValue(wire, path, 'nested');
    const target = compileValue(value!, childPath(path, REF_VALUE), 'nested');
    return Object.freeze({ ...model, [REF_KIND]: refKind!, [REF_VALUE]: target });
  }

  const type = position === 'root'
    ? kind(field.type, ['object'], childPath(path, 'type'))
    : has(field, 'type') ? kind(field.type, Object.keys(TYPE_RULES), childPath(path, 'type')) : undefined;
  const choices = position === 'root' ? [] : ['enum', 'const', 'anyOf'];
  keys(field, ['type', 'description', 'default', ...choices, ...(type ? TYPE_RULES[type]! : [])], path);
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
    schema.anyOf = Object.freeze(field.anyOf.map((branch, index) => compileValue(branch, branchesPath + '[' + index + ']', 'nested')));
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

const address = (value: JsonValue) => typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$');
const literal = (value: JsonValue) => typeof value === 'string' && value.startsWith('$$') ? value.slice(1) : value;

function nativeCheck(field: JsonObject, resolved: Check, parameter = true): Check {
  if (has(field, REF_KIND)) {
    const { [REF_KIND]: _kind, [REF_VALUE]: _value, ...wire } = field;
    const check = valueCheck(Object.freeze(wire));
    return (value, path) => address(value) ? check(value, path)
      : issue(path, 'Expected a published Ref address such as $app.view.ref.');
  }
  const item = parameter && field.type === 'array' && object(field.items) ? field.items : undefined;
  if (!item) return (value, path) => address(value) ? undefined : resolved(literal(value), path);

  const nominalItems = has(item, REF_KIND);
  const itemCheck = nativeCheck(item, valueCheck(resolvedField(item)), false);
  const { minItems, maxItems } = field;
  const shape = valueCheck(Object.freeze({ type: 'array', items: true, ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }) }));
  return (value, path) => {
    if (address(value)) return nominalItems ? issue(path, 'Supply an array of published Ref addresses.') : undefined;
    if (!Array.isArray(value)) return resolved(literal(value), path);
    if (!nominalItems && !value.some(address)) {
      return resolved(value.some(item => typeof item === 'string' && item.startsWith('$$')) ? value.map(literal) : value, path);
    }
    const invalidShape = shape(value, path);
    if (invalidShape) return invalidShape;
    for (const [index, item] of value.entries()) {
      const invalidItem = itemCheck(item, diagnosticPath(path + '[' + index + ']'));
      if (invalidItem) return invalidItem;
    }
  };
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
    const validate = valueCheck(compileValue(bounded(input, DECLARATION), '$', 'nested'));
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
    return { name, native: nativeCheck(field, resolved), resolved, hasRefs: field !== business };
  });
  const requiredNames = new Set(schema.required as readonly string[]);
  const check = (input: unknown, resolved: boolean): ToolParameterValidation => {
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
        for (const field of fields) {
          const { name } = field;
          if (diagnostics.length >= 16) break;
          const path = childPath('$', name);
          const failure = has(value, name) ? (resolved ? field.resolved : field.native)(value[name]!, path)
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
    schema, hasRefs: fields.some(field => field.hasRefs),
    validateModelInput: (input: unknown) => check(input, false),
    validateResolvedInput: (input: unknown) => check(input, true),
  }) });
}

const REF_HINT_MAX_JSON_BYTES = 118;
const REF_ADDRESS_HINT = 'Use $app_id.view_id.ref_id or append [index] for an ArrayRef element.';

function collectRefValueShapes(schema: JsonValue | undefined, shapes: Set<string>): boolean {
  if (!object(schema)) return false;
  if (typeof schema.type === 'string' && has(TYPE_RULES, schema.type)) {
    shapes.add(schema.type);
    return true;
  }
  return Array.isArray(schema.anyOf) && schema.anyOf.length > 0 &&
    schema.anyOf.every(branch => collectRefValueShapes(branch, shapes));
}

function refParameterHint(refType: string, valueSchema: JsonValue | undefined): string {
  const shapes = new Set<string>();
  const shape = collectRefValueShapes(valueSchema, shapes) ? 'Value shape ' + [...shapes].join(' or ') + '. ' : '';
  const type = refType !== 'unknown' && refType.length < REF_HINT_MAX_JSON_BYTES && !/[\p{Cc}\p{Cf}]/u.test(refType)
    ? 'Ref type ' + JSON.stringify(refType) + '. ' : '';
  for (const prefix of [type + shape, shape, type]) {
    const hint = prefix + REF_ADDRESS_HINT;
    if (utf8Size(JSON.stringify(hint)) - 2 <= REF_HINT_MAX_JSON_BYTES) return hint;
  }
  return REF_ADDRESS_HINT;
}

function modelField(field: JsonObject, parameter: boolean): JsonObject {
  const description = typeof field.description === 'string' ? field.description + ' ' : '';
  if (typeof field[REF_KIND] === 'string') {
    const { [REF_KIND]: refType, [REF_VALUE]: target, ...schema } = field;
    return Object.freeze({ ...schema, pattern: '^[$][^$]', description: description + refParameterHint(refType as string, target) });
  }
  const hint = description + 'Use a value or $app_id.view_id.ref_id. Start literal $ text with $$.';
  if (field.type === 'string' && !['minLength', 'maxLength', 'const', 'enum', 'anyOf'].some(key => has(field, key)))
    return Object.freeze({ ...field, description: hint });

  let literal = field;
  if (parameter && field.type === 'array' && object(field.items)) {
    literal = Object.freeze({ ...field, items: modelField(field.items, false) });
    if (has(field.items, REF_KIND)) return literal;
  }
  return Object.freeze({ anyOf: Object.freeze([literal, Object.freeze({
    type: 'string', pattern: field.type === 'string' || field.type === undefined ? '^[$]' : '^[$][^$]',
  })]), description: hint });
}

function routedToolSchema(input: JsonValue, viewType: string, multiplicity: ViewMultiplicity,
  mapField: (schema: JsonObject, name: string) => JsonObject): JsonObject {
  if (!object(input) || !object(input.properties) || !Array.isArray(input.required) ||
      has(input.properties, 'view_id') || (multiplicity !== 'single' && multiplicity !== 'multiple')) {
    throw new SnapshotDataError('TOOL_SCHEMA_INVALID', '$', 'Invalid View Tool model contract');
  }
  const properties = Object.fromEntries(Object.entries(input.properties).map(([name, schema]) => {
    if (!object(schema)) throw new SnapshotDataError('TOOL_SCHEMA_INVALID', '$.properties', 'Invalid View Tool parameter');
    return [name, mapField(schema, name)];
  }));
  const multiple = multiplicity === 'multiple';
  const result = Object.freeze({
    ...input,
    properties: Object.freeze({
      ...(multiple ? { view_id: Object.freeze({
        type: 'string',
        description: 'Receiving ' + viewType + ' page XML view_id.',
      }) } : {}),
      ...properties,
    }),
    required: multiple ? Object.freeze(['view_id', ...input.required]) : input.required,
  });
  if (utf8Size(canonicalJson(result)) > DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes) {
    throw new SnapshotDataError('TOOL_SCHEMA_CAPACITY', '$', 'View Tool model schema exceeds the byte limit');
  }
  return result;
}

/** Derive the one model schema for a page operation from its business contract. */
export function modelToolSchema(input: JsonValue, viewType: string, multiplicity: ViewMultiplicity): JsonObject {
  return routedToolSchema(input, viewType, multiplicity, schema => modelField(schema, true));
}

export function programToolInput(input: JsonValue, viewType: string, multiplicity: ViewMultiplicity): ProgramToolInput {
  const refOnly: ProgramToolInput['refOnly'][number][] = [];
  const schema = routedToolSchema(input, viewType, multiplicity, (field, parameter) => {
    const wire = (slot: JsonObject, arrayElement: boolean) => {
      const { [REF_KIND]: refType, [REF_VALUE]: _value, ...declared } = slot;
      if (typeof refType !== 'string') return slot;
      refOnly.push({ parameter, arrayElement, refType });
      return declared;
    };
    return field.type === 'array' && object(field.items) ? { ...field, items: wire(field.items, true) } : wire(field, false);
  });
  return { schema, refOnly };
}

/** Program arguments carry actual JSON. Turn literal dollar strings into the existing wire encoding. */
export function encodeProgramArguments(contract: ToolParameterContract, input: JsonObject): JsonObject {
  const fields = contract.schema.properties as JsonObject;
  const escape = (value: JsonValue, field: JsonObject) => typeof value === 'string' && value.startsWith('$') && !has(field, REF_KIND)
    ? '$' + value : value;
  const result = { ...input };
  for (const [name, declaration] of Object.entries(fields)) {
    if (!has(input, name)) continue;
    const field = declaration as JsonObject, value = input[name]!;
    const item = field.items;
    result[name] = field.type === 'array' && object(item) && Array.isArray(value)
      ? value.map(entry => escape(entry, item)) : escape(value, field);
  }
  return result;
}

/** Compile the ViewType Tool schema for model arguments and resolved handler input. */
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
