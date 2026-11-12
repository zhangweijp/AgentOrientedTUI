import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contracts from '../core/tool/ordinary-parameter-contract.js';
import { AppKernel } from './app-kernel/AppKernel.js';
import { invokeTypeParameters } from './ordinary-invocation-v2.js';
import type { IAppTypeToolPort, IViewOwnedToolPort } from '../spi/index.js';
import type { OrdinaryParameterContract } from '../core/tool/ordinary-parameter-contract.js';

async function setup() {
  let port!: IAppTypeToolPort, views!: IViewOwnedToolPort;
  const kernel = new AppKernel({ appName: 'compiled', name: 'Compiled', factory: {
    initialize: async (context) => {
      port = context.appTypeTools!; views = context.viewTools!;
      return { close() {} };
    },
  } });
  kernel.setId('app' as never); kernel.setAppExecutionInstanceId('run');
  await kernel.onOpen({ appId: 'app' as never, desktopId: 'd' as never });
  views.mount('detail', 'File');
  const context = { appId: 'app', instanceId: 'run', negotiated: true,
    validateBinding: kernel.validateBoundTypeTool.bind(kernel),
    getParameterContract: (tool: Parameters<typeof kernel.validateBoundTypeTool>[0], execution: Parameters<typeof kernel.validateBoundTypeTool>[1]) =>
            isRefViewLive: () => true,
      kernel.getBoundTypeToolContract(tool, execution),
    invokeBinding: kernel.invokeBoundTypeTool.bind(kernel),
  };
  return { kernel, port, views, context };
}

afterEach(() => vi.restoreAllMocks());

describe('registered parameter contract through Worker dispatch and AppKernel', () => {
  it.each([false, true])('compiles once for repeated calls (Ref=%s)', async ref => {
    const x = await setup(), compile = vi.spyOn(contracts, 'compileOrdinarySchema');
    const handler = vi.fn(async (args: Readonly<Record<string, unknown>>) => ({ success: true, data: { value: args.value } }));
    let compiled!: OrdinaryParameterContract;
    try {
      x.port.registerTypeTool({ viewType: 'File', name: 'read', description: 'Read', inputSchema: {
        type: 'object', properties: { value: ref ? { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File',
          'x-aotui-ref-value': { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }
          : { type: 'string' } }, required: ['value'], additionalProperties: false,
      } }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: contract => {
        compiled = contract;
        return async args => ({ phase: 'entered-returned', result: await handler(args) });
      } });
      const tool = x.kernel.getToolDefinitions()[0]!;
      expect(compile).toHaveBeenCalledOnce();
      for (let index = 0; index < 4; index++) {
        const rawArgs = { value: ref ? 'detail.current' : 'value-' + index };
        const effectiveArgs = { value: ref ? { text: 'value-' + index } : rawArgs.value };
        const response = await invokeTypeParameters({ type: 'VIEW_TOOL_INVOKE_V4', requestId: 'r-' + index,
          appId: 'app', instanceId: 'run', snapshotId: 'source', tool, execution: tool.execution,
          argumentMode: 'view-type-parameters-v1', rawArgs, effectiveArgs, refSources: ref ? [{
            param: 'value', refId: 'current', kind: 'snapshot-value', refType: 'File', snapshotId: 'source',
            viewId: 'detail', viewInstanceId: x.kernel.getViewOwnedViewInstances()[0]!.viewInstanceId,
          }] : [] }, x.context);
        expect(response?.terminal).toMatchObject({ phase: 'entered-returned', result: { success: true, data: effectiveArgs } });
      }
      expect(handler).toHaveBeenCalledTimes(4);
      expect(compile).toHaveBeenCalledOnce();
      expect(x.context.getParameterContract(tool, tool.execution)).toBe(compiled);
    } finally { await x.kernel.onClose(); }
  });

  it('keeps public trusted-factory entry distinct from Worker parameter rejection', async () => {
    const x = await setup(), handler = vi.fn(async (_args: Readonly<Record<string, unknown>>) => ({ success: true }));
    try {
      x.port.registerTypeTool({ viewType: 'File', name: 'read', description: 'Read', inputSchema: {
        type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
      } }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () =>
        async args => ({ phase: 'entered-returned', result: await handler(args) }) });
      const tool = x.kernel.getToolDefinitions()[0]!;
      expect((await x.kernel.invokeBoundTypeTool(tool, tool.execution, { value: 7 })).phase).toBe('entered-returned');
      const reply = await invokeTypeParameters({ type: 'VIEW_TOOL_INVOKE_V4', requestId: 'invalid', appId: 'app',
        instanceId: 'run', snapshotId: 'source', tool, execution: tool.execution, argumentMode: 'view-type-parameters-v1',
        rawArgs: { value: 7 }, effectiveArgs: { value: 7 }, refSources: [] }, x.context);
      expect(reply?.terminal).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS' } } });
      expect(handler).toHaveBeenCalledOnce();
    } finally { await x.kernel.onClose(); }
  });

  it('keeps the compiled contract with its registration across View reactivation, replacement and close', async () => {
    const x = await setup(), compile = vi.spyOn(contracts, 'compileOrdinarySchema');
    const handler = vi.fn(async (args: Readonly<Record<string, unknown>>) => ({ success: true, data: { value: args.value } }));
    const register = (type: string) => x.port.registerTypeTool({ viewType: 'File', name: 'read', description: 'Read',
      inputSchema: { type: 'object', properties: { value: { type } }, required: ['value'], additionalProperties: false },
    }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () =>
      async args => ({ phase: 'entered-returned', result: await handler(args) }) });
    try {
      const release = register('string'), old = x.kernel.getToolDefinitions()[0]!;
      const first = x.kernel.getBoundTypeToolContract(old, old.execution);
      x.views.unmount(x.kernel.getViewOwnedViewInstances()[0]!.viewInstanceId);
      expect(x.kernel.getBoundTypeToolContract(old, old.execution)).toBeUndefined();
      x.views.mount('detail', 'File');
      const reopened = x.kernel.getToolDefinitions()[0]!;
      expect(reopened.execution).not.toEqual(old.execution);
      expect(x.kernel.getBoundTypeToolContract(reopened, reopened.execution)).toBe(first);
      expect(x.kernel.getBoundTypeToolContract(old, old.execution)).toBeUndefined();
      release(); register('number');
      const current = x.kernel.getToolDefinitions()[0]!;
      expect(x.kernel.getBoundTypeToolContract(current, current.execution)).not.toBe(first);
      const request = (tool: typeof current, value: unknown) => ({ type: 'VIEW_TOOL_INVOKE_V4', requestId: 'r',
        appId: 'app', instanceId: 'run', snapshotId: 'source', tool, execution: tool.execution,
        argumentMode: 'view-type-parameters-v1', rawArgs: { value }, effectiveArgs: { value }, refSources: [] });
      expect((await invokeTypeParameters(request(old, 'old'), x.context))?.terminal.phase).toBe('not-entered');
      expect((await invokeTypeParameters(request(reopened, 'old'), x.context))?.terminal.phase).toBe('not-entered');
      expect(handler).not.toHaveBeenCalled();
      expect((await invokeTypeParameters(request(current, 7), x.context))?.terminal).toMatchObject({
        phase: 'entered-returned', result: { success: true, data: { value: 7 } },
      });
      expect(handler).toHaveBeenCalledOnce(); expect(compile).toHaveBeenCalledTimes(2);
      await x.kernel.onClose();
      expect(x.kernel.getBoundTypeToolContract(current, current.execution)).toBeUndefined();
      expect((await invokeTypeParameters(request(current, 8), x.context))?.terminal.phase).toBe('not-entered');
      expect(handler).toHaveBeenCalledOnce();
    } finally { await x.kernel.onClose(); }
  });

});
