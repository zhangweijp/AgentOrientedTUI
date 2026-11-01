import { describe, it, expect } from 'vitest';
import { compileOrdinaryParams } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import { captureOrdinaryV2Request, captureOrdinaryV2Terminal, ordinaryV2Response, validOrdinaryV2Arguments } from './ordinary-invocation-v2.js';
const header = { requestId: 'r', appId: 'a', instanceId: 'i' };
const fixture = () => {
  const c = compileOrdinaryParams({ q: { type: 'string', required: true, constraints: { maxLength: 1 } } }, { additionalProperties: false });
  if (!c.ok) throw Error('Fixture');
  const target = { viewId: 'aa', viewInstanceId: 'vi', bindingVersion: 1 };
  return { ...header, type: 'VIEW_TOOL_INVOKE_ORDINARY_V2', argumentMode: 'ordinary-v2', snapshotId: 's', args: { q: '😀' },
    tool: { id: 'tool', name: 'find', viewType: 'File', description: 'Find', isMutating: false, inputSchema: ordinaryParameterProfile(c.contract), targets: [target] }, target };
};
describe('R10 precise ordinary-v2 message grammar', () => {
  it('captures the canonical immutable request and terminal', () => {
    const input = fixture(), message = captureOrdinaryV2Request(input);
    expect(message).toEqual(input); expect(message).not.toBe(input); expect(Object.isFrozen(message.args)).toBe(true);
    expect(validOrdinaryV2Arguments(message)).toBe(true);
    const terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'BUSINESS', message: '', context: { value: 1 } } } };
    const response = ordinaryV2Response(header, terminal);
    expect(captureOrdinaryV2Terminal(response, header)).toEqual(terminal);
  });
  it.each(['type', 'mode', 'extra', 'missing', 'target', 'nonjson', 'argument-bytes', 'whole-bytes'])('rejects request %s', kind => {
    const message: any = fixture();
    if (kind === 'type') message.type = 'VIEW_TOOL_INVOKE_ORDINARY_V1';
    if (kind === 'mode') message.argumentMode = 'ordinary-v1';
    if (kind === 'extra') message.extra = true;
    if (kind === 'missing') delete message.snapshotId;
    if (kind === 'target') message.target = { ...message.target, extra: true };
    if (kind === 'nonjson') message.args.q = undefined;
    if (kind === 'argument-bytes') message.args.q = 'x'.repeat(128 * 1024);
    if (kind === 'whole-bytes') message.tool.description = 'x'.repeat(512 * 1024);
    expect(() => captureOrdinaryV2Request(message)).toThrow();
  });
  it('does not read getters and rejects non-B1 or mutated public profiles', () => {
    let reads = 0; const input = fixture();
    Object.defineProperty(input.args, 'q', { enumerable: true, get() { reads++; return 'x'; } });
    expect(() => captureOrdinaryV2Request(input)).toThrow(); expect(reads).toBe(0);
    const message: any = fixture(); message.tool.inputSchema = { ...message.tool.inputSchema, additionalProperties: true };
    expect(validOrdinaryV2Arguments(captureOrdinaryV2Request(message))).toBe(true); // Declared openness is valid; private qualification is separate.
    message.tool.inputSchema['x-aotui-parameter-contract'] = 'future';
    expect(validOrdinaryV2Arguments(captureOrdinaryV2Request(message))).toBe(false);
  });
  it.each(['type', 'mode', 'id', 'instance', 'extra', 'data', 'oversize', 'getter'])('rejects correlated terminal %s', kind => {
    const value: any = ordinaryV2Response(header, { phase: 'entered-returned', result: { success: true, data: {} } });
    const r: any = JSON.parse(JSON.stringify(value));
    if (kind === 'type') r.type = 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE';
    if (kind === 'mode') r.argumentMode = 'snapshot-value-v1';
    if (kind === 'id') r.requestId = 'other';
    if (kind === 'instance') r.instanceId = 'other';
    if (kind === 'extra') r.terminal.other = 1;
    if (kind === 'data') r.terminal.result.data = [];
    if (kind === 'oversize') r.terminal.result.data = { text: 'x'.repeat(512 * 1024) };
    if (kind === 'getter') Object.defineProperty(r.terminal.result, 'data', { enumerable: true, get() { throw Error('PRIVATE'); } });
    expect(captureOrdinaryV2Terminal(r, header)).toBeNull();
  });
  it('uses the same ordinary-v2 grammar for a genuinely mutating Tool', () => {
    const input = fixture(); input.tool.isMutating = true;
    const captured = captureOrdinaryV2Request(input);
    expect(captured.tool.isMutating).toBe(true); expect(validOrdinaryV2Arguments(captured)).toBe(true);
    expect(captured).not.toHaveProperty('resource'); expect(captured).not.toHaveProperty('resourceRefId');
  });
  it.each(['none', 'partial'] as const)('preserves application-declared %s failure effects', failureEffects => {
    const terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'APP_FAILED', message: 'Failed' } }, failureEffects };
    expect(captureOrdinaryV2Terminal(ordinaryV2Response(header, terminal), header)).toEqual(terminal);
  });
  it.each(['success', 'not-entered', 'invalid', 'raw-result'] as const)('rejects invalid effect placement: %s', kind => {
    const response: any = JSON.parse(JSON.stringify(ordinaryV2Response(header, { phase: 'entered-returned', result: { success: false } })));
    response.terminal.failureEffects = kind === 'invalid' ? 'all' : 'none';
    if (kind === 'success') response.terminal.result.success = true;
    if (kind === 'not-entered') response.terminal.phase = 'not-entered';
    if (kind === 'raw-result') { delete response.terminal.failureEffects; response.terminal.result.effects = 'none'; }
    expect(captureOrdinaryV2Terminal(response, header)).toBeNull();
  });

});
