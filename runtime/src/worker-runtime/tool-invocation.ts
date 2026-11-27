import { captureToolInvocation, toolInvocationResponse } from '../adapters/tool-invocation.js';
import type { RefDescriptor, ToolResultData, ToolRoute, ViewToolReceiver } from '@aotui/core';
import { checkRefViews, refPath, scopeAllows, refLane } from '@aotui/core/producer';
import type { ViewToolInvocationTerminal, ViewToolInvokeResponse } from '../spi/worker-protocol/messages.js';

export async function invokeViewTool(input: unknown, context?: Readonly<{
    appId: string;
    instanceId: string;
    toolsEnabled: boolean;
    validateBinding: (tool: ToolRoute, receiver: ViewToolReceiver) => ToolResultData;
    isRefViewLive: (viewId: string, viewInstanceId: string) => boolean;
    refDescriptor: (viewId: string, viewInstanceId: string, refId: string) => Pick<RefDescriptor, "scope" | "continuity"> | undefined;
    invokeBinding: (tool: ToolRoute, receiver: ViewToolReceiver,
        args: Readonly<Record<string, unknown>>, capture: (terminal: ViewToolInvocationTerminal) => ViewToolInvokeResponse | null)
        => ViewToolInvokeResponse | null | Promise<ViewToolInvokeResponse | null>;
}>) {
    const failure = (code: string, message: string, path?: string): ToolResultData =>
        ({ success: false, error: { code, message, ...(path === undefined ? {} : { context: { path } }) } });
    const reject = (result: ToolResultData) => toolInvocationResponse(input, { phase: 'not-entered', result });
    let message: ReturnType<typeof captureToolInvocation>;
    try { message = captureToolInvocation(input); }
    catch { return reject(failure('E_INVALID_ARGS', 'Expected a bounded Tool invocation')); }
    if (!context?.toolsEnabled) return reject(failure('TOOL_EXECUTION_UNAVAILABLE', 'Tool execution is unavailable for this App'));
    if (message.appId !== context.appId || message.instanceId !== context.instanceId)
        return reject(failure('APP_INSTANCE_MISMATCH', 'Request is from another App instance'));
    const { tool, receiver, localRefs, effectiveArgs } = message;
    const live = context.validateBinding(tool, receiver);
    if (!live.success) return reject(live);
    const stale = checkRefViews(localRefs, context.isRefViewLive);
    if (stale) return reject(failure(stale.code, stale.message, stale.path));
    for (const ref of localRefs) {
        const liveRef = context.refDescriptor(ref.viewId, ref.viewInstanceId, ref.refId);
        if (!liveRef || !scopeAllows(liveRef.scope, ref.viewInstanceId, receiver.viewInstanceId) ||
            liveRef.continuity[refLane(ref.viewInstanceId, receiver.viewInstanceId, true)] !== ref.since) {
            return reject(failure('REF_NOT_VISIBLE', 'The publishing page no longer grants this Ref.', refPath(ref.param, ref.index)));
        }
    }
    try {
        const response = await context.invokeBinding(tool, receiver, effectiveArgs, terminal => toolInvocationResponse(message, terminal));
        if (response) return response;
    } catch { /* A thrown handler cannot establish whether an effect occurred. */ }
    return toolInvocationResponse(message, { phase: 'finished-unknown' });
}
