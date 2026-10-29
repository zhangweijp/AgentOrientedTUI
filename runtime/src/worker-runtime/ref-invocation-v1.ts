import { captureRefV1Request, refV1Failure, refV1Rejection, refV1Response, REF_V1_MODE, validateRefV1Arguments } from '../adapters/ref-invocation-v1.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../core/snapshot/types.js';
import type { RefV1Terminal } from '../spi/worker-protocol/messages.js';

/** No yield between correspondence/live checks and the registry's safe entry point. */
export async function invokeRefInvocationV1(input: unknown, context: Readonly<{
    appId: string; instanceId: string; negotiated: boolean;
    validateBinding?: (tool: ToolDescriptorV2, target: ToolTargetV2) => OperationResult;
    validateWrapper?: (tool: ToolDescriptorV2, target: ToolTargetV2) => OperationResult;
    invokeBinding?: (tool: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>) => RefV1Terminal | Promise<RefV1Terminal>;
}>) {
    let message;
    let result: OperationResult;
    try {
        message = captureRefV1Request(input);
        if (message.argumentMode !== REF_V1_MODE || !context.negotiated) {
            result = refV1Failure('REF_EXECUTION_UNAVAILABLE', 'Current Worker has no negotiated Ref capability');
        } else if (message.appId !== context.appId || message.instanceId !== context.instanceId) {
            result = refV1Failure('APP_INSTANCE_MISMATCH', 'Ref request is from another App instance');
        } else if (!context.validateBinding || !context.validateWrapper || !context.invokeBinding) {
            result = refV1Failure('REF_EXECUTION_UNAVAILABLE', 'Current App has no safe Ref registry');
        } else if (message.tool.isMutating) {
            result = refV1Failure('TOOL_PERMISSION_DENIED', 'Ref protocol only supports read-only Tools');
        } else {
            result = context.validateBinding(message.tool, message.target);
            if (result.success) result = validateRefV1Arguments(message);
            if (result.success) result = context.validateWrapper(message.tool, message.target);
            if (result.success) {
                // Once the safe callable is invoked, an exception cannot prove non-entry.
                try {
                    const terminal = await context.invokeBinding(message.tool, message.target, message.effectiveArgs);
                    return refV1Response(message, terminal);
                } catch { return null; }
            }
        }
    } catch {
        result = refV1Failure('OPERATION_INVALID_ARGS', 'Expected a bounded, consistent Ref request');
    }
    return refV1Rejection(message ?? input, result);
}
