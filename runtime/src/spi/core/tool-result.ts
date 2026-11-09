import type { JsonValue } from '../../core/snapshot/types.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
/** Public transport data. Local Error instances, stack and cause are not wire errors. */
export type ToolError = {
    readonly code: string;
    readonly message: string;
    readonly context?: JsonObject;
};
type Success = Readonly<{ success: true; data?: JsonObject; error?: never; effects?: never }>;
type Failure = Readonly<{ success: false; error: ToolError; data?: JsonObject; effects?: 'none' | 'partial' }>;
/** A short receipt; omitted failure effects mean that business effects are unknown. */
export type ToolResult = Success | Failure;
/** Captured result envelope. Failure effects travel beside it in the execution terminal. */
export type ToolResultData = Success | Readonly<Omit<Failure, 'effects'> & { effects?: never }>;

/** Validate a result after the existing boundary has captured it as bounded JSON. */
export function isToolResultData(value: unknown): value is ToolResultData {
    const object = (input: unknown): input is Readonly<Record<string, unknown>> =>
        input !== null && typeof input === 'object' && !Array.isArray(input);
    if (!object(value) || Object.keys(value).some(key => !['success', 'data', 'error'].includes(key)) ||
        (value.success !== true && value.success !== false)) return false;
    if (Object.hasOwn(value, 'data') && !object(value.data)) return false;
    if (value.success) return !Object.hasOwn(value, 'error');
    const error = value.error;
    return object(error) && typeof error.code === 'string' && error.code.length > 0 && typeof error.message === 'string' &&
        Object.keys(error).every(key => ['code', 'message', 'context'].includes(key)) &&
        (!Object.hasOwn(error, 'context') || object(error.context));
}
