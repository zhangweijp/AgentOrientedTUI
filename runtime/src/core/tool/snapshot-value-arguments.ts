import { VIEW_TYPE_PARAMETERS_MODE } from './ordinary-parameter-contract.js';
import { canonicalJson, copyJson, utf8Size, type JsonCopyLimits } from '../snapshot/json.js';
import type { JsonValue, ObservedToolExecutionV3, SnapshotIssueCode, SnapshotStore } from '../snapshot/types.js';
import { compileOrdinaryProfile } from './ordinary-parameter-profile.js';
import { acquireToolSource } from './source-binding.js';
import { selectedRefParameters } from './versioned-ref-declarations.js';
import { RAW_TOOL_ARGUMENT_LIMITS as RAW, RESOLVED_TOOL_ARGUMENT_LIMITS as ARGUMENTS,
    RESOLVED_TOOL_ENVELOPE_LIMITS as ENVELOPE } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type ArgumentIssueCode = SnapshotIssueCode | 'TOOL_INVALID_ARGS' | 'TOOL_PERMISSION_DENIED'
    | 'REF_NOT_VISIBLE' | 'REF_TARGET_UNSUPPORTED' | 'REF_TYPE_MISMATCH' | 'REF_VALUE_UNSUPPORTED'
    | 'REF_ARGUMENT_BUDGET_EXCEEDED';

export interface SnapshotValueRefSource {
    readonly param: string;
    readonly refId: string;
    readonly kind: 'snapshot-value';
    readonly refType: string;
    readonly snapshotId: string;
    readonly viewId: string;
    readonly viewInstanceId: string;
}

export function checkRefViews(sources: readonly SnapshotValueRefSource[], raw: Readonly<Record<string, unknown>>,
    isLive: (viewId: string, viewInstanceId: string) => boolean) {
    const indices = new Map<string, number>();
    for (const { param, viewId, viewInstanceId } of sources) {
        const index = indices.get(param) ?? 0;
        if (!isLive(viewId, viewInstanceId)) {
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param) ? '.' + param : '[' + JSON.stringify(param) + ']';
            const path = ('$' + key + (Array.isArray(raw[param]) ? '[' + index + ']' : '')).slice(0, 512);
            return { code: 'REF_VIEW_UNAVAILABLE', message: 'The original View is closed or was reopened. Choose a Ref from a current observation.', path };
        }
        indices.set(param, index + 1);
    }
}

type Limits = JsonCopyLimits & { readonly maxCanonicalBytes: number };
// Keep the existing separate argument and envelope budgets for Ref preparation.
const REQUEST: Limits = Object.freeze({ maxDepth: RAW.maxDepth + 1, maxNodes: RAW.maxNodes + 16,
    maxApproxBytes: RAW.maxApproxBytes + 8 * 1024, maxCanonicalBytes: RAW.maxCanonicalBytes + 8 * 1024 });

/** Resolve only from the original granted Snapshot; execution remains ViewType-owned. */
export function prepareViewTypeParameters(
    store: SnapshotStore, context: Readonly<{ appId: string; instanceId: string }>,
    callerRequest: unknown, visibleRefs: readonly Readonly<{ refId: string; viewId: string; viewInstanceId: string }>[],
): Readonly<{ status: 'rejected'; issue: Readonly<{ code: ArgumentIssueCode; message: string; path?: string }> }> | Readonly<{
    status: 'prepared'; rawArgs: JsonObject; effectiveArgs: JsonObject;
    refSources: readonly SnapshotValueRefSource[]; release(): void;
}> {
    let request: JsonObject;
    try {
        const value = bounded(callerRequest, REQUEST);
        if (!object(value) || Object.keys(value).length !== 4 || !object(value.execution) || value.execution.kind !== 'view-type' ||
            typeof value.snapshotId !== 'string' || typeof value.toolId !== 'string' || !object(value.args))
            return rejected('TOOL_INVALID_ARGS', 'Expected qualified ViewType parameters');
        request = value;
    } catch { return rejected('TOOL_INVALID_ARGS', 'Expected bounded ViewType parameters'); }
    const selected = acquireToolSource(store, { appId: context.appId, instanceId: context.instanceId,
        snapshotId: request.snapshotId as string, toolId: request.toolId as string,
        execution: request.execution as unknown as ObservedToolExecutionV3 });
    if (selected.status === 'rejected') return rejected(selected.issue.code, 'Tool source is unavailable');
    let retained = false;
    try {
        if (selected.execution.kind !== 'view-type') return rejected('REF_CONTRACT_UNSUPPORTED', 'Expected ViewType execution');
        const contract = compileOrdinaryProfile(selected.tool.inputSchema);
        if (!contract || contract.revision !== VIEW_TYPE_PARAMETERS_MODE) return rejected('REF_CONTRACT_UNSUPPORTED', 'Expected the ViewType parameter profile');
        const rawArgs = bounded(request.args, RAW) as JsonObject;
        const model = (contract.validateModelInput ?? contract.validate)(rawArgs);
        if (!model.ok) {
            const diagnostic = model.diagnostics[0];
            return rejected('TOOL_INVALID_ARGS', diagnostic?.message ?? 'Invalid model parameters', diagnostic?.path);
        }
        const fields = contract.schema.properties as JsonObject;
        const slots = selectedRefParameters(fields, rawArgs);
        let effectiveArgs: Record<string, JsonValue> = { ...rawArgs };
        const visibleByAddress = new Map<string, typeof visibleRefs[number] | null>();
        for (const ref of visibleRefs) {
            const address = `${ref.viewId}.${ref.refId}`;
            visibleByAddress.set(address, visibleByAddress.has(address) ? null : ref);
        }
        const refSources: SnapshotValueRefSource[] = [];
        for (const { param, field, refId, index } of slots) {
            if (typeof refId !== 'string') return rejected('TOOL_INVALID_ARGS', 'Expected a Ref name');
            const owner = visibleByAddress.get(refId);
            if (owner === undefined) return rejected('REF_NOT_VISIBLE', 'Expected a visible View-qualified Ref: view_id.ref_id');
            if (owner === null) return rejected('REF_TARGET_UNSUPPORTED', 'Expected one unambiguous Ref');
            const resolved = store.resolveRef({ appId: context.appId, instanceId: context.instanceId,
                snapshotId: request.snapshotId as string, refId: owner.refId, viewId: owner.viewId, viewInstanceId: owner.viewInstanceId });
            if (resolved.status === 'rejected') return rejected(resolved.issue.code, 'Original Ref source is unavailable');
            if (resolved.target.kind !== 'snapshot-value') return rejected('REF_TARGET_UNSUPPORTED', 'Expected a Snapshot value');
            const expectedType = (field as JsonObject)['x-aotui-ref-kind'] as string;
            if (resolved.ref.refType !== expectedType) return rejected('REF_TYPE_MISMATCH',
                `Parameter ${JSON.stringify(param.slice(0, 64))} requires a current ${JSON.stringify(expectedType.slice(0, 64))} Ref, but the selected Ref is ${JSON.stringify(resolved.ref.refType.slice(0, 64))}. Read the latest View and pass view_id.ref_id for the required type.`);
            if (index === undefined) effectiveArgs[param] = resolved.target.payload;
            else {
                if (index === 0) effectiveArgs[param] = [];
                (effectiveArgs[param] as JsonValue[])[index] = resolved.target.payload;
            }
            refSources.push({ param, refId: owner.refId, kind: 'snapshot-value', refType: resolved.ref.refType,
                snapshotId: request.snapshotId as string, viewId: owner.viewId, viewInstanceId: owner.viewInstanceId });
        }
        // Budget the complete resolved arguments, not a mix of payloads and unresolved Ref names.
        effectiveArgs = bounded(effectiveArgs, ARGUMENTS) as JsonObject;
        const effective = (contract.validateResolvedInput ?? contract.validate)(effectiveArgs);
        if (!effective.ok) {
            const diagnostic = effective.diagnostics[0];
            return rejected('REF_VALUE_UNSUPPORTED', diagnostic?.message ?? 'Resolved parameters do not match the contract', diagnostic?.path);
        }
        const envelope = bounded({ source: { appId: context.appId, instanceId: context.instanceId,
            snapshotId: request.snapshotId, toolId: request.toolId, activationId: selected.execution.activationId },
            effectiveArgs, refSources }, ENVELOPE) as JsonObject;
        retained = true;
        return Object.freeze({ status: 'prepared', rawArgs,
            effectiveArgs: envelope.effectiveArgs as JsonObject, refSources: envelope.refSources as unknown as readonly SnapshotValueRefSource[], release: selected.release });
    } catch { return rejected('REF_ARGUMENT_BUDGET_EXCEEDED', 'Combined resolved parameters exceed the call limit. Select fewer Ref values.', '$'); }
    finally { if (!retained) selected.release(); }
}

function object(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bounded(value: unknown, limits: Limits): JsonValue {
    const copied = copyJson(value, limits);
    // Canonicalization only sees an already bounded, getter-free copy.
    if (utf8Size(canonicalJson(copied)) > limits.maxCanonicalBytes) {
        throw new RangeError('Canonical JSON byte budget exceeded');
    }
    return copied;
}
function rejected(code: ArgumentIssueCode, message: string, path?: string): Readonly<{ status: 'rejected'; issue: Readonly<{ code: ArgumentIssueCode; message: string; path?: string }> }> {
    return Object.freeze({ status: 'rejected' as const, issue: Object.freeze({ code, message, ...(path === undefined ? {} : { path }) }) });
}

