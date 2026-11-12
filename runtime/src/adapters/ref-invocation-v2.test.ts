import { validateCapturedTypeParameters as validateTypeParameters } from '../../tests/fixtures/type-parameters.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../core/snapshot/json.js';
import { RAW_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ENVELOPE_LIMITS, TOOL_REQUEST_LIMITS } from '../core/snapshot/snapshot-support.js';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import { captureTypeParametersRequest, typeParametersResponse } from './ordinary-invocation-v2.js';
import { captureTypeParametersTerminal } from './worker-message-capture.js';
function fixture() {
    const c = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } }, choice: { type: 'string', enum: ['ok'] } }, required: ['file'], additionalProperties: false }, 'view-type-parameters-v1');
    if (!c.ok) throw Error('fixture');
    const execution = { kind: 'view-type' as const, activationId: 'active-1' };
    return { type: 'VIEW_TOOL_INVOKE_V4', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', argumentMode: 'view-type-parameters-v1', execution,
        tool: { id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: JSON.parse(JSON.stringify(ordinaryParameterProfile(c.contract))), 
            execution },
        rawArgs: { file: 'v.id', choice: 'ok' }, effectiveArgs: { file: { opaque: true }, choice: 'ok' },
        refSources: [{ param: 'file', refId: 'id', kind: 'snapshot-value', refType: 'unknown', snapshotId: 'source', viewId: 'v', viewInstanceId: 'mount' }] };
}
describe('R03/R04 Ref V4 exact codec and pure correspondence projection', () => {
    it('retains the original profile and source while checking both complete argument stages', () => {
        const input = fixture(), before = canonicalJson(input as any), message = captureTypeParametersRequest(input);
        expect(validateTypeParameters(message)).toEqual({ success: true });
        expect(canonicalJson(input as any)).toBe(before);expect(message.tool.inputSchema).toEqual(input.tool.inputSchema);
        expect(message.tool.inputSchema).toHaveProperty('x-aotui-parameter-contract', 'view-type-parameters-v1');
    });
    it.each(['mode', 'type', 'tool', 'execution', 'extra', 'getter', 'oversize'])('rejects malformed request %s before projection', kind => {
        let reads = 0;const m: any = fixture();
        if (kind === 'mode') m.argumentMode = 'snapshot-value-v1';if (kind === 'type') m.type = 'VIEW_TOOL_INVOKE_REF_V1';
        if (kind === 'tool') m.tool.unexpected = true;if (kind === 'execution') m.execution = { kind: 'view-type', activationId: 'wrong-branch' };
        if (kind === 'extra') m.extra = true;if (kind === 'oversize') m.tool.description = 'x'.repeat(TOOL_REQUEST_LIMITS.maxCanonicalBytes);
        if (kind === 'getter') Object.defineProperty(m, 'rawArgs', { enumerable: true, get() { reads++;return {}; } });
        expect(() => captureTypeParametersRequest(m)).toThrow();expect(reads).toBe(0);
    });
    it.each(['ordinary', 'mismatch', 'source', 'old-profile', 'expanded-budget'])('rejects %s at its proper seam', kind => {
        const m: any = fixture();
        if (kind === 'ordinary') m.rawArgs.choice = m.effectiveArgs.choice = 7;
        if (kind === 'mismatch') m.effectiveArgs.choice = 'other';if (kind === 'source') m.refSources[0].snapshotId = 'other';
        if (kind === 'old-profile') delete m.tool.inputSchema['x-aotui-parameter-contract'];
        if (kind === 'expanded-budget') m.effectiveArgs.file = { list: Array(RESOLVED_TOOL_ARGUMENT_LIMITS.maxNodes).fill(null) };
        // Detached mutable JSON for mutation cases; the captured contract itself stays frozen.
        if (kind === 'expanded-budget') { expect(() => captureTypeParametersRequest(m)).toThrow(); return; }
        const result = validateTypeParameters(captureTypeParametersRequest(m));expect(result.success).toBe(false);
        expect(result.error?.code).toBe(kind === 'old-profile' ? 'REF_CONTRACT_UNSUPPORTED' : 'E_INVALID_ARGS');
    });
    it('correlates only exact new terminal type/mode/identity and preserves entered business failure', () => {
        const m = fixture(), terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'BUSINESS', message: 'Expected failure' } } };
        const response = typeParametersResponse(m, terminal)!;expect(response.type).toBe('VIEW_TOOL_INVOKE_V4_RESPONSE');
        expect(captureTypeParametersTerminal(response, m)).toEqual(terminal);
        for (const patch of [{ type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' }, { argumentMode: 'snapshot-value-v1' }, { requestId: 'other' }, { instanceId: 'other' }, { extra: true }])
            expect(captureTypeParametersTerminal({ ...response, ...patch }, m)).toBe(null);
        expect(typeParametersResponse(m, { phase: 'entered-returned', result: { success: true, data: { value: 'x'.repeat(600000) } } })).toBe(null);
    });
    it('counts complete raw arguments and expanded source envelope before ordinary validation', () => {
        const raw: any = fixture();raw.rawArgs.choice = raw.effectiveArgs.choice = 'x'.repeat(RAW_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes);
        expect(() => captureTypeParametersRequest(raw)).toThrow();
        const envelope = fixture();
        const sourceBytes = RESOLVED_TOOL_ENVELOPE_LIMITS.maxCanonicalBytes - RESOLVED_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes;
        envelope.snapshotId = envelope.refSources[0]!.snapshotId = 's'.repeat(sourceBytes);
        const file = { opaque: true, value: 'a'.repeat(RESOLVED_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes - 1024) };
        envelope.effectiveArgs.file = file;
        expect(validateTypeParameters(captureTypeParametersRequest(envelope)).error?.code).toBe('REF_ARGUMENT_BUDGET_EXCEEDED');
    });
    it('rejects malformed source metadata and key correspondence without needing a V1 projection', () => {
        const extra: any = fixture();extra.refSources[0].untrusted = true;
        expect(validateTypeParameters(captureTypeParametersRequest(extra)).error?.code).toBe('E_INVALID_ARGS');
        const missing: any = fixture();delete missing.refSources[0].viewInstanceId;
        expect(validateTypeParameters(captureTypeParametersRequest(missing)).error?.code).toBe('E_INVALID_ARGS');
        const key: any = fixture();key.effectiveArgs.other = true;
        expect(validateTypeParameters(captureTypeParametersRequest(key)).error?.code).toBe('E_INVALID_ARGS');
    });
});
