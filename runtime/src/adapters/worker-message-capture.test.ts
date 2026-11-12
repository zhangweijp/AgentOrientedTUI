import { describe, expect, it } from 'vitest';
import { captureInvocationJson, captureTypeParametersTerminal, captureViewToolCapabilities, exact, invocationObject, text } from './worker-message-capture.js';
import { PARAMETERS_V4_CAPABILITY, SNAPSHOT_CAPABILITY } from '../spi/worker-protocol/types.js';

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
            type: 'VIEW_TOOL_INVOKE_V4_RESPONSE', requestId: 'r', appId: 'a', instanceId: 'i',
            argumentMode: 'view-type-parameters-v1', success: true,
            terminal: { phase: 'entered-returned', result: { success: true, data: {} } },
        };
        expect(captureTypeParametersTerminal(response, expected)).toEqual(response.terminal);
        expect(captureTypeParametersTerminal({ ...response, requestId: 'other' }, expected)).toBeNull();
        expect(captureTypeParametersTerminal({ ...response, extra: true }, expected)).toBeNull();
        expect(invocationObject(response)).toBe(true);
        expect(exact(response, ['type', 'requestId', 'appId', 'instanceId', 'argumentMode', 'success', 'terminal'])).toBe(true);
        expect(text('x')).toBe(true);
        expect(text('')).toBe(false);
    });

    it('bounds the negotiated capability list and rejects duplicates and accessors', () => {
        const invalid = { ok: false, code: 'WORKER_CAPABILITY_INVALID' };
        expect(captureViewToolCapabilities([SNAPSHOT_CAPABILITY, SNAPSHOT_CAPABILITY])).toEqual(invalid);
        expect(captureViewToolCapabilities([SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY, 'future/v9'])).toEqual(invalid);
        expect(captureViewToolCapabilities({})).toEqual(invalid);
        let reads = 0;
        const accessor = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return SNAPSHOT_CAPABILITY; } });
        expect(captureViewToolCapabilities(accessor)).toEqual(invalid);
        expect(reads).toBe(0);
    });

    it('accepts the current capabilities and rejects unsupported capability names uniformly', () => {
        for (const capabilities of [[], [SNAPSHOT_CAPABILITY], [SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY]]) {
            expect(captureViewToolCapabilities(capabilities)).toEqual({ ok: true, capabilities });
        }
        expect(captureViewToolCapabilities(undefined)).toEqual({ ok: true, capabilities: [] });
        for (const capability of ['view-tool-ordinary-invoke/v2', 'view-tool-ref-invoke/v2', 'view-tool-ref-invoke/v3', 'future/v9']) {
            expect(captureViewToolCapabilities([capability])).toEqual({ ok: false, code: 'WORKER_CAPABILITY_UNSUPPORTED' });
        }
    });
});
