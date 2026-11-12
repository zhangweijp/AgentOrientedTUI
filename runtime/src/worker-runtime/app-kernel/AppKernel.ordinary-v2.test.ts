import { buildPublicToolName } from '../../adapters/public-tool-name.js';
import { describe, it, expect, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';
import { compileOrdinaryParams, type OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { AppTypeToolRegistrationOptions, IAppTypeToolPort, IViewOwnedToolPort } from '../../spi/index.js';
import type { SafeOrdinaryInvoker } from '../../core/tool/invocation-terminal.js';

const compiledSchema = () => {
  const result = compileOrdinaryParams({ q: { type: 'string', required: true, constraints: { minLength: 1 } } }, { additionalProperties: false });
  if (!result.ok) throw new Error('Test schema must compile');
  return result.contract.schema;
};

const setup = async () => {
  let viewTools!: IViewOwnedToolPort;
  let appTypeTools!: IAppTypeToolPort;
  const kernel = new AppKernel({ appName: 'ordinary', name: 'Read', factory: {
    initialize: async (context) => {
      viewTools = context.viewTools!;
      appTypeTools = context.appTypeTools!;
      return { close() {} };
    },
  } });
  kernel.setId('app' as any); kernel.setAppExecutionInstanceId('run');
  await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any });
  const viewInstanceId = viewTools.mount('aa', 'File');
  return { kernel, viewTools, appTypeTools, viewInstanceId };
};

const definition = (overrides: Record<string, unknown> = {}) => ({ viewType: 'File', name: 'find', description: 'Find',
  inputSchema: compiledSchema(),  ...overrides });
const options = (factory: AppTypeToolRegistrationOptions['createSafeOrdinaryParametersInvoker'] = () =>
  async () => ({ phase: 'entered-returned', result: { success: true } })) => ({
    safeOrdinaryParametersInvocationMode: 'ordinary-v2' as const,
    createSafeOrdinaryParametersInvoker: factory,
  });

describe('AppKernel ViewType Tool Runtime port', () => {
  it('keeps structured Tool identity independent of native adapter alias constraints', async () => {
    const x = await setup();
    try {
      expect(x.appTypeTools.protocol).toBe('view-type-tools-v4');
      for (const name of ['x'.repeat(51), 'has space']) {
        const release = x.appTypeTools.registerTypeTool(definition({ name }), options());
        const tool = x.kernel.getToolDefinitions()[0]!;
        expect(JSON.parse(tool.id)).toEqual(['app', 'File', name]);
        expect(() => buildPublicToolName('ordinary', 'File', name)).toThrow(expect.objectContaining({ code: 'AOTUI_TOOL_NAME_INVALID' }));
        expect((await x.kernel.invokeBoundTypeTool(tool, tool.execution, { q: 'value' })).phase).toBe('entered-returned');
        release();expect(x.kernel.getToolDefinitions()).toHaveLength(0);
      }
    } finally { await x.kernel.onClose(); }
  });

  it('uses the Runtime context ID and refuses replacing an assigned identity', async () => {
    const x = await setup();
    try {
      expect(x.kernel.id).toBe('app');
      expect(() => x.kernel.setId('other' as never)).toThrow(expect.objectContaining({ code: 'APP_IDENTITY_MISMATCH' }));
      expect(x.kernel.id).toBe('app');
    } finally { await x.kernel.onClose(); }
  });

  it('passes the original declaration and options to Core, which compiles one authoritative contract', async () => {
    const x = await setup(); let captured!: OrdinaryParameterContract;
    const inputSchema = compiledSchema();
    const safeFactory = vi.fn((contract: OrdinaryParameterContract) => {
      captured = contract;
      const invoker: SafeOrdinaryInvoker = async args => {
        const result = contract.validate(args);
        return { phase: result.ok ? 'entered-returned' : 'not-entered',
          result: result.ok ? { success: true } : { success: false, error: { code: 'E_INVALID_ARGS', message: 'bad input' } } };
      };
      return invoker;
    });
    const declaration = definition({ inputSchema });
    const registrationOptions = options(safeFactory);
    try {
      const release = x.appTypeTools.registerTypeTool(declaration, registrationOptions);
      const tool = x.kernel.getToolDefinitions()[0]!;
      expect(safeFactory).toHaveBeenCalledOnce();
      expect(tool.execution.kind).toBe('view-type');
      expect(tool.inputSchema).toEqual({ ...captured.schema, 'x-aotui-parameter-contract': 'view-type-parameters-v1' });
      expect(captured.validate({ q: 'x' }).ok).toBe(true);
      expect(x.kernel.validateBoundTypeTool(tool, tool.execution).success).toBe(true);
      declaration.name = 'mutated';
      expect(x.kernel.getToolDefinitions()[0]!.name).toBe('find');
      release();
      expect(x.kernel.getToolDefinitions()).toEqual([]);
    } finally { await x.kernel.onClose(); }
  });

  it('preserves mutation metadata and enters only the private trusted callable', async () => {
    const x = await setup();
    const safe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { changed: true } } }));
    try {
      const release = x.appTypeTools.registerTypeTool(definition({  }), options(() => safe));
      const tool = x.kernel.getToolDefinitions()[0]!;
      expect(tool).not.toHaveProperty('isMutating');
      expect(x.kernel.validateBoundTypeTool(tool, tool.execution).success).toBe(true);
      expect(await x.kernel.invokeBoundTypeTool(tool, tool.execution, { q: 'edit' })).toEqual({
        phase: 'entered-returned', result: { success: true, data: { changed: true } },
      });
      expect(safe).toHaveBeenCalledOnce();
      release();
    } finally { await x.kernel.onClose(); }
  });

  it('rejects unsupported Schema before publishing or constructing a callable', async () => {
    const x = await setup(), factory = vi.fn(options().createSafeOrdinaryParametersInvoker);
    const unsupportedSchema = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { x: { type: 'string', format: 'email' } } },
      },
    };
    try {
      expect(() => x.appTypeTools.registerTypeTool(definition({ inputSchema: unsupportedSchema }), options(factory))).toThrow();
      expect(x.kernel.getToolDefinitions()).toHaveLength(0);
      expect(factory).not.toHaveBeenCalled();
    } finally { await x.kernel.onClose(); }
  });

  it.each(['missing', 'wrong', 'throw', 'promise', 'extra', 'getter', 'custom-prototype'])('lets Core reject %s factory metadata without a usable registration', async kind => {
    const x = await setup(); let reads = 0;
    const metadata: any = options();
    if (kind === 'missing') delete metadata.createSafeOrdinaryParametersInvoker;
    if (kind === 'wrong') metadata.createSafeOrdinaryParametersInvoker = 1;
    if (kind === 'throw') metadata.createSafeOrdinaryParametersInvoker = () => { throw Error('PRIVATE'); };
    if (kind === 'promise') metadata.createSafeOrdinaryParametersInvoker = async () => async () => ({ phase: 'entered-returned', result: { success: true } });
    if (kind === 'extra') metadata.other = true;
    if (kind === 'getter') Object.defineProperty(metadata, 'createSafeOrdinaryParametersInvoker', { enumerable: true,
      get() { reads++; return options().createSafeOrdinaryParametersInvoker; } });
    const input = kind === 'custom-prototype' ? Object.assign(Object.create({ inherited: true }), options()) : metadata;
    try {
      expect(() => x.appTypeTools.registerTypeTool(definition(), input)).toThrow();
      expect(x.kernel.getToolDefinitions()).toHaveLength(0);
      expect(reads).toBe(0);
    } finally { await x.kernel.onClose(); }
  });

  it('does not leave a ghost Tool or publish another mutation if its callable factory closes the App', async () => {
    const x = await setup();
    const before = x.kernel.getProjectionCoordinator().token().epoch;
    let closing: Promise<void> | undefined;
    try {
      expect(() => x.appTypeTools.registerTypeTool(definition(), options(() => {
        closing = x.kernel.onClose();
        return async () => ({ phase: 'entered-returned', result: { success: true } });
      }))).toThrow('APP_KERNEL_CLOSED');
      await closing;
      expect(x.kernel.getToolDefinitions()).toEqual([]);
      expect(x.kernel.getProjectionCoordinator().token().epoch).toBe(before);
    } finally { await x.kernel.onClose(); }
  });
});
