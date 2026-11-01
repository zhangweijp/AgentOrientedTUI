import { canonicalJson, copyJson } from '../core/snapshot/json.js';
import type { JsonValue } from '../core/snapshot/types.js';
import { compileSnapshotValueProfile } from '../core/tool/snapshot-value-parameter-contract.js';
import { SNAPSHOT_VALUE_ARGUMENT_LIMITS, SNAPSHOT_VALUE_ENVELOPE_LIMITS } from '../core/tool/snapshot-value-arguments.js';
import { captureInvocationJson, captureInvocationTerminal, exact, invocationObject, invocationTarget, text } from './worker-message-capture.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ViewToolInvokeRefV2Message, ViewToolInvokeRefV2Response, ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

export const REF_V2_MODE = 'snapshot-value-v2';
export const REF_V2_CAPABILITY = 'view-tool-ref-invoke/v2';
export const refV2Failure = (code: string, message: string): OperationResult => ({ success: false, error: { code, message } });
const refSourceKeys = ['param', 'refId', 'kind', 'refType', 'snapshotId', 'viewId', 'viewInstanceId'] as const;

export function captureRefV2Request(input: unknown): ViewToolInvokeRefV2Message {
    const value = captureInvocationJson(input);
    if (!invocationObject(value) || !exact(value, ['type', 'requestId', 'appId', 'instanceId', 'snapshotId',
        'tool', 'target', 'argumentMode', 'rawArgs', 'effectiveArgs', 'refSources']) ||
        value.type !== 'VIEW_TOOL_INVOKE_REF_V2' || value.argumentMode !== REF_V2_MODE ||
        !['requestId', 'appId', 'instanceId', 'snapshotId'].every(key => text(value[key])) ||
        !invocationObject(value.tool) || !exact(value.tool, ['id', 'name', 'viewType', 'description', 'inputSchema', 'isMutating', 'targets']) ||
        !['id', 'name', 'viewType', 'description'].every(key => text((value.tool as Record<string, unknown>)[key])) ||
        typeof value.tool.isMutating !== 'boolean' || !invocationObject(value.tool.inputSchema) ||
        value.tool.inputSchema.type !== 'object' || !Array.isArray(value.tool.targets) || !value.tool.targets.every(invocationTarget) ||
        !invocationTarget(value.target) || !invocationObject(value.rawArgs) || !invocationObject(value.effectiveArgs) ||
        !Array.isArray(value.refSources)) throw new Error('Invalid Ref V2 request');
    copyJson({ name: value.tool.name, description: value.tool.description,
        inputSchema: value.tool.inputSchema, isMutating: value.tool.isMutating },
    { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 });
    return value as unknown as ViewToolInvokeRefV2Message;
}
/** Captured request only. The projection is private to pure validation, never a source/binding or sent message. */
export function validateRefV2Arguments(message: ViewToolInvokeRefV2Message): OperationResult {
    const compiled = compileSnapshotValueProfile(message.tool.inputSchema);
    if (!compiled.ok) return refV2Failure(compiled.issue.code === 'PARAMETER_DECLARATION_UNSUPPORTED'
        ? 'REF_CONTRACT_UNSUPPORTED' : 'REF_DECLARATION_INVALID', 'Expected an exact snapshot-value parameter profile');
    if (message.tool.isMutating) return refV2Failure('TOOL_PERMISSION_DENIED', 'Ref V2 requires a read-only Tool');
    let rawArgs: Readonly<Record<string, JsonValue>>;
    let effectiveArgs: Readonly<Record<string, JsonValue>>;
    try {
        const raw = captureInvocationJson(message.rawArgs, SNAPSHOT_VALUE_ARGUMENT_LIMITS);
        if (!invocationObject(raw)) return refV2Failure('OPERATION_INVALID_ARGS', 'Expected bounded Ref arguments');
        rawArgs = raw;
    } catch { return refV2Failure('OPERATION_INVALID_ARGS', 'Expected bounded Ref arguments'); }
    try {
        const effective = captureInvocationJson(message.effectiveArgs, SNAPSHOT_VALUE_ARGUMENT_LIMITS);
        if (!invocationObject(effective)) return refV2Failure('REF_ARGUMENT_BUDGET_EXCEEDED', 'Effective Ref arguments exceed the budget');
        effectiveArgs = effective;
    } catch { return refV2Failure('REF_ARGUMENT_BUDGET_EXCEEDED', 'Effective Ref arguments exceed the budget'); }

    const { param, refType } = compiled.contract.ref;
    const rawRefId = rawArgs[param];
    if (!text(rawRefId) || !invocationObject(effectiveArgs[param]) ||
        Object.keys(rawArgs).length !== Object.keys(effectiveArgs).length ||
        Object.keys(rawArgs).some(key => !Object.hasOwn(effectiveArgs, key) ||
            key !== param && canonicalJson(rawArgs[key]!) !== canonicalJson(effectiveArgs[key]!))) {
        return refV2Failure('OPERATION_INVALID_ARGS', 'Ref arguments and source metadata are inconsistent');
    }
    const [source] = message.refSources;
    if (message.refSources.length !== 1 || !invocationObject(source) || !exact(source, refSourceKeys) ||
        source.param !== param || source.refId !== rawRefId || source.kind !== 'snapshot-value' ||
        !text(source.refType) || !source.refType.trim() || source.snapshotId !== message.snapshotId ||
        source.viewId !== message.target.viewId || source.viewInstanceId !== message.target.viewInstanceId) {
        return refV2Failure('OPERATION_INVALID_ARGS', 'Ref arguments and source metadata are inconsistent');
    }
    if (refType !== undefined && refType !== source.refType) return refV2Failure('REF_TYPE_MISMATCH', 'Ref type does not match the declared requirement');
    try {
        captureInvocationJson({ source: { appId: message.appId, instanceId: message.instanceId,
            snapshotId: message.snapshotId, toolId: message.tool.id, viewId: message.target.viewId,
            viewInstanceId: message.target.viewInstanceId, bindingVersion: message.target.bindingVersion },
        effectiveArgs, refSources: message.refSources }, SNAPSHOT_VALUE_ENVELOPE_LIMITS);
    } catch { return refV2Failure('REF_ARGUMENT_BUDGET_EXCEEDED', 'Ref source envelope exceeds the budget'); }
    for (const checked of [compiled.contract.validateRaw(message.rawArgs), compiled.contract.validateEffective(message.effectiveArgs)]) {
        if (!checked.ok) return { success: false, error: { code: 'E_INVALID_ARGS', message: 'Expected valid snapshot-value parameters',
            context: { diagnostics: checked.diagnostics } } };
    }
    return { success: true };
}
export function captureRefV2Terminal(input: unknown, expected: Readonly<{ requestId: string; appId: string; instanceId: string }>) {
    return captureInvocationTerminal(input, expected, 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE', REF_V2_MODE);
}
export function refV2Response(input: unknown, terminal: ViewToolInvocationTerminal): ViewToolInvokeRefV2Response | null {
    try {
        if (!invocationObject(input)) return null;
        const header: Record<string, string> = {};
        for (const key of ['requestId', 'appId', 'instanceId']) {
            const field = Object.getOwnPropertyDescriptor(input, key);
            if (!field || !('value' in field) || !text(field.value)) return null;
            header[key] = field.value;
        }
        const response = captureInvocationJson({ ...header, type: 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE',
            argumentMode: REF_V2_MODE, success: true, terminal });
        return captureRefV2Terminal(response, header as { requestId: string; appId: string; instanceId: string })
            ? response as unknown as ViewToolInvokeRefV2Response : null;
    } catch { return null; }
}
