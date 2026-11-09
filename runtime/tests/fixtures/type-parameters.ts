import { compileOrdinaryProfile } from '../../src/core/tool/ordinary-parameter-profile.js';
import { validateTypeParameters } from '../../src/adapters/ordinary-invocation-v2.js';
import type { ViewToolInvokeV4Message } from '../../src/spi/worker-protocol/messages.js';

/** Detached wire fixtures compile their own declaration; production uses the live registration. */
export function validateCapturedTypeParameters(message: ViewToolInvokeV4Message) {
    return validateTypeParameters(message, compileOrdinaryProfile(message.tool.inputSchema));
}
