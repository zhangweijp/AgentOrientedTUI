import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, Component, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { createTUIApp, View, useViewTypeTool, useState } from './index.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const cleanups: Array<() => Promise<void>> = [];
async function setup(Content: () => any, root?: () => any, control: {
  support?: unknown; removeFingerprint?: boolean; onRegister?: (definition: any) => void;
} = {}) {
  const captures: any[] = [], definitions: any[] = [];
  const factory = createTUIApp({ app_name: 'ordinary_read', component: root ?? (() => h(View, { id: 'aa', type: 'File' }, h(Content, {}))) });
  const initialize = factory.initializeComponent;
  factory.initializeComponent = async (container, context) => {
    const port = context.viewTools!;
    const forwarded = { ...port,
      ...(Object.hasOwn(control, 'support') ? { safeOrdinaryParametersInvocationSupport: control.support } : {}),
      ...(control.removeFingerprint ? { fingerprintOrdinaryParams: undefined } : {}),
      registerTool: (id: string, name: string, definition: any, options: any) => {
        definitions.push(definition); control.onRegister?.(definition);
        return port.registerTool(id, name, definition, { ...options, createSafeOrdinaryParametersInvoker: (c: any) => {
          captures.push(c); return options.createSafeOrdinaryParametersInvoker(c);
        } });
      },
    };
    return initialize(container, { ...context, viewTools: forwarded as typeof port });
  };
  const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
  kernel.setId('app' as any); kernel.setAppExecutionInstanceId('run');
  const container = document.createElement('div'); document.body.appendChild(container);
  cleanups.push(async () => { await kernel.onClose(); container.remove(); });
  await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, container);
  const tool = () => kernel.getViewOwnedToolDefinitions()[0];
  return { kernel, container, captures, definitions, tool,
    invoke: (args: any, observed = tool(), target = observed.targets[0]) => kernel.invokeBoundOrdinaryParametersViewTool(observed, target, args) };
}
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
const params = () => ({ q: { type: 'string' as const, required: true as const, constraints: { minLength: 1 } }, limit: { type: 'number' as const, default: 7 } });
it('routes a read-only declaration through its explicit target parameter', async () => {
  const handler = vi.fn(async () => ({ success: true }));
  function Content() { useViewTypeTool('inspect', { description: 'Inspect selected document', params: { document: { type: 'string', required: true } }, isMutating: false,
    target: { param: 'document', value: 'A' } }, handler); return null; }
  const app = await setup(Content);
  expect(app.tool().targets[0].selector).toEqual({ param: 'document', value: 'A' });
  expect(await app.invoke({ document: 'B' })).toMatchObject({ phase: 'not-entered', result: { error: { code: 'INVALID_VIEW_TARGET' } } });
  expect(handler).not.toHaveBeenCalled();
  expect(await app.invoke({ document: 'A' })).toMatchObject({ result: { success: true } });
});
class Boundary extends Component<{ children?: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {}
  render() { return this.state.failed ? h('p', {}, 'Controlled fallback') : this.props.children; }
}

describe('R02–R08 real SDK/Preact/View/AppKernel ordinary-v2 capture', () => {
  it('registers once, has no legacy bypass, freezes handler input and leaves default absent', async () => {
    const handler = vi.fn(async (args: any) => {
      expect(Object.isFrozen(args)).toBe(true); expect(Object.hasOwn(args, 'limit')).toBe(false);
      return { success: true, data: { q: args.q } };
    });
    function Content() { const [Tool] = useViewTypeTool('find', { description: 'Find', params: params(), isMutating: false }, handler); return h(Tool, {}, 'Find symbols'); }
    const x = await setup(Content), source = x.tool();
    expect(x.captures).toHaveLength(1);
    expect(source.inputSchema).toEqual({ ...x.captures[0].schema, 'x-aotui-parameter-contract': 'ordinary-params-v1' });
    expect((source.inputSchema as any).additionalProperties).toBe(false);
    expect(x.container.querySelector('tool-ref')?.textContent).toBe('Find symbols');
    expect(await x.definitions[0].handler({ q: 'x' })).toMatchObject({ error: { code: 'TOOL_EXECUTION_UNAVAILABLE' } });
    expect(handler).not.toHaveBeenCalled();
    expect(await x.invoke({ q: 'x' })).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { q: 'x' } } });
    expect(await x.invoke({ q: 'x', extra: true })).toMatchObject({ phase: 'not-entered' });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('captures nested defaults/options/constraints and ignores external mutation until an actual commit', async () => {
    let update!: () => void;
    const p = { e: { type: 'enum' as const, options: ['a'] }, q: { type: 'string' as const, constraints: { minLength: 1 } }, o: { type: 'object' as const, default: { values: ['initial'] } } };
    function Content() { const [n, set] = useState(0); update = () => set(n + 1);
      useViewTypeTool('find', { description: 'Find', params: p, isMutating: false }, async () => ({ success: true })); return h('p', {}, String(n)); }
    const x = await setup(Content), old = x.tool(), schema = JSON.stringify(old.inputSchema);
    p.e.options.push('b'); p.q.constraints.minLength = 2; p.o.default.values[0] = 'changed';
    expect(JSON.stringify(x.tool().inputSchema)).toBe(schema);
    expect(await x.invoke({ e: 'a', q: 'x' }, old)).toMatchObject({ phase: 'entered-returned' });
    expect(await x.invoke({ e: 'b' }, old)).toMatchObject({ phase: 'not-entered' });
    expect(Object.isFrozen(p.o.default.values)).toBe(false);
    await act(update);
    expect(x.tool().targets[0].bindingVersion).not.toBe(old.targets[0].bindingVersion);
    expect(await x.invoke({ q: 'xx' }, old)).toMatchObject({ phase: 'not-entered' });
    expect(await x.invoke({ e: 'b', q: 'xx' })).toMatchObject({ phase: 'entered-returned' });
  });
  it('uses actual layout capture after render-time mutation and avoids a redundant next binding', async () => {
    const p = params(); let once = true, update!: () => void;
    function Content() { const [n, set] = useState(0); update = () => set(n + 1);
      useViewTypeTool('find', { description: 'Find', params: p, isMutating: false }, async () => ({ success: true })); return h('p', {}, String(n)); }
    const x = await setup(Content, undefined, { onRegister() { if (once) { once = false; p.q.constraints.minLength = 2; } } });
    const old = x.tool();
    expect((old.inputSchema as any).properties.q.minLength).toBe(2);
    expect(await x.invoke({ q: 'x' })).toMatchObject({ phase: 'not-entered' });
    expect(await x.invoke({ q: 'xx' })).toMatchObject({ phase: 'entered-returned' });
    await act(update);
    expect(x.tool().targets[0]).toEqual(old.targets[0]);
    expect(x.captures).toHaveLength(1);
  });
  it.each(['rule', 'default', 'description', 'open'])('rebinds %s without dropping annotations from identity', async kind => {
    let update!: (v: boolean) => void;
    function Content() { const [next, set] = useState(false); update = set;
      const p = params(); if (next && kind === 'rule') p.q.constraints.minLength = 2;
      if (next && kind === 'default') p.limit.default = 8;
      useViewTypeTool('find', { description: next && kind === 'description' ? 'New' : 'Find', params: p, additionalProperties: next && kind === 'open', isMutating: false }, async () => ({ success: true }));
      return h('p', {}, 'Stable'); }
    const x = await setup(Content), old = x.tool();
    await act(() => update(true));
    expect(x.tool().targets[0].bindingVersion).not.toBe(old.targets[0].bindingVersion);
    expect(await x.invoke({ q: 'xx' }, old)).toMatchObject({ phase: 'not-entered' });
    expect(await x.invoke({ q: 'xx' })).toMatchObject({ phase: 'entered-returned' });
  });
  it('keeps equivalent key order binding and publishes handlers only in layout', async () => {
    let update!: (v: boolean) => void;
    const entries: string[] = [];
    function Content() { const [next, set] = useState(false); update = set;
      const p = params(), ordered = next ? { limit: p.limit, q: p.q } : p;
      useViewTypeTool('find', { description: 'Find', params: ordered, isMutating: false }, async () => { entries.push(next ? 'new' : 'old'); return { success: true }; });
      return h('p', {}, 'Stable'); }
    const x = await setup(Content), old = x.tool();
    update(true); const pending = x.invoke({ q: 'x' }, old);
    expect(entries).toEqual(['old']);
    await pending; await act(() => {});
    expect(x.tool().targets[0]).toEqual(old.targets[0]);
    await x.invoke({ q: 'x' }, old);
    expect(entries).toEqual(['old', 'new']);
  });
  it('isolates two same-type View instances across enabled and unmount/remount transitions', async () => {
    let update!: (v: number) => void;
    const entries: string[] = [];
    function Detail({ id, enabled }: { id: string; enabled: boolean }) {
      const [Tool] = useViewTypeTool('find', { description: 'Find', params: params(), isMutating: false }, async () => { entries.push(id); return { success: true }; }, { enabled });
      return h(Tool, {});
    }
    function Root() { const [state, set] = useState(0); update = set; return h('main', {}, [
      state === 2 ? null : h(View, { key: 'aa', id: 'aa', type: 'File' }, h(Detail, { id: 'aa', enabled: state !== 1 })),
      h(View, { key: 'bb', id: 'bb', type: 'File' }, h(Detail, { id: 'bb', enabled: true })),
    ]); }
    const x = await setup(() => null, Root), old = x.tool(), [a, b] = old.targets;
    expect(x.container.querySelectorAll('tool-ref')).toHaveLength(2);
    await x.invoke({ q: 'a' }, old, a); await x.invoke({ q: 'b' }, old, b);
    expect(entries).toEqual(['aa', 'bb']);
    await act(() => update(1));
    expect(x.container.querySelectorAll('tool-ref')).toHaveLength(1);
    expect(await x.invoke({ q: 'x' }, old, a)).toMatchObject({ phase: 'not-entered' });
    expect(await x.invoke({ q: 'x' }, old, b)).toMatchObject({ phase: 'entered-returned' });
    await act(() => update(2)); await act(() => update(0));
    expect(x.tool().targets[0].viewInstanceId).not.toBe(a.viewInstanceId);
    expect(await x.invoke({ q: 'x' }, old, a)).toMatchObject({ phase: 'not-entered' });
    expect(x.tool().targets[1]).toEqual(b);
  });
  it('does not publish a failed render candidate and revokes the View on committed fallback', async () => {
    let update!: (v: boolean) => void;
    const a = vi.fn(async () => ({ success: true })), b = vi.fn(async () => ({ success: true }));
    function Content() { const [bad, set] = useState(false); update = set;
      useViewTypeTool('find', { description: 'Find', params: params(), isMutating: false }, bad ? b : a);
      if (bad) throw Error('Controlled candidate failure'); return h('p', {}, 'Stable'); }
    const x = await setup(Content, () => h(Boundary, {}, h(View, { id: 'aa', type: 'File' }, h(Content, {})))), old = x.tool();
    await act(() => update(true));
    expect(x.container.textContent).toContain('Controlled fallback');
    expect(await x.invoke({ q: 'x' }, old)).toMatchObject({ phase: 'not-entered' });
    expect(b).not.toHaveBeenCalled();
  });
  it('failed registration after render releases the previous binding', async () => {
    let update!: (v: boolean) => void, fail = false;
    function Content() { const [next, set] = useState(false); update = set;
      useViewTypeTool('find', { description: next ? 'New' : 'Find', params: params(), isMutating: false }, async () => ({ success: true })); return h('p', {}, 'Stable'); }
    const x = await setup(Content, () => h(Boundary, {}, h(View, { id: 'aa', type: 'File' }, h(Content, {}))), {
      onRegister(definition) { if (fail) definition.params.limit.default = 'Invalid default'; },
    }), old = x.tool();
    fail = true; await act(() => update(true));
    expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
    expect(await x.invoke({ q: 'x' }, old)).toMatchObject({ phase: 'not-entered' });
  });
  it.each([undefined, 'ordinary-v1', 'future', false])('explicitly rejects unsupported port %s even while disabled', async support => {
    function Content() { useViewTypeTool('find', { description: 'Find', params: params(), isMutating: false }, async () => ({ success: true }), { enabled: false }); return null; }
    await expect(setup(Content, undefined, { support })).rejects.toThrow('ORDINARY_PARAMETERS_UNSUPPORTED');
  });
  it('rejects missing fingerprint and invalid disabled declaration in all environments', async () => {
    function Missing() { useViewTypeTool('find', { description: 'Find', params: params(), isMutating: false }, async () => ({ success: true }), { enabled: false }); return null; }
    await expect(setup(Missing, undefined, { removeFingerprint: true })).rejects.toThrow('ORDINARY_PARAMETERS_UNSUPPORTED');
    for (const env of ['development', 'production']) {
      vi.stubEnv('NODE_ENV', env);
      function Invalid() { useViewTypeTool('find', { description: 'Find', params: { q: { type: 'string', constraints: { pattern: '[' } } }, isMutating: false }, async () => ({ success: true }), { enabled: false }); return null; }
      await expect(setup(Invalid)).rejects.toThrow('PARAMETER_DECLARATION_INVALID');
    }
    vi.unstubAllEnvs();
  });
});
