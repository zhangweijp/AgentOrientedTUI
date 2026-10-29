import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';
import type { IViewOwnedToolPort } from '../../spi/index.js';
async function setup() {
    let port!: IViewOwnedToolPort;const kernel = new AppKernel({ appName: 'ref', name: 'Ref', component: { initializeComponent: async (_el, context) => { port = context.viewTools!;return { unmount() {} }; } } });
    kernel.setId('app' as any);kernel.setAppExecutionInstanceId('run');const { document } = parseHTML('<html><body></body></html>');
    await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, document.createElement('div') as unknown as HTMLElement);
    return { kernel, get port() { return port; }, owner: port.mount('aa', 'File') };
}
describe('R01/R02/R13 Runtime committed Ref V2 parameter capture', () => {
    it('uses the exact same captured contract for profile and private factory, classifying render separately', async () => {
        const x = await setup();const params = { file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' }, n: { type: 'number', default: 2 } };let captured: any;
        const factory = vi.fn((contract: any) => { captured = contract;return async (input: unknown) => ({ phase: 'entered-returned' as const, result: { success: contract.validateEffective(input).ok } }); });
        try {
            const render = x.port.fingerprintReadOnlyParams!(params, false);expect(render.kind).toBe('snapshot-value');expect(x.port.fingerprintReadOnlyParams!({}, false).kind).toBe('ordinary');
            x.port.registerTool(x.owner, 'read', { description: 'Read', params, isMutating: false, handler: async () => ({ success: true }) }, { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2', additionalProperties: false, createSafeSnapshotValueParametersInvoker: factory });
            expect(factory).toHaveBeenCalledOnce();const source = x.kernel.getViewOwnedToolDefinitions()[0]!;expect(captured.fingerprint).toBe(render.fingerprint);
            // Registry intentionally strict-copies the public spec, so compare complete values, not JS pointer identity.
            expect(source.inputSchema).toEqual(captured.schema);params.n.default = 99;expect((source.inputSchema as any).properties.n.default).toBe(2);
            expect(x.kernel.validateBoundSnapshotValueParametersViewTool(source, source.targets[0]!).success).toBe(true);
            expect((await x.kernel.invokeBoundSnapshotValueParametersViewTool(source, source.targets[0]!, { file: {} })).phase).toBe('entered-returned');
            expect(x.kernel.validateBoundRefViewTool(source, source.targets[0]!).success).toBe(false);
        } finally { await x.kernel.onClose(); }
    });
    it.each(['missing', 'wrong', 'promise', 'extra', 'getter', 'mutating'])('refuses %s metadata without publishing a binding', async kind => {
        const x = await setup();let reads = 0;const options: any = { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2', additionalProperties: false, createSafeSnapshotValueParametersInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }) };
        if (kind === 'missing') delete options.createSafeSnapshotValueParametersInvoker;if (kind === 'wrong') options.createSafeSnapshotValueParametersInvoker = 1;
        if (kind === 'promise') options.createSafeSnapshotValueParametersInvoker = async () => () => {};if (kind === 'extra') options.extra = true;
        if (kind === 'getter') Object.defineProperty(options, 'additionalProperties', { enumerable: true, get() { reads++;return false; } });
        try { expect(() => x.port.registerTool(x.owner, 'read', { description: 'Read', params: { file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } }, isMutating: kind === 'mutating', handler: async () => ({ success: true }) }, options)).toThrow();expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);expect(reads).toBe(0); }
        finally { await x.kernel.onClose(); }
    });
});
