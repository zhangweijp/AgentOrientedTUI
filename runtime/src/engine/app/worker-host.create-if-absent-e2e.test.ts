import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
let Host: any,
  temporary: string,
  appFile: string,
  workerFile: string,
  oldWorkerFile: string,
  w05WorkerFile: string;
const running: any[] = [],
  facts: any[] = [];
let tag = 0;
function receipt(r: any) {
  expect(r.kind).toBe('receipt');
  if (r.kind !== 'receipt') throw Error(r.code);
  return r.receipt;
}
const key = (target: any) => JSON.stringify([target.viewInstanceId, target.bindingVersion]);
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
  const found = x.messages.slice(from).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((yes, no) => {
    const timer = setTimeout(() => {
      x.worker.off('message', receive);
      no(Error('W06 barrier timed out ' + x.logs.join('').slice(-2000)));
    }, 6000);
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
const prepared = (x: any, predicate: (d: any) => boolean = () => true, from = 0) =>
  wait(x, (m) => m.type === 'SNAPSHOT_PREPARED' && predicate(m.draft), from);
async function control(x: any, type: string, data: any = {}) {
  const id = ++tag,
    from = x.messages.length;
  if (['swap', 'remount'].includes(type)) x.assignments.set(data.viewId, data.workspace);
  await x.host.sendExternalEvent('probe', type, { ...data, tag: id });
  return wait(x, (m) => m.type === 'TEST_CONTROL_ACK' && m.tag === id, from);
}
async function change(
  x: any,
  type: string,
  data: any = {},
  predicate: (d: any) => boolean = () => true
) {
  const from = x.messages.length;
  await control(x, type, data);
  return prepared(x, predicate, from);
}
async function metrics(x: any) {
  const id = ++tag,
    from = x.messages.length;
  x.worker.postMessage({ type: 'TEST_METRICS', tag: id });
  return (await wait(x, (m) => m.type === 'TEST_METRICS_RESULT' && m.tag === id, from)).metrics;
}
function releaseNative(x: any, target: string) {
  x.worker.postMessage({ type: 'TEST_RELEASE', target });
}
async function start(options: any = {}) {
  const directory =
    options.directory ?? (await fs.realpath(await fs.mkdtemp(path.join(temporary, 'case-'))));
  if (!options.directory)
    for (const label of ['A', 'B', 'C'])
      await fs.mkdir(path.join(directory, label, 'sub'), { recursive: true });
  const worker = new Worker(options.worker ?? workerFile, {
    stdout: true,
    stderr: true,
    env: { ...process.env, AOTUI_CREATE_DIR: directory, ...options.env },
  });
  const sent: any[] = [],
    messages: any[] = [],
    logs: string[] = [];
  const nativePost = worker.postMessage.bind(worker);
  worker.postMessage = (m: any) => {
    sent.push(m);
    nativePost(m);
  };
  worker.stdout!.on('data', (b) => logs.push(String(b)));
  worker.stderr!.on('data', (b) => logs.push(String(b)));
  const host = new Host({
    appId: 'create_app',
    desktopId: 'd',
    appModulePath: appFile,
    existingWorker: worker,
    snapshotShadow: true,
    experimentalReadOnlyViewTools: options.readOnly !== false,
    experimentalInteractionModes: options.modes ?? [
      'ordinary-v1',
      'snapshot-value-v1',
      'create-if-absent-v1',
    ],
    timeout: 700,
  });
  worker.on('message', (m) => messages.push(m));
  const x = {
    host,
    worker,
    directory,
    sent,
    messages,
    logs,
    nativePost,
    assignments: new Map([
      ['aa', 'A'],
      ['bb', 'B'],
    ]),
    snapshot: () => (host as any).shadowReceiver.core.store.readLatest('create_app').snapshot,
    target: (label: string, name: string) => path.join(directory, label, name),
  };
  running.push(x);
  await host.start();
  await host.open();
  await prepared(x);
  return x;
}
function scope(x: any, allowed = ['A', 'B', 'C']) {
  const owned = new Map<string, string>(),
    controls = { authorize: (_c: any): any => true, read: (_m: any): any => true };
  const policy: any = {
    project: (ctx: any) => {
      const views = ctx.source.views.filter((v: any) => ctx.selection.viewIds.includes(v.id));
      const targets = Object.values(ctx.source.tools).flatMap((t: any) =>
        t.targets
          .filter((v: any) => ctx.selection.viewIds.includes(v.viewId))
          .map((target: any) => {
            if (target.viewId !== 'probe') owned.set(key(target), x.assignments.get(target.viewId));
            return { toolId: t.id, target };
          })
      );
      return {
        views: views.map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: [],
        targets,
        content: [],
      };
    },
    authorize: (ctx: any) => {
      if (
        ctx.source.target.viewId !== 'probe' &&
        !allowed.includes(owned.get(key(ctx.source.target))!)
      )
        return false;
      return controls.authorize(ctx);
    },
    canReadReceipt: (m: any) => controls.read(m),
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
    request: (
      o: any,
      id: string,
      relativePath = 'new.txt',
      content = 'text',
      name = 'create_file_if_absent',
      view = 'aa'
    ) => {
      const tool = o.tools.find((t: any) => t.name === name);
      expect(tool).toBeDefined();
      const binding = o.bindings.find((b: any) => b.toolId === tool.id && b.target.viewId === view);
      expect(binding).toBeDefined();
      return {
        invocationId: id,
        observationId: o.observationId,
        bindingId: binding.bindingId,
        input: name === 'read_probe' ? {} : { relativePath, content },
      };
    },
  };
}
async function absent(p: string) {
  await expect(fs.lstat(p)).rejects.toMatchObject({ code: 'ENOENT' });
}
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}
const creationPosts = (x: any) =>
  x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1');
describe('W06 actual WorkspaceCreateView / SDK / Core / Worker / native disk', () => {
  beforeAll(async () => {
    const runtime = path.resolve(process.cwd());
    temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-w06-create-')));
    appFile = path.join(temporary, 'app.mjs');
    workerFile = path.join(runtime, 'dist/worker-runtime/index.js');
    Host = (await import(pathToFileURL(path.join(runtime, 'dist/engine/app/worker-host.js')).href))
      .AppWorkerHost;
    await fs.mkdir(path.join(temporary, 'node_modules/@aotui'), { recursive: true });
    await fs.mkdir(path.join(temporary, 'node_modules/@preact'), { recursive: true });
    for (const [pkg, base] of [
      ['preact', runtime],
      ['linkedom', runtime],
      ['@preact/signals', runtime],
      ['glob', path.join(runtime, '../demo-apps/aotui-ide')],
      ['emittery', path.join(runtime, '../demo-apps/aotui-ide')],
      ['lowdb', path.join(runtime, '../demo-apps/aotui-ide')],
      ['vscode-jsonrpc', path.join(runtime, '../demo-apps/aotui-ide')],
      ['vscode-languageserver-types', path.join(runtime, '../demo-apps/aotui-ide')],
      ['zod', path.join(runtime, '../demo-apps/aotui-ide')],
    ])
      await fs.symlink(
        path.join(base, 'node_modules', pkg),
        path.join(temporary, 'node_modules', pkg),
        'dir'
      );
    await fs.symlink(runtime, path.join(temporary, 'node_modules/@aotui/runtime'), 'dir');
    const old =
      process.env.AOTUI_REF_COMPAT_BASELINE ??
      path.resolve(runtime, '../rfcs/sdk-runtime-delivery/w00-20261024T090930Z');
    await build({
      entryPoints: [path.join(runtime, 'src/e2e-test/fixtures/ide-create-slice.mjs')],
      outfile: appFile,
      alias: {
        '@fixture/sdk': path.join(runtime, '../sdk/dist'),
        '@fixture/old-sdk': path.join(old, 'artifacts/rebuilt/sdk/dist'),
        '@fixture/ide': path.join(runtime, '../demo-apps/aotui-ide/dist'),
        '@aotui/sdk': path.join(runtime, '../sdk/dist/index.js'),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
    });
    for (const [label, folder] of [
      ['old', path.join(old, 'artifacts/rebuilt/runtime/dist')],
      ['w05', path.resolve(old, '../w05-20261025T100742Z/artifacts/runtime/dist')],
    ]) {
      const out = path.join(temporary, label + '-runtime');
      await fs.mkdir(out);
      await fs.cp(folder, path.join(out, 'dist'), { recursive: true });
      await fs.writeFile(
        path.join(out, 'package.json'),
        await fs.readFile(path.join(runtime, 'package.json'))
      );
      await fs.symlink(path.join(runtime, 'node_modules'), path.join(out, 'node_modules'), 'dir');
      if (label === 'old') oldWorkerFile = path.join(out, 'dist/worker-runtime/index.js');
      else w05WorkerFile = path.join(out, 'dist/worker-runtime/index.js');
    }
  });
  afterEach(async () => {
    for (const x of running.splice(0)) {
      x.host.terminate();
      await x.worker.terminate();
      facts.push({
        kind: 'test native cleanup',
        messages: x.messages.length,
        createPosts: creationPosts(x).length,
        sentJsonBytes: x.sent.reduce(
          (n: number, m: any) => n + Buffer.byteLength(JSON.stringify(m)),
          0
        ),
        receivedJsonBytes: x.messages.reduce(
          (n: number, m: any) => n + Buffer.byteLength(JSON.stringify(m)),
          0
        ),
        coreAfter: x.host.getInteractionReport(),
        workerThreadId: x.worker.threadId,
        logs: x.logs.join(''),
      });
      expect(x.logs.join('')).not.toContain('W06_PRIVATE_SENTINEL');
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (process.env.AOTUI_W06_FACTS_FILE) {
      const runtime = path.resolve(process.cwd()),
        files = [
          'dist/engine/app/worker-host.js',
          'dist/worker-runtime/index.js',
          '../sdk/dist/hooks/useCreateIfAbsentTool.js',
          '../sdk/dist/utils/create-if-absent-tool.js',
          '../demo-apps/aotui-ide/dist/tui/WorkspaceCreateView.js',
          '../demo-apps/aotui-ide/dist/core/conditional-file-create.js',
          'src/e2e-test/fixtures/ide-create-slice.mjs',
        ];
      const inputs = await Promise.all(
        files.map(async (p) => ({
          path: path.resolve(runtime, p),
          sha256: createHash('sha256')
            .update(await fs.readFile(path.resolve(runtime, p)))
            .digest('hex'),
        }))
      );
      await fs.writeFile(
        process.env.AOTUI_W06_FACTS_FILE,
        JSON.stringify(
          {
            kind: 'Actual emitted production WorkspaceCreateView and native creator. FS/transport barriers and Q-W06-01 UI hook are fixture-only; no OS sandbox or W08 claim',
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            inputs,
            cases: facts,
          },
          null,
          2
        ),
        { flag: 'wx' }
      );
    }
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  });
  it('create-only without readonly flag supports real empty/Unicode files, exact dedup and normal result display', async () => {
    const x = await start({ readOnly: false, modes: ['create-if-absent-v1'] }),
      s = scope(x),
      o = await s.observe(),
      request = s.request(o, 'first', 'empty.txt', '');
    expect(x.host.hasCreateIfAbsentCapability()).toBe(true);
    expect(x.host.hasOrdinaryCapability()).toBe(false);
    const before = performance.now();
    const [a, b] = await Promise.all([s.client.invoke(request), s.client.invoke(request)]);
    const r = receipt(a);
    expect(b).toEqual(a);
    expect(r.outcome).toEqual({
      status: 'succeeded',
      value: { filePath: x.target('A', 'empty.txt'), bytesWritten: 0 },
    });
    expect(await s.client.invoke(request)).toEqual(a);
    await prepared(x, (d) =>
      d.views.some((v: any) => v.id === 'aa' && v.content.value.includes('bytesWritten: 0'))
    );
    const unicode = receipt(
      await s.client.invoke(s.request(o, 'unicode', 'sub/unicode.txt', '文本😀'))
    );
    expect(unicode.outcome).toMatchObject({
      status: 'succeeded',
      value: { bytesWritten: Buffer.byteLength('文本😀') },
    });
    expect(await fs.readFile(x.target('A', 'sub/unicode.txt'), 'utf8')).toBe('文本😀');
    const m = await metrics(x);
    expect(m.creatorEntries.A).toBe(2);
    expect(m.opened).toBe(2);
    expect(m.nativeCloses).toBe(2);
    expect(m.activeHandles).toBe(0);
    facts.push({
      kind: 'C14 sample',
      firstCallMs: performance.now() - before,
      metrics: m,
      testProcessRss: process.memoryUsage().rss,
      notProductBudget: true,
    });
    s.client.close();
  });
  it('two workspaces share schema but retain resource permission, Scope ID and new-ID conflict semantics', async () => {
    const x = await start(),
      s = scope(x, ['A']),
      a = await s.observe(),
      b = await s.observe('bb');
    expect(a.tools[0].inputSchema).toEqual(b.tools[0].inputSchema);
    expect(
      receipt(
        await s.client.invoke(s.request(b, 'denied', 'b.txt', 'B', 'create_file_if_absent', 'bb'))
      ).outcome.status
    ).toBe('rejected');
    await absent(x.target('B', 'b.txt'));
    const request = s.request(a, 'same', 'a.txt', 'A');
    expect(receipt(await s.client.invoke(request)).outcome.status).toBe('succeeded');
    expect(
      await s.client.invoke({
        ...request,
        input: { relativePath: 'other.txt', content: 'different' },
      })
    ).toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' });
    s.controls.read = () => false;
    expect(await s.client.invoke(request)).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
    s.controls.read = () => true;
    expect(
      receipt(await s.client.invoke(s.request(a, 'new-id', 'a.txt', 'overwrite'))).outcome
    ).toMatchObject({ status: 'failed', code: 'RESOURCE_ALREADY_EXISTS', effects: 'none' });
    expect(await fs.readFile(x.target('A', 'a.txt'), 'utf8')).toBe('A');
    const peer = scope(x, ['B']),
      p = await peer.observe('bb');
    expect(
      receipt(
        await peer.client.invoke(
          peer.request(p, 'same', 'b.txt', 'B', 'create_file_if_absent', 'bb')
        )
      ).outcome.status
    ).toBe('succeeded');
    expect(await fs.readFile(x.target('B', 'b.txt'), 'utf8')).toBe('B');
    s.client.close();
    peer.client.close();
  });
  it('real independent Workers and different invocation IDs compete on wx with one complete winner', async () => {
    const a = await start(),
      b = await start({ directory: a.directory }),
      sa = scope(a),
      sb = scope(b),
      oa = await sa.observe(),
      ob = await sb.observe();
    const ar = sa.request(oa, 'worker-A', 'race.txt', 'A'.repeat(7000)),
      br = sb.request(ob, 'worker-B', 'race.txt', 'B'.repeat(9000));
    const values = await Promise.all([sa.client.invoke(ar), sb.client.invoke(br)]);
    const outcomes = values.map((v) => receipt(v).outcome);
    expect(outcomes.filter((v) => v.status === 'succeeded')).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === 'failed')).toMatchObject([
      { code: 'RESOURCE_ALREADY_EXISTS', effects: 'none' },
    ]);
    const winner = outcomes[0].status === 'succeeded' ? 'A'.repeat(7000) : 'B'.repeat(9000);
    expect(await fs.readFile(a.target('A', 'race.txt'), 'utf8')).toBe(winner);
    expect(await sa.client.invoke(ar)).toEqual(values[0]);
    expect(await sb.client.invoke(br)).toEqual(values[1]);
    const am = await metrics(a),
      bm = await metrics(b);
    expect(am.openAttempts + bm.openAttempts).toBe(2);
    expect(am.opened + bm.opened).toBe(1);
    facts.push({
      kind: 'C10 cross Worker race',
      differentIds: ['worker-A', 'worker-B'],
      outcomes,
      metrics: [am, bm],
      winnerBytes: Buffer.byteLength(winner),
    });
    sa.client.close();
    sb.client.close();
  });
  it.each(['published', 'unpublished'])(
    'changing creator during authorization rejects original binding (%s)',
    async (visibility) => {
      const x = await start(),
        s = scope(x),
        o = await s.observe(),
        gate = deferred(),
        entered = deferred();
      s.controls.authorize = () => {
        entered.resolve(true);
        return gate.promise;
      };
      const pending = s.client.invoke(s.request(o, 'auth', 'auth.txt', 'original'));
      await entered.promise;
      const deliver = x.worker.listeners('message')[0],
        relay = (m: any) => {
          if (m.type !== 'SNAPSHOT_PREPARED') deliver(m);
        };
      if (visibility === 'unpublished') {
        x.worker.off('message', deliver);
        x.worker.on('message', relay);
      }
      try {
        const old = o.bindings[0].target;
        await change(x, 'swap', { viewId: 'aa', workspace: 'B' }, (d) =>
          Object.values(d.tools).some(
            (t: any) =>
              t.name === 'create_file_if_absent' &&
              t.targets.some(
                (v: any) => v.viewId === 'aa' && v.bindingVersion !== old.bindingVersion
              )
          )
        );
        gate.resolve(true);
        const r = receipt(await pending);
        expect(r.outcome.status).toBe('rejected');
        expect(r.executionPhase).toBe(
          visibility === 'published' ? 'not-dispatched' : 'not-entered'
        );
        expect((await metrics(x)).creatorEntries).toEqual({});
        await absent(x.target('A', 'auth.txt'));
        await absent(x.target('B', 'auth.txt'));
      } finally {
        if (visibility === 'unpublished') {
          x.worker.off('message', relay);
          x.worker.on('message', deliver);
        }
        s.client.close();
      }
    }
  );
  it('already entered A remains A after B commits, while old binding new IDs are revoked', async () => {
    const x = await start(),
      s = scope(x),
      a = await s.observe(),
      target = x.target('A', 'entered.txt');
    await control(x, 'fault', { target, mode: 'before-open-hold' });
    const pending = s.client.invoke(s.request(a, 'entered', 'entered.txt', 'A retained'));
    await wait(
      x,
      (m) => m.type === 'TEST_FS_BARRIER' && m.target === target && m.stage === 'before-open'
    );
    const old = a.bindings[0].target;
    await change(x, 'swap', { viewId: 'aa', workspace: 'B' }, (d) =>
      Object.values(d.tools).some(
        (t: any) =>
          t.name === 'create_file_if_absent' &&
          t.targets.some((v: any) => v.viewId === 'aa' && v.bindingVersion !== old.bindingVersion)
      )
    );
    releaseNative(x, target);
    expect(receipt(await pending).outcome).toMatchObject({
      status: 'succeeded',
      value: { filePath: target },
    });
    expect(await fs.readFile(target, 'utf8')).toBe('A retained');
    await absent(x.target('B', 'entered.txt'));
    expect(
      receipt(await s.client.invoke(s.request(a, 'stale', 'other.txt', 'no'))).outcome.status
    ).toBe('rejected');
    const b = await s.observe();
    expect(b.bindings[0].target.viewInstanceId).toBe(old.viewInstanceId);
    expect(
      receipt(await s.client.invoke(s.request(b, 'new-b', 'b.txt', 'B'))).outcome.value.filePath
    ).toBe(x.target('B', 'b.txt'));
    facts.push({
      kind: 'C06 already entered retains original creator',
      originalRoot: 'A',
      newRoot: 'B',
      oldCompletedAtOriginal: true,
    });
    s.client.close();
  });
  it('unpublished unmount and same public ID remount cannot redirect the old request; companion remains usable', async () => {
    const x = await start(),
      s = scope(x),
      a = await s.observe(),
      b = await s.observe('bb'),
      old = a.bindings[0].target,
      deliver = x.worker.listeners('message')[0],
      relay = (m: any) => {
        if (m.type !== 'SNAPSHOT_PREPARED') deliver(m);
      };
    x.worker.off('message', deliver);
    x.worker.on('message', relay);
    try {
      await change(x, 'remount', { viewId: 'aa', workspace: 'C' }, (d) =>
        d.views.some((v: any) => v.id === 'aa' && v.viewInstanceId !== old.viewInstanceId)
      );
      const r = receipt(await s.client.invoke(s.request(a, 'old', 'old.txt', 'old')));
      expect(r).toMatchObject({ executionPhase: 'not-entered', outcome: { status: 'rejected' } });
      expect((await metrics(x)).creatorEntries).toEqual({});
    } finally {
      x.worker.off('message', relay);
      x.worker.on('message', deliver);
    }
    deliver(x.messages.filter((m: any) => m.type === 'SNAPSHOT_PREPARED').at(-1));
    const c = await s.observe();
    expect(c.bindings[0].target.viewInstanceId).not.toBe(old.viewInstanceId);
    expect(
      receipt(await s.client.invoke(s.request(c, 'c', 'c.txt', 'C'))).outcome.value.filePath
    ).toBe(x.target('C', 'c.txt'));
    expect(
      receipt(await s.client.invoke(s.request(b, 'b', 'b.txt', 'B', 'create_file_if_absent', 'bb')))
        .outcome.value.filePath
    ).toBe(x.target('B', 'b.txt'));
    await absent(x.target('A', 'old.txt'));
    s.client.close();
  });
  it.each(['zero-write', 'partial-write', 'close-fail', 'unknown-open', 'forged-open-error'])(
    'native %s returns honest effects and keeps valid business transport healthy',
    async (mode) => {
      const x = await start(),
        s = scope(x),
        o = await s.observe(),
        target = x.target('A', 'fault.txt');
      await control(x, 'fault', { target, mode });
      const r = receipt(await s.client.invoke(s.request(o, 'fault', 'fault.txt', 'abcdef')));
      expect(r.executionPhase).toBe('entered-returned');
      expect(x.host.getInteractionReport().transportUncertain).toBe(false);
      if (mode === 'zero-write' || mode === 'partial-write') {
        expect(r.outcome).toMatchObject({
          status: 'failed',
          code: 'RESOURCE_WRITE_FAILED',
          effects: 'partial',
        });
        expect(await fs.readFile(target, 'utf8')).toBe(mode === 'zero-write' ? '' : 'abc');
      } else {
        expect(r.outcome.status).toBe('unknown');
        if (mode === 'unknown-open') await absent(target);
        else expect(await fs.readFile(target, 'utf8')).toBe(mode === 'close-fail' ? 'abcdef' : '');
      }
      const good = receipt(await s.client.invoke(s.request(o, 'good', 'good.txt', 'good')));
      expect(good.outcome.status).toBe('succeeded');
      const m = await metrics(x);
      expect(m.activeHandles).toBe(0);
      facts.push({ kind: 'C13 native failure', mode, outcome: r.outcome, metrics: m });
      s.client.close();
    }
  );
  it('observes an actual open empty file before failure/close rather than inferring no effects', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe(),
      target = x.target('A', 'empty-open.txt');
    await control(x, 'fault', { target, mode: 'after-open-hold' });
    const pending = s.client.invoke(s.request(o, 'open', 'empty-open.txt', 'abcdef'));
    await wait(
      x,
      (m) => m.type === 'TEST_FS_BARRIER' && m.target === target && m.stage === 'after-open'
    );
    expect((await fs.stat(target)).size).toBe(0);
    expect((await metrics(x)).activeHandles).toBe(1);
    s.client.close();
    expect(x.host.getInteractionReport().core.activeInvocations).toBe(1);
    releaseNative(x, target);
    expect(await pending).toMatchObject({ kind: 'unavailable' });
    expect(await fs.readFile(target, 'utf8')).toBe('abcdef');
    expect(x.host.getInteractionReport().core.activeInvocations).toBe(0);
    facts.push({
      kind: 'C18 closed Scope during actual empty open',
      fileExistedWithZeroBytes: true,
      receipt: 'unavailable',
      fileAfterRelease: 'abcdef',
      remoteCancelNotClaimed: true,
    });
  });
  it('successful disk output with lost terminal is unknown and never retried; a fresh instance sees EEXIST', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe(),
      target = x.target('A', 'lost.txt');
    const deliver = x.worker.listeners('message')[0],
      relay = (m: any) => {
        if (m.type !== 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE') deliver(m);
      };
    x.worker.off('message', deliver);
    x.worker.on('message', relay);
    const req = s.request(o, 'lost', 'lost.txt', 'durable-in-test');
    const pending = s.client.invoke(req);
    await wait(x, (m) => m.type === 'TEST_CLOSED' && m.target === target);
    expect(await fs.readFile(target, 'utf8')).toBe('durable-in-test');
    const result = await pending;
    expect(receipt(result).outcome.status).toBe('unknown');
    expect(await s.client.invoke(req)).toEqual(result);
    expect((await metrics(x)).creatorEntries.A).toBe(1);
    expect(await x.host.releaseWorker()).toBeNull();
    const fresh = await start({ directory: x.directory }),
      next = scope(fresh),
      newO = await next.observe();
    expect(
      receipt(await next.client.invoke(next.request(newO, 'new-id', 'lost.txt', 'no-overwrite')))
        .outcome
    ).toMatchObject({ status: 'failed', code: 'RESOURCE_ALREADY_EXISTS', effects: 'none' });
    expect(await fs.readFile(target, 'utf8')).toBe('durable-in-test');
    s.client.close();
    next.client.close();
  });
  it.each(['create-first', 'read-first'])(
    'actual unknown then posted companion settlement in direction %s, pending authorization cannot post',
    async (order) => {
      const x = await start(),
        s = scope(x),
        a = await s.observe(),
        r = await s.observe('probe'),
        third = scope(x),
        to = await third.observe(),
        gate = deferred(),
        auth = deferred();
      await control(x, 'fault', { target: x.target('A', 'mixed.txt'), mode: 'after-close-hold' });
      await control(x, 'read-mode', { hold: true });
      vi.useFakeTimers();
      const createReq = s.request(a, 'create', 'mixed.txt', 'disk'),
        readReq = s.request(r, 'read', '', '', 'read_probe', 'probe');
      const first = s.client.invoke(order === 'create-first' ? createReq : readReq);
      await wait(x, (m) =>
        order === 'create-first'
          ? m.type === 'TEST_FS_BARRIER' && m.stage === 'after-close'
          : m.type === 'TEST_READ_ENTERED'
      );
      await vi.advanceTimersByTimeAsync(200);
      const peer = s.client.invoke(order === 'create-first' ? readReq : createReq);
      await wait(x, (m) =>
        order === 'create-first'
          ? m.type === 'TEST_READ_ENTERED'
          : m.type === 'TEST_FS_BARRIER' && m.stage === 'after-close'
      );
      third.controls.authorize = () => {
        auth.resolve(true);
        return gate.promise;
      };
      const waiting = third.client.invoke(third.request(to, 'waiting', 'never.txt', 'never'));
      await auth.promise;
      await vi.advanceTimersByTimeAsync(500);
      expect(receipt(await first).outcome.status).toBe('unknown');
      expect(x.host.getInteractionReport().transportUncertain).toBe(true);
      if (order === 'create-first') await control(x, 'release-read');
      else releaseNative(x, x.target('A', 'mixed.txt'));
      expect(receipt(await peer).outcome.status).toBe('succeeded');
      gate.resolve(true);
      expect(receipt(await waiting).outcome.status).toBe('rejected');
      await absent(x.target('A', 'never.txt'));
      expect(await fs.readFile(x.target('A', 'mixed.txt'), 'utf8')).toBe('disk');
      const before = x.sent.length;
      expect(
        receipt(await s.client.invoke(s.request(a, 'blocked', 'blocked.txt', 'blocked'))).outcome
          .status
      ).toBe('rejected');
      expect(x.sent.length).toBe(before);
      if (order === 'create-first') releaseNative(x, x.target('A', 'mixed.txt'));
      else await control(x, 'release-read');
      expect(await x.host.releaseWorker()).toBeNull();
      facts.push({
        kind: 'C16 actual ordering',
        order,
        unknownBeforePeerRelease: true,
        peerSucceededAfterUnknown: true,
        waitingNeverPosted: true,
      });
      s.client.close();
      third.client.close();
    }
  );
  it('post-create result render failure preserves original success and receipt while revoking only failed View', async () => {
    const x = await start(),
      s = scope(x),
      a = await s.observe(),
      b = await s.observe('bb'),
      target = x.target('A', 'ui.txt'),
      req = s.request(a, 'ui', 'ui.txt', 'actual file');
    await control(x, 'ui-failure', { target });
    const pending = s.client.invoke(req);
    await wait(
      x,
      (m) => m.type === 'TEST_UI_THROW' && m.target === target && m.nativeWriteAndCloseCompleted
    );
    await wait(x, (m) => m.type === 'TEST_UI_FALLBACK_COMMITTED' && m.viewId === 'aa');
    await prepared(x, (d) => !d.views.some((v: any) => v.id === 'aa'));
    const first = await pending;
    expect(receipt(first).outcome.status).toBe('succeeded');
    expect(await s.client.invoke(req)).toEqual(first);
    expect(
      receipt(await s.client.invoke(s.request(a, 'stale', 'not-created.txt', 'no'))).outcome.status
    ).toBe('rejected');
    await absent(x.target('A', 'not-created.txt'));
    expect(await fs.readFile(target, 'utf8')).toBe('actual file');
    expect(
      receipt(
        await s.client.invoke(
          s.request(b, 'companion', 'normal.txt', 'B', 'create_file_if_absent', 'bb')
        )
      ).outcome.status
    ).toBe('succeeded');
    await prepared(x, (d) =>
      d.views.some((v: any) => v.id === 'bb' && v.content.value.includes('normal.txt'))
    );
    const m = await metrics(x);
    expect(m.uiThrows).toBe(1);
    expect(m.uiFallbackCommits).toBe(1);
    expect(m.creatorEntries.A).toBe(1);
    facts.push({
      kind: 'C14 Q-W06-01',
      renderFailureAfterWriteClose: true,
      originalSuccessPreserved: true,
      oldIdStillReadable: true,
      oldBindingNewIdRejected: true,
      metrics: m,
      doesNotProveSynchronousSetterThrow: true,
    });
    s.client.close();
  });
  it.each(['old-sdk', 'old-worker', 'w05-worker', 'new-hook-old-runtime'])(
    'actual archived compatibility %s never implicitly creates',
    async (kind) => {
      if (kind === 'new-hook-old-runtime') {
        const x = await start({ worker: oldWorkerFile });
        await wait(x, (m) => m.type === 'TEST_UI_FALLBACK_COMMITTED' && m.viewId === 'aa');
        await wait(x, (m) => m.type === 'TEST_UI_FALLBACK_COMMITTED' && m.viewId === 'bb');
        expect(x.messages.filter((m: any) => m.type === 'TEST_UNSUPPORTED_CREATION')).toHaveLength(
          2
        );
        expect(
          x.messages
            .filter((m: any) => m.type === 'TEST_UI_FALLBACK_COMMITTED')
            .map((m: any) => m.viewId)
            .sort()
        ).toEqual(['aa', 'bb']);
        expect(x.messages.some((m: any) => m.type === 'TEST_CREATOR_ENTERED')).toBe(false);
        expect(x.sent.some((m: any) => m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1')).toBe(
          false
        );
        expect(
          Object.values(x.snapshot().tools).some((t: any) => t.name === 'create_file_if_absent')
        ).toBe(false);
        for (const label of ['A', 'B', 'C'])
          expect(await fs.readdir(x.target(label, ''))).toEqual(['sub']);
        return;
      }
      const x = await start({
        worker:
          kind === 'old-worker' ? oldWorkerFile : kind === 'w05-worker' ? w05WorkerFile : undefined,
        env: { AOTUI_CREATE_OLD_SDK: 'true' },
      });
      if (kind === 'old-sdk') {
        const s = scope(x),
          o = await s.observe();
        expect(
          receipt(await s.client.invoke(s.request(o, 'unsafe', 'unsafe.txt', 'no'))).outcome.status
        ).toBe('rejected');
        s.client.close();
      } else {
        expect(x.host.hasCreateIfAbsentCapability()).toBe(false);
        expect(x.host.createInteractionScope({})).toMatchObject({ status: 'rejected' });
      }
      await absent(x.target('A', 'unsafe.txt'));
      expect(creationPosts(x)).toHaveLength(0);
      expect(x.messages.some((m: any) => m.type === 'TEST_LEGACY_CREATE_ENTERED')).toBe(false);
    }
  );
  it('closing during actual authorization prevents dispatch and keeps local responsibility until policy settles', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe(),
      gate = deferred(),
      entered = deferred();
    s.controls.authorize = () => {
      entered.resolve(true);
      return gate.promise;
    };
    const p = s.client.invoke(s.request(o, 'auth-close', 'never.txt', 'no'));
    await entered.promise;
    s.client.close();
    expect(x.host.getInteractionReport().core.activeInvocations).toBe(1);
    gate.resolve(true);
    expect(await p).toMatchObject({ kind: 'unavailable' });
    expect(creationPosts(x)).toHaveLength(0);
    expect((await metrics(x)).creatorEntries).toEqual({});
    await absent(x.target('A', 'never.txt'));
    expect(x.host.getInteractionReport().core.activeInvocations).toBe(0);
  });
  it('a create already posted but held before Worker entry is refused after shutdown revokes negotiation', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe(),
      posted = deferred();
    let held: any;
    const post = x.worker.postMessage.bind(x.worker);
    x.worker.postMessage = (m: any) => {
      if (m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1') {
        x.sent.push(m);
        held = m;
        posted.resolve(m);
      } else post(m);
    };
    const p = s.client.invoke(s.request(o, 'held', 'never.txt', 'no'));
    await posted.promise;
    const closing = x.host.close().then(
      () => ({ status: 'closed' }),
      (error: any) => ({ status: 'failed', message: error.message })
    );
    await wait(x, (m) => m.type === 'TEST_LIFECYCLE_RECEIVED' && m.lifecycle === 'APP_SHUTDOWN');
    x.nativePost(held);
    const raw = await wait(
      x,
      (m) =>
        m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE' && m.requestId === held.requestId
    );
    expect(raw.terminal).toMatchObject({ phase: 'not-entered', outcome: { status: 'rejected' } });
    expect(await p).toMatchObject({ kind: 'unavailable' });
    expect(x.messages.some((m: any) => m.type === 'TEST_CREATOR_ENTERED')).toBe(false);
    await absent(x.target('A', 'never.txt'));
    facts.push({
      kind: 'C18 posted before entry then Host shutdown',
      rawTerminal: raw.terminal,
      closeOutcome: await closing,
      remoteDrainNotProven: true,
    });
    s.client.close();
  });
  it('closed Scope after native write and close has unavailable receipt and preserves completed file', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe(),
      target = x.target('A', 'closed-receipt.txt');
    await control(x, 'fault', { target, mode: 'after-close-hold' });
    const p = s.client.invoke(s.request(o, 'closed-result', 'closed-receipt.txt', 'complete'));
    await wait(
      x,
      (m) => m.type === 'TEST_FS_BARRIER' && m.stage === 'after-close' && m.target === target
    );
    expect(await fs.readFile(target, 'utf8')).toBe('complete');
    expect((await metrics(x)).activeHandles).toBe(0);
    s.client.close();
    expect(x.host.getInteractionReport().core.activeInvocations).toBe(1);
    releaseNative(x, target);
    expect(await p).toMatchObject({ kind: 'unavailable' });
    expect(await fs.readFile(target, 'utf8')).toBe('complete');
    expect((await metrics(x)).creatorEntries.A).toBe(1);
    facts.push({
      kind: 'C18 close after write/close before terminal',
      fileCompleteBeforeClose: true,
      receipt: 'unavailable',
      automaticRetry: false,
    });
  });
  it('parent removed after preflight gives native open none and is never recreated', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe(),
      target = x.target('A', 'sub/removed.txt');
    await control(x, 'fault', { target, mode: 'before-open-hold' });
    const p = s.client.invoke(s.request(o, 'removed-parent', 'sub/removed.txt', 'no'));
    await wait(x, (m) => m.type === 'TEST_FS_BARRIER' && m.target === target);
    await fs.rmdir(x.target('A', 'sub'));
    releaseNative(x, target);
    expect(receipt(await p).outcome).toMatchObject({
      status: 'failed',
      code: 'RESOURCE_OPEN_FAILED',
      effects: 'none',
    });
    await absent(x.target('A', 'sub'));
    expect((await metrics(x)).opened).toBe(0);
    s.client.close();
  });
  it('static symlink escape, dangling leaf, root inode replacement and POSIX access denial preserve external facts', async () => {
    const x = await start(),
      s = scope(x),
      o = await s.observe();
    await fs.writeFile(x.target('B', 'sentinel'), 'B original');
    await fs.symlink(x.target('B', ''), x.target('A', 'escape'));
    await fs.symlink(x.target('B', 'missing'), x.target('A', 'dangling'));
    expect(
      receipt(await s.client.invoke(s.request(o, 'escape', 'escape/new.txt', 'no'))).outcome
    ).toMatchObject({ status: 'failed', code: 'RESOURCE_OUTSIDE_WORKSPACE', effects: 'none' });
    expect(
      receipt(await s.client.invoke(s.request(o, 'dangling', 'dangling', 'no'))).outcome
    ).toMatchObject({ status: 'failed', code: 'RESOURCE_ALREADY_EXISTS', effects: 'none' });
    expect(await fs.readFile(x.target('B', 'sentinel'), 'utf8')).toBe('B original');
    await absent(x.target('B', 'new.txt'));
    if (process.getuid?.() !== 0) {
      await fs.chmod(x.target('A', 'sub'), 0);
      try {
        expect(
          receipt(await s.client.invoke(s.request(o, 'permission', 'sub/denied.txt', 'no'))).outcome
        ).toMatchObject({ status: 'failed', effects: 'none' });
      } finally {
        await fs.chmod(x.target('A', 'sub'), 0o700);
      }
      await absent(x.target('A', 'sub/denied.txt'));
      facts.push({
        kind: 'C11 native permissions',
        uid: process.getuid?.(),
        permissionDenialActuallyAsserted: true,
      });
    } else
      facts.push({
        kind: 'C11 native permissions',
        uid: 0,
        permissionDenialActuallyAsserted: false,
        reason: 'Privileged process does not enforce directory permissions',
      });
    await fs.rename(x.target('A', ''), path.join(x.directory, 'A-old'));
    await fs.mkdir(x.target('A', ''));
    expect(
      receipt(await s.client.invoke(s.request(o, 'inode', 'new.txt', 'no'))).outcome
    ).toMatchObject({ status: 'failed', code: 'WORKSPACE_ROOT_CHANGED', effects: 'none' });
    await absent(x.target('A', 'new.txt'));
    await absent(path.join(x.directory, 'A-old/new.txt'));
    s.client.close();
  });
  it.each(['old-protocol', 'accepted', 'oversize'])(
    'correlated %s terminal after actual disk success is transport unknown',
    async (kind) => {
      const x = await start(),
        s = scope(x),
        o = await s.observe(),
        deliver = x.worker.listeners('message')[0];
      const relay = (m: any) => {
        if (m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1_RESPONSE') {
          const broken =
            kind === 'old-protocol'
              ? {
                  ...m,
                  type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE',
                  argumentMode: 'snapshot-value-v1',
                }
              : kind === 'accepted'
                ? {
                    ...m,
                    terminal: {
                      phase: 'entered-returned',
                      outcome: { status: 'accepted', operationId: 'invented' },
                    },
                  }
                : {
                    ...m,
                    terminal: {
                      phase: 'entered-returned',
                      outcome: { status: 'succeeded', value: 'x'.repeat(525000) },
                    },
                  };
          deliver(broken);
        } else deliver(m);
      };
      x.worker.off('message', deliver);
      x.worker.on('message', relay);
      const req = s.request(o, 'bad-terminal', 'bad.txt', 'actual');
      const response = await s.client.invoke(req);
      expect(receipt(response).outcome.status).toBe('unknown');
      expect(x.host.getInteractionReport().transportUncertain).toBe(true);
      expect(await s.client.invoke(req)).toEqual(response);
      expect(await fs.readFile(x.target('A', 'bad.txt'), 'utf8')).toBe('actual');
      expect((await metrics(x)).creatorEntries.A).toBe(1);
      expect(await x.host.releaseWorker()).toBeNull();
      facts.push({
        kind: 'C08/C17 malformed transport after disk success',
        fault: kind,
        actualFile: 'actual',
        createCalls: 1,
        noRetry: true,
      });
      s.client.close();
    }
  );
});
