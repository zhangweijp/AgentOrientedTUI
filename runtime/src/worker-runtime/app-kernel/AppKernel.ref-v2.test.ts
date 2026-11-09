import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';
async function setup() {
    let context: any;
    const kernel = new AppKernel({ appName: 'ref', name: 'Ref', component: {
        initializeComponent: async (_el, value) => { context = value; return { unmount() {} }; },
    } });
    kernel.setId('app' as any); kernel.setAppExecutionInstanceId('run');
    const { document } = parseHTML('<html><body></body></html>');
    await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any }, document.createElement('div') as unknown as HTMLElement);
    context.viewTools.mount('aa', 'File'); return { kernel, context, port: context.appTypeTools };
}
const declaration = () => ({ viewType: 'File', name: 'read', description: 'Read', 
    inputSchema: { type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } }, n: { type: 'number', default: 2 } }, required: ['file'], additionalProperties: false },
});
const options = (factory: any = () => async () => ({ phase: 'entered-returned', result: { success: true } })) => ({
    safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: factory,
});
describe('AppKernel shared parameter port', () => {
    it('uses Core as the sole contract compiler and preserves a captured typed Ref contract', async () => {
        const x = await setup(); let captured: any;
        const factory = vi.fn((contract: any) => { captured = contract; return async (input: unknown) => ({
            phase: 'entered-returned', result: { success: contract.validateResolvedInput(input).ok },
        }); });
        try {
            const definition = declaration(); const release = x.port.registerTypeTool(definition, options(factory));
            expect(factory).toHaveBeenCalledOnce(); const tool = x.kernel.getToolDefinitions()[0]!;
            expect(tool.execution.kind).toBe('view-type'); expect(tool.inputSchema).toEqual(ordinaryParameterProfile(captured));
            definition.inputSchema.properties.n.default = 99; expect((tool.inputSchema as any).properties.n.default).toBe(2);
            expect(Object.keys(x.context.viewTools).sort()).toEqual(['mount', 'unmount']);
            expect(x.kernel.validateBoundTypeTool(tool, tool.execution).success).toBe(true);
            expect((await x.kernel.invokeBoundTypeTool(tool, tool.execution, { file: {} })).phase).toBe('entered-returned');
            expect(x.kernel.validateBoundTypeTool(tool, { kind: 'view-type', activationId: 'bad' }).success).toBe(false); release();
        } finally { await x.kernel.onClose(); }
    });
    it.each(['missing', 'wrong', 'promise', 'extra', 'getter', 'unknown-field', 'custom-prototype'])('lets Core refuse %s without publishing a binding', async kind => {
        const x = await setup(); let reads = 0; const opts: any = options();
        if (kind === 'missing') delete opts.createSafeOrdinaryParametersInvoker;
        if (kind === 'wrong') opts.createSafeOrdinaryParametersInvoker = 1;
        if (kind === 'promise') opts.createSafeOrdinaryParametersInvoker = async () => () => {};
        if (kind === 'extra') opts.extra = true;
        if (kind === 'getter') Object.defineProperty(opts, 'safeOrdinaryParametersInvocationMode', { enumerable: true, get() { reads++; return 'ordinary-v2'; } });
        const input: any = declaration(); if (kind === 'unknown-field') input.unknownField = 'yes';
        const value = kind === 'custom-prototype' ? Object.assign(Object.create({ inherited: true }), input) : input;
        try { expect(() => x.port.registerTypeTool(value, opts)).toThrow(); expect(x.kernel.getToolDefinitions()).toHaveLength(0); expect(reads).toBe(0); }
        finally { await x.kernel.onClose(); }
    });
});
