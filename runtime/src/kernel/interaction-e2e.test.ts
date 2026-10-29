import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let directory: string, app: string, runtimePackage: any;
const facts: any[] = [];
const deferred = () => { let resolve!: (value?: any) => void, reject!: (error: unknown) => void;
    const promise = new Promise<any>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; };
async function capture(path: string, body: string) {
    await writeFile(path, body);const output = process.env.AOTUI_W08_C1_FACTS_DIR;
    if (output) { const hash = createHash('sha256').update(body).digest('hex'), folder = join(output, 'b2-inputs');await mkdir(folder, { recursive: true });
        await writeFile(join(folder, hash), body);await writeFile(join(folder, hash + '.json'), JSON.stringify({ path, sha256: hash, capturedBeforeExecution: true })); }
}
beforeAll(async () => {
    const repo = resolve(process.cwd(), '..');directory = await mkdtemp(join(tmpdir(), 'aotui-b2-public-'));
    const modules = join(directory, 'node_modules');await mkdir(join(modules, '@aotui'), { recursive: true });
    for (const pkg of ['runtime', 'sdk']) {
        const pack = join(directory, 'pack-' + pkg), target = join(modules, '@aotui', pkg);await mkdir(pack);await mkdir(target);
        const argv = ['pack', '--ignore-scripts', '--json', '--pack-destination', pack];
        await capture(join(directory, 'pack-' + pkg + '-before.json'), JSON.stringify({ cwd: join(repo, pkg), argv: ['npm', ...argv], env: { NPM_CONFIG_CACHE: join(directory, 'npm-cache') } }));
        const result = JSON.parse(execFileSync('npm', argv, { cwd: join(repo, pkg), env: { ...process.env, NPM_CONFIG_CACHE: join(directory, 'npm-cache') }, encoding: 'utf8' }));
        const archive = join(pack, result[0].filename);execFileSync('tar', ['-xzf', archive, '--strip-components', '1', '-C', target]);
        facts.push({ package: pkg, archive, sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), actualTar: true });
    }
    const links: any[] = [];
    for (const pkg of ['runtime', 'sdk']) for (const entry of await readdir(join(repo, pkg, 'node_modules'), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === '@aotui') continue;
        const target = join(modules, entry.name);try { await symlink(join(repo, pkg, 'node_modules', entry.name), target, 'dir');links.push({ path: target, source: join(repo, pkg, 'node_modules', entry.name) }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    }
    for (const entry of await readdir(join(repo, 'runtime/node_modules/@aotui'))) {
        if (entry === 'runtime' || entry === 'sdk') continue;
        await symlink(join(repo, 'runtime/node_modules/@aotui', entry), join(modules, '@aotui', entry), 'dir');
    }
    const document = await readFile(join(repo, 'runtime/docs/runtime-app-interaction.md'), 'utf8');
    const body = document.match(/<!-- b2-app:start -->\n```js\n([\s\S]*?)\n```\n<!-- b2-app:end -->/)?.[1];if (!body) throw Error('App example markers');
    app = join(directory, 'app.mjs');await capture(app, body + '\n');
    const entry = join(directory, 'entry.mjs');await capture(entry, "export * from '@aotui/runtime';\n");runtimePackage = await import(pathToFileURL(entry).href);
    facts.push({ selfPackageLinks: false, thirdPartyLinks: links, completeCleanInstall: false });
}, 30000);
afterAll(async () => { const output = process.env.AOTUI_W08_C1_FACTS_DIR;if (output) { await mkdir(output, { recursive: true });await writeFile(join(output, 'b2-public-e2e.json'), JSON.stringify(facts, null, 2)); }if (directory) await rm(directory, { recursive: true, force: true }); });

const allModes = ['ordinary-v1', 'ordinary-v2', 'snapshot-value-v1', 'snapshot-value-v2', 'create-if-absent-v1'];
function makeRuntime() { return runtimePackage.createRuntime({ worker: { timeoutMs: 4000, pool: { initialSize: 0, maxSize: 8 } } }); }
async function install(runtime: any, desktop = 'd', id = 'a', modes: any = allModes, extra = {}, appPath = app) {
    try { runtime.getDesktop(desktop); } catch { await runtime.createDesktop(desktop); }
    return runtime.installDynamicWorkerApp(desktop, pathToFileURL(appPath).href, { appId: id, experimentalInteractionModes: modes, config: { AOTUI_DATA_DIR: join(directory, 'data', desktop, id) }, ...extra });
}
function scope(runtime: any, desktop = 'd', id = 'a') {
    const controls = { project: (context: any): any => grant(context), authorize: (_context: any): any => true, read: (_meta: any, _signal: any): any => true };
    function grant({ source, selection }: any) { return {
        views: source.views.filter((v: any) => selection.viewIds.includes(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(source.refs).filter((r: any) => selection.viewIds.includes(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(source.tools).flatMap((t: any) => t.targets.filter((target: any) => selection.viewIds.includes(target.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] }; }
    const policy = { project: (context: any) => controls.project(context), authorize: (context: any) => controls.authorize(context), canReadReceipt: (meta: any, signal: any) => controls.read(meta, signal) };
    const result = runtime.experimentalCreateAppScope(desktop, id, policy);expect(result.status).toBe('opened');if (result.status !== 'opened') throw Error(result.issue.code);
    async function observe() { let observation: any;await vi.waitFor(async () => { const result = await resultClient.observe({ viewIds: ['detail'] });expect(result.status).toBe('observed');if (result.status === 'observed') observation = result.observation; }, { timeout: 6000 });return observation; }
    const resultClient = result.client;return { client: resultClient, controls, policy, observe };
}
function request(observation: any, name = 'ordinary', input: any = {}, invocationId = 'call') {
    const tool = observation.tools.find((tool: any) => tool.name === name), binding = observation.bindings.find((binding: any) => binding.toolId === tool?.id && binding.target.viewId === 'detail');
    if (!binding) throw Error('Missing tool binding ' + name);return { invocationId, observationId: observation.observationId, bindingId: binding.bindingId, input };
}

it('B2 C08/26 all five modes execute through actual tar package public default Runtime/SDK', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), observation = await s.observe(), outputs: any[] = [];
        for (const [index, [name, input]] of ([['ordinary', {}], ['parameters', { text: 'hello' }], ['ref', { file: 'file' }], ['ref_parameters', { file: 'file', text: 'hello' }], ['create', { relativePath: 'example.txt', content: 'x' }]] as const).entries()) {
            const result = await s.client.invoke(request(observation, name, input, 'mode-' + index));expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });outputs.push(result);
        }
        expect(outputs[2].receipt.outcome.value.data.args.file).toEqual({ text: 'original' });expect(outputs[3].receipt.outcome.value.data.args.file).toEqual({ text: 'original' });
        expect(runtime.experimentalCreateAppScope('d', 'a', {}).issue.code).toBe('SCOPE_INVALID');s.client.close();facts.push({ case: 'all-five-public', outputs });
    } finally { expect((await runtime.beginShutdown().completion).ok).toBe(true); }
}, 15000);

it.each(allModes)('B2 C09 public single-mode %s keeps other execution modes unavailable without handler fallback', async mode => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', [mode]);const s = scope(runtime), observation = await s.observe();
        const choices = [['ordinary', {}], ['parameters', { text: 'x' }], ['ref', { file: 'file' }], ['ref_parameters', { file: 'file', text: 'x' }], ['create', { relativePath: 'x', content: 'x' }]] as const;
        const index = allModes.indexOf(mode), [name, input] = choices[index];
        const first = await s.client.invoke(request(observation, name, input));expect(first.receipt.outcome.status).toBe('succeeded');
        const other = choices[(index + 1) % choices.length], refused = await s.client.invoke(request(observation, other[0], other[1], 'unsupported'));
        expect(refused.receipt.outcome.status).toBe('rejected');
        const again = await s.client.invoke(request(observation, name, input, 'next'));
        expect(again.receipt.outcome.value.data?.calls ?? again.receipt.outcome.value.calls).toBe(2);s.client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it.each(allModes)('B2 C09/24 missing or wrong ACK denies public %s while known-empty Core remains verifiable', async mode => {
    for (const wrong of [false, true]) {
        const runtime = makeRuntime(), script = join(directory, `ack-${mode}-${wrong}.mjs`);
        await capture(script, `import {parentPort} from 'node:worker_threads';parentPort.on('message',m=>{parentPort.postMessage({type:m.type==='INIT'?'INIT_RESPONSE':m.type==='RESET'?'RESET_RESPONSE':'LIFECYCLE_RESPONSE',requestId:m.requestId,success:true,...(m.type==='INIT'?{appInstanceId:m.appInstanceId${wrong ? ",acceptedCapabilities:['unknown-capability']" : ''}}:{})});});\n`);
        try {
            await install(runtime, 'd', 'a', [mode], { workerScriptPath: script });
            expect(runtime.experimentalCreateAppScope('d', 'a', { project() { throw Error('no project'); }, authorize() { throw Error('no authorize'); }, canReadReceipt() { throw Error('no read'); } })).toMatchObject({ issue: { code: 'REF_EXECUTION_UNAVAILABLE' } });
            expect(await runtime.beginShutdown().completion).toMatchObject({ resourcesReleased: true, hasFailures: false, verification: 'mixed', interactions: { verified: true, retainedScopes: 0, retainedBytes: 0 } });
        } finally { await runtime.beginShutdown().completion; }
    }
}, 15000);

it('B2 C10 public scope capacity shares the existing single authority and can release its slots', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), clients = [s.client];
        for (let index = 1; index < 16; index++) clients.push(scope(runtime).client);
        expect(runtime.experimentalCreateAppScope('d', 'a', s.policy)).toMatchObject({ issue: { code: 'INVOCATION_CAPACITY' } });
        clients[0].close();const next = scope(runtime);next.client.close();for (const client of clients) client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it.each((['runtime', 'desktop', 'app', 'delete'] as const).flatMap(parent => [false, true].map(reject => [parent, reject] as const)))('B2 C14/17 actual %s close holds project until reject=%s resolves actual ownership', async (parent, reject) => {
    const runtime = makeRuntime(), gate = deferred(), entered = deferred();let closing: any;
    try {
        await install(runtime);const s = scope(runtime);await s.observe();let calls = 0;
        s.controls.project = (context: any) => { calls++;entered.resolve();context.signal.addEventListener('abort', () => {
            expect(runtime.experimentalCreateAppScope('d', 'a', s.policy).status).toBe('rejected');
        });return gate.promise; };
        const observing = s.client.observe({ viewIds: ['detail'] });await entered.promise;const desktop = runtime.getDesktop('d');
        closing = parent === 'runtime' ? runtime.beginShutdown() : parent === 'desktop' || parent === 'delete' ? runtime.beginDesktopShutdown('d', parent === 'delete' ? { intent: 'delete' } : undefined) : undefined;
        const appClosing = parent === 'app' ? desktop.closeApp('a') : undefined;
        const previous = calls, sameStack = s.client.observe({ viewIds: ['detail'] });
        expect(await s.client.invoke({ invocationId: 'late', observationId: 'old', bindingId: 'old', input: {} })).not.toHaveProperty('kind', 'receipt');
        expect(await s.client.readReceipt('late')).toHaveProperty('code', 'SCOPE_UNAVAILABLE');
        expect(runtime.experimentalCreateAppScope('d', 'a', s.policy).status).toBe('rejected');await sameStack;expect(calls).toBe(previous);
        let appDone = false;void appClosing?.then(() => { appDone = true; });
        if (closing) {
            const deadline = await closing.wait({ timeoutMs: 5 });expect(deadline).toMatchObject({ status: 'deadline', report: { resourcesReleased: false, hasFailures: false, interactions: { verified: true, retainedScopes: 1 } } });
            facts.push({ case: 'held-project-' + parent, pending: deadline.report });
        } else { for (let i = 0; i < 30; i++) await Promise.resolve();expect(appDone).toBe(false); }
        if (reject) gate.reject(Error('held project'));else gate.resolve({ views: [], refs: [], targets: [], content: [] });expect((await observing).status).toBe('rejected');await appClosing;
        if (closing) expect(await closing.completion).toMatchObject({ resourcesReleased: true, interactions: { verified: true, retainedScopes: 0, retainedBytes: 0 } });
    } finally { gate.resolve({ views: [], refs: [], targets: [], content: [] });await runtime.beginShutdown().completion; }
}, 15000);

it.each((['authorize', 'auto-read', 'explicit-read'] as const).flatMap(stage => (['runtime', 'desktop', 'app'] as const).map(parent => [stage, parent] as const)))('B2 C18 actual SDK/Node %s remains owned through %s close until resolve/reject', async (stage, parent) => {
    for (const reject of [false, true]) {
        const runtime = makeRuntime(), entered = deferred(), gate = deferred();try {
            const trace = join(directory, `handlers-${stage}-${parent}-${reject}`), tracedApp = trace + '.mjs';
            const original = await readFile(app, 'utf8'), traced = original.replace('const result = async args => ({ success: true, data: { args, calls: ++calls } });',
                `const result = async args => { await appendFile(${JSON.stringify(trace)}, 'entered\\n');return { success: true, data: { args, calls: ++calls } }; };`);
            expect(traced).not.toBe(original);await capture(tracedApp, "import { appendFile } from 'node:fs/promises';\n" + traced);
            const handlerCount = async () => (await readFile(trace, 'utf8').catch(error => { if (error.code === 'ENOENT') return '';throw error; })).split('\n').filter(Boolean).length;
            await install(runtime, 'd', 'a', allModes, {}, tracedApp);const s = scope(runtime), observation = await s.observe(), input = request(observation);let calls = 0;
            if (stage === 'explicit-read') await s.client.invoke(input);
            const hold = () => { calls++;entered.resolve();return gate.promise; };
            if (stage === 'authorize') s.controls.authorize = hold;else s.controls.read = hold;
            const work = stage === 'explicit-read' ? s.client.readReceipt('call') : s.client.invoke(input);await entered.promise;
            const handlersBeforeClose = await handlerCount();expect(handlersBeforeClose).toBe(stage === 'authorize' ? 0 : 1);
            const appClosing = parent === 'app' ? runtime.getDesktop('d').closeApp('a') : undefined;
            const closing = parent === 'desktop' ? runtime.beginDesktopShutdown('d') : runtime.beginShutdown(), before = closing.inspect();expect((await closing.wait({ timeoutMs: 5 })).status).toBe('deadline');
            expect(closing.inspect()).toMatchObject({ resourcesReleased: false, hasFailures: false, interactions: { verified: true, retainedScopes: 1 } });
            expect(await s.client.readReceipt('call')).toHaveProperty('code', 'SCOPE_UNAVAILABLE');expect(calls).toBe(1);
            if (reject) gate.reject(Error('held policy'));else gate.resolve(true);
            expect(await work).not.toHaveProperty('kind', 'receipt');const report = await closing.completion;
            expect(report).toMatchObject({ ok: true, resourcesReleased: true, interactions: { verified: true, retainedScopes: 0, retainedBytes: 0 } });
            const handlersAfterClose = await handlerCount();expect(handlersAfterClose).toBe(handlersBeforeClose);
            await appClosing;expect(before.interactions.retainedScopes).toBe(1);facts.push({ case: stage, parent, reject, handlersBeforeClose, handlersAfterClose, before, report });
        } finally { gate.resolve(true);await runtime.beginShutdown().completion; }
    }
}, 25000);

it('B2 C06/10–12/16 public pending/collapse/pause/reopen/reinitialize keeps modes and permanently closes old clients', async () => {
    const runtime = makeRuntime();try {
        const id = await runtime.createDesktop('d'), desktop = runtime.getDesktop(id), modes = ['ordinary-v1'];
        await desktop.registerPendingApp({ appId: 'a', modulePath: pathToFileURL(app).href, experimentalInteractionModes: modes });modes.length = 0;
        expect(runtime.experimentalCreateAppScope(id, 'a', {}).issue.code).toBe('SCOPE_UNAVAILABLE');await desktop.openApp('a');
        const s = scope(runtime), first = await s.observe();await desktop.collapseApp('a');const collapsed = scope(runtime);collapsed.client.close();
        await runtime.suspend(id);expect(runtime.experimentalCreateAppScope(id, 'a', s.policy).issue.code).toBe('SCOPE_UNAVAILABLE');
        const paused = await s.client.invoke(request(first));expect(paused.receipt?.outcome.status).toBe('rejected');await runtime.resume(id);
        expect((await s.client.invoke(request(first, 'ordinary', {}, 'resumed'))).receipt.outcome.status).toBe('succeeded');
        await desktop.closeApp('a');expect((await s.client.observe({ viewIds: ['detail'] })).status).toBe('rejected');await desktop.openApp('a');
        const reopened = scope(runtime), next = await reopened.observe();expect(next.source.instanceId).not.toBe(first.source.instanceId);
        const reinitializing = runtime.reinitializeDesktopApps(id);expect(runtime.experimentalCreateAppScope(id, 'a', s.policy).status).toBe('rejected');
        expect((await reopened.client.observe({ viewIds: ['detail'] })).status).toBe('rejected');await reinitializing;
        const fresh = scope(runtime), last = await fresh.observe();expect(last.source.instanceId).not.toBe(next.source.instanceId);
        expect((await fresh.client.invoke(request(last))).receipt.outcome.status).toBe('succeeded');fresh.client.close();
        expect(JSON.stringify(runtime.serialize(id))).not.toContain('experimentalInteractionModes');facts.push({ case: 'instance-boundaries', instances: [first.source.instanceId, next.source.instanceId, last.source.instanceId] });
    } finally { await runtime.beginShutdown().completion; }
}, 20000);

it('B2 C12/21 two Desktop/three App actual owners aggregate held callbacks without rerouting same IDs', async () => {
    const runtime = makeRuntime(), gates = [deferred(), deferred(), deferred()], entered = [deferred(), deferred(), deferred()];try {
        await install(runtime, 'one', 'a');await install(runtime, 'one', 'b');await install(runtime, 'two', 'a');
        const scopes = [scope(runtime, 'one', 'a'), scope(runtime, 'one', 'b'), scope(runtime, 'two', 'a')], observations = await Promise.all(scopes.map(s => s.observe()));
        const foreign = await scopes[1].client.invoke(request(observations[0]));expect(foreign.receipt?.outcome.status).toBe('rejected');
        const works = scopes.map((s, index) => { s.controls.project = () => { entered[index].resolve();return gates[index].promise; };return s.client.observe({ viewIds: ['detail'] }); });await Promise.all(entered.map(g => g.promise));
        const one = runtime.getDesktop('one').beginClose(), two = runtime.getDesktop('two').beginClose();
        const closing = runtime.beginShutdown(), previous = closing.inspect();expect(previous.interactions).toMatchObject({ verified: true, retainedScopes: 3 });
        expect(one.inspect().interactions.retainedScopes).toBe(2);expect(two.inspect().interactions.retainedScopes).toBe(1);
        expect(previous.interactions.retainedBytes).toBe(one.inspect().interactions.retainedBytes + two.inspect().interactions.retainedBytes);
        for (const [index, remaining] of [2, 1, 0].entries()) { gates[index].resolve({ views: [], refs: [], targets: [], content: [] });await works[index];
            await vi.waitFor(() => expect(closing.inspect().interactions.retainedScopes).toBe(remaining));
            expect(closing.inspect().interactions.retainedBytes).toBe(one.inspect().interactions.retainedBytes + two.inspect().interactions.retainedBytes); }
        const report = await closing.completion;expect(report).toMatchObject({ resourcesReleased: true, interactions: { verified: true, retainedScopes: 0, retainedBytes: 0 } });
        expect(previous.interactions.retainedScopes).toBe(3);facts.push({ case: 'three-owners', previous, report });
    } finally { for (const gate of gates) gate.resolve({ views: [], refs: [], targets: [], content: [] });await runtime.beginShutdown().completion; }
}, 20000);

it('B2 C07 public launch configuration spoofing cannot grant modes', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', undefined, { experimentalInteractionModes: undefined, config: { experimentalInteractionModes: allModes, snapshotShadow: true, experimentalReadOnlyViewTools: true } });
        expect(runtime.experimentalCreateAppScope('d', 'a', { project() {}, authorize() {}, canReadReceipt() {} })).toMatchObject({ issue: { code: 'REF_EXECUTION_UNAVAILABLE' } });
    } finally { await runtime.beginShutdown().completion; }
}, 15000);
