import { h, Component, options } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { createTUIApp } from '@fixture/sdk/app-factory/createTUIApp.js';
import { View } from '@fixture/sdk/components/View.js';
import { useViewTypeTool } from '@fixture/sdk/hooks/useViewTypeTool.js';
import { useAppRuntimeContext } from '@fixture/sdk/context/AppRuntimeContext.js';
import { View as OldView } from '@fixture/old-sdk/components/View.js';
import { AppRuntimeContext as OldContext } from '@fixture/old-sdk/context/AppRuntimeContext.js';
import { useViewTypeTool as oldTool } from '@fixture/old-sdk/hooks/useViewTypeTool.js';
import { WorkspaceCreateView } from '@fixture/ide/tui/WorkspaceCreateView.js';
import { fileSystemService } from '@fixture/ide/core/file-system-service.js';

const base = process.env.AOTUI_CREATE_DIR;
const roots = Object.fromEntries(['A', 'B', 'C'].map((label) => [label, path.join(base, label)]));
const faults = new Map(),
  gates = new Map(),
  closedPaths = new Set();
const metrics = {
  creatorEntries: {},
  openAttempts: 0,
  opened: 0,
  nativeWrites: 0,
  nativeCloses: 0,
  activeHandles: 0,
  readEntries: 0,
  uiThrows: 0,
  uiFallbackCommits: 0,
};
let readBarrier = false,
  readRelease,
  uiTarget = null;
const send = (type, data = {}) => parentPort.postMessage({ type, ...data });
function hold(target, stage) {
  return new Promise((resolve) => {
    let set = gates.get(target);
    if (!set) gates.set(target, (set = new Set()));
    set.add(resolve);
    send('TEST_FS_BARRIER', { target, stage });
  });
}
function release(target) {
  const set = gates.get(target);
  gates.delete(target);
  for (const resolve of set ?? []) resolve();
  faults.delete(target);
}
const originalOpen = fs.open;
const nativeOpen = originalOpen.bind(fs);
const instrumentedOpen = async (target, flags, mode) => {
  if (
    flags !== 'wx' ||
    typeof target !== 'string' ||
    !Object.values(roots).some((root) => target.startsWith(root + path.sep))
  )
    return nativeOpen(target, flags, mode);
  metrics.openAttempts++;
  const fault = faults.get(target);
  send('TEST_OPEN_ATTEMPT', { target, flags, mode });
  if (fault === 'before-open-hold') await hold(target, 'before-open');
  if (fault === 'unknown-open')
    throw {
      get message() {
        throw Error('W06_PRIVATE_SENTINEL');
      },
      get code() {
        throw Error('W06_PRIVATE_SENTINEL');
      },
    };
  const handle = await nativeOpen(target, flags, mode);
  metrics.opened++;
  metrics.activeHandles++;
  send('TEST_OPENED', { target });
  if (fault === 'forged-open-error') {
    await handle.close();
    metrics.nativeCloses++;
    metrics.activeHandles--;
    send('TEST_CLOSED', { target });
    throw Object.assign(Error('Synthetic untrusted open error'), { code: 'EEXIST' });
  }
  if (fault === 'after-open-hold') await hold(target, 'after-open');
  return {
    writeFile: async (data) => {
      if (fault === 'zero-write') throw Error('Controlled zero-byte write failure');
      if (fault === 'partial-write') {
        await handle.writeFile(data.subarray(0, 3));
        metrics.nativeWrites++;
        send('TEST_WRITTEN', { target, bytes: 3 });
        throw Error('Controlled partial write failure');
      }
      await handle.writeFile(data);
      metrics.nativeWrites++;
      send('TEST_WRITTEN', { target, bytes: data.byteLength });
    },
    close: async () => {
      await handle.close();
      metrics.nativeCloses++;
      metrics.activeHandles--;
      closedPaths.add(target);
      send('TEST_CLOSED', { target });
      if (fault === 'close-fail') throw Error('Controlled close uncertainty');
      if (fault === 'after-close-hold') await hold(target, 'after-close');
    },
  };
};
fs.open = instrumentedOpen;
const creators = {};
for (const label of ['A', 'B', 'C']) {
  const actual = await fileSystemService.createWorkspaceFileCreator(roots[label]);
  creators[label] = async (input) => {
    metrics.creatorEntries[label] = (metrics.creatorEntries[label] ?? 0) + 1;
    send('TEST_CREATOR_ENTERED', { label, relativePath: input.relativePath });
    return actual(input);
  };
}
// Out-of-band test cleanup can release a native barrier after the product Scope has closed.
parentPort.on('message', (m) => {
  if (['APP_SHUTDOWN', 'RESET'].includes(m?.type))
    send('TEST_LIFECYCLE_RECEIVED', { lifecycle: m.type });
  if (m?.type === 'TEST_RELEASE') release(m.target);
  if (m?.type === 'TEST_METRICS') send('TEST_METRICS_RESULT', { tag: m.tag, metrics });
});
class Boundary extends Component {
  constructor(p) {
    super(p);
    this.state = { failed: false };
  }
  componentDidCatch(error) {
    const message =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'message')?.value
        : undefined;
    if (typeof message === 'string' && message.startsWith('CREATE_IF_ABSENT_UNSUPPORTED:'))
      send('TEST_UNSUPPORTED_CREATION', {
        viewId: this.props.viewId,
        code: 'CREATE_IF_ABSENT_UNSUPPORTED',
      });
    send('TEST_UI_CAUGHT', { viewId: this.props.viewId });
    this.setState({ failed: true });
  }
  render() {
    return this.state.failed ? h(Fallback, { viewId: this.props.viewId }) : this.props.children;
  }
}
function Fallback({ viewId }) {
  useLayoutEffect(() => {
    metrics.uiFallbackCommits++;
    send('TEST_UI_FALLBACK_COMMITTED', { viewId });
  }, []);
  return h('p', {}, 'Workspace creation result failed to render');
}
function ReadProbe() {
  useViewTypeTool(
    'read_probe',
    { description: 'Read current test workspace counters', params: {}, isMutating: false },
    async () => {
      metrics.readEntries++;
      send('TEST_READ_ENTERED');
      if (readBarrier)
        return new Promise((resolve) => {
          readRelease = () =>
            resolve({ success: true, data: { readEntries: metrics.readEntries } });
        });
      return { success: true, data: { readEntries: metrics.readEntries } };
    }
  );
  return h('p', {}, 'Stable read-only companion');
}
const params = {
  relativePath: { type: 'string', required: true, desc: 'Relative path in this workspace' },
  content: { type: 'string', required: true, desc: 'Exact UTF-8 text to create' },
};
function LegacyContent() {
  oldTool(
    'create_file_if_absent',
    {
      description:
        'Create a new file in this workspace. The parent must already exist; existing files are never overwritten.',
      params,
      isMutating: true,
    },
    async () => {
      send('TEST_LEGACY_CREATE_ENTERED');
      return {
        success: false,
        error: { code: 'LEGACY_DISABLED', message: 'No creation through old wrapper' },
      };
    }
  );
  return h('p', {}, 'Legacy SDK registration');
}
function Root() {
  const context = useAppRuntimeContext();
  const [views, setViews] = useState([
    { id: 'aa', workspace: 'A', generation: 1 },
    { id: 'bb', workspace: 'B', generation: 1 },
  ]);
  useLayoutEffect(() => {
    fs.open = instrumentedOpen;
    const prior = options.vnode;
    const intercept = (vnode) => {
      prior?.(vnode);
      const content = vnode.type === 'pre' ? vnode.props.children : null;
      if (
        uiTarget &&
        closedPaths.has(uiTarget) &&
        typeof content === 'string' &&
        content.includes('filePath: ' + uiTarget)
      ) {
        const target = uiTarget;
        uiTarget = null;
        metrics.uiThrows++;
        send('TEST_UI_THROW', { target, nativeWriteAndCloseCompleted: true });
        throw Error('W06 controlled result render failure');
      }
    };
    options.vnode = intercept;
    const listener = (event) => {
      const e = event.detail;
      if (e.type === 'fault') faults.set(e.data.target, e.data.mode);
      if (e.type === 'release') release(e.data.target);
      if (e.type === 'read-mode') readBarrier = e.data.hold === true;
      if (e.type === 'release-read') readRelease?.();
      if (e.type === 'ui-failure') uiTarget = e.data.target;
      if (e.type === 'swap')
        setViews((p) =>
          p.map((v) => (v.id === e.data.viewId ? { ...v, workspace: e.data.workspace } : v))
        );
      if (e.type === 'remount')
        setViews((p) =>
          p.map((v) =>
            v.id === e.data.viewId
              ? { ...v, workspace: e.data.workspace, generation: v.generation + 1 }
              : v
          )
        );
      if (e.type === 'unmount') setViews((p) => p.filter((v) => v.id !== e.data.viewId));
      send('TEST_CONTROL_ACK', { tag: e.data.tag, control: e.type, metrics });
    };
    document.body.addEventListener('aotui:external-event', listener);
    return () => {
      document.body.removeEventListener('aotui:external-event', listener);
      if (options.vnode === intercept) options.vnode = prior;
      if (fs.open === instrumentedOpen) fs.open = originalOpen;
    };
  }, []);
  return h('main', {}, [
    h(
      'p',
      {},
      'Observe the workspace target before creating. Use create_file_if_absent with relativePath and content. Parents must exist. Uncertain completion must not be retried automatically.'
    ),
    ...views.map((v) =>
      process.env.AOTUI_CREATE_OLD_SDK === 'true'
        ? h(
            OldContext.Provider,
            { key: v.id + v.generation, value: context },
            h(
              OldView,
              { id: v.id, type: 'WorkspaceCreate', name: v.workspace },
              h(LegacyContent, {})
            )
          )
        : h(
            Boundary,
            { key: v.id + v.generation, viewId: v.id },
            h(WorkspaceCreateView, {
              viewId: v.id,
              workspaceLabel: v.workspace,
              creator: creators[v.workspace],
            })
          )
    ),
    h(View, { id: 'probe', type: 'ReadProbe', key: 'probe' }, h(ReadProbe, {})),
  ]);
}
export default createTUIApp({ app_name: 'ide_create_slice', component: Root });
