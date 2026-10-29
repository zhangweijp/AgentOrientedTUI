import { VIEW_TOOL_V1_MESSAGE_LIMITS as REF_V1_MESSAGE_LIMITS, invocationObject as refV1Object, captureInvocationJson as captureRefV1Json, exact, text, invocationTarget as target, captureInvocationTerminal } from './view-tool-invocation-v1.js';
export { REF_V1_MESSAGE_LIMITS, refV1Object, captureRefV1Json };
type JsonObject = Readonly<Record<string, JsonValue>>;
import { canonicalJson, copyJson, SnapshotDataError } from '../core/snapshot/json.js';
import type { JsonValue } from '../core/snapshot/types.js';
import { validateToolRefDeclarations } from '../core/tool/ref-declarations.js';
import { SNAPSHOT_VALUE_ARGUMENT_LIMITS, SNAPSHOT_VALUE_ENVELOPE_LIMITS } from '../core/tool/snapshot-value-arguments.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ViewToolInvokeRefV1Message, ViewToolInvokeRefV1Response, RefV1Terminal } from '../spi/worker-protocol/messages.js';

export const REF_V1_MODE = 'snapshot-value-v1';
export const REF_V1_CAPABILITY = 'view-tool-ref-invoke/v1';
export function refV1Failure(code: string, message: string): OperationResult {
    return { success: false, error: { code, message } };
}
export function refV1Unknown(): OperationResult {
    return refV1Failure('TOOL_OUTCOME_UNKNOWN', 'No trusted Ref invocation terminal was received; do not retry automatically');
}
/** Only the new capability fields are bounded here, never existing launchConfig. */
export function captureRefCapabilities(input: unknown): readonly string[] | null {
    if (input === undefined) return Object.freeze([]);
    try {
        const value = captureRefV1Json(input, { maxDepth: 1, maxNodes: 17, maxApproxBytes: 1024, maxCanonicalBytes: 1024 });
        return Array.isArray(value) && value.every(v => text(v) && v.length <= 128) &&
            new Set(value).size === value.length ? value as readonly string[] : null;
    } catch { return null; }
}

/** Throws only safe fixed errors; callers never expose arbitrary codec exceptions. */
export function captureRefV1Request(input: unknown): ViewToolInvokeRefV1Message {
    const value = captureRefV1Json(input);
    if (!refV1Object(value) || !exact(value, ['type', 'requestId', 'appId', 'instanceId', 'snapshotId',
        'tool', 'target', 'argumentMode', 'rawArgs', 'effectiveArgs', 'refSources']) ||
        value.type !== 'VIEW_TOOL_INVOKE_REF_V1' ||
        !['requestId', 'appId', 'instanceId', 'snapshotId'].every(key => text(value[key])) ||
        !refV1Object(value.tool) || !exact(value.tool, ['id', 'name', 'viewType', 'description', 'inputSchema', 'isMutating', 'targets']) ||
        !['id', 'name', 'viewType', 'description'].every(key => text((value.tool as JsonObject)[key])) ||
        typeof value.tool.isMutating !== 'boolean' || !refV1Object(value.tool.inputSchema) ||
        value.tool.inputSchema.type !== 'object' || !Array.isArray(value.tool.targets) ||
        !value.tool.targets.every(target) || !target(value.target)) {
        throw new Error('Invalid Ref request structure');
    }
    // Preserve the existing registration profile, including its synthetic root.
    copyJson({ name: value.tool.name, description: value.tool.description,
        inputSchema: value.tool.inputSchema, isMutating: value.tool.isMutating },
    { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 });
    return value as unknown as ViewToolInvokeRefV1Message;
}

/** Checks correspondence, not the historical payload's origin (owned by Host Store). */
export function validateRefV1Arguments(message: ViewToolInvokeRefV1Message): OperationResult {
    const invalid = () => refV1Failure('OPERATION_INVALID_ARGS', 'Ref arguments and source metadata are inconsistent');
    let raw: JsonObject, effective: JsonObject;
    try {
        const value = captureRefV1Json(message.rawArgs, SNAPSHOT_VALUE_ARGUMENT_LIMITS);
        if (!refV1Object(value)) return invalid();
        raw = value;
    } catch { return invalid(); }
    try {
        const value = captureRefV1Json(message.effectiveArgs, SNAPSHOT_VALUE_ARGUMENT_LIMITS);
        if (!refV1Object(value)) return invalid();
        effective = value;
    } catch { return refV1Failure('REF_ARGUMENT_BUDGET_EXCEEDED', 'Effective Ref arguments exceed the budget'); }
    try {
        validateToolRefDeclarations(message.tool.inputSchema, message.tool.isMutating);
    } catch (error) {
        const code = error instanceof SnapshotDataError && error.code === 'REF_CONTRACT_UNSUPPORTED'
            ? 'REF_CONTRACT_UNSUPPORTED' : 'REF_DECLARATION_INVALID';
        return refV1Failure(code, 'Unsupported or invalid Ref declaration');
    }
    const schema = message.tool.inputSchema as JsonObject;
    const properties = refV1Object(schema.properties) ? schema.properties : {};
    const slots = Object.entries(properties).filter(([, v]) => refV1Object(v) && Object.hasOwn(v, 'x-aotui-ref'));
    if (slots.length !== 1 || !Array.isArray(schema.required) || !schema.required.includes(slots[0]![0])) {
        return refV1Failure('REF_CONTRACT_UNSUPPORTED', 'Ref invocation requires exactly one required top-level Ref');
    }
    const [param, field] = slots[0]!;
    const declaration = (field as JsonObject)['x-aotui-ref'] as JsonObject;
    if (!Object.hasOwn(raw, param) || !text(raw[param]) || !Object.hasOwn(effective, param) ||
        !refV1Object(effective[param]) || Object.keys(raw).length !== Object.keys(effective).length ||
        Object.keys(raw).some(key => !Object.hasOwn(effective, key) ||
            key !== param && canonicalJson(raw[key]!) !== canonicalJson(effective[key]!))) return invalid();
    const sources = message.refSources;
    if (!Array.isArray(sources) || sources.length !== 1) return invalid();
    const source = sources[0] as unknown as JsonValue;
    if (!refV1Object(source) || !exact(source, ['param', 'refId', 'kind', 'refType', 'snapshotId', 'viewId', 'viewInstanceId']) ||
        source.param !== param || source.refId !== raw[param] || source.kind !== 'snapshot-value' ||
        !text(source.refType) || !source.refType.trim() || source.snapshotId !== message.snapshotId ||
        source.viewId !== message.target.viewId || source.viewInstanceId !== message.target.viewInstanceId) return invalid();
    if (Object.hasOwn(declaration, 'refType') && declaration.refType !== source.refType) {
        return refV1Failure('REF_TYPE_MISMATCH', 'Ref type does not match the declared requirement');
    }
    try {
        captureRefV1Json({ source: { appId: message.appId, instanceId: message.instanceId,
            snapshotId: message.snapshotId, toolId: message.tool.id, viewId: message.target.viewId,
            viewInstanceId: message.target.viewInstanceId, bindingVersion: message.target.bindingVersion },
        effectiveArgs: effective, refSources: sources }, SNAPSHOT_VALUE_ENVELOPE_LIMITS);
    } catch { return refV1Failure('REF_ARGUMENT_BUDGET_EXCEEDED', 'Ref source envelope exceeds the budget'); }
    return { success: true };
}

export function captureRefV1Terminal(input: unknown, expected: Readonly<{ requestId: string; appId: string; instanceId: string }>): RefV1Terminal | null {
    return captureInvocationTerminal(input, expected, 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', REF_V1_MODE);
}

/** Correlate a rejection even when the complete message cannot be copied. No getters. */
export function refV1Rejection(input: unknown, result: OperationResult): ViewToolInvokeRefV1Response | null {
    return refV1Response(input, { phase: 'not-entered', result });
}

/** Capture and validate the complete terminal. Invalid/oversized business output is unknown. */
export function refV1Response(input: unknown, terminal: RefV1Terminal): ViewToolInvokeRefV1Response | null {
    try {
        if (!refV1Object(input)) return null;
        const header: Record<string, unknown> = {};
        for (const key of ['requestId', 'appId', 'instanceId']) {
            const field = Object.getOwnPropertyDescriptor(input, key);
            if (!field || !('value' in field) || !text(field.value)) return null;
            header[key] = field.value;
        }
        const response = captureRefV1Json({ ...header, type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', argumentMode: REF_V1_MODE,
            success: true, terminal });
        return captureRefV1Terminal(response, header as { requestId: string; appId: string; instanceId: string })
            ? response as unknown as ViewToolInvokeRefV1Response : null;
    } catch { return null; }
}
