import { isToolResultData } from '../tool/tool-result.js';
import { copyWireJson } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import type { ExecutionPhase, InvocationJsonLimits, InvocationOutcome } from './app-interaction-types.js';

export function jsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exactFields(value: Readonly<Record<string, JsonValue>>, required: readonly string[]): boolean {
    return Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
}
export const unknownOutcome = (): InvocationOutcome => Object.freeze({ status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN',
    message: 'The final business outcome could not be established' });
export interface ExecutionMapping {
    readonly executionPhase: 'not-dispatched' | ExecutionPhase | 'unknown';
    readonly outcome: InvocationOutcome;
}
export function mapExecutionFact(raw: unknown, limits: InvocationJsonLimits): ExecutionMapping {
    try {
        const fact = copyWireJson(raw, limits);
        if (!jsonObject(fact)) throw 0;
        if (fact.kind === 'unknown' && exactFields(fact, ['kind'])) return { executionPhase: 'unknown', outcome: unknownOutcome() };
        if (fact.phase !== 'not-entered' && fact.phase !== 'entered-returned') throw 0;
        const phase: ExecutionPhase = fact.phase;
        if (fact.kind !== 'tool-result' || !exactFields(fact, ['kind', 'phase', 'result'])) throw 0;
        const result = fact.result;
        if (!isToolResultData(result)) throw 0;
        const details = { kind: 'tool-result' as const, phase, result };
        if (phase === 'not-entered') {
            if (result.success) throw 0;
            const { code, message, context } = result.error;
            if (code === 'REF_VIEW_UNAVAILABLE' || code === 'REF_NOT_VISIBLE' || code === 'REF_ARGUMENT_BUDGET_EXCEEDED')
                return { executionPhase: phase, outcome: Object.freeze({ status: 'rejected', code, message,
                    ...(typeof context?.path === 'string' ? { path: context.path } : {}), details }) };
            return { executionPhase: phase, outcome: Object.freeze({ status: 'rejected', code: 'TOOL_REJECTED',
                message: 'The Tool rejected the request before handler entry', details }) };
        }
        if (result.success) return { executionPhase: phase, outcome: Object.freeze({ status: 'succeeded', value: result }) };
        return { executionPhase: phase, outcome: Object.freeze({ status: 'failed', code: 'TOOL_FAILED',
            message: 'The application reported a task failure', details }) };
    } catch { return { executionPhase: 'unknown', outcome: unknownOutcome() }; }
}
