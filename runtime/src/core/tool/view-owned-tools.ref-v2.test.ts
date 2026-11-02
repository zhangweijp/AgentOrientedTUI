import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileSnapshotValueParams } from './snapshot-value-parameter-contract.js';
const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });if (!c.ok) throw Error('fixture');
const spec = { name: 'read', description: 'Read original object', inputSchema: c.contract.schema, isMutating: false };
function setup() { const r = createViewOwnedTools('app', 'run'), owner = r.mount('aa', 'File');return { r, owner }; }
describe('R01/R02/R12 Registry exact Ref V2 private qualification', () => {
    it('admits a declaration without granting Ref execution until a private V2 callable is registered', async () => {
        const { r, owner } = setup(), handler = vi.fn(async () => ({ success: true }));r.registerTool(owner.viewInstanceId, spec, handler);
        const t = r.listTools()[0]!, target = t.targets[0]!;
        expect(r.validateSnapshotValueParametersBinding(t, target).success).toBe(false);
        expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('not-entered');
        expect(handler).not.toHaveBeenCalled();
    });
    it.each(['retired-mode', 'old-profile', 'missing-callable', 'mutating'])('refuses mismatched %s registration', kind => {
        const { r, owner } = setup();const options: any = kind === 'retired-mode' ? { safeRefInvocationMode: 'snapshot-value-v1' } : { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' };
        const schema: any = JSON.parse(JSON.stringify(spec.inputSchema));if (kind === 'old-profile') delete schema['x-aotui-parameter-contract'];
        expect(() => r.registerTool(owner.viewInstanceId, { ...spec, inputSchema: schema, isMutating: kind === 'mutating' }, async () => ({ success: true }), options,
            kind === 'missing-callable' ? undefined : async () => ({ phase: 'entered-returned', result: { success: true } }))).toThrow();expect(r.listTools()).toHaveLength(0);
    });
    it('calls only the current target safe wrapper and revokes old binding identity', async () => {
        const { r, owner } = setup(), other = r.mount('bb', 'File');const a = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true } })), b = vi.fn(a);
        const release = r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }), { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, a);
        r.registerTool(other.viewInstanceId, spec, async () => ({ success: true }), { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, b);
        const t = r.listTools()[0]!, target = t.targets.find(x => x.viewId === 'aa')!;
        expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('entered-returned');expect(a).toHaveBeenCalledOnce();expect(b).not.toHaveBeenCalled();
        expect(r.validateSnapshotValueParametersBinding({ ...t, appInstanceId: 'other' }, target).success).toBe(false);
        expect(r.validateSnapshotValueParametersBinding({ ...t, description: 'changed' }, target).success).toBe(false);
        release();r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }), { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, a);
        expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('not-entered');
        r.unmount(owner.viewInstanceId);r.mount('aa', 'File');expect((await r.invokeSnapshotValueParameters(t, target, { file: {} })).phase).toBe('not-entered');
    });
    it('invokes a fresh snapshot-value-v2 binding after same-View release and re-registration', async () => {
        const { r, owner } = setup();
        const oldSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'old' } } }));
        const release = r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }),
            { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, oldSafe);
        const observed = r.listTools()[0]!, oldTarget = observed.targets[0]!;
        expect(await r.invokeSnapshotValueParameters(observed, oldTarget, { file: {} })).toMatchObject({ result: { data: { binding: 'old' } } });
        expect(oldSafe).toHaveBeenCalledOnce();
        release();
        expect(await r.invokeSnapshotValueParameters(observed, oldTarget, { file: {} })).toMatchObject({
            phase: 'not-entered', result: { error: { code: 'TOOL_UNAVAILABLE' } },
        });
        const newSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'new' } } }));
        r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }),
            { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }, newSafe);

        const current = r.listTools()[0]!, currentTarget = current.targets[0]!;
        expect(currentTarget.bindingVersion).not.toBe(oldTarget.bindingVersion);
        expect(r.validateSnapshotValueParametersBinding(current, currentTarget)).toEqual({ success: true });
        expect(await r.invokeSnapshotValueParameters(current, currentTarget, { file: {} })).toEqual({
            phase: 'entered-returned', result: { success: true, data: { binding: 'new' } },
        });
        expect(await r.invokeSnapshotValueParameters(observed, oldTarget, { file: {} })).toMatchObject({
            phase: 'not-entered', result: { error: { code: 'TOOL_SOURCE_STALE' } },
        });
        expect(oldSafe).toHaveBeenCalledOnce(); expect(newSafe).toHaveBeenCalledOnce();
    });
    it('compares the full public profile for same type/name and never picks a first definition', () => {
        const { r, owner } = setup(), other = r.mount('bb', 'File');r.registerTool(owner.viewInstanceId, spec, async () => ({ success: true }));
        expect(() => r.registerTool(other.viewInstanceId, { ...spec, inputSchema: { ...spec.inputSchema, description: 'changed' } }, async () => ({ success: true }))).toThrow('TOOL_SCHEMA_CONFLICT');
    });
});
