import { validateCapturedTypeParameters as validateInvocationParameters } from '../../tests/fixtures/type-parameters.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@aotui/core/internal';
import { RAW_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ENVELOPE_LIMITS, TOOL_REQUEST_LIMITS } from '@aotui/core/internal';
import { compileToolParameters } from '@aotui/core';
import { captureToolInvocation, toolInvocationResponse } from './tool-invocation.js';
import { captureToolInvocationTerminal } from './worker-message-capture.js';
function fixture() {
    const c = compileToolParameters({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } }, choice: { type: 'string', enum: ['ok'] } }, required: ['file'], additionalProperties: false });
    if (!c.ok) throw Error('fixture');
    const receiver = { viewId: 'v', viewInstanceId: 'mount', activationId: 'active-1' };
    return { type: 'VIEW_TOOL_INVOKE', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', observationId: 'obs', receiver,
        tool: { multiplicity: 'multiple', id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: JSON.parse(JSON.stringify(c.contract.schema)) },
        rawArgs: { file: '$app.v.id', choice: 'ok' },
        refSources: [{ param: 'file', address: '$app.v.id', refId: 'id', path: [], kind: 'snapshot-value',
            scope: 'private', refType: 'unknown', appId: 'app', instanceId: 'run', snapshotId: 'source',
            observationId: 'obs', viewId: 'v', viewInstanceId: 'mount',
            consumerInstanceId: 'run', consumerObservationId: 'obs',
            consumerViewInstanceId: 'mount', consumerActivationId: 'active-1', value: { opaque: true } }] };
}
describe('Ref Tool message capture and argument validation', () => {
    it('retains the original schema and source while checking both complete argument stages', () => {
        const input = fixture(), before = canonicalJson(input as any), message = captureToolInvocation(input);
        expect(validateInvocationParameters(message)).toMatchObject({ status: 'prepared', effectiveArgs: { file: { opaque: true }, choice: 'ok' } });
        expect(canonicalJson(input as any)).toBe(before);expect(message.tool.inputSchema).toEqual(input.tool.inputSchema);
    });
    it.each(['extra-field', 'type', 'tool', 'receiver', 'extra', 'getter', 'oversize'])('rejects malformed request %s before projection', kind => {
        let reads = 0;const m: any = fixture();
        if (kind === 'extra-field') m.unexpected = true;if (kind === 'type') m.type = 'VIEW_TOOL_INVOKE_REF_V1';
        if (kind === 'tool') m.tool.unexpected = true;if (kind === 'receiver') m.receiver = { viewId: 'v', activationId: 'active-1' };
        if (kind === 'extra') m.extra = true;if (kind === 'oversize') m.tool.description = 'x'.repeat(TOOL_REQUEST_LIMITS.maxCanonicalBytes);
        if (kind === 'getter') Object.defineProperty(m, 'rawArgs', { enumerable: true, get() { reads++;return {}; } });
        expect(() => captureToolInvocation(m)).toThrow();expect(reads).toBe(0);
    });
    it.each(['ordinary', 'mismatch', 'source', 'obsolete-marker', 'expanded-budget'])('rejects %s at its proper seam', kind => {
        const m: any = fixture();
        if (kind === 'ordinary') m.rawArgs.choice = 7;
        if (kind === 'mismatch') m.refSources[0].consumerActivationId = 'other';if (kind === 'source') m.refSources[0].snapshotId = 'other';
        if (kind === 'obsolete-marker') m.tool.inputSchema['x-aotui-parameter-contract'] = 'view-type-parameters-v1';
        if (kind === 'expanded-budget') m.refSources[0].value = { list: Array(RESOLVED_TOOL_ENVELOPE_LIMITS.maxNodes).fill(null) };
        // Detached mutable JSON for mutation cases; the captured contract itself stays frozen.
        if (kind === 'expanded-budget') { expect(() => captureToolInvocation(m)).toThrow(); return; }
        const code = kind === 'obsolete-marker' ? 'REF_CONTRACT_UNSUPPORTED' : kind === 'ordinary' ? 'TOOL_INVALID_ARGS' : 'E_INVALID_ARGS';
        expect(validateInvocationParameters(captureToolInvocation(m))).toMatchObject({ status: 'rejected', issue: { code } });
    });
    it('correlates only exact new terminal type/mode/identity and preserves entered business failure', () => {
        const m = fixture(), terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'BUSINESS', message: 'Expected failure' } } };
        const response = toolInvocationResponse(m, terminal)!;expect(response.type).toBe('VIEW_TOOL_INVOKE_RESPONSE');
        expect(captureToolInvocationTerminal(response, m)).toEqual(terminal);
        for (const patch of [{ type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' }, { unexpected: true }, { requestId: 'other' }, { instanceId: 'other' }, { extra: true }])
            expect(captureToolInvocationTerminal({ ...response, ...patch }, m)).toBe(null);
        expect(toolInvocationResponse(m, { phase: 'entered-returned', result: { success: true, data: { value: 'x'.repeat(600000) } } })).toBe(null);
    });
    it('counts complete raw arguments and expanded source envelope before ordinary validation', () => {
        const raw: any = fixture();raw.rawArgs.choice = 'x'.repeat(RAW_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes);
        expect(() => captureToolInvocation(raw)).toThrow();
        const envelope = fixture();
        envelope.refSources[0]!.value = { opaque: true, value: 'a'.repeat(RESOLVED_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes) } as any;
        expect(validateInvocationParameters(captureToolInvocation(envelope))).toMatchObject({
            status: 'rejected', issue: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED' },
        });
    });
    it('rejects malformed source metadata and key correspondence without needing a V1 projection', () => {
        const extra: any = fixture();extra.refSources[0].untrusted = true;
        expect(validateInvocationParameters(captureToolInvocation(extra)).issue?.code).toBe('E_INVALID_ARGS');
        const missing: any = fixture();delete missing.refSources[0].viewInstanceId;
        expect(validateInvocationParameters(captureToolInvocation(missing)).issue?.code).toBe('E_INVALID_ARGS');
        const key = { ...fixture(), effectiveArgs: { other: true } };
        expect(() => captureToolInvocation(key)).toThrow('Invalid Tool invocation');
    });
});
