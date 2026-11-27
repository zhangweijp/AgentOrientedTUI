import { expect, it } from 'vitest';
import { TOOL_REQUEST_LIMITS } from '@aotui/core/producer';
import { checkWireJson, utf8Size } from '@aotui/core';
import { captureToolInvocation, toolInvocationResponse } from './tool-invocation.js';
import { captureToolInvocationTerminal } from './worker-message-capture.js';

const receiver = { viewId: 'file', viewInstanceId: 'mount', activationId: 'entry' };
const source = { requestId: 'op', appId: 'app', instanceId: 'run' };
const packet = () => ({ ...source, type: 'VIEW_TOOL_INVOKE', receiver: { ...receiver },
    tool: { id: 'tool', name: 'write', viewType: 'file' },
    effectiveArgs: { lines: [{ value: '中文\n' }] },
    localRefs: [{ param: 'lines', index: 0, refId: 'line', viewId: 'file', viewInstanceId: 'mount', since: 1 }],
});

it('checks and freezes the received transport copy without replacing it', () => {
    const original = packet();
    const received = structuredClone(original);
    const captured = captureToolInvocation(received);
    expect(captured).toBe(received);
    expect(Object.isFrozen(captured.effectiveArgs)).toBe(true);
    expect(Object.isFrozen(received.effectiveArgs.lines[0])).toBe(true);
    expect(Object.isFrozen(original.effectiveArgs.lines[0])).toBe(false);
});
it.each(['protocol', 'old-raw-arguments', 'foreign-source-record', 'bad-index', 'unexpected-field'])(
    'rejects the incompatible or malformed %s before dispatch', mode => {
        const input: any = packet();
        if (mode === 'protocol') input.type = 'VIEW_TOOL_INVOKE_V3';
        if (mode === 'old-raw-arguments') input.rawArgs = input.effectiveArgs;
        if (mode === 'foreign-source-record') input.localRefs[0].appId = 'another';
        if (mode === 'bad-index') input.localRefs[0].index = 10;
        if (mode === 'unexpected-field') input.tool.inputSchema = {};
        expect(() => captureToolInvocation(input)).toThrow();
    });
it('enforces the exact byte size of the complete escaped Worker envelope', () => {
    const input = packet();
    input.effectiveArgs.lines[0]!.value = '\\"中\n'.repeat(100);
    const exact = utf8Size(JSON.stringify(input));
    expect(() => checkWireJson(input, { ...TOOL_REQUEST_LIMITS, maxCanonicalBytes: exact })).not.toThrow();
    expect(() => checkWireJson(input, { ...TOOL_REQUEST_LIMITS, maxCanonicalBytes: exact - 1 })).toThrow(/Encoded JSON/);
    const over = packet();
    over.effectiveArgs.lines[0]!.value = '\n'.repeat(TOOL_REQUEST_LIMITS.maxCanonicalBytes / 2);
    expect(() => captureToolInvocation(over)).toThrow(/Encoded JSON/);
});
it('keeps the original business fact and excludes wrong or malformed terminal identities', () => {
    const data = { text: 'wrote once' };
    const terminal = { phase: 'entered-returned', result: { success: true, data } } as const;
    const output = toolInvocationResponse(packet(), terminal);
    expect(Object.isFrozen(data)).toBe(false);
    expect(captureToolInvocationTerminal(structuredClone(output), source)).toEqual(terminal);
    expect(captureToolInvocationTerminal(structuredClone(output), { ...source, instanceId: 'new-run' })).toBeNull();
    expect(captureToolInvocationTerminal({ ...output, terminal: { phase: 'not-entered', result: { success: true } } }, source)).toBeNull();
});
