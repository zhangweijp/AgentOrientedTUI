import { describe, it, expect } from 'vitest';
import { ordinaryV1Response, captureOrdinaryV1Terminal } from './ordinary-invocation-v1.js';
const header = { requestId: 'r', appId: 'a', instanceId: 'i' };
describe('ordinary bounded terminal grammar', () => {
  it.each(['', ' ', 'message'])('preserves R1 lexical error fields %j', (message) => {
    for (const phase of ['not-entered', 'entered-returned'] as const) {
      const terminal = {
        phase,
        result: {
          success: false,
          error: { code: ' ', message, context: { retained: true } },
          data: { retained: 0 },
        },
      };
      const r = ordinaryV1Response(header, terminal);
      expect(captureOrdinaryV1Terminal(r, header)).toEqual(terminal);
    }
  });
  it.each(['mode', 'type', 'id', 'instance', 'invalid', 'oversize', 'getter', 'symbol'])(
    'rejects %s without invented result',
    (kind) => {
      const response: any = {
        ...header,
        type: 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE',
        argumentMode: 'ordinary-v1',
        success: true,
        terminal: { phase: 'entered-returned', result: { success: true, data: {} } },
      };
      if (kind === 'mode') response.argumentMode = 'snapshot-value-v1';
      if (kind === 'type') response.type = 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE';
      if (kind === 'id') response.requestId = 'other';
      if (kind === 'instance') response.instanceId = 'other';
      if (kind === 'invalid') response.terminal.result.data = [];
      if (kind === 'oversize') response.terminal.result.data = { text: 'x'.repeat(524288) };
      if (kind === 'getter')
        Object.defineProperty(response.terminal.result, 'data', {
          enumerable: true,
          get() {
            throw Error('sentinel');
          },
        });
      if (kind === 'symbol') response[Symbol('hidden')] = 1;
      expect(captureOrdinaryV1Terminal(response, header)).toBeNull();
    }
  );
});
