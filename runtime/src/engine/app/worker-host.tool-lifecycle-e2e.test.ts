import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { WorkerSandbox } from './worker-sandbox.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';

const repo = resolve(process.cwd(), '..'), running: any[] = [];
let consumer: string, AppWorkerHost: any;
beforeAll(async () => {
    consumer = await mkdtemp(join(tmpdir(), 'aotui-tool-consumer-'));
    const modules = join(consumer, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
    for (const pkg of ['runtime', 'sdk']) {
        const target = join(modules, '@aotui', pkg); await mkdir(target);
        await cp(join(repo, pkg, 'package.json'), join(target, 'package.json'));
        await cp(join(repo, pkg, 'dist'), join(target, 'dist'), { recursive: true });
    }
    for (const pkg of ['runtime', 'sdk']) for (const entry of await readdir(join(repo, pkg, 'node_modules'))) {
        if (entry.startsWith('.') || entry === '@aotui') continue;
        try { await symlink(join(repo, pkg, 'node_modules', entry), join(modules, entry), 'dir'); }
        catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    }
    await cp(join(repo, 'runtime/src/e2e-test/fixtures/tool-lifecycle.mjs'), join(consumer, 'app.mjs'));
    AppWorkerHost = (await import(pathToFileURL(join(modules, '@aotui/runtime/dist/engine/app/worker-host.js')).href)).AppWorkerHost;
}, 20000);
afterAll(async () => { if (consumer) await rm(consumer, { recursive: true, force: true }); });
let sequence = 0;
const gate = () => { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(yes => { resolve = yes; }); return { promise, resolve }; };
function wait(x: any, predicate: (message: any) => boolean, from = 0): Promise<any> {
    const found = x.messages.slice(from).find(predicate); if (found) return Promise.resolve(found);
    return new Promise((yes, no) => {
        const timer = setTimeout(() => { x.worker.off('message', receive); no(Error('Tool fixture barrier expired')); }, 5000);
        function receive(message: any) { if (predicate(message)) { clearTimeout(timer); x.worker.off('message', receive); yes(message); } }
        x.worker.on('message', receive);
    });
}
async function control(x: any, action: string) {
    const tag = ++sequence, from = x.messages.length;
    x.worker.postMessage({ type: 'TEST_CONTROL', action, tag });
    return wait(x, m => m.type === 'TEST_ACK' && m.tag === tag, from);
}
async function start(id = 'app', options: { holdInitialization?: boolean; existingWorker?: Worker } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'aotui-tool-'));
    const host = new AppWorkerHost({ appId: id as any, desktopId: 'd' as any,
        appModulePath: pathToFileURL(join(consumer, 'app.mjs')).href,
        workerScriptPath: join(consumer, 'node_modules/@aotui/runtime/dist/worker-runtime/index.js'), interactionModes: ['view-type-parameters-v1'], timeout: 5000,
        existingWorker: options.existingWorker,
        config: { AOTUI_DATA_DIR: join(root, 'state'), testFile: join(root, 'resource'), holdInitialization: !!options.holdInitialization },
    });
    await host.start(); const worker: Worker = (host as any).worker, messages: any[] = [];
    worker.on('message', message => messages.push(message)); const x: any = { host, worker, messages, root, closed: false };
    running.push(x); const opening = x.opening = host.open(); void opening.catch(() => {});
    if (options.holdInitialization) { await wait(x, m => m.type === 'TEST_INITIALIZING'); return x; }
    await opening; await wait(x, m => m.type === 'SNAPSHOT_PREPARED' && Object.keys(m.draft.tools).length > 0); return x;
}
function scope(x: any) {
    const controls = { authorize: (_c: any): boolean | Promise<boolean> => true };
    const opened = x.host.createInteractionScope({
        project: ({ source, selection }: any) => {
            const ids = new Set(selection.viewIds);
            const views = source.views.filter((v: any) => ids.has(v.id));
            return { views: views.map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
                refs: [],
                toolBindings: Object.values(source.tools).flatMap((tool: any) => 
                    views.some((view: any) => view.type === tool.viewType) ? [{ toolId: tool.id, execution: tool.execution }] : []),
                content: [] };
        }, authorize: (c: any) => controls.authorize(c), canReadReceipt: () => true,
    });
    expect(opened.status).toBe('opened'); if (opened.status !== 'opened') throw Error(opened.issue.code);
    return { ...opened.client, controls, async observeCounter() {
        const observed = await opened.client.observe({ viewIds: ['counter'] });
        if (observed.status === 'observed') expect(opened.client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
        expect(observed.status).toBe('observed'); return observed.observation;
    } };
}
const request = (observation: any, input: Record<string, unknown> = { view_id: 'counter', amount: 1 }) => ({ invocationId: 'invoke-' + ++sequence,
    observationId: observation.observationId, bindingId: observation.bindings[0].bindingId, input });
function outcome(result: any) { expect(result.kind).toBe('receipt'); return result.receipt.outcome; }
async function close(x: any, fail = false, transfer = false) {
    if (fail) await control(x, 'reject-close');
    const closed = x.host.close(); expect(x.host.close()).toBe(closed);
    await wait(x, m => m.type === 'TEST_STOPPED'); await wait(x, m => m.type === 'TEST_CLEANUP_ENTERED');
    expect(x.messages.findIndex((m: any) => m.type === 'TEST_CLEANUP_ENTERED'))
        .toBeGreaterThan(x.messages.findIndex((m: any) => m.type === 'TEST_STOPPED'));
    expect(x.host.getResourceReport().appCleanup?.report?.state).not.toBe('completed');
    expect(x.host.getResourceReport().resourcesReleased).toBe(false);
    expect(x.worker.threadId).not.toBe(-1);
    await control(x, 'release-cleanup');
    if (fail) await expect(closed).rejects.toThrow(); else await closed;
    await wait(x, m => m.type === 'TEST_RESOURCE_CLOSED');
    expect(x.host.getResourceReport().appCleanup).toMatchObject({ support: 'managed', report: {
        protocol: 'app-lifecycle-v2', state: fail ? 'failed' : 'completed', issues: fail ? ['APP_CLEANUP_FAILED'] : [],
    } });
    const returned = transfer ? await x.host.releaseWorker() : null;
    if (!transfer) x.host.terminate();
    const report = await x.host.waitForResourceRelease(); x.closed = true;
    expect(report.resourcesReleased).toBe(true);
    expect(report.worker).toBe(transfer ? 'transferred' : 'exited');
    if (!transfer) expect(x.worker.threadId).toBe(-1);
    return returned;
}
afterEach(async () => {
    for (const x of running.splice(0)) {
        if (!x.closed) { x.host.terminate(); await x.host.waitForResourceRelease(); }
        await rm(x.root, { recursive: true, force: true });
    }
});

describe('Actual SDK / Worker ordinary Tool and application cleanup', () => {
    it('stops through Sandbox before held installation settles and retains the leased Worker', async () => {
        const root = await mkdtemp(join(tmpdir(), 'aotui-tool-sandbox-'));
        const sandbox = new WorkerSandbox({ appId: 'sandbox' as any, desktopId: 'd' as any, appModulePath: pathToFileURL(join(consumer, 'app.mjs')).href,
            workerScriptPath: join(consumer, 'node_modules/@aotui/runtime/dist/worker-runtime/index.js'), interactionModes: ['view-type-parameters-v1'], runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 5000, pool: { initialSize: 0, maxSize: 1 } } }),
            config: { AOTUI_DATA_DIR: join(root, 'state'), testFile: join(root, 'resource'), holdInitialization: true } });
        const install = sandbox.installDynamic(); void install.catch(() => {});
        let worker: Worker | undefined;
        for (let index = 0; index < 100 && !worker; index++) { worker = (sandbox as any).lease?.worker; if (!worker) await new Promise(resolve => setTimeout(resolve, 1)); }
        expect(worker).toBeDefined(); const x: any = { worker, messages: [], host: (sandbox as any).workerHost, root, closed: false };
        worker!.on('message', message => x.messages.push(message)); running.push(x);
        await wait(x, m => m.type === 'TEST_INITIALIZING'); const closing = sandbox.disposeAsync();
        await wait(x, m => m.type === 'LIFECYCLE_RESPONSE' && m.appCleanup?.protocol === 'app-lifecycle-v2' && m.appCleanup.state === 'stopped');
        expect(sandbox.getCloseReport().state).toBe('closing'); expect((sandbox as any).pool.getReport().leased).toBe(1);
        worker!.postMessage({ type: 'TEST_RELEASE_INIT' }); await wait(x, m => m.type === 'TEST_STOPPED');
        await expect(install).rejects.toMatchObject({ code: 'INSTALL_FAILED' }); await wait(x, m => m.type === 'TEST_CLEANUP_ENTERED');
        expect(sandbox.getCloseReport().resourcesReleased).toBe(false); await control(x, 'release-cleanup');
        const report = await closing; expect(report).toMatchObject({ ok: false, resourcesReleased: true, issues: ['INSTALL_FAILED'],
            host: { appCleanup: { report: { state: 'completed', issues: [] } } }, lease: { disposition: 'exited' } });
        await wait(x, m => m.type === 'TEST_RESOURCE_CLOSED');
        expect(worker!.threadId).toBe(-1); x.closed = true;
    }, 15000);
    it.each(['rebind', 'disable'])('revokes the old binding during %s before handler entry', async action => {
        const x = await start('binding-' + action), s = scope(x), old = await s.observeCounter(), from = x.messages.length;
        await control(x, action); await wait(x, m => m.type === 'SNAPSHOT_PREPARED', from);
        expect(outcome(await s.invoke(request(old))).status).toBe('rejected'); expect((await control(x, 'inspect')).entries).toBe(0);
        if (action === 'disable') { const at = x.messages.length; await control(x, 'enable'); await wait(x, m => m.type === 'SNAPSHOT_PREPARED', at); }
        expect(outcome(await s.invoke(request(await s.observeCounter()))).status).toBe('succeeded'); await close(x);
    }, 15000);
    it('keeps the type-level binding across a View remount and invokes the current App handler', async () => {
        const x = await start('binding-remount'), s = scope(x), old = await s.observeCounter(), from = x.messages.length;
        await control(x, 'remount'); await wait(x, m => m.type === 'SNAPSHOT_PREPARED', from);
        expect(outcome(await s.invoke(request(old))).status).toBe('succeeded');
        expect((await control(x, 'inspect'))).toMatchObject({ value: 1, entries: 1 });
        expect(outcome(await s.invoke(request(await s.observeCounter()))).status).toBe('succeeded');
        expect((await control(x, 'inspect'))).toMatchObject({ value: 2, entries: 2 });
        await close(x);
    }, 15000);
    it.each(['none', 'partial', 'undeclared', 'throw'])('reports %s application failure effects and never executes a replay twice', async failure => {
        const x = await start('effect-' + failure), s = scope(x), req = request(await s.observeCounter(), { view_id: 'counter', amount: 2, failure });
        const first = outcome(await s.invoke(req));
        expect(first.status).toBe(failure === 'none' || failure === 'partial' ? 'failed' : 'unknown');
        if (failure === 'none' || failure === 'partial') expect(first.effects).toBe(failure);
        else expect(first).not.toHaveProperty('effects');
        expect((await control(x, 'inspect')).value).toBe(failure === 'none' ? 0 : 2);
        await s.invoke(req); expect((await control(x, 'inspect')).entries).toBe(1); await close(x);
    }, 15000);
    it('runs late stop callbacks while joining initialization and closes the actual resource', async () => {
        const x = await start('late', { holdInitialization: true });
        const closed = x.host.close();
        await wait(x, m => m.type === 'LIFECYCLE_RESPONSE' && m.appCleanup?.protocol === 'app-lifecycle-v2' && m.appCleanup.state === 'stopped');
        x.worker.postMessage({ type: 'TEST_RELEASE_INIT' });
        await wait(x, m => m.type === 'TEST_STOPPED'); await expect(x.opening).rejects.toThrow();
        await wait(x, m => m.type === 'TEST_CLEANUP_ENTERED');
        expect(x.host.getResourceReport().appCleanup?.report?.state).not.toBe('completed');
        expect(x.host.getResourceReport().resourcesReleased).toBe(false);
        await control(x, 'release-cleanup'); await closed;
        await wait(x, m => m.type === 'TEST_RESOURCE_CLOSED');
        expect(x.host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
        x.host.terminate(); const report = await x.host.waitForResourceRelease(); x.closed = true;
        expect(report.resourcesReleased).toBe(true); expect(x.worker.threadId).toBe(-1);
    }, 15000);
    it('reuses one physical Worker after the previous application cleanup completes', async () => {
        const a = await start('first'), physical = a.worker;
        expect(await close(a, false, true)).toBe(physical);
        const b = await start('second', { existingWorker: physical });
        const s = scope(b); expect(outcome(await s.invoke(request(await s.observeCounter()))).status).toBe('succeeded');
        expect((await control(b, 'inspect')).value).toBe(1); await close(b);
    }, 15000);
    it('keeps business values App-owned and rechecks binding authorization across remount', async () => {
        const a = await start('a'), b = await start('b'), sa = scope(a), sb = scope(b);
        const oa = await sa.observeCounter(), ob = await sb.observeCounter();
        expect(outcome(await sb.invoke(request(oa))).status).toBe('rejected'); expect((await control(b, 'inspect')).entries).toBe(0);
        expect(outcome(await sa.invoke(request(oa))).status).toBe('succeeded');
        expect((await control(a, 'inspect')).value).toBe(1); expect((await control(b, 'inspect')).value).toBe(0);
        // The type-level capability stays live across a View replacement; its handler is App-owned.
        expect(outcome(await sa.invoke(request(oa))).status).toBe('succeeded');
        expect((await control(a, 'inspect')).entries).toBe(2);
        const from = a.messages.length; await control(a, 'remount');
        await wait(a, m => m.type === 'SNAPSHOT_PREPARED', from);
        const current = await sa.observeCounter(), authorized = gate(), reached = gate();
        sa.controls.authorize = () => { reached.resolve(true); return authorized.promise; };
        const pending = sa.invoke(request(current));
        try {
            await reached.promise;
            const changed = a.messages.length; await control(a, 'remount'); await wait(a, m => m.type === 'SNAPSHOT_PREPARED', changed);
            authorized.resolve(true); expect(outcome(await pending).status).toBe('succeeded');
            expect((await control(a, 'inspect')).entries).toBe(3);
        } finally { authorized.resolve(true); await pending.catch(() => undefined); }
        expect(outcome(await sb.invoke(request(ob))).status).toBe('succeeded');
        await close(a); await close(b);
        expect(JSON.parse(await readFile(join(a.root, 'state/app-state/d/a/counter.json'), 'utf8')).value).toBe(3);
    }, 20000);
    it('checks the current View at Worker entry and lets the App cancel a held handler on stop', async () => {
        const x = await start(), s = scope(x), observation = await s.observeCounter();
        const send = x.worker.postMessage.bind(x.worker);
        x.worker.postMessage = (message: any) => send(message.type === 'VIEW_TOOL_INVOKE_V4' && message.argumentMode === 'view-type-parameters-v1'
            ? { ...message, execution: { kind: 'view-type', activationId: 'stale-activation' } } : message);
        expect(outcome(await s.invoke(request(observation))).status).toBe('rejected');
        expect((await control(x, 'inspect')).entries).toBe(0); x.worker.postMessage = send;
        const pending = s.invoke(request(observation, { view_id: 'counter', amount: 1, hold: true }));
        await wait(x, m => m.type === 'TEST_ENTERED'); const closed = x.host.close();
        await wait(x, m => m.type === 'TEST_STOPPED'); await control(x, 'release-handler');
        // Closing revokes this Scope, including receipt access. It must not
        // return a success or permit a retry through the retired authority.
        expect(await pending).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' });
        expect((await control(x, 'inspect')).value).toBe(0);
        await wait(x, m => m.type === 'TEST_CLEANUP_ENTERED'); await control(x, 'release-cleanup'); await closed;
        x.host.terminate(); const report = await x.host.waitForResourceRelease(); x.closed = true;
        await wait(x, m => m.type === 'TEST_RESOURCE_CLOSED');
        expect(report.appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
        expect(report.resourcesReleased).toBe(true); expect(x.worker.threadId).toBe(-1);
    }, 15000);
    it('retains callback failure, releases Host resources and refuses a healthy pool return', async () => {
        const x = await start(); await close(x, true);
        expect(x.host.getResourceReport().appCleanup).toMatchObject({ support: 'managed', report: { state: 'failed', issues: ['APP_CLEANUP_FAILED'] } });
        expect(x.host.getResourceReport().resourcesReleased).toBe(true); expect(await x.host.releaseWorker()).toBeNull();
    }, 15000);
});
