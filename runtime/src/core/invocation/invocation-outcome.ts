import { isToolResultData } from '../../spi/core/tool-result.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import type { ObservationJsonLimits } from './observation-types.js';
import type { ExecutionPhase, InvocationOutcome } from './app-interaction-types.js';

export function jsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exactFields(value: Readonly<Record<string, JsonValue>>, required: readonly string[], optional: readonly string[] = []): boolean {
    return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function captureBoundedJson<T>(raw: unknown, limits: ObservationJsonLimits): { value: T; bytes: number } {
    const value = copyJson(raw, limits);
    // Detached records have null prototypes and copied arrays have the
    // intrinsic Array.prototype. Native JSON preserves byte length across
    // key order; keep the canonical path if an inherited array toJSON
    // could add behavior or execute an accessor.
    const bytes = utf8Size('toJSON' in Array.prototype ? canonicalJson(value) : JSON.stringify(value)!);
    if (bytes > limits.maxCanonicalBytes) throw new RangeError('Bounded JSON capacity exceeded');
    return { value: value as T, bytes };
}
export const unknownOutcome = (): InvocationOutcome => Object.freeze({ status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN',
    message: 'The final business outcome could not be established' });
export interface ExecutionMapping {
    readonly executionPhase: 'not-dispatched' | ExecutionPhase | 'unknown';
    readonly outcome: InvocationOutcome;
}
export function mapExecutionFact(raw: unknown, limits: ObservationJsonLimits): ExecutionMapping {
    try {
        const fact = captureBoundedJson<JsonValue>(raw, limits).value;
        if (!jsonObject(fact)) throw 0;
        if (fact.kind === 'unknown' && exactFields(fact, ['kind'])) return { executionPhase: 'unknown', outcome: unknownOutcome() };
        if (fact.phase !== 'not-entered' && fact.phase !== 'entered-returned') throw 0;
        const phase: ExecutionPhase = fact.phase;
        if (fact.kind !== 'tool-result' || !exactFields(fact, ['kind', 'phase', 'result'], ['failureEffects'])) throw 0;
        const result = fact.result;
        if (!isToolResultData(result)) throw 0;
        if (Object.hasOwn(fact, 'failureEffects') && (phase !== 'entered-returned' || result.success ||
            fact.failureEffects !== 'none' && fact.failureEffects !== 'partial')) throw 0;
        const details = { kind: 'tool-result' as const, phase, result: result as unknown as import('./app-interaction-types.js').ToolResultData };
        if (phase === 'not-entered') {
            if (result.success) throw 0;
            if (result.error.code === 'REF_VIEW_UNAVAILABLE' && typeof result.error.context?.path === 'string') {
                return { executionPhase: phase, outcome: Object.freeze({ status: 'rejected', code: result.error.code,
                    message: result.error.message, path: result.error.context.path, details }) };
            }
            return { executionPhase: phase, outcome: Object.freeze({ status: 'rejected', code: 'TOOL_REJECTED',
                message: 'The Tool rejected the request before handler entry', details }) };
        }
        if (result.success) return { executionPhase: phase, outcome: Object.freeze({ status: 'succeeded', value: result }) };
        if (fact.failureEffects === 'none' || fact.failureEffects === 'partial') return { executionPhase: phase,
            outcome: Object.freeze({ status: 'failed', code: 'TOOL_FAILED', message: 'The application reported a task failure', effects: fact.failureEffects, details }) };
        return { executionPhase: phase, outcome: Object.freeze({ status: 'unknown', code: 'TOOL_OUTCOME_UNKNOWN',
            message: 'The business outcome is uncertain', details }) };
    } catch { return { executionPhase: 'unknown', outcome: unknownOutcome() }; }
}
