import { describe, expect, it } from 'vitest';
import { captureInvocationJson, captureToolInvocationTerminal, exact, invocationObject, text } from './worker-message-capture.js';

describe('bounded Worker message capture', () => {
    it('captures detached frozen JSON without invoking accessors and enforces the canonical byte ceiling', () => {
        let reads = 0;
        const unsafe = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 'x'; } });
        expect(() => captureInvocationJson(unsafe)).toThrow();
        expect(reads).toBe(0);

        const captured = captureInvocationJson({ value: 'ok' });
        expect(captured).toEqual({ value: 'ok' });
        expect(captured).not.toBe(unsafe);
        expect(Object.isFrozen(captured)).toBe(true);
        expect(() => captureInvocationJson({ value: 'x'.repeat(512 * 1024) })).toThrow();
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
