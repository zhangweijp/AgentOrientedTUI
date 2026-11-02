import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const ALL = ['ordinary-v2', 'snapshot-value-v2'] as const;
const invokes = (m: any) => /^VIEW_TOOL_INVOKE_(REF_V2|ORDINARY_V2)$/.test(m.type);
const closing: Array<() => Promise<void> | void> = [], facts: any[] = [];
let tag = 0;
afterEach(async () => { for (const close of closing.splice(0)) await close();vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; }
function project({ source, selection }: any) {
    const ids = new Set(selection.viewIds);return { views: source.views.filter((v: any) => ids.has(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(source.refs).filter((r: any) => ids.has(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(source.tools).flatMap((t: any) => t.targets.filter((t: any) => ids.has(t.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] };
}
function scope(x: any, visible = ['aa', 'bb']) {
    const authorizations: any[] = [], invocations: any[] = [], observations: any[] = [], control = { authorize: (_c: any): any => true };
    const opened = x.host.createInteractionScope({ project: (ctx: any) => project(ctx), authorize: (c: any) => { authorizations.push({ source: c.source, rawInput: c.rawInput, effectiveInput: c.effectiveInput, refSources: c.refSources });return control.authorize(c); }, canReadReceipt: () => true });
    expect(opened.status).toBe('opened');if (opened.status !== 'opened') throw Error(opened.issue.code);
    const client = opened.client;x.scopes ??= [];x.scopes.push({ authorizations, invocations, observations });closing.push(() => client.close());
    return { client, control, authorizations, async observe(ids = visible) { const r = await client.observe({ viewIds: ids });observations.push(r);expect(r.status).toBe('observed');return r.observation; },
        request(o: any, name = 'inspect', input: any = { file: 'file', choice: 'ok' }, view = 'aa') { const tool = o.tools.find((t: any) => t.name === name);expect(tool).toBeDefined();const binding = o.bindings.find((b: any) => b.toolId === tool.id && b.target.viewId === view);expect(binding).toBeDefined();return { invocationId: 'i-' + (++tag), observationId: o.observationId, bindingId: binding.bindingId, input }; },
        async invoke(request: any) { const id = Object.getOwnPropertyDescriptor(request, 'invocationId')?.value;const result = await client.invoke(request);invocations.push({ invocationId: id, result });return result; } };
}
function receipt(r: any) { expect(r.kind).toBe('receipt');return r.receipt; }
function value(r: any) { const result = receipt(r);expect(result.outcome.status).toBe('succeeded');return result.outcome.value; }
let temporary: string, Host: any, appFile: string, workerFile: string;
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
    const existing = x.messages.slice(from).find(predicate);if (existing) return Promise.resolve(existing);
    return new Promise((yes, no) => { const timer = setTimeout(() => { x.worker.off('message', receive);no(Error('Ref V2 barrier expired; ' + x.logs.join('').slice(-2000))); }, 5000);
        function receive(m: any) { if (predicate(m)) { clearTimeout(timer);x.worker.off('message', receive);yes(m); } }x.worker.on('message', receive); });
}
async function control(x: any, type: string, data: any = {}) { const id = ++tag, from = x.messages.length;await x.host.sendExternalEvent('ref-v2-probe', type, { ...data, tag: id });return wait(x, m => m.type === (type === 'state' ? 'REF_V2_COMMITTED' : 'REF_V2_CONTROL_ACK') && m.tag === id, from); }
async function change(x: any, patch: any, predicate: (draft: any) => boolean) { const from = x.messages.length;await control(x, 'state', { patch });return wait(x, m => m.type === 'SNAPSHOT_PREPARED' && predicate(m.draft), from); }
async function start(options: any = {}) {
    const caseId = expect.getState().currentTestName;
    const worker = options.existing ?? new Worker(workerFile, { stdout: true, stderr: true, env: { ...process.env, AOTUI_DATA_DIR: join(temporary, 'data-' + (++tag)) } });
    const messages: any[] = [], rawMessages: any[] = [], sent: any[] = [], attempted: any[] = [], logs: string[] = [];let transform: ((m: any) => any) | undefined;
    const emit = worker.emit.bind(worker);worker.emit = (event: string, ...args: any[]) => { if (event === 'message') { rawMessages.push(args[0]);const changed = transform ? transform(args[0]) : args[0];if (changed === null) return false;args[0] = changed; }return emit(event, ...args); };
    const post = worker.postMessage.bind(worker);worker.postMessage = (m: any) => { attempted.push(m);sent.push(m);post(m); };
    worker.stdout?.on('data', (b: any) => logs.push(String(b)));worker.stderr?.on('data', (b: any) => logs.push(String(b)));
    const host = new Host({ appId: 'app', desktopId: 'd', appModulePath: appFile, existingWorker: worker, timeout: 600,
        interactionModes: options.modes ?? ALL });
    worker.on('message', (m: any) => messages.push(m));
    const x: any = { host, worker, messages, rawMessages, sent, attempted, logs, transform(fn: any) { transform = fn; },
        entries: () => rawMessages.filter(m => m.type === 'REF_V2_HANDLER_ENTER'), posts: () => sent.filter(invokes), snapshot: () => host.snapshotReceiver.core.store.readLatest('app').snapshot };
    closing.push(async () => { facts.push({ kind: 'actual Node Worker V2 run', caseId, workerFile, hostKind: 'current Host', appModulePath: appFile,
        instanceId: host.appInstanceId, threadId: worker.threadId, rawMessages, deliveredMessages: messages, sent, attempted, scopes: x.scopes, logs, report: host.getInteractionReport?.() });
        const owned = host.worker === worker;host.terminate();if (owned) await worker.terminate(); });
    await host.start();await host.open();await wait(x, m => m.type === 'SNAPSHOT_PREPARED');return x;
}
describe('R07–R24 actual SDK / emitted Host / Node Worker Ref V2', () => {
    beforeAll(async () => {
        const runtime = resolve(process.cwd()), sdk = resolve(runtime, '../sdk');
        temporary = await mkdtemp(join(tmpdir(), 'aotui-v2-worker-'));
        workerFile = join(runtime, 'dist/worker-runtime/index.js');
        Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
        const modules = join(temporary, 'node_modules');
        await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const name of ['preact', 'linkedom']) await symlink(join(runtime, 'node_modules', name), join(modules, name), 'dir');
        await symlink(runtime, join(modules, '@aotui/runtime'), 'dir');
        appFile = join(temporary, 'app.mjs');
        await build({ stdin: { contents: await readFile(join(runtime, 'tests/fixtures/ref-v2-slice.mjs'), 'utf8'), resolveDir: runtime,
            sourcefile: 'ref-v2-slice.mjs', loader: 'js' }, outfile: appFile,
            alias: { '@aotui/sdk': join(sdk, 'dist/index.js') }, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
        facts.push({ kind: 'current emitted inputs', runtime, sdk, appFile, workerFile, node: process.version });
    });
    afterAll(async () => { if (process.env.AOTUI_W07_REF_V2_FACTS_FILE) await writeFile(process.env.AOTUI_W07_REF_V2_FACTS_FILE, JSON.stringify({ kind: 'Ref V2 controlled/actual evidence with explicit provenance', facts, afterAllReached: true }, null, 2)); });
    it('R08/R09/R12 really enters only the original target with one substituted slot and no default fill', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), input = { file: 'file', choice: 'ok', text: '😀', tags: ['a', 'b'] };
        const a = value(await s.invoke(s.request(o, 'inspect', input, 'aa'))), b = value(await s.invoke(s.request(o, 'inspect', input, 'bb')));
        expect(a.data.view).toBe('aa');expect(b.data.view).toBe('bb');expect(a.data.args.file).toMatchObject({ label: 'A', view: 'aa' });expect(Object.hasOwn(a.data.args, 'n')).toBe(false);
        const post = x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2' && m.target.viewId === 'aa');expect(post.rawArgs).toEqual(input);expect(post.effectiveArgs).toEqual(a.data.args);expect(post.tool.inputSchema['x-aotui-parameter-contract']).toBe('snapshot-value-params-v1');
        expect(post.refSources[0]).toMatchObject({ refId: 'file', snapshotId: post.snapshotId, viewId: 'aa' });expect(s.authorizations.find(a => a.source.target.viewId === 'aa').effectiveInput).toEqual(a.data.args);
        expect(x.entries().filter((e: any) => e.name === 'inspect')).toHaveLength(2);
    });
    it.each(['enum', 'array', 'range', 'required', 'extra', 'null', 'getter'])('R08/R21 invalid %s never authorizes/posts/enters', async kind => {
        const x = await start(), s = scope(x), o = await s.observe();let reads = 0;const input: any = { file: 'file', choice: 'ok' };
        if (kind === 'enum') input.choice = 7;if (kind === 'array') input.tags = ['a'];if (kind === 'range') input.n = 5;
        if (kind === 'required') delete input.choice;if (kind === 'extra') input.private = 'REF_V2_PRIVATE_INPUT';if (kind === 'null') input.meta = null;
        if (kind === 'getter') Object.defineProperty(input, 'n', { enumerable: true, get() { reads++;return 2; } });
        const result = await s.invoke(s.request(o, 'inspect', input));expect(result.kind === 'receipt' ? result.receipt.outcome.status : result.code).not.toBe('succeeded');
        expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);expect(reads).toBe(0);expect(JSON.stringify([x.sent, x.logs])).not.toContain('REF_V2_PRIVATE_INPUT');
    });
    it('R09/R13 uses historical A while the current committed handler observes revision2 without rebind', async () => {
        const x = await start(), s = scope(x), o = await s.observe();const request = s.request(o);const binding = o.bindings.find((b: any) => b.bindingId === request.bindingId);
        await change(x, { text: 'B', revision: 2 }, d => Object.values(d.refs).some((r: any) => r.ownerViewId === 'aa' && r.id === 'file' && r.target.payload.label === 'B'));
        const output = value(await s.invoke(request));expect(output.data.args.file.label).toBe('A');expect(output.data.revision).toBe(2);
        expect(x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2').target.bindingVersion).toBe(binding.target.bindingVersion);
    });
    it('R21 preserves open ordinary literals and whitespace without treating data as Schema markers', async () => {
        const x = await start(), s = scope(x), o = await s.observe();const extra = { 'x-aotui-ref': { kind: 'DATA' }, 'x-aotui-parameter-contract': 'DATA', refSource: 'DATA', text: '  unchanged  ' };
        const output = value(await s.invoke(s.request(o, 'open_ref', { file: 'file', extra })));expect(output.data.args.extra).toEqual(extra);expect(output.data.args.file.literal).toEqual({ 'x-aotui-ref': { kind: 'DATA' }, 'x-aotui-parameter-contract': 'DATA', refSource: 'DATA' });
        expect(x.entries()).toHaveLength(1);expect(x.entries()[0].frozen).toBe(true);expect(x.entries()[0].refFrozen).toBe(true);
    });
    it('R21 preserves special own Ref parameter names through real Core/codec/SDK execution', async () => {
        const x = await start(), s = scope(x), o = await s.observe();const names = ['', '__proto__', 'constructor', 'x-aotui-ref', 'x-aotui-parameter-contract', 'line\nname'];
        for (const [index, param] of names.entries()) {
            const result = value(await s.invoke(s.request(o, 'special_' + index, Object.fromEntries([[param, 'file']]))));expect(Object.hasOwn(result.data.args, param)).toBe(true);expect(result.data.args[param]).toMatchObject({ label: 'A', view: 'aa' });
            const request = x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2' && m.tool.name === 'special_' + index);expect(request.refSources[0].param).toBe(param);
        }
        expect(x.entries()).toHaveLength(names.length);expect(x.entries().every((e: any) => e.frozen && e.refFrozen)).toBe(true);
    });
    it.each(['foreign', 'type'])('R10 refuses %s Ref before policy', async kind => {
        const x = await start(), s = scope(x, ['aa']), o = await s.observe();const result = receipt(await s.invoke(s.request(o, kind === 'type' ? 'typed' : 'inspect', { file: kind === 'foreign' ? 'foreign-bb' : 'file', ...(kind === 'foreign' ? { choice: 'ok' } : {}) })));
        expect(result.outcome.code).toBe(kind === 'type' ? 'REF_TYPE_MISMATCH' : 'REF_NOT_VISIBLE');expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);
    });
    it.each(['default', 'ref-metadata', 'unmount', 'scope'])('R11 revokes %s during awaited policy before dispatch', async kind => {
        const x = await start();await change(x, { showSecond: false }, d => !d.views.some((v: any) => v.id === 'bb'));
        const s = scope(x, ['aa']), o = await s.observe(), entered = deferred(), release = deferred();s.control.authorize = () => { entered.resolve();return release.promise.then(() => true); };
        const running = s.invoke(s.request(o));await entered.promise;
        if (kind === 'default') await change(x, { defaultValue: 3 }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect' && t.inputSchema.properties.n.default === 3));
        if (kind === 'ref-metadata') await change(x, { refType: 'File' }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect' && t.inputSchema.properties.file['x-aotui-ref'].refType === 'File'));
        if (kind === 'unmount') await change(x, { show: false }, d => !d.views.some((v: any) => v.id === 'aa'));if (kind === 'scope') s.client.close();release.resolve();
        const result = await running;expect(result.code ?? result.receipt.outcome.code).toBe(kind === 'default' || kind === 'ref-metadata' ? 'TOOL_SOURCE_STALE' : kind === 'unmount' ? 'VIEW_INSTANCE_REVOKED' : 'SCOPE_UNAVAILABLE');expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);
    });
    it.each([5001, 10000, 10001])('R20 full effective %i-node real Worker boundary', async nodes => {
        const x = await start();await change(x, { capacityNodes: nodes }, d => Object.values(d.refs).some((r: any) => r.ownerViewId === 'aa' && r.id === 'big' && r.target.payload.list.length === nodes - 3));
        const s = scope(x, ['aa']), o = await s.observe(), result = await s.invoke(s.request(o, 'capacity', { file: 'big' }));
        if (nodes <= 10000) { expect(value(result).data.nodes).toBe(nodes);expect(s.authorizations).toHaveLength(1);expect(x.posts()).toHaveLength(1);expect(x.entries()).toHaveLength(1);expect(x.entries()[0].nestedFrozen).toBe(true); }
        else { expect(receipt(result).outcome.code).toBe('REF_ARGUMENT_BUDGET_EXCEEDED');expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0); }
    });
    it('R20 oversized raw input is refused before policy and Worker dispatch', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), result = await s.invoke(s.request(o, 'open_ref', { file: 'file', extra: { value: 'x'.repeat(150000) } }));
        expect(result.kind === 'receipt' ? result.receipt.outcome.status : result.code).not.toBe('succeeded');expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);
    });
    it('R14 unmount/re-mount revokes old target and disabled Tools never enter', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), old = s.request(o);
        await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'inspect'));
        expect(receipt(await s.invoke(old)).outcome.status).toBe('rejected');expect(x.entries()).toHaveLength(0);
        await change(x, { enabled: true }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect'));value(await s.invoke(s.request(await s.observe())));
        const before = await s.observe(), stale = s.request(before);await change(x, { show: false }, d => !d.views.some((v: any) => v.id === 'aa'));
        await change(x, { show: true }, d => d.views.some((v: any) => v.id === 'aa'));expect(receipt(await s.invoke(stale)).outcome.status).toBe('rejected');value(await s.invoke(s.request(await s.observe())));
    });
    it('R10 actual Worker rejects a foreign App instance before entering its callable', async () => {
        const x = await start(), s = scope(x), o = await s.observe();value(await s.invoke(s.request(o)));const source = x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2');
        const requestId = 'foreign-' + (++tag), from = x.messages.length, count = x.entries().length;
        x.worker.postMessage({ ...source, requestId, instanceId: 'other' });
        const response = await wait(x, m => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' && m.requestId === requestId, from);expect(response.terminal).toMatchObject({ phase: 'not-entered', result: { error: { code: 'APP_INSTANCE_MISMATCH' } } });expect(x.entries()).toHaveLength(count);
    });
    it.each(['disable', 'replace'])('R15 Worker refuses the old binding after a queued request is %s', async kind => {
        const x = await start();await change(x, { showSecond: false }, d => !d.views.some((v: any) => v.id === 'bb'));const s = scope(x, ['aa']), o = await s.observe(), queued: any[] = [], held = deferred();
        const physical = x.worker.postMessage.bind(x.worker);x.worker.postMessage = (m: any) => { if (m.type === 'VIEW_TOOL_INVOKE_REF_V2') { queued.push(m);held.resolve(); }else physical(m); };
        const running = s.invoke(s.request(o));await held.promise;
        if (kind === 'disable') await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'inspect'));
        else await change(x, { defaultValue: 3 }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect' && t.inputSchema.properties.n.default === 3));
        expect(queued).toHaveLength(1);expect(queued[0].tool.inputSchema['x-aotui-parameter-contract']).toBe('snapshot-value-params-v1');physical(queued[0]);
        const result = receipt(await running);expect(result.outcome.status).toBe('rejected');expect(x.entries()).toHaveLength(0);expect(x.host.getInteractionReport().transportUncertain).toBe(false);
        const terminal = x.rawMessages.find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' && m.requestId === queued[0].requestId);expect(terminal.terminal.phase).toBe('not-entered');
    });
    it.each(['business', 'throw'])('R16 keeps %s failure details and healthy transport', async mode => {
        const x = await start();await control(x, 'mode', { mode });const s = scope(x), o = await s.observe(), result = receipt(await s.invoke(s.request(o)));
        expect(result.executionPhase).toBe('entered-returned');expect(result.outcome.details.result.error.code).toBe(mode === 'business' ? 'BUSINESS' : 'E_HANDLER_ERROR');
        expect(x.host.getInteractionReport().transportUncertain).toBe(false);expect(JSON.stringify(x.messages)).not.toContain('REF_V2_PRIVATE_EXCEPTION');
    });
    it.each(['drop', 'type', 'mode', 'instance', 'request', 'huge'])('R17 %s terminal cannot be trusted or recycled', async kind => {
        const x = await start();if (kind === 'huge') await control(x, 'mode', { mode: 'huge' });
        x.transform((m: any) => m.type !== 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' ? m : kind === 'drop' ? null : kind === 'type' ? { ...m, type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' } : kind === 'mode' ? { ...m, argumentMode: 'snapshot-value-v1' } : kind === 'instance' ? { ...m, instanceId: 'other' } : kind === 'request' ? { ...m, requestId: 'other' } : m);
        const s = scope(x), o = await s.observe(), result = receipt(await s.invoke(s.request(o)));expect(result.outcome.status).toBe('unknown');expect(x.host.getInteractionReport().transportUncertain).toBe(true);expect(x.entries()).toHaveLength(1);
        const count = x.posts().length;await s.invoke(s.request(o));expect(x.posts()).toHaveLength(count);expect(await x.host.releaseWorker()).toBe(null);
    });
    it('R17 a Worker exit while the handler is held is unknown with no automatic retry', async () => {
        const x = await start();await control(x, 'mode', { mode: 'hold' });const s = scope(x), o = await s.observe(), request = s.request(o), running = s.invoke(request);await wait(x, m => m.type === 'REF_V2_HANDLER_ENTER');await x.worker.terminate();
        expect(await running).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' });expect(x.host.getInteractionReport().transportUncertain).toBe(true);expect(x.posts()).toHaveLength(1);expect(x.entries()).toHaveLength(1);expect(await x.host.releaseWorker()).toBe(null);
    });
    it.each(['inspect', 'capacity', 'plain'])('R18 actual %s response loss closes new dispatch', async name => {
        const x = await start(), s = scope(x), o = await s.observe();x.transform((m: any) => /^VIEW_TOOL_INVOKE_.*_RESPONSE$/.test(m.type) ? null : m);
        const args = name === 'inspect' ? { file: 'file', choice: 'ok' } : name === 'capacity' ? { file: 'big' } : {};
        const request = s.request(o, name, args, 'aa');
        expect(receipt(await s.invoke(request)).outcome.status).toBe('unknown');expect(x.entries()).toHaveLength(1);expect(x.host.getInteractionReport().transportUncertain).toBe(true);const count = x.posts().length;
        for (const [next, nextArgs] of [['inspect', { file: 'file', choice: 'ok' }], ['capacity', { file: 'big' }], ['plain', {}]] as const)
            await s.invoke(s.request(o, next, nextArgs, 'aa'));
        expect(x.posts()).toHaveLength(count);expect(x.entries()).toHaveLength(1);expect(await x.host.releaseWorker()).toBe(null);
    });
    it('R18 healthy RESET reuses the actual Worker under a new App identity', async () => {
        const x = await start(), s = scope(x), o = await s.observe();value(await s.invoke(s.request(o)));s.client.close();const id = x.host.appInstanceId, thread = x.worker.threadId, pooled = await x.host.releaseWorker();expect(pooled).toBe(x.worker);
        const next = await start({ existing: pooled, caseId: 'healthy reused worker' });expect(next.worker.threadId).toBe(thread);expect(next.host.appInstanceId).not.toBe(id);const n = scope(next), observed = await n.observe();value(await n.invoke(n.request(observed)));
    }, 10000);
});
