/**
 * M0 SP-01/SP-02: real SDK Hook timing probe, no production-source edits.
 * Important: import the Preact installation actually used by SDK source.
 */
import { describe, it, expect } from 'vitest';
import { h, render } from '../../../sdk/node_modules/preact/dist/preact.module.js';
import { ViewRuntimeContext } from '../../../sdk/src/contexts/view-runtime-context.ts';
import { useDataRef } from '../../../sdk/src/hooks/useRef.ts';
import { useArrayRef } from '../../../sdk/src/hooks/useArrayRef.ts';
import { useViewTypeTool } from '../../../sdk/src/hooks/useViewTypeTool.ts';

type Task = { id: string; title: string };
type Sample = { phase: string; html: string; refs: string[]; tools: string[]; refIds: Record<string, string> };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('M0 SP-01 SDK registration alignment', () => {
  it('records DOM and Ref/Tool state at synchronous and settled lifecycle moments', async () => {
    const refs = new Map<string, object>();
    const tools = new Map<string, object>();
    const samples: Sample[] = [];
    const events: string[] = [];
    const registerRef = (key: string, data: object) => { events.push('ref+' + key); refs.set(key, data); };
    const unregisterRef = (key: string) => { events.push('ref-' + key); refs.delete(key); };
    const registerTypeTool = (type: string, name: string, definition: object) => {
      events.push('tool+' + type + '.' + name); tools.set(type + '.' + name, definition);
    };
    const unregisterTypeTool = (type: string, name: string) => {
      events.push('tool-' + type + '.' + name); tools.delete(type + '.' + name);
    };
    const context: any = {
      meta: { viewId: 'workspace', appId: 'app_0', desktopId: 'desktop_0', markDirty() {} },
      refs: { registerRef, unregisterRef },
      typeTools: { registerTypeTool, unregisterTypeTool },
      operations: { registerOperation() {}, unregisterOperation() {} },
      mountable: {}, dynamic: {}, config: {},
      llmOutput: { subscribe: () => () => {}, getHistory: () => [] },
    };
    let task: Task = { id: 'a', title: 'Stable UI label' };
    let enabled = true;
    const container = document.createElement('div');
    document.body.appendChild(container);

    function App({ current, isEnabled }: { current: Task; isEnabled: boolean }) {
      const single = useDataRef('focused', current);
      const [_list, item] = useArrayRef('tasks', [current], { itemType: 'Task' });
      const [ToolUI] = useViewTypeTool('Workspace', 'complete_task', {
        description: 'Complete a selected task',
        params: {},
      }, async () => ({ success: true }), { enabled: isEnabled });
      return h('section', {}, [
        h('p', { key: 'focused' }, single('Stable UI label')),
        h('p', { key: 'item' }, item(0, 'Stable UI label')),
        h('p', { key: 'list' }, _list('Task list')),
        h(ToolUI, { key: 'tool' }, 'Complete'),
      ]);
    }
    function capture(phase: string): Sample {
      const value: Sample = {
        phase, html: container.innerHTML,
        refs: [...refs.keys()].sort(),
        tools: [...tools.keys()].sort(),
        refIds: Object.fromEntries([...refs.entries()].map(([key, value]) => [key, (value as Task).id])),
      };
      samples.push(value); return value;
    }
    function update() {
      render(h(ViewRuntimeContext.Provider as any, { value: context }, h(App, { current: task, isEnabled: enabled })), container);
    }

    try {
      update();
      const sync = capture('immediate-after-render');
      await sleep(150);
      const steady = capture('passive-effects-settled');
      expect(steady.html).toContain('(focused)');
      expect(steady.refs).toContain('focused');
      expect(steady.refs).toContain('tasks[0]');
      expect(steady.html).toContain('(Task[]:tasks)');
      expect(steady.refs).not.toContain('tasks'); // current SDK emits list label ref without list-level entry
      expect(steady.tools).toContain('Workspace.complete_task');

      let domMutationCount = 0;
      const observer = new MutationObserver((mutations) => { domMutationCount += mutations.length; });
      observer.observe(container, { childList: true, attributes: true, characterData: true, subtree: true });
      task = { id: 'b', title: 'Stable UI label' };
      update();
      const changedSync = capture('same-markup-new-ref-immediate');
      await sleep(150);
      const changedSteady = capture('same-markup-new-ref-settled');
      observer.disconnect();
      expect(changedSteady.refIds.focused).toBe('b');
      expect(changedSteady.refIds['tasks[0]']).toBe('b');

      enabled = false;
      update();
      const disabledSync = capture('tool-disabled-immediate');
      await sleep(150);
      const disabledSteady = capture('tool-disabled-settled');
      expect(disabledSteady.tools).not.toContain('Workspace.complete_task');

      render(null, container);
      await sleep(100);
      const unmounted = capture('after-unmount');
      expect(unmounted.refs).toHaveLength(0);
      expect(unmounted.tools).toHaveLength(0);

      console.log('M0_SP01_TIMELINE=' + JSON.stringify({ samples, events, domMutationCount, observations: {
        syncHasCompleteRefTool: sync.refs.includes('focused') && sync.tools.includes('Workspace.complete_task'),
        refBeforeEffect: changedSync.refIds.focused,
        refAfterEffect: changedSteady.refIds.focused,
        enabledToolBeforeEffect: disabledSync.tools.includes('Workspace.complete_task'),
        enabledToolAfterEffect: disabledSteady.tools.includes('Workspace.complete_task'),
      }}));
    } finally {
      render(null, container);
      container.remove();
    }
  });
});
