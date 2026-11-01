import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
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
        return port.registerTool(id, name, definition, { ...options, ...(options.createSafeOrdinaryParametersInvoker ? {
          createSafeOrdinaryParametersInvoker(contract: any) {
            captures.push(contract); return options.createSafeOrdinaryParametersInvoker(contract);
          }, } : {}),
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
  it('captures stable business targets and rebinds only when the target value changes', async () => {
    let setPath!: (value: string) => void, rerender!: (value: number) => void;
    const handler = vi.fn(async () => ({ success: true }));
    function Content() {
      const [filePath, set] = useState('/a'); setPath = set;
      const [, bump] = useState(0); rerender = bump;
      useViewTypeTool('write', { description: 'Write', params: { filePath: { type: 'string', required: true } },
        target: { param: 'filePath', value: filePath } }, handler);
      return null;
    }
    const app = await setup(Content), original = app.tool();
    expect(original.targets[0].selector).toEqual({ param: 'filePath', value: '/a' });
    await act(() => rerender(1)); expect(app.definitions).toHaveLength(1);
    expect(await app.invoke({ filePath: '/b' })).toMatchObject({ phase: 'not-entered', result: { error: { code: 'INVALID_VIEW_TARGET' } } });
    expect(handler).not.toHaveBeenCalled();
    expect(await app.invoke({ filePath: '/a' })).toMatchObject({ result: { success: true } });
    await act(() => setPath('/b')); expect(app.definitions).toHaveLength(2);
    expect(app.tool().inputSchema).toEqual(original.inputSchema);
    expect(await app.invoke({ filePath: '/a' }, original)).toMatchObject({ phase: 'not-entered', result: { error: { code: 'TOOL_SOURCE_STALE' } } });
    expect(await app.invoke({ filePath: '/b' })).toMatchObject({ result: { success: true } });
  });
  it.each([
    ['ordinary-v2', { params: params() }],
    ['ordinary-v2 read-only empty', { params: {}, isMutating: false }],
    ['snapshot-value-v2', { params: { file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } }, isMutating: false }],
  ])('keeps %s UI and callable availability in sync when enabled changes', async (_mode, options) => {
    let setEnabled!: (value: boolean) => void;
    function Content() {
      const [enabled, set] = useState(false); setEnabled = set;
      const [Tool] = useViewTypeTool('inspect', { description: 'Inspect', ...options } as any,
        async () => ({ success: true }), { enabled });
      return h(Tool, {}, 'Inspect current object');
    }
    const app = await setup(Content);
    expect(app.container.querySelector('tool-ref')).toBeNull();
    expect(app.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
    await act(() => setEnabled(true));
    expect(app.container.querySelector('tool-ref')?.textContent).toBe('Inspect current object');
    expect(app.kernel.getViewOwnedToolDefinitions()).toHaveLength(1);
    await act(() => setEnabled(false));
    expect(app.container.querySelector('tool-ref')).toBeNull();
    expect(app.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
  });
  it('executes a newly registered Tool after the Hook is disabled and re-enabled', async () => {
    let setEnabled!: (value: boolean) => void;
    const handler = vi.fn(async (args: { value: number }) => ({ success: true, data: { value: args.value } }));
    function Content() {
      const [enabled, set] = useState(false); setEnabled = set;
      const [Tool] = useViewTypeTool('inspect', { description: 'Inspect', params: params() }, handler, { enabled });
      return h(Tool, {}, 'Inspect');
    }
    const app = await setup(Content);
    expect(app.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);

    await act(() => setEnabled(true));
    const first = app.tool(), oldTarget = first.targets[0];
    expect(await app.invoke({ value: 1 }, first)).toMatchObject({
      phase: 'entered-returned', result: { success: true, data: { value: 1 } },
    });

    await act(() => setEnabled(false));
    expect(await app.invoke({ value: 2 }, first)).toMatchObject({
      phase: 'not-entered', result: { error: { code: 'TOOL_UNAVAILABLE' } },
    });
    expect(handler).toHaveBeenCalledOnce();

    await act(() => setEnabled(true));
    const current = app.tool(), currentTarget = current.targets[0];
    expect(currentTarget.bindingVersion).not.toBe(oldTarget.bindingVersion);
    expect(await app.invoke({ value: 3 }, current)).toMatchObject({
      phase: 'entered-returned', result: { success: true, data: { value: 3 } },
    });
    expect(await app.invoke({ value: 4 }, first)).toMatchObject({
      phase: 'not-entered', result: { error: { code: 'TOOL_SOURCE_STALE' } },
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
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
  it.each(['none', 'partial'] as const)('passes application-declared %s failure through the ordinary callable', async effects => {
    function Content() {
      useViewTypeTool('set', { description: 'Set value', params: params() }, async () => ({
        success: false, effects, error: { code: 'FAILED', message: 'Application reports a known failure' }, data: { completed: 1 },
      })); return null;
    }
    const app = await setup(Content);
    expect(await app.invoke({ value: 1 })).toEqual({ phase: 'entered-returned', failureEffects: effects, result: {
      success: false, error: { code: 'FAILED', message: 'Application reports a known failure' }, data: { completed: 1 },
    } });
  });
  it('preserves an unknown failure without inventing an effects declaration', async () => {
    const result = { success: false, error: { code: 'OUTCOME_UNKNOWN', message: 'Check current state' } };
    function Content() {
      useViewTypeTool('set', { description: 'Set value', params: params() }, async () => result);
      return null;
    }
    const app = await setup(Content);
    expect(await app.invoke({ value: 1 })).toEqual({ phase: 'entered-returned', result });
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
  it('uses ordinary-v2 for an empty read-only Tool without making it mutating', async () => {
    const handler = vi.fn(async () => ({ success: true, data: { read: true } }));
    function Content() {
      useViewTypeTool('read_status', { description: 'Read current status', params: {}, isMutating: false }, handler);
      return null;
    }
    const app = await setup(Content);
    expect(app.tool().isMutating).toBe(false);
    expect(app.captures).toHaveLength(1);
    expect(await app.invoke({})).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { read: true } } });
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
