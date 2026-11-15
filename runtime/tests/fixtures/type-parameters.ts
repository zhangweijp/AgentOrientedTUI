import { compileOrdinaryProfile } from '../../src/core/tool/ordinary-parameter-profile.js';
import { validateTypeParameters } from '../../src/adapters/ordinary-invocation-v2.js';
import type { ViewToolInvokeV5Message } from '../../src/spi/worker-protocol/messages.js';

/** Detached wire fixtures compile their own declaration; production uses the live registration. */
export function validateCapturedTypeParameters(message: ViewToolInvokeV5Message) {
    return validateTypeParameters(message, compileOrdinaryProfile(message.tool.inputSchema));
}
