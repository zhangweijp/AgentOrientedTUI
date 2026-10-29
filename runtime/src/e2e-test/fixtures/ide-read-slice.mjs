import { h, Component } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import Emittery from 'emittery';
import { createTUIApp } from '@fixture/sdk/app-factory/createTUIApp.js';
import { View } from '@fixture/sdk/components/View.js';
import { useViewTypeTool } from '@fixture/sdk/hooks/useViewTypeTool.js';
import { useDataRef } from '@fixture/sdk/hooks/useRef.js';
import { FileDetailView } from '@fixture/ide/tui/FileDetailContent.js';
import { lspService, fileSystemService } from '@fixture/ide/core/index.js';

// Real component, SDK, Emittery and file reads; only the external LSP boundary is controlled.
const bus = new Emittery(),
  requests = new Map();
const directory = process.env.AOTUI_IDE_FILES_DIR;
const paths = {
  A: join(directory, 'A.ts'),
  B: join(directory, 'B.ts'),
  C: join(directory, 'C.ts'),
};
let lspCalls = 0,
  fsCalls = 0,
  ordinaryCalls = 0,
  refCalls = 0,
  releaseOrdinary,
  releaseRef;
let mode = 'success';
let failRead = false;
const realRead = fileSystemService.readFile.bind(fileSystemService);
fileSystemService.readFile = async (path) => {
  fsCalls++;
  if (failRead) throw Error('controlled read failure');
  return realRead(path);
};
lspService.getDiagnostics = (path) =>
  new Promise((resolve, reject) => {
    const id = ++lspCalls;
    requests.set(id, { resolve, reject, path });
    parentPort.postMessage({ type: 'TEST_LSP_REQUEST', id, path });
  });
function RefContent() {
  const [value, set] = useState('one');
  const ref = useDataRef('file', { value });
  useLayoutEffect(() => {
    const listener = (e) => {
      if (e.detail.type === 'ref-update') set(e.detail.data.value);
    };
    document.body.addEventListener('aotui:external-event', listener);
    return () => document.body.removeEventListener('aotui:external-event', listener);
  }, []);
  useViewTypeTool(
    'ref_read',
    {
      description: 'Read original Ref value',
      params: { file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } },
      isMutating: false,
    },
    async (args) => {
      refCalls++;
      if (mode === 'ref-barrier') {
        parentPort.postMessage({ type: 'TEST_REF_ENTERED' });
        return new Promise((resolve) => {
          releaseRef = () => resolve({ success: true, data: { args, refCalls } });
        });
      }
      return { success: true, data: { args, refCalls } };
    }
  );
  return h('p', {}, ref('Stable Ref'));
}
function Probe() {
  const [state, set] = useState({ revision: 1, enabled: true, bad: false });
  useLayoutEffect(() => {
    const listener = (e) => {
      if (e.detail.type === 'probe-update') set((p) => ({ ...p, ...e.detail.data }));
    };
    document.body.addEventListener('aotui:external-event', listener);
    return () => document.body.removeEventListener('aotui:external-event', listener);
  }, []);
  useViewTypeTool(
    'query',
    { description: 'Read committed probe state', params: {}, isMutating: false },
    async () => {
      ordinaryCalls++;
      if (mode === 'ordinary-barrier') {
        parentPort.postMessage({ type: 'TEST_ORDINARY_ENTERED' });
        return new Promise((resolve) => {
          releaseOrdinary = () =>
            resolve({ success: true, data: { revision: state.revision, ordinaryCalls } });
        });
      }
      if (mode === 'false')
        return { success: false, error: { code: 'E_INVALID_ARGS', message: '' } };
      if (mode === 'throw')
        throw {
          get message() {
            throw Error('W05_PRIVATE_SENTINEL');
          },
        };
      return {
        success: true,
        data: { revision: state.revision, ordinaryCalls, lspCalls, fsCalls, refCalls },
      };
    },
    { enabled: state.enabled }
  );
  if (state.bad) throw Error('W05 controlled internal failed render');
  return h('p', {}, 'Stable probe');
}
class Boundary extends Component {
  constructor(p) {
    super(p);
    this.state = { failed: false };
  }
  componentDidCatch() {
    this.setState({ failed: true });
  }
  render() {
    return this.state.failed ? h('p', {}, 'Explicit failed fallback') : this.props.children;
  }
}
function Root() {
  const [views, setViews] = useState([
    { id: 'aa', path: paths.A, key: 1 },
    { id: 'bb', path: paths.B, key: 1 },
  ]);
  useLayoutEffect(() => {
    const listener = async (event) => {
      const e = event.detail;
      try {
        if (e.type === 'diagnostics')
          await bus.emit('lsp_diagnostics_result', {
            operationName: 'lsp_get_diagnostics',
            source: 'manual',
            status: 'success',
            updatedAt: 0,
            ...e.data,
          });
        if (e.type === 'refresh') await bus.emit('file_changed', { filePath: e.data.path });
        if (e.type === 'rename') await bus.emit('file_renamed', e.data);
        if (e.type === 'replace')
          setViews((p) =>
            p.map((v) =>
              v.id === e.data.id ? { id: v.id, path: paths[e.data.file], key: v.key + 1 } : v
            )
          );
        if (e.type === 'close') setViews((p) => p.filter((v) => v.id !== e.data.id));
        if (e.type === 'lsp-reply') {
          const request = requests.get(e.data.id);
          if (request) {
            requests.delete(e.data.id);
            if (e.data.error) request.reject(Error(e.data.error));
            else request.resolve(e.data.diagnostics ?? []);
            if (e.data.awaitContinuation) {
              // loadFile awaits this promise directly. Its continuation and Preact's
              // queued render/layout microtasks finish before the next event-loop turn.
              await new Promise((resolve) => setImmediate(resolve));
              parentPort.postMessage({
                type: 'TEST_LSP_CONTINUATION_DRAINED',
                id: e.data.id,
                path: request.path,
              });
            }
          }
        }
        if (e.type === 'fs-failure') failRead = e.data.value;
        if (e.type === 'mode') mode = e.data.value;
        if (e.type === 'release-ordinary') releaseOrdinary?.();
        if (e.type === 'release-ref') releaseRef?.();
        parentPort.postMessage({
          type: 'TEST_CONTROL_ACK',
          tag: e.data?.tag,
          control: e.type,
          counts: { lspCalls, fsCalls, ordinaryCalls, refCalls },
          pendingLsp: requests.size,
        });
      } catch {
        parentPort.postMessage({ type: 'TEST_CONTROL_FAILED', control: e.type });
      }
    };
    document.body.addEventListener('aotui:external-event', listener);
    return () => document.body.removeEventListener('aotui:external-event', listener);
  }, []);
  if (process.env.AOTUI_IDE_INITIAL_FAIL === 'true') throw Error('W05 controlled initial failure');
  return h('main', {}, [
    h(
      'p',
      {},
      'Read the already loaded diagnostics through each FileDetail View. Observe the target first. This query does not refresh diagnostics.'
    ),
    ...views.map((v) =>
      h(FileDetailView, {
        key: v.id + ':' + v.key,
        viewId: v.id,
        filePath: v.path,
        eventBus: bus,
        onClose: () => setViews((p) => p.filter((x) => x !== v)),
        enableDiagnosticsRead: process.env.AOTUI_IDE_DEFAULT !== 'true',
      })
    ),
    h(View, { id: 'ref', type: 'RefOnly', key: 'ref' }, h(RefContent, {})),
    h(Boundary, { key: 'boundary' }, h(View, { id: 'probe', type: 'Probe' }, h(Probe, {}))),
  ]);
}
export default createTUIApp({ app_name: 'ide_read_slice', component: Root });
