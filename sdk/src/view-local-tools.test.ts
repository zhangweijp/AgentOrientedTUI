import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from './hooks/preact-hooks.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const cleanups: Array<() => Promise<void>> = [];
async function setup(Content: () => any, onRegister?: (definition: any) => void) {
  const definitions: any[] = [], captures: any[] = [];
  const factory = createTUIApp({ app_name: 'ordinary_mutation', component: () => h(View, { id: 'items', type: 'Items' }, h(Content, {})) });
  const initialize = factory.initializeComponent;
  factory.initializeComponent = async (container, context) => {
    const port = context.viewTools!;
    return initialize(container, { ...context, viewTools: { ...port,
      registerTool(id: string, name: string, definition: any, options: any) {
        definitions.push(definition); onRegister?.(definition);
        return port.registerTool(id, name, definition, { ...options,
          createSafeOrdinaryParametersInvoker(contract: any) {
            captures.push(contract); return options.createSafeOrdinaryParametersInvoker(contract);
          },
        });
      },
    } });
  };
  const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
  kernel.setId('app' as any); kernel.setAppExecutionInstanceId('run');
  const container = document.createElement('div'); document.body.appendChild(container);
  cleanups.push(async () => { await kernel.onClose(); container.remove(); });
  await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, container);
  const tool = () => kernel.getViewOwnedToolDefinitions()[0];
  return { kernel, container, definitions, captures, tool,
    invoke: (args: any, observed = tool()) => kernel.invokeBoundOrdinaryParametersViewTool(observed, observed.targets[0], args) };
}
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const params = () => ({ value: { type: 'number' as const, required: true as const } });

describe('ordinary View-local tools without entity preconditions', () => {
  it('awaits the application handler and keeps real mutation metadata', async () => {
    let finish!: () => void, value = 0, settled = false;
    const operation = new Promise<void>(resolve => { finish = resolve; });
    const handler = vi.fn(async (args: { value: number }) => {
      await operation; value = args.value; return { success: true, data: { value } };
    });
    function Content() {
      const [Tool] = useViewTypeTool('set', { description: 'Set value', params: params() }, handler);
      return h(Tool, {}, 'Set value');
    }
    const app = await setup(Content), tool = app.tool();
    expect(tool.isMutating).toBe(true); expect(app.captures).toHaveLength(1);
    expect(app.container.querySelector('tool-ref')?.textContent).toBe('Set value');
    const pending = app.invoke({ value: 42 });
    void Promise.resolve(pending).then(() => { settled = true; });
    await Promise.resolve(); expect(value).toBe(0); expect(settled).toBe(false);
    finish(); expect(await pending).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { value: 42 } } });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('rejects invalid input and prevents generic-handler bypass', async () => {
    const handler = vi.fn(async () => ({ success: true }));
    function Content() { useViewTypeTool('set', { description: 'Set value', params: params(), isMutating: true }, handler); return null; }
    const app = await setup(Content);
    expect(await app.invoke({ value: 'bad' })).toMatchObject({ phase: 'not-entered' });
    expect(await app.invoke({ value: 1, extra: true })).toMatchObject({ phase: 'not-entered' });
    expect(await app.definitions[0].handler({ value: 1 })).toMatchObject({ success: false, error: { code: 'TOOL_EXECUTION_UNAVAILABLE' } });
    expect(handler).not.toHaveBeenCalled();
  });
  it('passes application-declared partial failure through the ordinary callable', async () => {
    function Content() {
      useViewTypeTool('set', { description: 'Set value', params: params() }, async () => ({
        success: false, effects: 'partial', error: { code: 'PARTIAL', message: 'Application reports partial work' }, data: { completed: 1 },
      })); return null;
    }
    const app = await setup(Content);
    expect(await app.invoke({ value: 1 })).toEqual({ phase: 'entered-returned', failureEffects: 'partial', result: {
      success: false, error: { code: 'PARTIAL', message: 'Application reports partial work' }, data: { completed: 1 },
    } });
  });
  it('honors additionalProperties on an empty read-only ordinary contract', async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => ({ success: true, data: { args } }));
    function Content() {
      useViewTypeTool('read', { description: 'Read supplied fields', params: {}, isMutating: false, additionalProperties: true }, handler);
      return null;
    }
    const app = await setup(Content);
    expect(app.tool().isMutating).toBe(false);
    expect(await app.invoke({ extra: 'kept' })).toMatchObject({ phase: 'entered-returned', result: { data: { args: { extra: 'kept' } } } });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('captures the actual layout contract and avoids a redundant rebind on the next render', async () => {
    const fields = { value: { type: 'number' as const, required: true as const, constraints: { min: 1 } } };
    let update!: () => void, once = true;
    function Content() {
      const [n, set] = useState(0); update = () => set(n + 1);
      useViewTypeTool('set', { description: 'Set value', params: fields }, async () => ({ success: true, data: { n } }));
      return h('p', {}, String(n));
    }
    const app = await setup(Content, () => { if (once) { once = false; fields.value.constraints.min = 2; } });
    const first = app.tool();
    expect(await app.invoke({ value: 1 })).toMatchObject({ phase: 'not-entered' });
    await act(update);
    expect(app.tool().targets[0]).toEqual(first.targets[0]); expect(app.captures).toHaveLength(1);
    expect(await app.invoke({ value: 2 })).toMatchObject({ result: { data: { n: 1 } } });
  });
  it('revokes the previous callable after a committed parameter change', async () => {
    let update!: () => void;
    const handler = vi.fn(async () => ({ success: true }));
    function Content() {
      const [next, set] = useState(false); update = () => set(true);
      useViewTypeTool('set', { description: 'Set value', params: { value: { type: 'number', required: true, constraints: { min: next ? 2 : 1 } } } }, handler);
      return null;
    }
    const app = await setup(Content), original = app.tool();
    await act(update);
    expect(await app.invoke({ value: 2 }, original)).toMatchObject({ phase: 'not-entered' });
    expect(handler).not.toHaveBeenCalled();
    expect(await app.invoke({ value: 2 })).toMatchObject({ phase: 'entered-returned', result: { success: true } });
    expect(handler).toHaveBeenCalledOnce();
  });
});
