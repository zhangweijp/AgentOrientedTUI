/**
 * AOTUI SDK - Argument Validation (Enhanced)
 *
 * Runtime validation for Operation parameters.
 * Bridges the gap between compile-time TypeScript and runtime Agent calls.
 *
 * [Operation Enhancement] Supports:
 * - Basic types: string, number, boolean, object
 * - Array types with itemType validation
 * - Enum types with options validation
 * - Constraints: minLength, maxLength, pattern, min, max
 *
 * @example
 * ```typescript
 * const errors = validateArgs(
 *     { content: 'hello', tags: ['a', 'b'] },
 *     {
 *         content: { type: 'string', required: true, constraints: { maxLength: 100 } },
 *         tags: { type: 'array', itemType: 'string' },
 *         priority: { type: 'enum', options: ['low', 'medium', 'high'] }
 *     }
 * );
 * ```
 */

import type {
  ParamSchema,
  ParamDef,
  ParamBaseType,
} from "../operation/types.js";

/**
 * Validation error for a single parameter
 */
export interface ValidationError {
  /** Parameter name */
  param: string;
  /** Expected type description */
  expected: string;
  /** Actual received type */
  received: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Validate arguments against a ParamSchema
 *
 * @param args - Arguments received from Agent
 * @param schema - Parameter schema defined by developer
 * @returns Array of validation errors (empty if valid)
 */
export function validateArgs(
  args: Record<string, unknown>,
  schema: ParamSchema,
): ValidationError[] {
  const errors: ValidationError[] = [];
  validateArguments(args, schema, (_name, _reason, legacy) => errors.push(legacy()), false);
  return errors;
}

/** Internal safe diagnostics; not re-exported by the SDK entry point. */
export interface SafeArgumentDiagnostic {
  param: string;
  reason: string;
}
export const SNAPSHOT_VALUE_DIAGNOSTIC_LIMITS = Object.freeze({
  maxItems: 16, maxParamLength: 128, maxReasonLength: 256, maxMessageLength: 512,
});
const SAFE_REASONS = {
  required: "Required parameter is missing or null",
  type: "Parameter does not match its declared type",
  "array-item": "Array item does not match its declared type",
  enum: "Parameter is outside the declared choices",
  reference: "Reference parameter has an unsupported type",
  "string-min": "String is shorter than the declared minimum",
  "string-max": "String is longer than the declared maximum",
  pattern: "String does not match the declared pattern",
  min: "Number is below the declared minimum",
  max: "Number is above the declared maximum",
  "array-min": "Array has fewer items than the declared minimum",
  "array-max": "Array has more items than the declared maximum",
} as const;
type Reporter = (name: string, reason: keyof typeof SAFE_REASONS, legacy: () => ValidationError) => void;

/** Caller supplies already bounded, detached declarations and strict JSON arguments. */
export function validateArgsForSnapshotValue(
  args: Record<string, unknown>, schema: ParamSchema,
): SafeArgumentDiagnostic[] {
  const diagnostics: SafeArgumentDiagnostic[] = [];
  validateArguments(args, schema, (name, reason) => {
    if (diagnostics.length < SNAPSHOT_VALUE_DIAGNOSTIC_LIMITS.maxItems) {
      diagnostics.push({ param: name.slice(0, SNAPSHOT_VALUE_DIAGNOSTIC_LIMITS.maxParamLength),
        reason: SAFE_REASONS[reason].slice(0, SNAPSHOT_VALUE_DIAGNOSTIC_LIMITS.maxReasonLength) });
    }
  }, true);
  return diagnostics;
}

function validateArguments(
  args: Record<string, unknown>, schema: ParamSchema, report: Reporter, ownValues: boolean,
): void {
  for (const [name, def] of Object.entries(schema)) {
    const value = ownValues && !Object.hasOwn(args, name) ? undefined : args[name];
    if (def.required === true && (value === undefined || value === null)) {
      report(name, "required", () => ({
        param: name,
        expected: formatExpected(def),
        received: value === null ? "null" : "undefined",
        message: `Parameter '${name}' is required but was ${value === null ? "null" : "undefined"}`,
      }));
      continue;
    }
    if (value === undefined) continue;
    if (!validateType(name, value, def, report)) continue;
    validateConstraints(name, value, def, report);
  }
}

/**
 * Validate type of a value against ParamDef
 */
function validateType(
  name: string,
  value: unknown,
  def: ParamDef,
  report: Reporter,
): boolean {
  const actualType = getActualType(value);

  switch (def.type) {
    case "array":
      if (!Array.isArray(value)) {
        report(name, "type", () => ({
          param: name,
          expected: `array<${def.itemType || "any"}>`,
          received: actualType,
          message: `Parameter '${name}' expected array, got ${actualType}`,
        }));
        return false;
      }
      // Validate item types if itemType is specified
      if (def.itemType) {
        for (let i = 0; i < (value as unknown[]).length; i++) {
          const item = (value as unknown[])[i];
          const itemType = getActualType(item);
          if (!isBaseTypeMatch(itemType, def.itemType)) {
            report(name, "array-item", () => ({
              param: name,
              expected: `array<${def.itemType}>`,
              received: `array containing ${itemType} at index ${i}`,
              message: `Parameter '${name}[${i}]' expected ${def.itemType}, got ${itemType}`,
            }));
            return false;
          }
        }
      }
      return true;

    case "enum":
      if (!def.options || !def.options.includes(String(value))) {
        report(name, "enum", () => ({
          param: name,
          expected: `enum(${def.options?.join(" | ") || "no options"})`,
          received: String(value),
          message: `Parameter '${name}' must be one of [${def.options?.join(", ")}], got '${value}'`,
        }));
        return false;
      }
      return true;

    case "reference":
      // [RFC-Reference] Reference types can be:
      // 1. String (Raw Reference ID from LLM, e.g. "recent_msgs[0]")
      // 2. Object (Resolved Reference from Runtime, e.g. Message object)
      // Both are valid depending on the resolution stage.
      if (actualType === "string" || actualType === "object") {
        return true;
      }
      report(name, "reference", () => ({
        param: name,
        expected: `reference<${def.refType || "any"}>`,
        received: actualType,
        message: `Parameter '${name}' expected reference (string or object), got ${actualType}`,
      }));
      return false;

    default:
      // Basic types: string, number, boolean, object
      if (!isBaseTypeMatch(actualType, def.type as ParamBaseType)) {
        report(name, "type", () => ({
          param: name,
          expected: def.type,
          received: actualType,
          message: `Parameter '${name}' expected ${def.type}, got ${actualType}`,
        }));
        return false;
      }
      return true;
  }
}

/**
 * Validate constraints
 */
function validateConstraints(
  name: string,
  value: unknown,
  def: ParamDef,
  report: Reporter,
): void {
  const c = def.constraints;
  if (!c) return;

  // String constraints
  if (typeof value === "string") {
    if (c.minLength !== undefined && value.length < c.minLength) {
      report(name, "string-min", () => ({
        param: name,
        expected: `length >= ${c.minLength}`,
        received: `length = ${value.length}`,
        message: `Parameter '${name}' must have at least ${c.minLength} characters`,
      }));
    }
    if (c.maxLength !== undefined && value.length > c.maxLength) {
      report(name, "string-max", () => ({
        param: name,
        expected: `length <= ${c.maxLength}`,
        received: `length = ${value.length}`,
        message: `Parameter '${name}' must have at most ${c.maxLength} characters`,
      }));
    }
    if (c.pattern !== undefined) {
      try {
        const regex = new RegExp(c.pattern);
        if (!regex.test(value)) {
          report(name, "pattern", () => ({
            param: name,
            expected: `match pattern ${c.pattern}`,
            received: value,
            message: `Parameter '${name}' must match pattern /${c.pattern}/`,
          }));
        }
      } catch {
        // Invalid regex pattern - skip validation
      }
    }
  }

  // Number constraints
  if (typeof value === "number") {
    if (c.min !== undefined && value < c.min) {
      report(name, "min", () => ({
        param: name,
        expected: `>= ${c.min}`,
        received: String(value),
        message: `Parameter '${name}' must be at least ${c.min}`,
      }));
    }
    if (c.max !== undefined && value > c.max) {
      report(name, "max", () => ({
        param: name,
        expected: `<= ${c.max}`,
        received: String(value),
        message: `Parameter '${name}' must be at most ${c.max}`,
      }));
    }
  }

  // Array length constraints
  if (Array.isArray(value)) {
    if (c.minLength !== undefined && value.length < c.minLength) {
      report(name, "array-min", () => ({
        param: name,
        expected: `length >= ${c.minLength}`,
        received: `length = ${value.length}`,
        message: `Parameter '${name}' must have at least ${c.minLength} items`,
      }));
    }
    if (c.maxLength !== undefined && value.length > c.maxLength) {
      report(name, "array-max", () => ({
        param: name,
        expected: `length <= ${c.maxLength}`,
        received: `length = ${value.length}`,
        message: `Parameter '${name}' must have at most ${c.maxLength} items`,
      }));
    }
  }

}

/**
 * Format expected type description
 */
function formatExpected(def: ParamDef): string {
  switch (def.type) {
    case "array":
      return `array<${def.itemType || "any"}>${def.required ? " (required)" : ""}`;
    case "enum":
      return `enum(${def.options?.join(" | ") || "no options"})${def.required ? " (required)" : ""}`;
    default:
      return `${def.type}${def.required ? " (required)" : ""}`;
  }
}

/**
 * Get the runtime type of a value
 */
function getActualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Check if actual type matches expected base ParamType
 */
function isBaseTypeMatch(actual: string, expected: ParamBaseType): boolean {
  if (expected === "object") {
    // object type should match plain objects, not null or array
    return actual === "object";
  }
  if (expected === "reference") {
    // reference can be a raw string (LLM-provided ref id) or a resolved object
    return actual === "string" || actual === "object";
  }
  return actual === expected;
}

/**
 * Format validation errors into a single message
 *
 * @param errors - Array of validation errors
 * @returns Formatted error message
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 1) {
    return errors[0].message;
  }
  return errors.map((e) => e.message).join("; ");
}
