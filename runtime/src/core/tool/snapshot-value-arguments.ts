import { canonicalJson, copyJson, SnapshotDataError, utf8Size, type JsonCopyLimits } from '../snapshot/json.js';
import type { JsonValue, SnapshotIssueCode, SnapshotStore, ToolDescriptorV2, ToolTargetV2 } from '../snapshot/types.js';
import { validateVersionedToolRefDeclarations } from './versioned-ref-declarations.js';
import { acquireToolSource, type ToolSourceRequest } from './source-binding.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type ArgumentIssueCode = SnapshotIssueCode | 'OPERATION_INVALID_ARGS' | 'TOOL_PERMISSION_DENIED'
    | 'REF_TARGET_UNSUPPORTED' | 'REF_TYPE_MISMATCH' | 'REF_VALUE_UNSUPPORTED'
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

export type SnapshotValueArgumentPreparation =
    | Readonly<{ status: 'rejected'; issue: Readonly<{ code: ArgumentIssueCode; message: string }> }>
    | Readonly<{
        status: 'prepared';
        sourceRequest: Readonly<ToolSourceRequest>;
        tool: ToolDescriptorV2;
        target: ToolTargetV2;
        rawArgs: JsonObject;
        effectiveArgs: JsonObject;
        refSources: readonly [SnapshotValueRefSource];
        release(): void;
    }>;

type Limits = JsonCopyLimits & { readonly maxCanonicalBytes: number };
// Snapshot-value V2 keeps a separately bounded parameter and envelope profile.
const REQUEST: Limits = Object.freeze({ maxDepth: 25, maxNodes: 10_004, maxApproxBytes: 136 * 1024, maxCanonicalBytes: 136 * 1024 });
const ARGUMENTS: Limits = Object.freeze({ maxDepth: 24, maxNodes: 10_000, maxApproxBytes: 128 * 1024, maxCanonicalBytes: 128 * 1024 });
const ENVELOPE: Limits = Object.freeze({ maxDepth: 26, maxNodes: 11_000, maxApproxBytes: 136 * 1024, maxCanonicalBytes: 136 * 1024 });
export { ARGUMENTS as SNAPSHOT_VALUE_ARGUMENT_LIMITS, ENVELOPE as SNAPSHOT_VALUE_ENVELOPE_LIMITS };

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
function rejected(code: ArgumentIssueCode, message: string): Extract<SnapshotValueArgumentPreparation, { status: 'rejected' }> {
    return Object.freeze({ status: 'rejected' as const, issue: Object.freeze({ code, message }) });
}

/**
 * Internal synchronous preparation only: no authorization or Handler dispatch.
 * Store and App identity are trusted; the complete caller request is not.
 * On success the caller owns one lease and must release it in finally.
 */
export function prepareSnapshotValueArguments(
    store: SnapshotStore,
    context: Readonly<{ appId: string; instanceId: string }>,
    callerRequest: unknown,
): SnapshotValueArgumentPreparation {
    let request: JsonObject;
    let rawArgs: JsonObject;
    try {
        const captured = bounded(callerRequest, REQUEST);
        if (!object(captured) || Object.keys(captured).length !== 4 ||
            ['snapshotId', 'toolId', 'viewId'].some(key =>
                typeof captured[key] !== 'string' || (captured[key] as string).length === 0) ||
            !Object.hasOwn(captured, 'args') || !object(captured.args)) {
            return rejected('OPERATION_INVALID_ARGS', 'Expected a bounded request with source IDs and an object args');
        }
        request = captured;
        rawArgs = bounded(captured.args, ARGUMENTS) as JsonObject;
    } catch {
        return rejected('OPERATION_INVALID_ARGS', 'Expected bounded plain JSON request and arguments');
    }

    const sourceRequest: Readonly<ToolSourceRequest> = Object.freeze({
        appId: context.appId, instanceId: context.instanceId,
        snapshotId: request.snapshotId as string, toolId: request.toolId as string, viewId: request.viewId as string,
    });
    const selected = acquireToolSource(store, sourceRequest);
    if (selected.status === 'rejected') return rejected(selected.issue.code, 'Tool source is unavailable');
    let retained = false;
    try {
        if (selected.tool.isMutating !== false) {
            return rejected('TOOL_PERMISSION_DENIED', 'Snapshot-value arguments require a read-only Tool');
        }
        const schema = selected.tool.inputSchema;
        let declared: boolean;
        try {
            declared = validateVersionedToolRefDeclarations(schema, selected.tool.isMutating);
        } catch (error) {
            // Only trusted validator classification is retained; never its input path/value.
            if (error instanceof SnapshotDataError) return rejected(error.code, 'Invalid or unsupported Ref declaration');
            throw error;
        }
        const properties = object(schema) && object(schema.properties) ? schema.properties : {};
        const slots = Object.entries(properties).filter(([, field]) => object(field) && Object.hasOwn(field, 'x-aotui-ref'));
        if (!declared || slots.length !== 1 || !object(schema) ||
            !Array.isArray(schema.required) || !schema.required.includes(slots[0]![0])) {
            return rejected('REF_CONTRACT_UNSUPPORTED', 'Expected exactly one required top-level Ref declaration');
        }
        const [param, field] = slots[0]!;
        const refId = rawArgs[param];
        if (!Object.hasOwn(rawArgs, param) || typeof refId !== 'string' || refId.length === 0) {
            return rejected('OPERATION_INVALID_ARGS', 'The declared Ref argument must be a nonempty Ref ID string');
        }
        const resolved = store.resolveRef({
            ...sourceRequest, viewId: selected.target.viewId,
            viewInstanceId: selected.target.viewInstanceId, refId,
        });
        if (resolved.status === 'rejected') return rejected(resolved.issue.code, 'Ref is unavailable in the original target source');
        if (resolved.target.kind !== 'snapshot-value') {
            return rejected('REF_TARGET_UNSUPPORTED', 'Only snapshot-value Ref targets are supported');
        }
        const metadata = (field as JsonObject)['x-aotui-ref'] as JsonObject;
        if (Object.hasOwn(metadata, 'refType') && metadata.refType !== resolved.ref.refType) {
            return rejected('REF_TYPE_MISMATCH', 'Ref type does not match the declared requirement');
        }
        if (!object(resolved.target.payload)) {
            return rejected('REF_VALUE_UNSUPPORTED', 'Snapshot-value Ref must contain a non-null JSON object');
        }

        let envelope: Readonly<{
            source: Readonly<ToolSourceRequest & { viewInstanceId: string; bindingVersion: number }>;
            effectiveArgs: JsonObject;
            refSources: readonly [SnapshotValueRefSource];
        }>;
        try {
            // Assemble a shallow candidate; the payload is bounded while being copied,
            // before any canonical encoding or second full expanded value is built.
            const effectiveArgs = bounded({ ...rawArgs, [param]: resolved.target.payload }, ARGUMENTS);
            envelope = bounded({
                source: { ...sourceRequest, viewInstanceId: selected.target.viewInstanceId,
                    bindingVersion: selected.target.bindingVersion },
                effectiveArgs,
                refSources: [{ param, refId, kind: 'snapshot-value', refType: resolved.ref.refType,
                    snapshotId: sourceRequest.snapshotId, viewId: selected.target.viewId,
                    viewInstanceId: selected.target.viewInstanceId }],
            }, ENVELOPE) as unknown as typeof envelope;
        } catch {
            return rejected('REF_ARGUMENT_BUDGET_EXCEEDED', 'Prepared Ref arguments or source envelope exceed the budget');
        }
        retained = true;
        return Object.freeze({
            status: 'prepared' as const, sourceRequest, tool: selected.tool, target: selected.target,
            rawArgs, effectiveArgs: envelope.effectiveArgs, refSources: envelope.refSources,
            release: selected.release,
        });
    } finally {
        if (!retained) selected.release();
    }
}
