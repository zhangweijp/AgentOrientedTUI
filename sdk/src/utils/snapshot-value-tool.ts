import type { RefV1Terminal } from '@aotui/runtime/spi';
import type { OperationResult, ParamSchema } from '../operation/types.js';
import { SNAPSHOT_VALUE_DIAGNOSTIC_LIMITS as LIMITS, validateArgsForSnapshotValue,
    type SafeArgumentDiagnostic } from './validateArgs.js';

function invalidArguments(diagnostics: SafeArgumentDiagnostic[] = []): RefV1Terminal {
    return { phase: 'not-entered', result: { success: false, error: {
        code: 'E_INVALID_ARGS',
        message: (diagnostics.map(d => `${d.param}: ${d.reason}`).join('; ') || 'Tool arguments could not be validated')
            .slice(0, LIMITS.maxMessageLength),
        context: { diagnostics },
    } } };
}

/**
 * Internal only: params must be the current binding's bounded, detached C1 declarations;
 * effectiveArgs must already pass Runtime strict JSON, source and capacity checks.
 * The trusted caller supplies a callable business handler. No authorization, copying,
 * registration or transport is performed here; these prerequisites are not proved by A.
 */
export async function invokeSnapshotValueTool(
    params: ParamSchema,
    effectiveArgs: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => OperationResult | Promise<OperationResult>,
): Promise<RefV1Terminal> {
    try {
        const slots = Object.entries(params).filter(([, def]) => Object.hasOwn(def, 'refSource'));
        if (slots.length !== 1 || slots[0]![1].refSource !== 'snapshot-value-v1' ||
            slots[0]![1].type !== 'reference' || slots[0]![1].required !== true) {
            return { phase: 'not-entered', result: { success: false, error: {
                code: 'REF_CONTRACT_UNSUPPORTED', message: 'Expected exactly one required top-level snapshot-value Ref',
            } } };
        }
        const name = slots[0]![0];
        const value = Object.hasOwn(effectiveArgs, name) ? effectiveArgs[name] : undefined;
        if (value === null || typeof value !== 'object' || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
            return invalidArguments([{ param: name.slice(0, LIMITS.maxParamLength), reason: 'Ref parameter must be a JSON object' }]);
        }
        const diagnostics = validateArgsForSnapshotValue(effectiveArgs, params);
        if (diagnostics.length > 0) return invalidArguments(diagnostics);
    } catch {
        return invalidArguments();
    }

    try {
        const result = await handler(effectiveArgs);
        return { phase: 'entered-returned', result };
    } catch {
        return { phase: 'entered-returned', result: { success: false, error: {
            code: 'E_HANDLER_ERROR', message: 'Tool handler failed',
        } } };
    }
}
