import FixtureType from 'typebox';
import { preparedRefs } from './__tests__/projection-facts.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { describe, expect, it } from 'vitest';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { useContext, useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { DynamicView } from './components/View.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { useDataRef } from './hooks/useRef.js';
import { ViewRuntimeContext, type RefRegistry } from './contexts/view-runtime-context.js';

import {defineViewType} from './tools/view-type-tool.js';
const RecordType=defineViewType({ multiplicity: 'multiple',name:'Record'});
const WorkspaceType=defineViewType({ multiplicity: 'multiple',name:'Workspace'});
function setup(component: () => any) {
  const factory = createTUIApp({ app_name: 'ref_ownership', viewTypes:[RecordType,WorkspaceType], component });
  const kernel = new AppKernel({ factory,
      appId: createAppId('ref_ownership_app'), desktopId: createDesktopId('desktop'),
      instanceId: 'ref-ownership-run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
  });
  return {
    kernel,
    open: () => kernel.onOpen(),
    async close() { await kernel.onClose(); },
  };
}

const refsOf = (kernel: AppKernel) => Object.fromEntries(
  preparedRefs(kernel).map(ref => [`${ref.viewId}:${ref.refId}`, ref.value]),
);

describe('Ref registration ownership', () => {
  it.each([
    ['useDataRef', 'items', () => useDataRef('items', { private: 'RefPayload' }, { schema: FixtureType.Object({}), scope: 'protected' })],
    ['useArrayRef', 'unsafe\nlabel', () => useArrayRef('unsafe\nlabel', ['RefPayload'], { schema: FixtureType.Array(FixtureType.String()), scope: 'protected' })],
  ] as const)('explains how to move %s into its View', async (hook, id, publish) => {
    const x = setup(function Page() {
      publish();
      return h(DynamicView, { idPrefix: 'files', type: RecordType, });
    });
    try {
      let message;
      await expect(x.open().catch(error => {
        message = error.message;
        throw error;
      })).rejects.toThrow('must run in a child component of <StaticView>, <DynamicView>');
      expect(message).toContain(hook);
      if (id === 'items') expect(message).toContain('"items"');
      else expect(message).not.toContain('unsafe');
      expect(message).not.toMatch(/RefPayload|"files"/);
    } finally {
      await x.close();
    }
  });

  it('rejects a second live owner and makes update/release owner-bound and idempotent', async () => {
    const values = [{ id: 'first' }, { id: 'updated' }, { id: 'successor' }];
    let advance!: (step: number) => void;
    let first!: ReturnType<RefRegistry['registerRef']>;
    let successor!: ReturnType<RefRegistry['registerRef']>;
    function Content() {
      const [step, setStep] = useState(0);
      advance = setStep;
      const { captureRef, registerRef } = useContext(ViewRuntimeContext)!;
      const publication = { id: 'selected', scope: 'protected' as const, valueSchema: { type: 'object' }, capture: captureRef(values[step]) };
      useLayoutEffect(() => {
        if (step === 0) {
          first = registerRef(publication);
          expect(() => registerRef(publication)).toThrow(expect.objectContaining({ code: 'REF_ALREADY_REGISTERED' }));
        } else if (step === 1) {
          first.update(publication);
        } else {
          first.release();
          first.release();
          expect(() => first.update(publication)).toThrow('Invalid Ref binding');
          successor = registerRef(publication);
          first.release();
        }
      });
      return null;
    }
    const x = setup(() => h(DynamicView, { idPrefix: 'view', type: RecordType, }, h(Content, {})));
    try {
      await x.open();
      expect(refsOf(x.kernel)['view_1:selected']).toEqual(values[0]);
      expect(refsOf(x.kernel)['view_1:selected']).not.toBe(values[0]);
      await act(() => advance(1));
      expect(refsOf(x.kernel)['view_1:selected']).toEqual(values[1]);
      await act(() => advance(2));
      expect(refsOf(x.kernel)['view_1:selected']).toEqual(values[2]);
    } finally {
      await x.close();
    }
    expect(() => successor.release()).not.toThrow();
    expect(preparedRefs(x.kernel)).toEqual([]);
  });

  it('rejects duplicate declarations in real Preact when the later publisher keeps stable data', async () => {
    const firstValue = { id: 'first' };
    function FirstPublisher() {
      useDataRef('selected', firstValue, { schema: FixtureType.Object({}), scope: 'protected' });
      return null;
    }
    function SecondPublisher() {
      const stableValue = useMemo(() => ({ id: 'second' }), []);
      useDataRef('selected', stableValue, { schema: FixtureType.Object({}), scope: 'protected' });
      return null;
    }
    function App() {
      return h(DynamicView, {idPrefix: 'workspace', type: WorkspaceType }, [
        h(FirstPublisher, { key: 'first' }),
        h(SecondPublisher, { key: 'second' }),
      ]);
    }

    const x = setup(App);
    await expect(x.open()).rejects.toMatchObject({ code: 'REF_ALREADY_REGISTERED' });
    expect(preparedRefs(x.kernel)).toEqual([]);
    await x.close();
  });

  it('updates a binding, releases renamed IDs, reuses released IDs, and releases on unmount', async () => {
    let update!: (value: { id: string; refId: string }) => void;
    function Content() {
      const [state, setState] = useState({ id: 'one', refId: 'selected' });
      update = value => setState(value);
      const value = useMemo(() => ({ id: state.id }), [state.id]);
      useDataRef(state.refId, value, { schema: FixtureType.Object({}), scope: 'protected' });
      return null;
    }
    const x = setup(() => h(DynamicView, {idPrefix: 'workspace', type: WorkspaceType }, h(Content, {})));
    await x.open();
    expect(refsOf(x.kernel)['workspace_1:selected']).toEqual({ id: 'one' });

    await act(async () => update({ id: 'two', refId: 'selected' }));
    expect(refsOf(x.kernel)['workspace_1:selected']).toEqual({ id: 'two' });

    await act(async () => update({ id: 'three', refId: 'renamed' }));
    expect(refsOf(x.kernel)['workspace_1:selected']).toBeUndefined();
    expect(refsOf(x.kernel)['workspace_1:renamed']).toEqual({ id: 'three' });

    await act(async () => update({ id: 'four', refId: 'selected' }));
    expect(refsOf(x.kernel)['workspace_1:selected']).toEqual({ id: 'four' });
    expect(refsOf(x.kernel)['workspace_1:renamed']).toBeUndefined();

    await x.close();
    expect(preparedRefs(x.kernel)).toEqual([]);
  });

  it('registers a 100-item ArrayRef as one binding and releases it on unmount', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: 'item_' + index }));
    function Content() {
      useArrayRef('pending', items, { schema: FixtureType.Array(FixtureType.Object({})), scope: 'protected', itemType: 'Task' });
      return null;
    }
    const x = setup(() => h(DynamicView, { idPrefix: 'workspace', type: WorkspaceType }, h(Content, {})));
    try {
      await x.open();
      expect(preparedRefs(x.kernel)).toEqual([
        { viewId: 'workspace_1', refId: 'pending', refType: 'Task', value: items },
      ]);
    } finally { await x.close(); }
    expect(preparedRefs(x.kernel)).toEqual([]);
  });
});
