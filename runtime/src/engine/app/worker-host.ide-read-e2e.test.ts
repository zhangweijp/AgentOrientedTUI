import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
let Host: any,
  temporary: string,
  appFile: string,
  workerFile: string,
  oldSdkApp: string,
  oldWorkerFile: string,
  oldIdeApp: string;
const running: any[] = [],
  facts: any[] = [];
const diag = (message: string) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
  severity: 1,
  message,
  line: 0,
  character: 0,
  code: undefined,
  source: undefined,
});
function receipt(r: any) {
  expect(r.kind).toBe('receipt');
  if (r.kind !== 'receipt') throw Error(r.code);
  return r.receipt;
}
function data(r: any) {
  const value = receipt(r);
  expect(value.outcome.status).toBe('succeeded');
  return value.outcome.value.data;
}
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
  const found = x.messages.slice(from).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((yes, no) => {
    const timer = setTimeout(() => {
      x.worker.off('message', receive);
      no(Error('W05 explicit barrier timed out; ' + x.logs.join('').slice(-2500)));
    }, 5000);
    const receive = (m: any) => {
      if (predicate(m)) {
        clearTimeout(timer);
        x.worker.off('message', receive);
        yes(m);
      }
    };
    x.worker.on('message', receive);
  });
}
let tag = 0;
async function control(x: any, type: string, payload: any = {}) {
  const id = ++tag,
    from = x.messages.length;
  await x.host.sendExternalEvent('probe', type, { ...payload, tag: id });
  return wait(x, (m) => m.type === 'TEST_CONTROL_ACK' && m.tag === id, from);
}
function prepared(x: any, predicate: (d: any) => boolean = () => true, from = 0) {
  return wait(x, (m) => m.type === 'SNAPSHOT_PREPARED' && predicate(m.draft), from);
}
async function change(
  x: any,
  type: string,
  payload: any = {},
  predicate: (d: any) => boolean = () => true
) {
  const from = x.messages.length;
  const ack = await control(x, type, payload);
  await prepared(x, predicate, from);
  return ack;
}
async function start(
  env: any = {},
  existing?: Worker,
  selectedApp = appFile,
  selectedWorker = workerFile
) {
  const worker =
    existing ??
    new Worker(selectedWorker, {
      stdout: true,
      stderr: true,
      env: { ...process.env, AOTUI_IDE_FILES_DIR: temporary, ...env },
    });
  const sent: any[] = [],
    messages: any[] = [],
    logs: string[] = [];
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (m: any) => {
    sent.push(m);
    post(m);
  };
  worker.stdout!.on('data', (b) => logs.push(String(b)));
  worker.stderr!.on('data', (b) => logs.push(String(b)));
  const host = new Host({
    appId: 'ide_slice',
    desktopId: 'd',
    appModulePath: selectedApp,
    existingWorker: worker,
    timeout: 700,
    snapshotShadow: true,
    experimentalReadOnlyViewTools: true,
    experimentalInteractionModes: ['ordinary-v1', 'snapshot-value-v1'],
  });
  worker.on('message', (m) => messages.push(m));
  const x = {
    host,
    worker,
    sent,
    messages,
    logs,
    paths: { A: join(temporary, 'A.ts'), B: join(temporary, 'B.ts'), C: join(temporary, 'C.ts') },
    snapshot: () => (host as any).shadowReceiver.core.store.readLatest('ide_slice').snapshot,
  };
  running.push(x);
  await host.start();
  await host.open();
  await prepared(x);
  return x;
}
function scope(x: any) {
  const controls = { authorize: (_c: any): any => true, read: (_m: any, _s: any): any => true };
  const policy = {
    project: (ctx: any) => ({
      views: ctx.source.views
        .filter((v: any) => ctx.selection.viewIds.includes(v.id))
        .map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
      refs: Object.values(ctx.source.refs)
        .filter((r: any) => ctx.selection.viewIds.includes(r.ownerViewId))
        .map((r: any) => ({
          viewId: r.ownerViewId,
          viewInstanceId: r.ownerViewInstanceId,
          refId: r.id,
        })),
      targets: Object.values(ctx.source.tools).flatMap((t: any) =>
        t.targets
          .filter((v: any) => ctx.selection.viewIds.includes(v.viewId))
          .map((target: any) => ({ toolId: t.id, target }))
      ),
      content: [],
    }),
    authorize: (c: any) => controls.authorize(c),
    canReadReceipt: (m: any, s: any) => controls.read(m, s),
  };
  const opened = x.host.createInteractionScope(policy);
  expect(opened.status).toBe('opened');
  if (opened.status !== 'opened') throw Error(opened.issue.code);
  const client = opened.client;
  return {
    client,
    controls,
    policy,
    async observe(view = 'aa') {
      const r = await client.observe({ viewIds: [view] });
      expect(r.status).toBe('observed');
      return r.observation;
    },
    request(o: any, id: string, name = 'read_loaded_diagnostics', input: any = {}, view = 'aa') {
      const tool = o.tools.find((t: any) => t.name === name);
      expect(tool).toBeDefined();
      const binding = o.bindings.find((b: any) => b.toolId === tool.id && b.target.viewId === view);
      expect(binding).toBeDefined();
      return {
        invocationId: id,
        observationId: o.observationId,
        bindingId: binding.bindingId,
        input,
      };
    },
  };
}
async function lsp(x: any, file = 'A', from = 0) {
  return wait(x, (m) => m.type === 'TEST_LSP_REQUEST' && m.path === x.paths[file], from);
}
async function ready(x: any) {
  const a = await lsp(x, 'A'),
    b = await lsp(x, 'B');
  await change(x, 'lsp-reply', { id: a.id, diagnostics: [diag('A initial')] }, (d) =>
    d.views.some((v: any) => v.id === 'aa' && v.content.value.includes('A initial'))
  );
  await change(x, 'lsp-reply', { id: b.id, diagnostics: [diag('B initial')] }, (d) =>
    d.views.some((v: any) => v.id === 'bb' && v.content.value.includes('B initial'))
  );
}
async function event(x: any, file: string, message: string) {
  await change(x, 'diagnostics', { filePath: x.paths[file], data: [diag(message)] }, (d) =>
    d.views.some((v: any) => v.content.value.includes(message))
  );
}
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}
describe('W05 emitted actual IDE FileDetail / SDK / Host / Worker / Core', () => {
  beforeAll(async () => {
    const runtime = resolve(process.cwd());
    temporary = await mkdtemp(join(tmpdir(), 'aotui-w05-ide-'));
    Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href))
      .AppWorkerHost;
    workerFile = join(runtime, 'dist/worker-runtime/index.js');
    appFile = join(temporary, 'app.mjs');
    await mkdir(join(temporary, 'node_modules/@aotui'), { recursive: true });
    await mkdir(join(temporary, 'node_modules/@preact'), { recursive: true });
    for (const [pkg, base] of [
      ['preact', runtime],
      ['linkedom', runtime],
      ['emittery', join(runtime, '../demo-apps/aotui-ide')],
      ['glob', join(runtime, '../demo-apps/aotui-ide')],
      ['lowdb', join(runtime, '../demo-apps/aotui-ide')],
      ['vscode-jsonrpc', join(runtime, '../demo-apps/aotui-ide')],
      ['vscode-languageserver-types', join(runtime, '../demo-apps/aotui-ide')],
      ['zod', join(runtime, '../demo-apps/aotui-ide')],
      ['@preact/signals', runtime],
    ])
      await symlink(join(base, 'node_modules', pkg), join(temporary, 'node_modules', pkg), 'dir');
    await symlink(runtime, join(temporary, 'node_modules/@aotui/runtime'), 'dir');
    for (const file of ['A', 'B', 'C'])
      await writeFile(join(temporary, file + '.ts'), 'export const ' + file + ' = 1;\n');
    await build({
      entryPoints: [join(runtime, 'src/e2e-test/fixtures/ide-read-slice.mjs')],
      outfile: appFile,
      alias: {
        '@fixture/sdk': join(runtime, '../sdk/dist'),
        '@fixture/ide': join(runtime, '../demo-apps/aotui-ide/dist'),
        '@aotui/sdk': join(runtime, '../sdk/dist/index.js'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
    });
    const baseline =
      process.env.AOTUI_REF_COMPAT_BASELINE ??
      resolve(runtime, '../rfcs/sdk-runtime-delivery/w00-20261024T090930Z');
    oldSdkApp = join(temporary, 'old-sdk-app.mjs');
    await build({
      entryPoints: [join(runtime, 'src/e2e-test/fixtures/ide-read-slice.mjs')],
      outfile: oldSdkApp,
      alias: {
        '@fixture/sdk': join(baseline, 'artifacts/rebuilt/sdk/dist'),
        '@fixture/ide': join(runtime, '../demo-apps/aotui-ide/dist'),
        '@aotui/sdk': join(baseline, 'artifacts/rebuilt/sdk/dist/index.js'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
    });
    oldIdeApp = join(temporary, 'old-ide-app.mjs');
    const acceptedIde = resolve(
      baseline,
      '../w03-b-20261025T004233Z/artifacts/demo-apps/aotui-ide/dist'
    );
    const acceptedC = JSON.parse(
      await readFile(resolve(baseline, '../w04-c-20261025T081341Z/artifact-manifest.json'), 'utf8')
    );
    const oldFileDetail = await readFile(join(acceptedIde, 'tui/FileDetailContent.js'));
    expect(createHash('sha256').update(oldFileDetail).digest('hex')).toBe(
      acceptedC['demo-apps/aotui-ide'].files.find((r: any) => r.path === 'tui/FileDetailContent.js')
        .sha256
    );
    await build({
      entryPoints: [join(runtime, 'src/e2e-test/fixtures/ide-read-slice.mjs')],
      outfile: oldIdeApp,
      alias: {
        '@fixture/sdk': join(runtime, '../sdk/dist'),
        '@fixture/ide': acceptedIde,
        '@aotui/sdk': join(runtime, '../sdk/dist/index.js'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
    });
    const oldRuntime = join(temporary, 'old-runtime');
    await mkdir(oldRuntime);
    await cp(join(baseline, 'artifacts/rebuilt/runtime/dist'), join(oldRuntime, 'dist'), {
      recursive: true,
    });
    await writeFile(
      join(oldRuntime, 'package.json'),
      await readFile(join(runtime, 'package.json'))
    );
    await symlink(join(runtime, 'node_modules'), join(oldRuntime, 'node_modules'), 'dir');
    oldWorkerFile = join(oldRuntime, 'dist/worker-runtime/index.js');
  });
  afterEach(async () => {
    for (const x of running.splice(0)) {
      x.host.terminate();
      await x.worker.terminate();
      facts.push({
        sent: x.sent.length,
        prepared: x.messages.filter((m: any) => m.type === 'SNAPSHOT_PREPARED').length,
        ordinaryPosts: x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V1').length,
        refPosts: x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V1').length,
        sentJsonBytes: x.sent.reduce(
          (n: number, m: any) => n + Buffer.byteLength(JSON.stringify(m)),
          0
        ),
        receivedJsonBytes: x.messages.reduce(
          (n: number, m: any) => n + Buffer.byteLength(JSON.stringify(m)),
          0
        ),
        afterTestNativeCleanup: x.host.getInteractionReport(),
        workerThreadId: x.worker.threadId,
        logs: x.logs.join(''),
      });
      expect(x.logs.join('')).not.toContain('W05_PRIVATE_SENTINEL');
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (process.env.AOTUI_W05_FACTS_FILE) {
      const runtime = resolve(process.cwd()),
        paths = [
          'dist/engine/app/worker-host.js',
          'dist/worker-runtime/index.js',
          '../sdk/dist/hooks/useViewTypeTool.js',
          '../demo-apps/aotui-ide/dist/tui/FileDetailContent.js',
          '../demo-apps/aotui-ide/dist/tui/loaded-diagnostics.js',
          'src/e2e-test/fixtures/ide-read-slice.mjs',
        ];
      const inputs = await Promise.all(
        paths.map(async (p) => ({
          path: resolve(runtime, p),
          sha256: createHash('sha256')
            .update(await readFile(resolve(runtime, p)))
            .digest('hex'),
        }))
      );
      await writeFile(
        process.env.AOTUI_W05_FACTS_FILE,
        JSON.stringify(
          {
            kind: 'Actual file reads and actual emitted FileDetail; controlled LSP responses, external LSP not verified; native cleanup is test cleanup, not W08 guarantee',
            inputs,
            cases: facts,
          },
          null,
          2
        ),
        { flag: 'wx' }
      );
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  it('A/B ownership, old observation new state, duplicate original receipt, reads cause no LSP/FS/update', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      a = await s.observe(),
      b = await s.observe('bb');
    const readBegan = performance.now(),
      rssBefore = process.memoryUsage().rss;
    const first = await s.client.invoke(s.request(a, 'first'));
    const readMs = performance.now() - readBegan;
    const initial = data(first);
    expect(initial).toMatchObject({
      filePath: x.paths.A,
      status: 'success',
      diagnostics: [{ message: 'A initial', line: 0, character: 0 }],
      error: null,
    });
    expect(initial.diagnostics[0]).not.toHaveProperty('code');
    expect(
      data(await s.client.invoke(s.request(b, 'b', 'read_loaded_diagnostics', {}, 'bb'))).filePath
    ).toBe(x.paths.B);
    const before = await control(x, 'counts');
    const seq = x.messages.filter((m: any) => m.type === 'SNAPSHOT_PREPARED').length;
    const read = data(await s.client.invoke(s.request(a, 'again')));
    expect(read).toEqual(initial);
    const after = await control(x, 'counts');
    expect(after.counts).toEqual(before.counts);
    expect(x.messages.filter((m: any) => m.type === 'SNAPSHOT_PREPARED').length).toBe(seq);
    const updateFrom = x.messages.length,
      updateBegan = performance.now();
    await event(x, 'A', 'A changed');
    facts.push({
      kind: 'readonly/state-update sample',
      samples: 1,
      readMs,
      updateToPublishedMs: performance.now() - updateBegan,
      updatePublications: x.messages
        .slice(updateFrom)
        .filter((m: any) => m.type === 'SNAPSHOT_PREPARED').length,
      updatePublicationJsonBytes: x.messages
        .slice(updateFrom)
        .filter((m: any) => m.type === 'SNAPSHOT_PREPARED')
        .reduce((n: number, m: any) => n + Buffer.byteLength(JSON.stringify(m)), 0),
      testProcessRssBefore: rssBefore,
      testProcessRssAfter: process.memoryUsage().rss,
      rssIncludesHostWorkerAndVitest: true,
      productBudgetSigned: false,
    });
    const current = data(await s.client.invoke(s.request(a, 'new-id')));
    expect(current.stateVersion).toBeGreaterThan(initial.stateVersion);
    expect(current.diagnostics[0].message).toBe('A changed');
    expect(await s.client.invoke(s.request(a, 'first'))).toEqual(first);
    expect(
      data(await s.client.invoke(s.request(b, 'b-new', 'read_loaded_diagnostics', {}, 'bb')))
        .diagnostics[0].message
    ).toBe('B initial');
    s.client.close();
  });
  it('loading/error transitions and newer event invalidates late auto/refresh responses', async () => {
    const x = await start(),
      aRequest = await lsp(x),
      s = scope(x),
      o = await s.observe();
    const loading = data(await s.client.invoke(s.request(o, 'loading')));
    expect(loading.status).toBe('loading');
    await event(x, 'A', 'event wins');
    const accepted = data(await s.client.invoke(s.request(o, 'event')));
    await control(x, 'lsp-reply', { id: aRequest.id, diagnostics: [diag('late old auto')] });
    expect(data(await s.client.invoke(s.request(o, 'late-auto')))).toEqual(accepted);
    let from = x.messages.length;
    await change(x, 'refresh', { path: x.paths.A });
    const refresh = await lsp(x, 'A', from);
    expect(data(await s.client.invoke(s.request(o, 'loading-2'))).status).toBe('loading');
    await change(x, 'lsp-reply', { id: refresh.id, error: 'controlled LSP failure' }, (d) =>
      d.views.some((v: any) => v.id === 'aa' && v.content.value.includes('controlled LSP failure'))
    );
    const failed = data(await s.client.invoke(s.request(o, 'error')));
    expect(failed).toMatchObject({
      status: 'error',
      error: 'controlled LSP failure',
      diagnostics: [],
    });
    expect(failed.stateVersion).toBeGreaterThan(accepted.stateVersion);
    from = x.messages.length;
    await change(x, 'refresh', { path: x.paths.A });
    const older = await lsp(x, 'A', from);
    from = x.messages.length;
    await control(x, 'refresh', { path: x.paths.A });
    const newer = await lsp(x, 'A', from);
    await change(x, 'lsp-reply', { id: newer.id, diagnostics: [diag('new refresh wins')] }, (d) =>
      d.views.some((v: any) => v.content.value.includes('new refresh wins'))
    );
    const won = data(await s.client.invoke(s.request(o, 'won')));
    await control(x, 'lsp-reply', { id: older.id, diagnostics: [diag('stale refresh')] });
    expect(data(await s.client.invoke(s.request(o, 'stale-refresh')))).toEqual(won);
    s.client.close();
  });
  it('same public id remount C rejects A, B old observation survives, including authorization race', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      a = await s.observe(),
      b = await s.observe('bb'),
      gate = deferred(),
      entered = deferred();
    s.controls.authorize = () => {
      entered.resolve(true);
      return gate.promise;
    };
    const pending = s.client.invoke(s.request(a, 'race'));
    await entered.promise;
    const old = a.bindings[0].target;
    await change(x, 'replace', { id: 'aa', file: 'C' }, (d) =>
      d.views.some((v: any) => v.id === 'aa' && v.viewInstanceId !== old.viewInstanceId)
    );
    gate.resolve(true);
    expect(receipt(await pending).outcome.status).toBe('rejected');
    s.controls.authorize = () => true;
    expect(receipt(await s.client.invoke(s.request(a, 'old-a'))).outcome.status).toBe('rejected');
    const c = await s.observe();
    expect(c.bindings[0].target.viewInstanceId).not.toBe(old.viewInstanceId);
    const value = data(await s.client.invoke(s.request(c, 'new-c')));
    expect(value.filePath).toBe(x.paths.C);
    expect(value.diagnostics).toEqual([]);
    expect(
      data(await s.client.invoke(s.request(b, 'still-b', 'read_loaded_diagnostics', {}, 'bb')))
        .filePath
    ).toBe(x.paths.B);
    s.client.close();
  });
  it('Worker final validation rejects an unpublished remount and late unmounted load cannot overwrite C', async () => {
    const x = await start(),
      oldRequest = await lsp(x),
      s = scope(x),
      a = await s.observe();
    const deliver = x.worker.listeners('message')[0];
    const relay = (m: any) => {
      if (m.type !== 'SNAPSHOT_PREPARED') deliver(m);
    };
    x.worker.off('message', deliver);
    x.worker.on('message', relay);
    try {
      await change(x, 'replace', { id: 'aa', file: 'C' });
      const r = receipt(await s.client.invoke(s.request(a, 'worker-stale')));
      expect(r).toMatchObject({ executionPhase: 'not-entered', outcome: { status: 'rejected' } });
    } finally {
      x.worker.off('message', relay);
      x.worker.on('message', deliver);
    }
    await control(x, 'lsp-reply', { id: oldRequest.id, diagnostics: [diag('dead A')] });
    const m = x.messages.filter((m: any) => m.type === 'SNAPSHOT_PREPARED').at(-1);
    deliver(m);
    const c = await s.observe();
    expect(data(await s.client.invoke(s.request(c, 'current-c'))).filePath).toBe(x.paths.C);
    s.client.close();
  });
  it('rename invalidates pending A immediately and rebinds without changing schema', async () => {
    const x = await start(),
      pending = await lsp(x),
      pendingB = await lsp(x, 'B');
    await change(x, 'lsp-reply', { id: pendingB.id, diagnostics: [diag('B settled')] }, (d) =>
      d.views.some((v: any) => v.id === 'bb' && v.content.value.includes('B settled'))
    );
    const s = scope(x),
      a = await s.observe(),
      b = await s.observe('bb'),
      old = a.bindings[0].target,
      renameFrom = x.messages.length;
    await change(x, 'rename', { oldPath: x.paths.A, newPath: x.paths.C }, (d) =>
      Object.values(d.tools).some(
        (t: any) =>
          t.name === 'read_loaded_diagnostics' &&
          t.targets.some((v: any) => v.viewId === 'aa' && v.bindingVersion !== old.bindingVersion)
      )
    );
    const c = await s.observe();
    expect(c.tools[0].inputSchema).toEqual(b.tools[0].inputSchema);
    expect(c.bindings[0].target.viewInstanceId).toBe(old.viewInstanceId);
    expect(c.bindings[0].target.bindingVersion).not.toBe(old.bindingVersion);
    expect(receipt(await s.client.invoke(s.request(a, 'old-rename'))).outcome.status).toBe(
      'rejected'
    );
    const pendingC = await lsp(x, 'C', renameFrom);
    await change(x, 'lsp-reply', { id: pendingC.id, diagnostics: [diag('C settled')] }, (d) =>
      d.views.some((v: any) => v.id === 'aa' && v.content.value.includes('C settled'))
    );
    const before = data(await s.client.invoke(s.request(c, 'after-rename')));
    expect(before.filePath).toBe(x.paths.C);
    expect(before.status).toBe('success');
    expect(before.diagnostics.map((d: any) => d.message)).toEqual(['C settled']);
    expect(before.error).toBeNull();
    expect(before.updatedAt).toEqual(expect.any(Number));
    expect(Object.keys(before).sort()).toEqual(
      ['filePath', 'stateVersion', 'status', 'diagnostics', 'error', 'updatedAt'].sort()
    );
    const beforeB = data(
      await s.client.invoke(s.request(b, 'B-before-late-A', 'read_loaded_diagnostics', {}, 'bb'))
    );
    expect(beforeB.filePath).toBe(x.paths.B);
    expect(beforeB.diagnostics.map((d: any) => d.message)).toEqual(['B settled']);
    const replyFrom = x.messages.length;
    await control(x, 'lsp-reply', {
      id: pending.id,
      diagnostics: [diag('late A')],
      awaitContinuation: true,
    });
    const drained = await wait(
      x,
      (m) => m.type === 'TEST_LSP_CONTINUATION_DRAINED' && m.id === pending.id,
      replyFrom
    );
    expect(drained.path).toBe(x.paths.A);
    const after = data(await s.client.invoke(s.request(c, 'late-rename'))),
      afterB = data(
        await s.client.invoke(s.request(b, 'B-after-late-A', 'read_loaded_diagnostics', {}, 'bb'))
      );
    facts.push({
      kind: 'W06-R1 rename explicit C commit then old A continuation',
      requests: { A: pending, B: pendingB, C: pendingC },
      oldTarget: old,
      newTarget: c.bindings[0].target,
      before,
      after,
      beforeB,
      afterB,
      drained,
      currentReadIds: ['after-rename', 'late-rename', 'B-before-late-A', 'B-after-late-A'],
    });
    expect(after).toEqual(before);
    expect(afterB).toEqual(beforeB);
    s.client.close();
  });
  it('Tool-only enabled/disabled and real Ref-only updates publish despite unchanged View content', async () => {
    const x = await start();
    await ready(x);
    const before = x.snapshot(),
      probe = before.views.find((v: any) => v.id === 'probe').content;
    await change(
      x,
      'probe-update',
      { enabled: false },
      (d) => !Object.values(d.tools).some((t: any) => t.name === 'query')
    );
    expect(x.snapshot().views.find((v: any) => v.id === 'probe').content).toEqual(probe);
    await change(x, 'probe-update', { enabled: true }, (d) =>
      Object.values(d.tools).some((t: any) => t.name === 'query')
    );
    expect(x.snapshot().views.find((v: any) => v.id === 'probe').content).toEqual(probe);
    const s = scope(x),
      o = await s.observe('ref');
    const original = data(
      await s.client.invoke(s.request(o, 'ref-old', 'ref_read', { file: 'file' }, 'ref'))
    );
    await change(x, 'ref-update', { value: 'two' });
    expect(x.snapshot().views.find((v: any) => v.id === 'ref').content).toEqual(
      before.views.find((v: any) => v.id === 'ref').content
    );
    expect(
      data(
        await s.client.invoke(
          s.request(o, 'ref-old-observation', 'ref_read', { file: 'file' }, 'ref')
        )
      ).args
    ).toEqual(original.args);
    const next = await s.observe('ref');
    expect(
      data(await s.client.invoke(s.request(next, 'ref-new', 'ref_read', { file: 'file' }, 'ref')))
        .args.file.value
    ).toBe('two');
    s.client.close();
  });
  it('internal failed render commits explicit fallback, revokes failed target and never enters bad closure', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      o = await s.observe('probe');
    await change(
      x,
      'probe-update',
      { revision: 9, bad: true },
      (d) => !d.views.some((v: any) => v.id === 'probe')
    );
    expect(
      receipt(await s.client.invoke(s.request(o, 'failed', 'query', {}, 'probe'))).outcome.status
    ).toBe('rejected');
    expect((await control(x, 'counts')).counts.ordinaryCalls).toBe(0);
    expect(
      x.messages
        .filter((m: any) => m.type === 'SNAPSHOT_PREPARED')
        .at(-1)
        .draft.views.some((v: any) => v.id === 'probe')
    ).toBe(false);
    s.client.close();
  });
  it('default actual FileDetail has no query and failed initial render yields no ready tools', async () => {
    const x = await start({ AOTUI_IDE_DEFAULT: 'true' });
    expect(
      Object.values(x.snapshot().tools).some((t: any) => t.name === 'read_loaded_diagnostics')
    ).toBe(false);
    expect(
      Object.values(x.snapshot().tools).some(
        (t: any) => 'view_id' in (t.inputSchema.properties ?? {})
      )
    ).toBe(false);
    const count = running.length;
    await expect(start({ AOTUI_IDE_INITIAL_FAIL: 'true' })).rejects.toThrow();
    const failed = running[count];
    expect(
      failed.messages.some(
        (m: any) => m.type === 'SNAPSHOT_PREPARED' && Object.keys(m.draft.tools).length
      )
    ).toBe(false);
  });
  it('invalid oversized actual diagnostic output is never truncated into success', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      o = await s.observe();
    const deliver = x.worker.listeners('message')[0];
    const relay = (m: any) => {
      if (m.type !== 'SNAPSHOT_PREPARED') deliver(m);
    };
    x.worker.off('message', deliver);
    x.worker.on('message', relay);
    const message = 'x'.repeat(525000);
    await change(x, 'diagnostics', { filePath: x.paths.A, data: [diag(message)] });
    const r = receipt(await s.client.invoke(s.request(o, 'oversized')));
    expect(r.outcome.status).toBe('unknown');
    expect(x.host.getInteractionReport().transportUncertain).toBe(true);
    x.worker.off('message', relay);
    x.worker.on('message', deliver);
    s.client.close();
  });
  it('after ordinary unknown, posted Ref still settles; new Ref is blocked and business false stays usable', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      p = await s.observe('probe'),
      ref = await s.observe('ref');
    await control(x, 'mode', { value: 'false' });
    expect(
      receipt(await s.client.invoke(s.request(p, 'business', 'query', {}, 'probe'))).outcome.status
    ).toBe('unknown');
    expect(x.host.getInteractionReport().transportUncertain).toBe(false);
    vi.useFakeTimers();
    await control(x, 'mode', { value: 'ordinary-barrier' });
    const ordinary = s.client.invoke(s.request(p, 'lost', 'query', {}, 'probe'));
    await wait(x, (m) => m.type === 'TEST_ORDINARY_ENTERED');
    await vi.advanceTimersByTimeAsync(200);
    await control(x, 'mode', { value: 'ref-barrier' });
    const peer = s.client.invoke(s.request(ref, 'peer', 'ref_read', { file: 'file' }, 'ref'));
    await wait(x, (m) => m.type === 'TEST_REF_ENTERED');
    await vi.advanceTimersByTimeAsync(500);
    expect(receipt(await ordinary).outcome.status).toBe('unknown');
    expect(x.host.getInteractionReport().transportUncertain).toBe(true);
    await control(x, 'release-ref');
    expect(data(await peer).refCalls).toBe(1);
    facts.push({
      kind: 'R05 ordering',
      unknownConfirmedBeforePeerRelease: true,
      peerSettledAfterUnknown: true,
      hostTimeoutClock: 700,
      peerDeadlineClock: 900,
    });
    const count = x.sent.length;
    expect(
      receipt(await s.client.invoke(s.request(ref, 'blocked', 'ref_read', { file: 'file' }, 'ref')))
        .outcome.status
    ).toBe('rejected');
    expect(x.sent.length).toBe(count);
    await control(x, 'release-ordinary');
    expect(await x.host.releaseWorker()).toBeNull();
    s.client.close();
  });
  it('actual archived old SDK on new Runtime never gains ordinary callable qualification', async () => {
    const x = await start({}, undefined, oldSdkApp);
    await ready(x);
    const s = scope(x),
      o = await s.observe();
    const t = o.tools.find((t: any) => t.name === 'read_loaded_diagnostics');
    expect(t.inputSchema).not.toHaveProperty('additionalProperties');
    const r = receipt(await s.client.invoke(s.request(o, 'old-wrapper')));
    expect(r.outcome.status).toBe('rejected');
    expect(x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V1')).toHaveLength(0);
    s.client.close();
  });
  it('actual new SDK on archived old Runtime/Worker receives no implicit ordinary capability', async () => {
    const x = await start({}, undefined, appFile, oldWorkerFile);
    await ready(x);
    expect(x.host.hasOrdinaryCapability()).toBe(false);
    expect(x.host.createInteractionScope({})).toMatchObject({ status: 'rejected' });
    expect(
      Object.values(x.snapshot().tools).find((t: any) => t.name === 'read_loaded_diagnostics')
    ).not.toHaveProperty('inputSchema.additionalProperties');
    expect(x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V1')).toHaveLength(0);
  });

  it('normal real Worker release is reusable only by a fresh Host and fresh instance', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      o = await s.observe();
    data(await s.client.invoke(s.request(o, 'first')));
    s.client.close();
    const worker = await x.host.releaseWorker();
    expect(worker).toBe(x.worker);
    expect(x.host.createInteractionScope(s.policy)).toMatchObject({ status: 'rejected' });
    const next = await start({}, worker);
    await ready(next);
    expect(next.host.appInstanceId).not.toBe(x.host.appInstanceId);
    const n = scope(next),
      fresh = await n.observe();
    expect(data(await n.client.invoke(n.request(fresh, 'new-host'))).filePath).toBe(x.paths.A);
    expect(receipt(await n.client.invoke(s.request(o, 'foreign-observation'))).outcome.status).toBe(
      'rejected'
    );
    n.client.close();
  });
  it('closing during an entered ordinary handler revokes scopes; late result cannot revive old source', async () => {
    const x = await start();
    await ready(x);
    const s = scope(x),
      o = await s.observe('probe');
    await control(x, 'mode', { value: 'ordinary-barrier' });
    const pending = s.client.invoke(s.request(o, 'closing', 'query', {}, 'probe'));
    await wait(x, (m) => m.type === 'TEST_ORDINARY_ENTERED');
    const closing = x.host.close().then(
      () => ({ status: 'closed' }),
      (error: any) => ({ status: 'failed', message: error.message })
    );
    await pending;
    const closeOutcome = await closing;
    facts.push({
      kind: 'R17 entered handler close',
      closeOutcome,
      remoteHandlerDrainNotProven: true,
    });
    expect(x.host.createInteractionScope(s.policy)).toMatchObject({ status: 'rejected' });
    expect(x.host.getInteractionReport().negotiatedModes).toEqual([]);
    expect(x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V1')).toHaveLength(1);
    s.client.close();
  });
  it.each([
    ['read', 'current'],
    ['lsp', 'current'],
    ['read', 'C-baseline'],
    ['lsp', 'C-baseline'],
  ])('default FileDetail refresh %s failure preserves file contents (%s)', async (kind, flavor) => {
    await writeFile(join(temporary, 'A.ts'), 'export const A = 1;\n');
    const x = await start(
      { AOTUI_IDE_DEFAULT: 'true' },
      undefined,
      flavor === 'C-baseline' ? oldIdeApp : appFile
    );
    await ready(x);
    const content = () => x.snapshot().views.find((v: any) => v.id === 'aa').content.value;
    expect(content()).toContain('export const A = 1;');
    if (kind === 'read') {
      await control(x, 'fs-failure', { value: true });
      await change(x, 'refresh', { path: x.paths.A }, (d) =>
        d.views.some(
          (v: any) => v.id === 'aa' && v.content.value.includes('controlled read failure')
        )
      );
      expect(content()).toContain('export const A = 1;');
    } else {
      await writeFile(x.paths.A, 'export const A = 2;\n');
      const from = x.messages.length;
      const refreshing = control(x, 'refresh', { path: x.paths.A });
      const request = await lsp(x, 'A', from);
      await change(
        x,
        'lsp-reply',
        { id: request.id, error: 'controlled refresh LSP failure' },
        (d) =>
          d.views.some(
            (v: any) => v.id === 'aa' && v.content.value.includes('controlled refresh LSP failure')
          )
      );
      await refreshing;
      expect(content()).toContain('export const A = 2;');
    }
    expect(content()).toContain('Error:');
  });
});
