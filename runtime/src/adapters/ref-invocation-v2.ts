import { compileSnapshotValueProfile } from '../core/tool/snapshot-value-parameter-contract.js';
import { ORDINARY_PARAMETER_MARKER } from '../core/tool/ordinary-parameter-profile.js';
import { captureInvocationJson, captureInvocationTerminal, exact, invocationObject } from './view-tool-invocation-v1.js';
import { captureRefV1Request, refV1Failure, refV1Response, validateRefV1Arguments } from './ref-invocation-v1.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ViewToolInvokeRefV2Message, ViewToolInvokeRefV2Response, ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

export const REF_V2_MODE = 'snapshot-value-v2';
export const REF_V2_CAPABILITY = 'view-tool-ref-invoke/v2';
export function captureRefV2Request(input: unknown): ViewToolInvokeRefV2Message {
    const value = captureInvocationJson(input);
    if (!invocationObject(value) || !exact(value, ['type', 'requestId', 'appId', 'instanceId', 'snapshotId',
        'tool', 'target', 'argumentMode', 'rawArgs', 'effectiveArgs', 'refSources']) ||
        value.type !== 'VIEW_TOOL_INVOKE_REF_V2' || value.argumentMode !== REF_V2_MODE) throw new Error('Invalid Ref V2 request');
    // Complete original Tool and whole message are captured before adapting the structural checker.
    captureRefV1Request({ ...value, type: 'VIEW_TOOL_INVOKE_REF_V1', argumentMode: 'snapshot-value-v1' });
    return value as unknown as ViewToolInvokeRefV2Message;
}
/** Captured request only. The projection is private to pure validation, never a source/binding or sent message. */
export function validateRefV2Arguments(message: ViewToolInvokeRefV2Message): OperationResult {
    const compiled = compileSnapshotValueProfile(message.tool.inputSchema);
    if (!compiled.ok) return refV1Failure(compiled.issue.code === 'PARAMETER_DECLARATION_UNSUPPORTED'
        ? 'REF_CONTRACT_UNSUPPORTED' : 'REF_DECLARATION_INVALID', 'Expected an exact snapshot-value parameter profile');
    if (message.tool.isMutating) return refV1Failure('TOOL_PERMISSION_DENIED', 'Ref V2 requires a read-only Tool');
    const schema = { ...compiled.contract.schema };
    delete schema[ORDINARY_PARAMETER_MARKER];
    const correspondence = validateRefV1Arguments({ ...message, type: 'VIEW_TOOL_INVOKE_REF_V1', argumentMode: 'snapshot-value-v1',
        tool: { ...message.tool, inputSchema: schema } });
    if (!correspondence.success) return correspondence;
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
    const response = refV1Response(input, terminal);
    return response ? captureInvocationJson({ ...response, type: 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE', argumentMode: REF_V2_MODE }) as unknown as ViewToolInvokeRefV2Response : null;
}
