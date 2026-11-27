import { checkWireJson, copyWireJson, isToolResultData } from '@aotui/core';
import { TOOL_REQUEST_LIMITS } from '@aotui/core/producer';
import { WORKER_MESSAGE_LIMITS, exact, invocationReceiver, invocationObject, text } from './worker-message-capture.js';
import type { ViewToolInvokeMessage, ViewToolInvokeResponse } from '../spi/worker-protocol/messages.js';

/** The transport already detached this message. Validate and freeze that received copy. */
export function captureToolInvocation(input: unknown): ViewToolInvokeMessage {
    checkWireJson(input, TOOL_REQUEST_LIMITS, true);
    if (!invocationObject(input) || !exact(input, ['type', 'requestId', 'appId', 'instanceId', 'tool',
        'receiver', 'effectiveArgs', 'localRefs']) || input.type !== 'VIEW_TOOL_INVOKE' ||
        !['requestId', 'appId', 'instanceId'].every(key => text(input[key])) ||
        !invocationObject(input.tool) || !exact(input.tool, ['id', 'name', 'viewType']) ||
        !['id', 'name', 'viewType'].every(key => text((input.tool as Record<string, unknown>)[key])) ||
        !invocationReceiver(input.receiver) || !invocationObject(input.effectiveArgs) || !Array.isArray(input.localRefs))
        throw new Error('Invalid Tool invocation');
    const args = input.effectiveArgs;
    const slots = new Set<string>();
    for (const ref of input.localRefs) {
        if (!invocationObject(ref) || !exact(ref, ['param', 'refId', 'viewId', 'viewInstanceId', 'since', ...(ref.index === undefined ? [] : ['index'])]) ||
            typeof ref.param !== 'string' || typeof ref.since !== 'number' || !Number.isSafeInteger(ref.since) || ref.since <= 0 || !text(ref.refId) || !text(ref.viewId) || !text(ref.viewInstanceId) || !Object.hasOwn(args, ref.param))
            throw new Error('Invalid local Ref source');
        if (ref.index !== undefined) {
            const items = args[ref.param];
            if (typeof ref.index !== 'number' || !Number.isSafeInteger(ref.index) || !Array.isArray(items) || !Object.hasOwn(items, ref.index))
                throw new Error('Invalid local Ref argument slot');
        }
        const slot = JSON.stringify([ref.param, ref.index]);
        if (slots.has(slot)) throw new Error('Duplicate local Ref argument slot');
        slots.add(slot);
    }
    return input as unknown as ViewToolInvokeMessage;
}

export function toolInvocationResponse(input: unknown, terminal: ViewToolInvokeResponse['terminal']): ViewToolInvokeResponse | null {
    if (!invocationObject(input)) return null;
    const { requestId, appId, instanceId } = input;
    if (!text(requestId) || !text(appId) || !text(instanceId)) return null;
    try {
        const response = copyWireJson({ requestId, appId, instanceId, type: 'VIEW_TOOL_INVOKE_RESPONSE', success: true, terminal },
            WORKER_MESSAGE_LIMITS) as unknown as ViewToolInvokeResponse;
        const owned = response.terminal;
        if (owned.phase === 'finished-unknown') return Object.keys(owned).length === 1 ? response : null;
        return Object.keys(owned).length === 2 && isToolResultData(owned.result) &&
            (owned.phase === 'entered-returned' || owned.phase === 'not-entered' && owned.result.success === false) ? response : null;
    } catch { return null; }
}
