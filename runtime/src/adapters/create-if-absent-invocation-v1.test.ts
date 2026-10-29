import { describe, it, expect } from 'vitest';
import {
  captureCreateIfAbsentV1Terminal,
  createIfAbsentV1Response,
} from './create-if-absent-invocation-v1.js';
const header = { requestId: 'r', appId: 'a', instanceId: 'i' };
describe('W06 bounded creation terminal', () => {
  it.each(['succeeded', 'none', 'partial', 'unknown', 'rejected'])('preserves %s', (kind) => {
    const terminal: any =
      kind === 'rejected'
        ? { phase: 'not-entered', outcome: { status: 'rejected', code: 'NO', message: 'No entry' } }
        : {
            phase: 'entered-returned',
            outcome:
              kind === 'succeeded'
                ? { status: 'succeeded', value: { filePath: '/a', bytesWritten: 0 } }
                : kind === 'unknown'
                  ? { status: 'unknown', code: 'UNKNOWN', message: 'Unknown' }
                  : { status: 'failed', code: 'FAIL', message: 'Failure', effects: kind },
          };
    expect(
      captureCreateIfAbsentV1Terminal(createIfAbsentV1Response(header, terminal), header)
    ).toEqual(terminal);
  });
  it.each([
    'accepted',
    'entered-rejected',
    'not-entered-success',
    'wrong-type',
    'wrong-mode',
    'wrong-id',
    'wrong-instance',
    'getter',
    'symbol',
    'oversize',
    'extra',
    'bad-effects',
  ])('refuses %s', (kind) => {
    const m: any = {
      ...header,
      type: 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE',
      argumentMode: 'create-if-absent-v1',
      success: true,
      terminal: { phase: 'entered-returned', outcome: { status: 'succeeded', value: {} } },
    };
    if (kind === 'accepted') m.terminal.outcome = { status: 'accepted', operationId: 'operation' };
    if (kind === 'entered-rejected')
      m.terminal.outcome = { status: 'rejected', code: 'NO', message: 'No' };
    if (kind === 'not-entered-success') m.terminal.phase = 'not-entered';
    if (kind === 'wrong-type') m.type = 'VIEW_TOOL_INVOKE_ORDINARY_V1_RESPONSE';
    if (kind === 'wrong-mode') m.argumentMode = 'ordinary-v1';
    if (kind === 'wrong-id') m.requestId = 'other';
    if (kind === 'wrong-instance') m.instanceId = 'other';
    if (kind === 'getter')
      Object.defineProperty(m.terminal, 'outcome', {
        enumerable: true,
        get() {
          throw Error('private');
        },
      });
    if (kind === 'symbol') m[Symbol()] = 1;
    if (kind === 'oversize') m.terminal.outcome.value = { content: 'x'.repeat(524288) };
    if (kind === 'extra') m.terminal.condition = 'absent';
    if (kind === 'bad-effects')
      m.terminal.outcome = { status: 'failed', code: 'NO', message: 'No', effects: 'unknown' };
    expect(captureCreateIfAbsentV1Terminal(m, header)).toBeNull();
  });
});
