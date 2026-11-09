import { validateCapturedTypeParameters as validateTypeParameters } from '../../tests/fixtures/type-parameters.js';
import { describe, it, expect } from 'vitest';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import { captureTypeParametersRequest, captureTypeParametersTerminal, typeParametersResponse } from './ordinary-invocation-v2.js';
const header = { requestId: 'r', appId: 'a', instanceId: 'i' };
const fixture = () => {
  const c = compileOrdinarySchema({ type: 'object', properties: { q: { type: 'string', maxLength: 1 } }, required: ['q'], additionalProperties: false }, 'view-type-parameters-v1');
  if (!c.ok) throw Error('Fixture');
  const execution = { kind: 'view-type' as const, activationId: 'activation' };
  return { ...header, type: 'VIEW_TOOL_INVOKE_V4', argumentMode: 'view-type-parameters-v1', snapshotId: 's', rawArgs: { q: '😀' }, effectiveArgs: { q: '😀' }, refSources: [], execution,
    tool: { id: 'tool', name: 'find', viewType: 'File', description: 'Find', 
      inputSchema: ordinaryParameterProfile(c.contract), execution } };
};
describe('R10 precise qualified V4 message grammar', () => {
  it('captures the canonical immutable request and terminal', () => {
    const input = fixture(), message = captureTypeParametersRequest(input);
    expect(message).toEqual(input); expect(message).not.toBe(input); expect(Object.isFrozen(message.rawArgs)).toBe(true);
    expect(validateTypeParameters(message).success).toBe(true);
    const terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'BUSINESS', message: '', context: { value: 1 } } } };
    const response = typeParametersResponse(header, terminal);
    expect(captureTypeParametersTerminal(response, header)).toEqual(terminal);
  });
  it.each(['type', 'mode', 'extra', 'missing', 'execution', 'nonjson', 'argument-bytes', 'whole-bytes'])('rejects request %s', kind => {
    const message: any = fixture();
    if (kind === 'type') message.type = 'VIEW_TOOL_INVOKE_ORDINARY_V2';
    if (kind === 'mode') message.argumentMode = 'ordinary-v1';
    if (kind === 'extra') message.extra = true;
    if (kind === 'missing') delete message.snapshotId;
    if (kind === 'execution') message.execution = { ...message.execution, activationId: 'stale' };
    if (kind === 'nonjson') message.rawArgs.q = undefined;
    if (kind === 'argument-bytes') message.rawArgs.q = 'x'.repeat(128 * 1024);
    if (kind === 'whole-bytes') message.tool.description = 'x'.repeat(512 * 1024);
    expect(() => captureTypeParametersRequest(message)).toThrow();
  });
  it('does not read getters and rejects non-B1 or mutated public profiles', () => {
    let reads = 0; const input = fixture();
    Object.defineProperty(input.rawArgs, 'q', { enumerable: true, get() { reads++; return 'x'; } });
    expect(() => captureTypeParametersRequest(input)).toThrow(); expect(reads).toBe(0);
    const message: any = fixture(); message.tool.inputSchema = { ...message.tool.inputSchema, additionalProperties: true };
    expect(validateTypeParameters(captureTypeParametersRequest(message)).success).toBe(true); // Declared openness is valid; private qualification is separate.
    message.tool.inputSchema['x-aotui-parameter-contract'] = 'future';
    expect(validateTypeParameters(captureTypeParametersRequest(message)).success).toBe(false);
  });
  it.each(['type', 'mode', 'id', 'instance', 'extra', 'data', 'oversize', 'getter'])('rejects correlated terminal %s', kind => {
    const value: any = typeParametersResponse(header, { phase: 'entered-returned', result: { success: true, data: {} } });
    const r: any = JSON.parse(JSON.stringify(value));
    if (kind === 'type') r.type = 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE';
    if (kind === 'mode') r.argumentMode = 'snapshot-value-v1';
    if (kind === 'id') r.requestId = 'other';
    if (kind === 'instance') r.instanceId = 'other';
    if (kind === 'extra') r.terminal.other = 1;
    if (kind === 'data') r.terminal.result.data = [];
    if (kind === 'oversize') r.terminal.result.data = { text: 'x'.repeat(512 * 1024) };
    if (kind === 'getter') Object.defineProperty(r.terminal.result, 'data', { enumerable: true, get() { throw Error('PRIVATE'); } });
    expect(captureTypeParametersTerminal(r, header)).toBeNull();
  });
  it('captures qualified Tool metadata without an effect classification', () => {
    const input = fixture();
    const captured = captureTypeParametersRequest(input);
    expect(captured.tool).not.toHaveProperty('isMutating'); expect(validateTypeParameters(captured).success).toBe(true);
    expect(captured).not.toHaveProperty('resource'); expect(captured).not.toHaveProperty('resourceRefId');
  });
  it.each(['none', 'partial'] as const)('preserves application-declared %s failure effects', failureEffects => {
    const terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'APP_FAILED', message: 'Failed' } }, failureEffects };
    expect(captureTypeParametersTerminal(typeParametersResponse(header, terminal), header)).toEqual(terminal);
  });
  it.each(['success', 'not-entered', 'invalid', 'raw-result'] as const)('rejects invalid effect placement: %s', kind => {
    const response: any = JSON.parse(JSON.stringify(typeParametersResponse(header, { phase: 'entered-returned', result: { success: false, error: { code: 'BUSINESS', message: 'Expected failure' } } })));
    response.terminal.failureEffects = kind === 'invalid' ? 'all' : 'none';
    if (kind === 'success') response.terminal.result.success = true;
    if (kind === 'not-entered') response.terminal.phase = 'not-entered';
    if (kind === 'raw-result') { delete response.terminal.failureEffects; response.terminal.result.effects = 'none'; }
    expect(captureTypeParametersTerminal(response, header)).toBeNull();
  });

});
