import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileSnapshotValueParams } from './snapshot-value-parameter-contract.js';
const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });if (!c.ok) throw Error('fixture');
const spec = { name: 'read', description: 'Read original object', inputSchema: c.contract.schema, isMutating: false };
function setup() { const r = createViewOwnedTools('app', 'run'), owner = r.mount('aa', 'File');return { r, owner }; }
describe('R01/R02/R12 Registry exact Ref V2 private qualification', () => {
    it('admits a declaration without granting either Ref execution mode or generic handler access', async () => {
        const { r, owner } = setup(), handler = vi.fn(async () => ({ success: true }));r.registerTool(owner.viewInstanceId, spec, handler);
        const t = r.listTools()[0]!, target = t.targets[0]!;
        expect(r.validateRefBinding(t, target).success).toBe(false);expect(r.validateSnapshotValueParametersBinding(t, target).success).toBe(false);
        expect((await r.invokeRef(t, target, { file: {} })).phase).toBe('not-entered');expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('not-entered');
        expect((await r.invoke(t, target, { file: {} })).success).toBe(false);expect(handler).not.toHaveBeenCalled();
    });
    it.each(['old-mode', 'old-profile', 'missing-callable', 'mutating'])('refuses mismatched %s registration', kind => {
        const { r, owner } = setup();const options: any = kind === 'old-mode' ? { safeRefInvocationMode: 'snapshot-value-v1' } : { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' };
        const schema: any = JSON.parse(JSON.stringify(spec.inputSchema));if (kind === 'old-profile') delete schema['x-aotui-parameter-contract'];
        expect(() => r.registerTool(owner.viewInstanceId, { ...spec, inputSchema: schema, isMutating: kind === 'mutating' }, async () => ({ success: true }), true, options,
            kind === 'missing-callable' ? undefined : async () => ({ phase: 'entered-returned', result: { success: true } }))).toThrow();expect(r.listTools()).toHaveLength(0);
    });
    it('calls only the current target safe wrapper and revokes old binding identity', async () => {
        const { r, owner } = setup(), other = r.mount('bb', 'File');const a = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true } })), b = vi.fn(a);
        const release = r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }), true, { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, a);
        r.registerTool(other.viewInstanceId, spec, async () => ({ success: true }), true, { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, b);
        const t = r.listTools()[0]!, target = t.targets.find(x => x.viewId === 'aa')!;
        expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('entered-returned');expect(a).toHaveBeenCalledOnce();expect(b).not.toHaveBeenCalled();
        expect(r.validateSnapshotValueParametersBinding({ ...t, appInstanceId: 'other' }, target).success).toBe(false);
        expect(r.validateSnapshotValueParametersBinding({ ...t, description: 'changed' }, target).success).toBe(false);
        release();r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }), true, { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, a);
        expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('not-entered');
        r.unmount(owner.viewInstanceId);r.mount('aa', 'File');expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('not-entered');
    });
    it('compares the full public profile for same type/name and never picks a first definition', () => {
        const { r, owner } = setup(), other = r.mount('bb', 'File');r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }));
        expect(() => r.registerTool(other.viewInstanceId, { ...spec, inputSchema: { ...spec.inputSchema, description: 'changed' } }, async () => ({ success: true }))).toThrow('TOOL_SCHEMA_CONFLICT');
    });
});
