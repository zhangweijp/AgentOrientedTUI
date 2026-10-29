/**
 * M0 SP-02 candidate demonstration ONLY: SDK-commit-phase coordinator.
 * Does not patch the production SDK. Shows one feasible synchronization model.
 * Proves bounded, synchronous Preact layout-effect coordination, not async readiness in all apps.
 */
import { describe, it, expect } from 'vitest';
import { h, render } from '../../../sdk/node_modules/preact/dist/preact.module.js';
import { useLayoutEffect } from '../../../sdk/node_modules/preact/hooks/dist/hooks.module.js';

type Snapshot = { epoch: number; html: string; views: string[]; refs: Record<string,string>; tools: string[] };

describe('M0 SP-02 candidate ProjectionCoordinator', () => {
  it('coalesces layout registration and semantic-only changes into coherent snapshots', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const views = new Set<string>();
    const refs = new Map<string,string>();
    const tools = new Set<string>();
    const committed: Snapshot[] = [];
    let epoch = 0;
    let scheduled = false;

    function invalidate() {
      epoch++;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        // Commit after all *synchronous* layout effects in this render turn.
        const snapshot = {
          epoch, html: host.innerHTML,
          views: [...views].sort(),
          refs: Object.fromEntries([...refs.entries()]),
          tools: [...tools].sort(),
        };
        committed.push(snapshot);
      });
    }
    function App({ target, enabled }: { target: string; enabled: boolean }) {
      useLayoutEffect(() => {
        views.add('workspace'); invalidate();
        return () => { views.delete('workspace'); invalidate(); };
      }, []);
      useLayoutEffect(() => {
        refs.set('workspace:selected', target); invalidate();
        return () => { refs.delete('workspace:selected'); invalidate(); };
      }, [target]);
      useLayoutEffect(() => {
        if (!enabled) { tools.delete('Workspace.complete'); invalidate(); return; }
        tools.add('Workspace.complete'); invalidate();
        return () => { tools.delete('Workspace.complete'); invalidate(); };
      }, [enabled]);
      return h('section', {}, h('span', {}, '[Stable](selected)'));
    }

    try {
      render(h(App, { target: 'A', enabled: true }), host);
      await Promise.resolve();
      const initial = committed.at(-1)!;
      expect(initial.views).toEqual(['workspace']);
      expect(initial.refs['workspace:selected']).toBe('A');
      expect(initial.tools).toEqual(['Workspace.complete']);

      let mutations = 0;
      const observer = new MutationObserver(records => { mutations += records.length; });
      observer.observe(host,{childList:true,subtree:true,characterData:true,attributes:true});
      render(h(App, { target: 'B', enabled: true }), host);
      await Promise.resolve();
      const updated = committed.at(-1)!;
      observer.disconnect();
      expect(updated.refs['workspace:selected']).toBe('B');
      expect(updated.html).toBe(initial.html);
      expect(mutations).toBe(0);
      expect(updated.epoch).toBeGreaterThan(initial.epoch);

      render(h(App,{target:'B',enabled:false}),host);
      await Promise.resolve();
      const toolOff = committed.at(-1)!;
      expect(toolOff.tools).toEqual([]);
      expect(toolOff.refs['workspace:selected']).toBe('B');
      expect(toolOff.html).toBe(initial.html);

      render(null,host);
      await Promise.resolve();
      const unmounted = committed.at(-1)!;
      expect(unmounted.views).toEqual([]);
      expect(unmounted.tools).toEqual([]);
      expect(Object.keys(unmounted.refs)).toEqual([]);

      console.log('M0_SP02_COORDINATOR_POC=' + JSON.stringify({ committed, domMutationsForRefOnly: mutations,
        limitation: 'Uses custom layout-effect hooks; does not establish current SDK flush-ready guarantee or cross-async atomicity.' }));
    } finally {
      render(null,host);
      host.remove();
    }
  });
});
