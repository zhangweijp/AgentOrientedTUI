import { captureRefV2Request, refV2Failure, refV2Response, validateRefV2Arguments } from '../adapters/ref-invocation-v2.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../core/snapshot/types.js';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

export async function invokeRefInvocationV2(input: unknown, context: Readonly<{
    appId: string; instanceId: string; negotiated: boolean;
    validateBinding?: (tool: ToolDescriptorV2, target: ToolTargetV2) => OperationResult;
    validateWrapper?: (tool: ToolDescriptorV2, target: ToolTargetV2) => OperationResult;
    invokeBinding?: (tool: ToolDescriptorV2, target: ToolTargetV2, args: Readonly<Record<string, unknown>>) =>
        ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal>;
}>) {
    let message;
    let result: OperationResult;
    try {
        message = captureRefV2Request(input);
        if (!context.negotiated) result = refV2Failure('REF_EXECUTION_UNAVAILABLE', 'Current Worker has no negotiated Ref V2 capability');
        else if (message.appId !== context.appId || message.instanceId !== context.instanceId)
            result = refV2Failure('APP_INSTANCE_MISMATCH', 'Ref request is from another App instance');
        else if (!context.validateBinding || !context.validateWrapper || !context.invokeBinding)
            result = refV2Failure('REF_EXECUTION_UNAVAILABLE', 'Current App has no safe Ref V2 registry');
        else if (message.tool.isMutating) result = refV2Failure('TOOL_PERMISSION_DENIED', 'Ref V2 requires a read-only Tool');
        else {
            result = context.validateBinding(message.tool, message.target);
            if (result.success) result = validateRefV2Arguments(message);
            if (result.success) result = context.validateWrapper(message.tool, message.target);
            if (result.success) {
                // Final live/private qualification and safe callable entry are synchronous.
                try { return refV2Response(message, await context.invokeBinding(message.tool, message.target, message.effectiveArgs)); }
                catch { return null; }
            }
        }
    } catch { result = refV2Failure('OPERATION_INVALID_ARGS', 'Expected a bounded Ref V2 request'); }
    return refV2Response(message ?? input, { phase: 'not-entered', result });
}
