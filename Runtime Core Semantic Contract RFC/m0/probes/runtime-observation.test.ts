/**
 * M0 SP-03/SP-04/SP-05: runtime production-class behavior probes.
 * Copy into runtime/src/__m0_runtime_probe.test.ts before running Vitest
 * (runner script handles temporary placement and cleanup).
 */
import { describe, it, expect } from 'vitest';
import { SnapshotRegistry } from '../../../runtime/src/engine/system/registry.ts';
import { AppWorkerHost } from '../../../runtime/src/engine/app/worker-host.ts';
import { AppKernel } from '../../../runtime/src/worker-runtime/app-kernel/AppKernel.ts';

describe('M0 runtime behavioral baseline', () => {
  it('shows SnapshotRegistry retains a mutable payload and generates a new ID for unchanged content', () => {
    const registry = new SnapshotRegistry({ ttl: 10_000 });
    try {
      const source = { title: 'before', nested: { flag: 'initial' } };
      const first = registry.create({ 'v0:selected': source }, '<view>static</view>');
      const duplicate = registry.create({ 'v0:selected': source }, '<view>static</view>');
      source.title = 'after';
      source.nested.flag = 'mutated';
      const leaked = registry.resolve(first.id, 'v0:selected');
      const observation = {
        firstId: first.id,
        duplicateId: duplicate.id,
        sameId: first.id === duplicate.id,
        contentAfterExternalMutation: leaked,
      };
      console.log('M0_SNAPSHOT_STORE=' + JSON.stringify(observation));
      expect(first.id).not.toBe(duplicate.id);
      expect((leaked as any).title).toBe('after');
      expect((leaked as any).nested.flag).toBe('mutated');
    } finally {
      registry.shutdown();
    }
  });

  it('shows WorkerHost drops different valid fragments with equal millisecond timestamps', () => {
    const host = new AppWorkerHost({
      appId: 'app_0' as any,
      desktopId: 'desktop_0' as any,
      appModulePath: 'fake-not-started.js',
    });
    let updateCount = 0;
    host.onUpdateRequest = () => { updateCount++; };
    const timestamp = 1730000000000;
    const fragment = (markup: string, when = timestamp) => ({
      type: 'SNAPSHOT_FRAGMENT',
      appId: 'app_0', timestamp: when, markup, indexMap: {}, views: [],
      suppressSignal: false,
    });
    (host as any).handleMessage(fragment('first'));
    (host as any).handleMessage(fragment('second-same-ms'));
    (host as any).handleMessage(fragment('third-older', timestamp - 1));
    const observed = host.getSnapshotFragment()?.markup;
    console.log('M0_WORKER_TIMESTAMP=' + JSON.stringify({ observed, updateCount, sameMsSecondDropped: observed === 'first' }));
    expect(observed).toBe('first');
    expect(updateCount).toBe(1);
  });

  it('shows AppKernel can fall back to an unrelated same-named Ref in another view', () => {
    const kernel = new AppKernel({
      appName: 'app_test',
      name: 'Test',
      component: { initializeComponent: async () => ({ render() {}, unmount() {} }) },
    } as any);
    kernel.setId('app_0' as any);
    kernel.registerRef('view_a', 'selected', { id: 'A' });
    kernel.registerRef('view_b', 'selected', { id: 'B' });
    // No matching ViewType instance for this Ref, but suffix fallback still succeeds.
    const foreign = (kernel as any).resolveRefId('selected', [] as any);
    console.log('M0_REF_FALLBACK=' + JSON.stringify({ foreign, refKeys: Object.keys(kernel.exportRefsToIndexMap()) }));
    expect(foreign).toEqual({ id: 'A' });
  });

  it('shows Type Tool business rejection is wrapped as top-level success', async () => {
    const kernel = new AppKernel({
      appName: 'app_test',
      name: 'Test',
      component: { initializeComponent: async () => ({ render() {}, unmount() {} }) },
    } as any);
    kernel.setId('app_0' as any);
    (kernel as any).container = { querySelector: () => null };
    (kernel as any).componentRenderer = { render() {}, unmount() {} };
    kernel.registerTypeTool('Workspace', 'reject_task', {
      description: 'A deliberate business-level rejection',
      params: {},
      handler: async () => ({ success: false, error: { code: 'BUSINESS_DENIED', message: 'Rejected' } }),
    });
    const result = await kernel.callTypeTool('Workspace', 'reject_task', {});
    console.log('M0_TOOL_RESULT=' + JSON.stringify(result));
    expect(result.success).toBe(true);
    expect((result.data as any)?.success).toBe(false);
  });
});


describe('M0 SP-04/05/06 boundary checks', () => {
  it('source Snapshot ref and live AppKernel RefRegistry disagree after list reindex', async () => {
    const registry = new SnapshotRegistry({ ttl: 10_000 });
    const kernel = new AppKernel({
      appName: 'test_app', name: 'Test',
      component: { initializeComponent: async () => ({ render() {}, unmount() {} }) },
    } as any);
    kernel.setId('app_0' as any);
    (kernel as any).container = { querySelector: () => null };
    (kernel as any).componentRenderer = { render() {}, unmount() {} };
    try {
      kernel.registerRef('workspace', 'tasks[0]', { id: 'A' });
      const old = registry.create({ 'app_0:workspace:tasks[0]': { id: 'A' } }, '<view>Task A</view>');
      kernel.unregisterRef('workspace', 'tasks[0]');
      kernel.registerRef('workspace', 'tasks[0]', { id: 'B' });
      kernel.registerTypeTool('Workspace', 'pick', {
        description: 'Return selected ref id',
        params: { task: { type: 'reference' } },
        handler: async (args) => ({ success: true, data: { selectedId: (args.task as any).id } }),
      });
      const fromOldSnapshot = registry.resolve(old.id, 'app_0:workspace:tasks[0]');
      const fromCurrentWorker = (kernel as any).resolveRefId('tasks[0]', ['workspace']);
      const tool = await kernel.callTypeTool('Workspace', 'pick', { task: 'tasks[0]' });
      console.log('M0_SP05_SPLIT_REF=' + JSON.stringify({ fromOldSnapshot, fromCurrentWorker, tool }));
      expect((fromOldSnapshot as any).id).toBe('A');
      expect(fromCurrentWorker.id).toBe('B');
      expect((tool.data as any).data.selectedId).toBe('B');
    } finally {
      registry.shutdown();
    }
  });

  it('uses real worker_threads IPC to show equal-ms loss and absent appId source validation', async () => {
    const { Worker } = await import('node:worker_threads');
    const code = [
      "const {parentPort}=require('node:worker_threads');",
      "const send=(appId,markup,timestamp)=>parentPort.postMessage({type:'SNAPSHOT_FRAGMENT',appId,markup,timestamp,indexMap:{},views:[]});",
      "send('app_0','accepted',1730000000100);",
      "send('app_0','same-ms-dropped',1730000000100);",
      "send('app_other','wrong-app-accepted',1730000000101);",
    ].join('\n');
    const worker = new Worker(code, { eval: true });
    const host = new AppWorkerHost({
      appId: 'app_0' as any, desktopId: 'dt_0' as any,
      appModulePath: 'fake-worker-path.js', existingWorker: worker,
    });
    let updates = 0;
    let wake!: () => void;
    const received = new Promise<void>(resolve => { wake = resolve; });
    host.onUpdateRequest = () => { updates++; if (updates >= 2) wake(); };
    try {
      await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('IPC did not deliver snapshots in time')), 2000))]);
      const observed = host.getSnapshotFragment();
      console.log('M0_SP04_REAL_IPC=' + JSON.stringify({ hostAppId: host.appId, updates, currentMarkup: observed?.markup, appIdFieldFromHost: (observed as any)?.appId }));
      expect(updates).toBe(2);
      expect(observed?.markup).toBe('wrong-app-accepted');
    } finally {
      await worker.terminate();
    }
  });

  it('shows Workspace formatter projects two app fragments without an app revision vector', async () => {
    const { SnapshotFormatter } = await import('../../../runtime/src/engine/view/snapshot/formatter.ts');
    const formatter = new SnapshotFormatter();
    const meta: any = {
      getInstalledApps: () => [
        {appId:'app_0',name:'App A',status:'running'},
        {appId:'app_1',name:'App B',status:'running'},
      ],
      getSystemLogs: () => [],
      getAppOperationLogs: () => [],
    };
    const fragments = [0, 1].map(i => ({
      appId: 'app_' + i,
      markup: '<view>App state ' + i + '</view>',
      indexMap: { 'workspace:selected': { id: 'entity-' + i } },
      timestamp: 1730000000000 + i,
      views: [{
        viewId: 'workspace', viewType:'Workspace',
        markup: '<view>App state ' + i + '</view>', timestamp: 1730000000000 + i
      }],
    }));
    const result = formatter.format(fragments as any, meta);
    const snapshot = {
      structuredKeys: Object.keys(result.structured || {}),
      viewCount: result.structured?.viewStates?.length,
      refs: Object.keys(result.indexMap),
      vector: (result.structured as any)?.revisionVector || null,
    };
    console.log('M0_SP06_WORKSPACE_COMPOSITE=' + JSON.stringify(snapshot));
    expect(snapshot.viewCount).toBe(2);
    expect(snapshot.refs.sort()).toEqual(['app_0:workspace:selected','app_1:workspace:selected']);
    expect(snapshot.vector).toBeNull();
  });
});
