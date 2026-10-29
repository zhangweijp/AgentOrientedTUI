import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import type { ActionOutcome } from '../invocation/invocation-outcome.js';

export type CreateIfAbsentOutcome = Extract<
  ActionOutcome,
  { status: 'succeeded' | 'failed' | 'unknown' }
>;
export type CreateIfAbsentTerminal =
  | Readonly<{ phase: 'not-entered'; outcome: Extract<ActionOutcome, { status: 'rejected' }> }>
  | Readonly<{ phase: 'entered-returned'; outcome: CreateIfAbsentOutcome }>;
const object = (value: unknown): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (
  value: Readonly<Record<string, JsonValue>>,
  keys: readonly string[],
  optional: readonly string[] = []
) =>
  keys.every((k) => Object.hasOwn(value, k)) &&
  Object.keys(value).every((k) => keys.includes(k) || optional.includes(k));

export function createIfAbsentSchema(params: unknown): JsonValue {
  const captured = copyJson(params, { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 });
  if (!object(captured) || Object.keys(captured).length === 0)
    throw new TypeError('Invalid create-if-absent parameters');
  const properties: Record<string, JsonValue> = Object.create(null);
  for (const [name, field] of Object.entries(captured)) {
    if (
      !object(field) ||
      !exact(field, ['type', 'required'], ['desc']) ||
      field.type !== 'string' ||
      field.required !== true ||
      (Object.hasOwn(field, 'desc') && typeof field.desc !== 'string')
    )
      throw new TypeError('Invalid create-if-absent parameters');
    properties[name] = {
      type: 'string',
      ...(Object.hasOwn(field, 'desc') ? { description: field.desc! } : {}),
    };
  }
  return copyJson(
    { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 }
  );
}
export function isCreateIfAbsentSchema(input: unknown): boolean {
  try {
    const schema = copyJson(input, { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 });
    if (
      !object(schema) ||
      !exact(schema, ['type', 'properties', 'required', 'additionalProperties']) ||
      schema.type !== 'object' ||
      schema.additionalProperties !== false ||
      !object(schema.properties) ||
      Object.keys(schema.properties).length === 0 ||
      !Array.isArray(schema.required) ||
      schema.required.length !== Object.keys(schema.properties).length ||
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some(
        (k) => typeof k !== 'string' || !Object.hasOwn(schema.properties as object, k)
      )
    )
      return false;
    return Object.values(schema.properties).every(
      (field) =>
        object(field) &&
        exact(field, ['type'], ['description']) &&
        field.type === 'string' &&
        (!Object.hasOwn(field, 'description') || typeof field.description === 'string')
    );
  } catch {
    return false;
  }
}
export function matchesCreateIfAbsentInput(schema: unknown, input: unknown): boolean {
  try {
    if (!isCreateIfAbsentSchema(schema)) return false;
    const args = copyJson(input, { maxDepth: 32, maxNodes: 5_000, maxApproxBytes: 128 * 1024 });
    if (!object(args) || utf8Size(canonicalJson(args)) > 128 * 1024) return false;
    const properties = (schema as Readonly<Record<string, JsonValue>>).properties as Readonly<
      Record<string, JsonValue>
    >;
    return (
      Object.keys(args).length === Object.keys(properties).length &&
      Object.keys(properties).every((k) => Object.hasOwn(args, k) && typeof args[k] === 'string')
    );
  } catch {
    return false;
  }
}
