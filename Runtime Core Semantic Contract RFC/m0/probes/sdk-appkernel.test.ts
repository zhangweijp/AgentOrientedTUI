/**
 * M0 SP-01/SP-02: real createTUIApp -> View -> AppKernel integration (jsdom).
 * Runner temporarily copies this file into sdk/src and rewrites repo-root paths.
 */
import { describe, it, expect } from 'vitest';
import { h } from '../../../sdk/node_modules/preact/dist/preact.module.js';
import { useState } from '../../../sdk/node_modules/preact/hooks/dist/hooks.module.js';
import { createTUIApp } from '../../../sdk/src/app-factory/createTUIApp.ts';
import { View } from '../../../sdk/src/components/View.tsx';
import { useDataRef } from '../../../sdk/src/hooks/useRef.ts';
import { useViewTypeTool } from '../../../sdk/src/hooks/useViewTypeTool.ts';
import { AppKernel } from '../../../runtime/src/worker-runtime/app-kernel/AppKernel.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function setup(component: any) {
  const factory = createTUIApp({ app_name: 'probe_app', component });
  const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
  kernel.setId('app_0' as any);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const marks: string[] = [];
  return {
    kernel, root, marks,
    start: async () => kernel.onOpen({
      appId: 'app_0' as any,
      desktopId: 'desktop_0' as any,
      markDirty: () => { marks.push('dirty'); },
      onRender: () => {},
    }, root),
    cleanup: async () => {
      await kernel.onClose();
      root.remove();
    },
  };
}

describe('M0 SP-01 live SDK factory + AppKernel', () => {
  it('initial component View exists before passive Ref + ViewTypeTool registration', async () => {
    function Content() {
      const ref = useDataRef('current', { id: 'a', label: 'example' });
      const [ToolUI] = useViewTypeTool('Workspace', 'inspect', {
        description: 'Inspect selection',
        params: {},
      }, async () => ({ success: true }));
      return h('section', {}, [
        h('p', { key: 'ref' }, ref('Stable')),
        h(ToolUI, { key: 'tool' }, 'Inspect'),
      ]);
    }
    function App() { return h(View, { id: 'workspace', type: 'Workspace', name: 'Workspace' }, h(Content, {})); }
    const x = setup(App);
    try {
      await x.start();
      const before = {
        viewCount: (x.kernel as any).viewRegistry.getAll().length,
        refs: Object.keys(x.kernel.exportRefsToIndexMap()),
        tools: Array.from(x.kernel.getAllTypeTools().keys()),
        domContainsRef: x.root.innerHTML.includes('(current)'),
        dirtyCount: x.marks.length,
      };
      await sleep(140);
      const after = {
        viewCount: (x.kernel as any).viewRegistry.getAll().length,
        refs: Object.keys(x.kernel.exportRefsToIndexMap()),
        tools: Array.from(x.kernel.getAllTypeTools().keys()),
        domContainsRef: x.root.innerHTML.includes('(current)'),
        dirtyCount: x.marks.length,
      };
      console.log('M0_REAL_APPKERNEL_START=' + JSON.stringify({ before, after }));
      expect(after.viewCount).toBe(1);
      expect(after.refs).toContain('workspace:current');
      expect(after.tools).toContain('Workspace');
    } finally {
      await x.cleanup();
    }
  });

  it('ref-only state change updates live RefRegistry without a dirty signal or DOM change', async () => {
    let update!: (next: { id: string }) => void;
    function Content() {
      const [target, setTarget] = useState({ id: 'a' });
      update = setTarget;
      const ref = useDataRef('current', target);
      return h('p', {}, ref('Stable'));
    }
    function App() { return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {})); }
    const x = setup(App);
    try {
      await x.start();
      await sleep(150);
      const before = {
        refs: (x.kernel.exportRefsToIndexMap() as any)['workspace:current'],
        dirtyCount: x.marks.length,
        html: x.root.innerHTML,
      };
      let domMutations = 0;
      const observer = new MutationObserver(records => { domMutations += records.length; });
      observer.observe(x.root, { childList: true, attributes: true, characterData: true, subtree: true });
      update({ id: 'b' });
      await sleep(150);
      const after = {
        refs: (x.kernel.exportRefsToIndexMap() as any)['workspace:current'],
        dirtyCount: x.marks.length,
        html: x.root.innerHTML,
        domMutations,
      };
      observer.disconnect();
      console.log('M0_REAL_APPKERNEL_REF_ONLY=' + JSON.stringify({ before, after }));
      expect(before.refs.id).toBe('a');
      expect(after.refs.id).toBe('b');
      expect(after.domMutations).toBe(0);
      expect(after.dirtyCount).toBe(before.dirtyCount);
    } finally {
      await x.cleanup();
    }
  });
});
