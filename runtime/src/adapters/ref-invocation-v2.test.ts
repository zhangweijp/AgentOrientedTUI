import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../core/snapshot/json.js';
import { compileSnapshotValueParams } from '../core/tool/snapshot-value-parameter-contract.js';
import { captureRefV2Request, captureRefV2Terminal, refV2Response, validateRefV2Arguments } from './ref-invocation-v2.js';
function fixture() {
    const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' }, choice: { type: 'enum', options: ['ok'] } }, { additionalProperties: false });
    if (!c.ok) throw Error('fixture');const target = { viewId: 'v', viewInstanceId: 'mount', bindingVersion: 1 };
    return { type: 'VIEW_TOOL_INVOKE_REF_V2', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', argumentMode: 'snapshot-value-v2',
        tool: { id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: JSON.parse(JSON.stringify(c.contract.schema)), isMutating: false, targets: [target] }, target,
        rawArgs: { file: 'id', choice: 'ok' }, effectiveArgs: { file: { opaque: true }, choice: 'ok' },
        refSources: [{ param: 'file', refId: 'id', kind: 'snapshot-value', refType: 'unknown', snapshotId: 'source', viewId: 'v', viewInstanceId: 'mount' }] };
}
describe('R03/R04 Ref V2 exact codec and pure correspondence projection', () => {
    it('retains the original profile and source while checking both complete argument stages', () => {
        const input = fixture(), before = canonicalJson(input as any), message = captureRefV2Request(input);
        expect(validateRefV2Arguments(message)).toEqual({ success: true });
        expect(canonicalJson(input as any)).toBe(before);expect(message.tool.inputSchema).toEqual(input.tool.inputSchema);
        expect(message.tool.inputSchema).toHaveProperty('x-aotui-parameter-contract', 'snapshot-value-params-v1');
    });
    it.each(['mode', 'type', 'extra', 'getter', 'oversize'])('rejects malformed request %s before projection', kind => {
        let reads = 0;const m: any = fixture();
        if (kind === 'mode') m.argumentMode = 'snapshot-value-v1';if (kind === 'type') m.type = 'VIEW_TOOL_INVOKE_REF_V1';
        if (kind === 'extra') m.extra = true;if (kind === 'oversize') m.tool.description = 'x'.repeat(600000);
        if (kind === 'getter') Object.defineProperty(m, 'rawArgs', { enumerable: true, get() { reads++;return {}; } });
        expect(() => captureRefV2Request(m)).toThrow();expect(reads).toBe(0);
    });
    it.each(['ordinary', 'mismatch', 'source', 'old-profile', 'expanded-budget'])('rejects %s at its proper seam', kind => {
        const m: any = fixture();
        if (kind === 'ordinary') m.rawArgs.choice = m.effectiveArgs.choice = 7;
        if (kind === 'mismatch') m.effectiveArgs.choice = 'other';if (kind === 'source') m.refSources[0].snapshotId = 'other';
        if (kind === 'old-profile') delete m.tool.inputSchema['x-aotui-parameter-contract'];
        if (kind === 'expanded-budget') m.effectiveArgs.file = { list: Array(10000).fill(null) };
        // Detached mutable JSON for mutation cases; the captured contract itself stays frozen.
        const result = validateRefV2Arguments(captureRefV2Request(m));expect(result.success).toBe(false);
        expect(result.error?.code).toBe(kind === 'ordinary' ? 'E_INVALID_ARGS' : kind === 'expanded-budget' ? 'REF_ARGUMENT_BUDGET_EXCEEDED' : kind === 'old-profile' ? 'REF_CONTRACT_UNSUPPORTED' : 'OPERATION_INVALID_ARGS');
    });
    it('correlates only exact new terminal type/mode/identity and preserves entered business failure', () => {
        const m = fixture(), terminal = { phase: 'entered-returned' as const, result: { success: false, error: { code: 'BUSINESS', message: 'Expected failure' } } };
        const response = refV2Response(m, terminal)!;expect(response.type).toBe('VIEW_TOOL_INVOKE_REF_V2_RESPONSE');
        expect(captureRefV2Terminal(response, m)).toEqual(terminal);
        for (const patch of [{ type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' }, { argumentMode: 'snapshot-value-v1' }, { requestId: 'other' }, { instanceId: 'other' }, { extra: true }])
            expect(captureRefV2Terminal({ ...response, ...patch }, m)).toBe(null);
        expect(refV2Response(m, { phase: 'entered-returned', result: { success: true, data: { value: 'x'.repeat(600000) } } })).toBe(null);
    });
    it('counts complete raw arguments and expanded source envelope before ordinary validation', () => {
        const raw: any = fixture();raw.rawArgs.choice = raw.effectiveArgs.choice = 'x'.repeat(140000);
        expect(validateRefV2Arguments(captureRefV2Request(raw)).error?.code).toBe('OPERATION_INVALID_ARGS');
        const envelope: any = fixture();envelope.snapshotId = envelope.refSources[0].snapshotId = 's'.repeat(9000);envelope.effectiveArgs.file = { value: 'a'.repeat(122000) };
        expect(validateRefV2Arguments(captureRefV2Request(envelope)).error?.code).toBe('REF_ARGUMENT_BUDGET_EXCEEDED');
    });
});
