import { compileToolParameters } from '@aotui/core';
import { validateInvocationParameters } from '../../src/adapters/tool-invocation.js';
import type { ViewToolInvokeMessage } from '../../src/spi/worker-protocol/messages.js';

/** Detached wire fixtures compile their own declaration; production uses the live registration. */
export function validateCapturedTypeParameters(message: ViewToolInvokeMessage) {
    const compiled = compileToolParameters(message.tool.inputSchema);
    return validateInvocationParameters(message, compiled.ok ? compiled.contract : undefined);
}
