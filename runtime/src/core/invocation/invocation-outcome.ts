import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import type { ObservationJsonLimits } from './observation-types.js';
import type { ExecutionPhase, InvocationOutcome } from './scoped-interaction-types.js';

export type ActionOutcome =
    | Readonly<{ status: 'succeeded'; value: JsonValue }>
    | Readonly<{ status: 'rejected'; code: string; message: string }>
    | Readonly<{ status: 'failed'; code: string; message: string; effects: 'none' | 'partial' }>
    | Readonly<{ status: 'accepted'; operationId: string }>
    | Readonly<{ status: 'unknown'; code: string; message: string }>;

export function jsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exactFields(value: Readonly<Record<string, JsonValue>>, required: readonly string[], optional: readonly string[] = []): boolean {
    return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Existing M5 shape rules, applied only to already detached strict JSON. */
export function parseActionOutcome(result: JsonValue): ActionOutcome {
    if (!jsonObject(result)) throw new TypeError('Invalid ActionOutcome');
    switch (result.status) {
        case 'succeeded':
            if (exactFields(result, ['status', 'value'])) return result as unknown as ActionOutcome;
            break;
        case 'rejected': case 'unknown':
            if (exactFields(result, ['status', 'code', 'message']) && nonEmpty(result.code) && nonEmpty(result.message)) return result as unknown as ActionOutcome;
            break;
        case 'failed':
            if (exactFields(result, ['status', 'code', 'message', 'effects']) && nonEmpty(result.code) && nonEmpty(result.message) &&
                (result.effects === 'none' || result.effects === 'partial')) return result as unknown as ActionOutcome;
            break;
        case 'accepted':
            if (exactFields(result, ['status', 'operationId']) && nonEmpty(result.operationId)) return result as unknown as ActionOutcome;
    }
    throw new TypeError('Invalid ActionOutcome shape');
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
    readonly queryTerminal: boolean;
}
export function mapExecutionFact(raw: unknown, limits: ObservationJsonLimits): ExecutionMapping {
    try {
        const fact = captureBoundedJson<JsonValue>(raw, limits).value;
        if (!jsonObject(fact)) throw 0;
        if (fact.kind === 'unknown' && exactFields(fact, ['kind'])) return { executionPhase: 'unknown', outcome: unknownOutcome(), queryTerminal: false };
        if (fact.phase !== 'not-entered' && fact.phase !== 'entered-returned') throw 0;
        const phase: ExecutionPhase = fact.phase;
        if (fact.kind === 'action' && exactFields(fact, ['kind', 'phase', 'outcome'])) {
            const outcome = parseActionOutcome(fact.outcome!);
            if (phase === 'not-entered') {
                if (outcome.status !== 'rejected') throw 0;
                return { executionPhase: phase, outcome, queryTerminal: false };
            }
            if (outcome.status === 'rejected') return { executionPhase: phase, queryTerminal: false,
                outcome: Object.freeze({ status: 'unknown', code: 'TOOL_OUTCOME_UNKNOWN', message: 'The business outcome is uncertain',
                    details: { kind: 'action-outcome' as const, phase, outcome } }) };
            return { executionPhase: phase, outcome, queryTerminal: outcome.status !== 'accepted' };
        }
        if (fact.kind !== 'operation-result' || !exactFields(fact, ['kind', 'phase', 'result'], ['failureEffects'])) throw 0;
        const result = fact.result;
        if (!jsonObject(result) || !exactFields(result, ['success'], ['data', 'error']) || typeof result.success !== 'boolean' ||
            Object.hasOwn(result, 'data') && !jsonObject(result.data)) throw 0;
        if (Object.hasOwn(result, 'error')) {
            const error = result.error;
            if (!jsonObject(error) || !exactFields(error, ['code', 'message'], ['context']) || typeof error.code !== 'string' || error.code.length === 0 ||
                typeof error.message !== 'string' || Object.hasOwn(error, 'context') && !jsonObject(error.context)) throw 0;
        }
        if (Object.hasOwn(fact, 'failureEffects') && (phase !== 'entered-returned' || result.success ||
            fact.failureEffects !== 'none' && fact.failureEffects !== 'partial')) throw 0;
        const details = { kind: 'operation-result' as const, phase, result: result as unknown as import('./scoped-interaction-types.js').OperationResultData };
        if (phase === 'not-entered') {
            if (result.success) throw 0;
            return { executionPhase: phase, queryTerminal: false, outcome: Object.freeze({ status: 'rejected', code: 'TOOL_REJECTED',
                message: 'The tool rejected the operation before entry', details }) };
        }
        if (result.success) return { executionPhase: phase, queryTerminal: true, outcome: Object.freeze({ status: 'succeeded', value: result }) };
        if (fact.failureEffects === 'none' || fact.failureEffects === 'partial') return { executionPhase: phase, queryTerminal: true,
            outcome: Object.freeze({ status: 'failed', code: 'TOOL_FAILED', message: 'The business operation failed', effects: fact.failureEffects, details }) };
        return { executionPhase: phase, queryTerminal: true, outcome: Object.freeze({ status: 'unknown', code: 'TOOL_OUTCOME_UNKNOWN',
            message: 'The business outcome is uncertain', details }) };
    } catch { return { executionPhase: 'unknown', outcome: unknownOutcome(), queryTerminal: false }; }
}
