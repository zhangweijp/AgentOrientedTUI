import { describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useMemo, useState } from 'preact/hooks';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { useDataRef } from './hooks/useRef.js';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';

function setup(component: () => any) {
  const factory = createTUIApp({ app_name: 'ref_ownership', component });
  const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
  kernel.setId('ref_ownership_app' as any);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    kernel,
    container,
    open: () => kernel.onOpen({ appId: 'ref_ownership_app' as any, desktopId: 'desktop' as any,
       }, container),
    async close() { await kernel.onClose(); container.remove(); },
  };
}

const refsOf = (kernel: AppKernel) => Object.fromEntries(
  kernel.getViewRefs().map(ref => [`${ref.viewId}:${ref.refId}`, ref.value]),
);

describe('Ref registration ownership', () => {
  it('rejects a second live owner and makes update/release owner-bound and idempotent', async () => {
    const x = setup(() => null);
    await x.open();
    const firstValue = { id: 'first' };
    const first = x.kernel.registerRef('view', 'selected', firstValue);

    expect(() => x.kernel.registerRef('view', 'selected', { id: 'duplicate' }))
      .toThrow(expect.objectContaining({ code: 'REF_ALREADY_REGISTERED' }));
    expect(refsOf(x.kernel)['view:selected']).toBe(firstValue);

    const updatedValue = { id: 'updated' };
    first.update(updatedValue);
    expect(refsOf(x.kernel)['view:selected']).toBe(updatedValue);

    first.release();
    first.release();
    expect(() => first.update({ id: 'stale' })).toThrow('is no longer active');
    const successorValue = { id: 'successor' };
    const successor = x.kernel.registerRef('view', 'selected', successorValue);
    first.release();
    expect(refsOf(x.kernel)['view:selected']).toBe(successorValue);

    const closing = x.kernel.onClose();
    expect(() => successor.release()).not.toThrow();
    await closing;
    x.container.remove();
  });

  it('rejects duplicate declarations in real Preact when the later publisher keeps stable data', async () => {
    const firstValue = { id: 'first' };
    function FirstPublisher() {
      useDataRef('selected', firstValue);
      return null;
    }
    function SecondPublisher() {
      const stableValue = useMemo(() => ({ id: 'second' }), []);
      useDataRef('selected', stableValue);
      return null;
    }
    function App() {
      return h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, [
        h(FirstPublisher, { key: 'first' }),
        h(SecondPublisher, { key: 'second' }),
      ]);
    }

    const x = setup(App);
    await expect(x.open()).rejects.toMatchObject({ code: 'REF_ALREADY_REGISTERED' });
    expect(x.kernel.getViewRefs()).toEqual([]);
    await x.close();
  });

  it('updates a binding, releases renamed IDs, reuses released IDs, and releases on unmount', async () => {
    let update!: (value: { id: string; refId: string }) => void;
    function Content() {
      const [state, setState] = useState({ id: 'one', refId: 'selected' });
      update = value => setState(value);
      const value = useMemo(() => ({ id: state.id }), [state.id]);
      useDataRef(state.refId, value);
      return null;
    }
    const x = setup(() => h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {})));
    const registerRef = vi.spyOn(x.kernel, 'registerRef');
    await x.open();
    expect((refsOf(x.kernel)['workspace:selected'] as any)?.id).toBe('one');
    const initialBinding = registerRef.mock.results[0]!.value;
    const updateBinding = vi.spyOn(initialBinding, 'update');

    await act(async () => update({ id: 'two', refId: 'selected' }));
    expect(registerRef).toHaveBeenCalledOnce();
    expect(updateBinding).toHaveBeenCalledOnce();
    expect((refsOf(x.kernel)['workspace:selected'] as any)?.id).toBe('two');

    await act(async () => update({ id: 'three', refId: 'renamed' }));
    expect(refsOf(x.kernel)['workspace:selected']).toBeUndefined();
    expect((refsOf(x.kernel)['workspace:renamed'] as any)?.id).toBe('three');

    await act(async () => update({ id: 'four', refId: 'selected' }));
    expect((refsOf(x.kernel)['workspace:selected'] as any)?.id).toBe('four');
    expect(refsOf(x.kernel)['workspace:renamed']).toBeUndefined();
    expect(registerRef).toHaveBeenCalledTimes(3);

    await x.close();
    expect(x.kernel.getViewRefs()).toEqual([]);
  });

  it('releases all ArrayRef bindings if a later registration fails', () => {
    const refs = new Map<string, object>();
    const registry = {
      registerRef(id: string, value: object) {
        if (id === 'pending[1]') {
          const error = new Error('controlled Ref registration failure');
          Object.assign(error, { code: 'REF_ALREADY_REGISTERED' });
          throw error;
        }
        const binding = { update(next: object) { refs.set(id, next); }, release() { refs.delete(id); } };
        refs.set(id, value);
        return binding;
      },
    };
    function Content() {
      useArrayRef('pending', [{ id: 'A' }, { id: 'B' }], { itemType: 'Task' });
      return null;
    }
    const container = document.createElement('div');
    expect(() => render(h(ViewRuntimeContext.Provider, {
      value: { meta: {}, refs: registry } as any,
    }, h(Content, {})), container)).toThrow('controlled Ref registration failure');
    expect([...refs.keys()]).toEqual([]);
    render(null, container);
  });
});
