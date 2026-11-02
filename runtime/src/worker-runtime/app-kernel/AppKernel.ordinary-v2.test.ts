import { describe, it, expect, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';
import type { IViewOwnedToolPort, OrdinaryParameterContract } from '../../spi/index.js';
const setup = async () => {
  let port!: IViewOwnedToolPort;
  const kernel = new AppKernel({ appName: 'ordinary', name: 'Read', component: {
    initializeComponent: async (_container, ctx) => { port = ctx.viewTools!; return { unmount() {} }; },
  } });
  kernel.setId('app' as any); kernel.setAppExecutionInstanceId('run');
  const { document } = parseHTML('<html><body></body></html>');
  await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, document.createElement('div') as unknown as HTMLElement);
  const identity = port.mount('aa', 'File');
  return { kernel, port, identity };
};
describe('R03/R07 AppKernel Runtime-owned ordinary capture', () => {
  it.each(['x'.repeat(51), 'has space'])('rejects invalid public Tool name at registration: %s', async name => {
    const x = await setup();
    try {
      const definition = { description: 'Inspect', params: {}, handler: vi.fn(async () => ({ success: true })) };
      expect(() => x.port.registerTool(x.identity, name, definition, undefined as any)).toThrow('AOTUI_TOOL_NAME_INVALID');
      expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
      expect((x.kernel as any).registerTypeTool).toBeUndefined();
      expect(definition.handler).not.toHaveBeenCalled();
    } finally { await x.kernel.onClose(); }
  });

  it('delivers the one captured contract to factory and generates its matching public profile', async () => {
    const x = await setup(); let captured!: OrdinaryParameterContract;
    const params = { q: { type: 'string', required: true, constraints: { minLength: 1 } } };
    const factory = vi.fn((c: OrdinaryParameterContract) => { captured = c; return async (args: Readonly<Record<string, unknown>>) => {
      const r = c.validate(args); return { phase: 'not-entered' as const, result: { success: false, error: { code: r.ok ? 'TEST' : 'E_INVALID_ARGS', message: 'controlled' } } };
    }; });
    try {
      x.port.registerTool(x.identity, 'find', { description: 'Find', params, handler: async () => ({ success: true }), isMutating: false }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2', additionalProperties: false, createSafeOrdinaryParametersInvoker: factory,
      });
      const tool = x.kernel.getViewOwnedToolDefinitions()[0];
      expect(factory).toHaveBeenCalledOnce();
      expect(tool.inputSchema).toEqual({ ...captured.schema, 'x-aotui-parameter-contract': 'ordinary-params-v1' });
      expect(x.port.fingerprintOrdinaryParams!(params, false)).toBe(captured.fingerprint);
      params.q.constraints.minLength = 10;
      expect(captured.validate({ q: 'x' }).ok).toBe(true);
      expect(x.kernel.validateBoundOrdinaryParametersViewTool(tool, tool.targets[0]).success).toBe(true);
    } finally { await x.kernel.onClose(); }
  });
  it('keeps mutation metadata and enters only the captured ordinary callable', async () => {
    const x = await setup();
    const generic = vi.fn(async () => ({ success: true }));
    const safe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { changed: true } } }));
    try {
      x.port.registerTool(x.identity, 'change', { description: 'Change', params: {}, handler: generic, isMutating: true }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2', additionalProperties: false, createSafeOrdinaryParametersInvoker: () => safe,
      });
      const tool = x.kernel.getViewOwnedToolDefinitions()[0];
      expect(tool.isMutating).toBe(true);
      expect(x.kernel.validateBoundOrdinaryParametersViewTool(tool, tool.targets[0]).success).toBe(true);
      expect(await x.kernel.invokeBoundOrdinaryParametersViewTool(tool, tool.targets[0], {})).toEqual({
        phase: 'entered-returned', result: { success: true, data: { changed: true } },
      });
      expect(safe).toHaveBeenCalledOnce(); expect(generic).not.toHaveBeenCalled();
    } finally { await x.kernel.onClose(); }
  });
  it('does not publish a Tool that lacks a canonical V2 registration contract', async () => {
    const x = await setup();
    const generic = vi.fn(async () => ({ success: true }));
    try {
      expect(() => x.port.registerTool(x.identity, 'uncontracted', {
        description: 'Uncontracted', params: {}, handler: generic, isMutating: false,
      }, undefined as any)).toThrow();
      expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
      expect(generic).not.toHaveBeenCalled();
    } finally { await x.kernel.onClose(); }
  });
  it.each(['missing', 'wrong', 'throw', 'promise', 'non-boolean', 'extra'])('fails %s factory metadata without leaving a usable registration', async kind => {
    const x = await setup();
    const metadata: any = { safeOrdinaryParametersInvocationMode: 'ordinary-v2', additionalProperties: false, createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }) };
    if (kind === 'missing') delete metadata.createSafeOrdinaryParametersInvoker;
    if (kind === 'wrong') metadata.createSafeOrdinaryParametersInvoker = 1;
    if (kind === 'throw') metadata.createSafeOrdinaryParametersInvoker = () => { throw Error('PRIVATE'); };
    if (kind === 'promise') metadata.createSafeOrdinaryParametersInvoker = async () => () => {};
    if (kind === 'extra') metadata.other = true;
    try {
      expect(() => x.port.registerTool(x.identity, 'find', { description: 'Find', params: {}, handler: async () => ({ success: true }), isMutating: kind === 'non-boolean' ? 'true' as any : false }, metadata)).toThrow();
      expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
    } finally { await x.kernel.onClose(); }
  });
});
