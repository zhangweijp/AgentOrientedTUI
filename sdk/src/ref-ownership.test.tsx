import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { useDataRef } from './hooks/useRef.js';
import { createRefCapture } from '@aotui/runtime/spi';
import { useRefRegistry, ViewRuntimeContext, type RefRegistry } from './contexts/view-runtime-context.js';

import {defineViewType} from './tools/view-type-tool.js';
const RecordType=defineViewType({name:'Record'});
const WorkspaceType=defineViewType({name:'Workspace'});
function setup(component: () => any) {
  const factory = createTUIApp({ app_name: 'ref_ownership', viewTypes:[RecordType,WorkspaceType], component });
  const kernel = new AppKernel({ ...factory.kernelConfig, factory } as any);
  kernel.setId('ref_ownership_app' as any);
  kernel.enableAppLifecycle();
  return {
    kernel,
    get container() { return document.getElementById('app-root-ref_ownership_app')!; },
    open: () => kernel.onOpen({ appId: 'ref_ownership_app' as any, desktopId: 'desktop' as any,
       }),
    async close() { await kernel.onClose(); },
  };
}

const refsOf = (kernel: AppKernel) => Object.fromEntries(
  kernel.getViewRefs().map(ref => [`${ref.viewId}:${ref.refId}`, ref.value]),
);

describe('Ref registration ownership', () => {
  it('rejects a second live owner and makes update/release owner-bound and idempotent', async () => {
    const values = [{ id: 'first' }, { id: 'updated' }, { id: 'successor' }];
    let advance!: (step: number) => void;
    let first!: ReturnType<RefRegistry['registerRef']>;
    let successor!: ReturnType<RefRegistry['registerRef']>;
    function Content() {
      const [step, setStep] = useState(0);
      advance = setStep;
      const { captureRef, registerRef } = useRefRegistry();
      const capture = captureRef(values[step]);
      useLayoutEffect(() => {
        if (step === 0) {
          first = registerRef('selected', capture);
          expect(() => registerRef('selected', capture)).toThrow(expect.objectContaining({ code: 'REF_ALREADY_REGISTERED' }));
        } else if (step === 1) {
          first.update(capture);
        } else {
          first.release();
          first.release();
          expect(() => first.update(capture)).toThrow('is no longer active');
          successor = registerRef('selected', capture);
          first.release();
        }
      });
      return null;
    }
    const x = setup(() => h(View, { id: 'view', type: RecordType, kind: 'state' }, h(Content, {})));
    try {
      await x.open();
      expect(refsOf(x.kernel)['view:selected']).toEqual(values[0]);
      expect(refsOf(x.kernel)['view:selected']).not.toBe(values[0]);
      await act(() => advance(1));
      expect(refsOf(x.kernel)['view:selected']).toEqual(values[1]);
      await act(() => advance(2));
      expect(refsOf(x.kernel)['view:selected']).toEqual(values[2]);
    } finally {
      await x.close();
    }
    expect(() => successor.release()).not.toThrow();
    expect(x.kernel.getViewRefs()).toEqual([]);
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
      return h(View, {kind: 'state', id: 'workspace', type: WorkspaceType }, [
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
    const x = setup(() => h(View, {kind: 'state', id: 'workspace', type: WorkspaceType }, h(Content, {})));
    await x.open();
    expect(refsOf(x.kernel)['workspace:selected']).toEqual({ id: 'one' });

    await act(async () => update({ id: 'two', refId: 'selected' }));
    expect(refsOf(x.kernel)['workspace:selected']).toEqual({ id: 'two' });

    await act(async () => update({ id: 'three', refId: 'renamed' }));
    expect(refsOf(x.kernel)['workspace:selected']).toBeUndefined();
    expect(refsOf(x.kernel)['workspace:renamed']).toEqual({ id: 'three' });

    await act(async () => update({ id: 'four', refId: 'selected' }));
    expect(refsOf(x.kernel)['workspace:selected']).toEqual({ id: 'four' });
    expect(refsOf(x.kernel)['workspace:renamed']).toBeUndefined();

    await x.close();
    expect(x.kernel.getViewRefs()).toEqual([]);
  });

  it('releases all ArrayRef bindings if a later registration fails', () => {
    const refs = new Map<string, object>();
    const registry = {
      captureRef: createRefCapture(),
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
      value: { viewId: 'example', ...registry },
    }, h(Content, {})), container)).toThrow('controlled Ref registration failure');
    expect([...refs.keys()]).toEqual([]);
    render(null, container);
  });
});
