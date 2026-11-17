import { validateCapturedTypeParameters as validateInvocationParameters } from '../../tests/fixtures/type-parameters.js';
import { describe, it, expect } from 'vitest';
import { compileToolParameters } from '../core/tool/tool-parameters.js';
import { RAW_TOOL_ARGUMENT_LIMITS, TOOL_REQUEST_LIMITS } from '../core/snapshot/snapshot-support.js';
import { captureToolInvocation, toolInvocationResponse } from './tool-invocation.js';
import { captureToolInvocationTerminal } from './worker-message-capture.js';
const header = { requestId: 'r', appId: 'a', instanceId: 'i' };
const fixture = () => {
  const c = compileToolParameters({ type: 'object', properties: { q: { type: 'string', maxLength: 1 } }, required: ['q'], additionalProperties: false });
  if (!c.ok) throw Error('Fixture');
  const receiver = { viewId: 'v', viewInstanceId: 'mount', activationId: 'activation' };
  return { ...header, type: 'VIEW_TOOL_INVOKE', snapshotId: 's', rawArgs: { q: '😀' }, effectiveArgs: { q: '😀' }, refSources: [], receiver,
    tool: { id: 'tool', name: 'find', viewType: 'File', description: 'Find', 
      inputSchema: c.contract.schema } };
};
describe('R10 precise qualified V6 message grammar', () => {
  it('captures the canonical immutable request and terminal', () => {
    const input = fixture(), message = captureToolInvocation(input);
    expect(message).toEqual(input); expect(message).not.toBe(input); expect(Object.isFrozen(message.rawArgs)).toBe(true);
    expect(validateInvocationParameters(message).success).toBe(true);
    const terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'BUSINESS', message: '', context: { value: 1 } } } };
    const response = toolInvocationResponse(header, terminal);
    expect(captureToolInvocationTerminal(response, header)).toEqual(terminal);
  });
  it.each(['type', 'retired-v4', 'extra-field', 'extra', 'missing', 'receiver', 'nonjson', 'argument-bytes', 'whole-bytes'])('rejects request %s', kind => {
    const message: any = fixture();
    if (kind === 'type') message.type = 'VIEW_TOOL_INVOKE_ORDINARY_V2';
    if (kind === 'retired-v4') message.type = 'VIEW_TOOL_INVOKE_V4';
    if (kind === 'extra-field') message.unexpected = true;
    if (kind === 'extra') message.extra = true;
    if (kind === 'missing') delete message.snapshotId;
    if (kind === 'receiver') message.receiver = { ...message.receiver, kind: 'view-type' };
    if (kind === 'nonjson') message.rawArgs.q = undefined;
    if (kind === 'argument-bytes') message.rawArgs.q = 'x'.repeat(RAW_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes);
    if (kind === 'whole-bytes') message.tool.description = 'x'.repeat(TOOL_REQUEST_LIMITS.maxCanonicalBytes);
    expect(() => captureToolInvocation(message)).toThrow();
  });
  it('does not read getters and rejects non-B1 or mutated public profiles', () => {
    let reads = 0; const input = fixture();
    Object.defineProperty(input.rawArgs, 'q', { enumerable: true, get() { reads++; return 'x'; } });
    expect(() => captureToolInvocation(input)).toThrow(); expect(reads).toBe(0);
    const message: any = fixture(); message.tool.inputSchema = { ...message.tool.inputSchema, additionalProperties: true };
    expect(validateInvocationParameters(captureToolInvocation(message)).success).toBe(true); // Declared openness is valid; private qualification is separate.
    message.tool.inputSchema['x-aotui-parameter-contract'] = 'future';
    expect(validateInvocationParameters(captureToolInvocation(message)).success).toBe(false);
  });
  it.each(['type', 'extra-field', 'id', 'instance', 'extra', 'data', 'oversize', 'getter'])('rejects correlated terminal %s', kind => {
    const value: any = toolInvocationResponse(header, { phase: 'entered-returned', result: { success: true, data: {} } });
    const r: any = JSON.parse(JSON.stringify(value));
    if (kind === 'type') r.type = 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE';
    if (kind === 'extra-field') r.unexpected = true;
    if (kind === 'id') r.requestId = 'other';
    if (kind === 'instance') r.instanceId = 'other';
    if (kind === 'extra') r.terminal.other = 1;
    if (kind === 'data') r.terminal.result.data = [];
    if (kind === 'oversize') r.terminal.result.data = { text: 'x'.repeat(512 * 1024) };
    if (kind === 'getter') Object.defineProperty(r.terminal.result, 'data', { enumerable: true, get() { throw Error('PRIVATE'); } });
    expect(captureToolInvocationTerminal(r, header)).toBeNull();
  });
  it('captures qualified Tool metadata without an effect classification', () => {
    const input = fixture();
    const captured = captureToolInvocation(input);
    expect(captured.tool).not.toHaveProperty('isMutating'); expect(validateInvocationParameters(captured).success).toBe(true);
    expect(captured).not.toHaveProperty('resource'); expect(captured).not.toHaveProperty('resourceRefId');
  });
  it.each(['retired-v4', 'terminal-field', 'result-field', 'getter'] as const)('rejects an incompatible response: %s', kind => {
    const response: any = JSON.parse(JSON.stringify(toolInvocationResponse(header, { phase: 'entered-returned', result: { success: false, error: { code: 'BUSINESS', message: 'Expected failure' } } })));
    let reads = 0;
    if (kind === 'retired-v4') response.type = 'VIEW_TOOL_INVOKE_V4_RESPONSE';
    if (kind === 'terminal-field') response.terminal.failureEffects = 'none';
    if (kind === 'result-field') response.terminal.result.effects = 'none';
    if (kind === 'getter') Object.defineProperty(response.terminal.result, 'effects', { enumerable: true, get() { reads++; return 'none'; } });
    expect(captureToolInvocationTerminal(response, header)).toBeNull();
    expect(reads).toBe(0);
  });

});
