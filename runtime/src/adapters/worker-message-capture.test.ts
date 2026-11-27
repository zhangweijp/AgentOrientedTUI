import { describe, expect, it } from 'vitest';
import { captureAppLifecycleAck } from './app-lifecycle-protocol.js';
import { captureToolInvocationTerminal, exact, invocationObject, text } from './worker-message-capture.js';

describe('bounded Worker message capture', () => {
    it('captures a detached frozen lifecycle acknowledgement within its own bounds', () => {
        const ack = { protocol: 'app-lifecycle-v3', instanceId: 'i' };
        let reads = 0;
        const unsafe = { ...ack, get instanceId() { reads++; return ack.instanceId; } };
        expect(captureAppLifecycleAck(unsafe, ack.instanceId)).toBeNull();
        expect(reads).toBe(0);

        const captured = captureAppLifecycleAck(ack, ack.instanceId);
        expect(captured).toEqual(ack);
        expect(captured).not.toBe(ack);
        expect(Object.isFrozen(captured)).toBe(true);
        const instanceId = '\n'.repeat(1024);
        expect(captureAppLifecycleAck({ ...ack, instanceId }, instanceId)).toBeNull();
    });

    it('accepts only an exact, identity-correlated bounded invocation terminal', () => {
        const expected = { requestId: 'r', appId: 'a', instanceId: 'i' };
        const response = {
            type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId: 'r', appId: 'a', instanceId: 'i',
            success: true,
            terminal: { phase: 'entered-returned', result: { success: true, data: {} } },
        };
        expect(captureToolInvocationTerminal(response, expected)).toEqual(response.terminal);
        expect(captureToolInvocationTerminal({ ...response, requestId: 'other' }, expected)).toBeNull();
        expect(captureToolInvocationTerminal({ ...response, extra: true }, expected)).toBeNull();
        expect(invocationObject(response)).toBe(true);
        expect(exact(response, ['type', 'requestId', 'appId', 'instanceId', 'success', 'terminal'])).toBe(true);
        expect(text('x')).toBe(true);
        expect(text('')).toBe(false);
    });
});
