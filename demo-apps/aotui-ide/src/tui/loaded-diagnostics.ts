import type { Diagnostic } from "../types.js";

export interface LoadedDiagnostic {
  readonly range: Readonly<{
    start: Readonly<{ line: number; character: number }>;
    end: Readonly<{ line: number; character: number }>;
  }>;
  readonly severity: Diagnostic["severity"];
  readonly message: string;
  readonly line?: number;
  readonly character?: number;
  readonly code?: string | number;
  readonly source?: string;
}
export interface LoadedDiagnosticsState {
  readonly filePath: string;
  readonly stateVersion: number;
  readonly status: "idle" | "loading" | "success" | "error";
  readonly diagnostics: readonly LoadedDiagnostic[];
  readonly updatedAt: number | null;
  readonly error: string | null;
}
function fields(input: unknown): Record<string, PropertyDescriptor> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Invalid diagnostic data");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).some(
      (k) =>
        typeof k !== "string" ||
        !descriptors[k]!.enumerable ||
        !("value" in descriptors[k]!),
    )
  )
    throw new Error("Invalid diagnostic data");
  return descriptors;
}
function position(input: unknown) {
  const d = fields(input);
  const line = d.line?.value,
    character = d.character?.value;
  if (
    !Number.isSafeInteger(line) ||
    line < 0 ||
    !Number.isSafeInteger(character) ||
    character < 0
  )
    throw new Error("Invalid diagnostic position");
  return Object.freeze({
    line: line as number,
    character: character as number,
  });
}
/** Copy known DTO fields explicitly; the real service's optional undefined is omitted. No truncation. */
export function loadedDiagnostic(input: Diagnostic): LoadedDiagnostic {
  const d = fields(input);
  const range = fields(d.range?.value),
    severity = d.severity?.value,
    message = d.message?.value;
  if (
    !(
      (typeof severity === "number" && Number.isFinite(severity)) ||
      ["error", "warning", "info", "hint"].includes(severity)
    ) ||
    typeof message !== "string"
  )
    throw new Error("Invalid diagnostic data");
  const optional: {
    line?: number;
    character?: number;
    code?: string | number;
    source?: string;
  } = {};
  for (const key of ["line", "character", "code", "source"] as const) {
    const value = d[key]?.value;
    if (value === undefined) continue;
    if (
      key === "line" || key === "character"
        ? !Number.isSafeInteger(value) || value < 0
        : key === "source"
          ? typeof value !== "string"
          : !(
              typeof value === "string" ||
              (typeof value === "number" && Number.isFinite(value))
            )
    )
      throw new Error("Invalid diagnostic data");
    Object.assign(optional, { [key]: value });
  }
  return Object.freeze({
    range: Object.freeze({
      start: position(range.start?.value),
      end: position(range.end?.value),
    }),
    severity,
    message,
    ...optional,
  });
}
export function initialLoadedDiagnostics(
  filePath: string,
): LoadedDiagnosticsState {
  return Object.freeze({
    filePath,
    stateVersion: 0,
    status: "idle",
    diagnostics: Object.freeze([]),
    updatedAt: null,
    error: null,
  });
}
export function transitionLoadedDiagnostics(
  previous: LoadedDiagnosticsState,
  filePath: string,
  status: LoadedDiagnosticsState["status"],
  diagnostics: readonly Diagnostic[] = [],
  updatedAt = Date.now(),
  error: string | null = null,
): LoadedDiagnosticsState {
  if (
    !Number.isSafeInteger(previous.stateVersion) ||
    previous.stateVersion < 0 ||
    previous.stateVersion === Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(updatedAt)
  )
    throw new Error("Invalid diagnostic state");
  return Object.freeze({
    filePath,
    stateVersion: previous.stateVersion + 1,
    status,
    diagnostics: Object.freeze(
      status === "success" ? diagnostics.map(loadedDiagnostic) : [],
    ),
    updatedAt: status === "idle" ? null : updatedAt,
    error: status === "error" ? (error ?? "Diagnostics failed") : null,
  });
}
