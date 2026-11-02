import { describe, expect, it } from 'vitest';
import { captureInvocationJson, captureInvocationTerminal, captureWorkerCapabilities, exact, invocationObject, text } from './worker-message-capture.js';

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
            type: 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE', requestId: 'r', appId: 'a', instanceId: 'i',
            argumentMode: 'ordinary-v2', success: true,
            terminal: { phase: 'entered-returned', result: { success: true, data: {} } },
        };
        expect(captureInvocationTerminal(response, expected, response.type, 'ordinary-v2')).toEqual(response.terminal);
        expect(captureInvocationTerminal({ ...response, requestId: 'other' }, expected, response.type, 'ordinary-v2')).toBeNull();
        expect(captureInvocationTerminal({ ...response, extra: true }, expected, response.type, 'ordinary-v2')).toBeNull();
        expect(invocationObject(response)).toBe(true);
        expect(exact(response, ['type', 'requestId', 'appId', 'instanceId', 'argumentMode', 'success', 'terminal'])).toBe(true);
        expect(text('x')).toBe(true);
        expect(text('')).toBe(false);
    });

    it('bounds the negotiated capability list and rejects duplicates and accessors', () => {
        expect(captureWorkerCapabilities(undefined)).toEqual([]);
        expect(captureWorkerCapabilities(['ordinary-v2', 'snapshot-value-v2'])).toEqual(['ordinary-v2', 'snapshot-value-v2']);
        expect(captureWorkerCapabilities(['ordinary-v2', 'ordinary-v2'])).toBeNull();
        expect(captureWorkerCapabilities(['ordinary-v2', 'snapshot-value-v2', 'future'])).toBeNull();
        let reads = 0;
        const accessor = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return 'ordinary-v2'; } });
        expect(captureWorkerCapabilities(accessor)).toBeNull();
        expect(reads).toBe(0);
    });
});
