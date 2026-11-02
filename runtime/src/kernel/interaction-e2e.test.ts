import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let directory: string, app: string, runtimePackage: any, adaptersPackage: any;
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
    const adaptersEntry = join(directory, 'adapters.mjs');await capture(adaptersEntry, "export * from '@aotui/runtime/adapters';\n");adaptersPackage = await import(pathToFileURL(adaptersEntry).href);
    facts.push({ selfPackageLinks: false, thirdPartyLinks: links, completeCleanInstall: false });
}, 30000);
afterAll(async () => { const output = process.env.AOTUI_W08_C1_FACTS_DIR;if (output) { await mkdir(output, { recursive: true });await writeFile(join(output, 'b2-public-e2e.json'), JSON.stringify(facts, null, 2)); }if (directory) await rm(directory, { recursive: true, force: true }); });

const allModes = ['ordinary-v2', 'snapshot-value-v2'] as const;
function makeRuntime() { return runtimePackage.createRuntime({ worker: { timeoutMs: 4000, pool: { initialSize: 0, maxSize: 8 } } }); }
async function install(runtime: any, desktop = 'd', id = 'a', modes?: any, extra = {}, appPath = app) {
    try { runtime.getDesktop(desktop); } catch { await runtime.createDesktop(desktop); }
    return runtime.installDynamicWorkerApp(desktop, pathToFileURL(appPath).href, {
        appId: id, config: { AOTUI_DATA_DIR: join(directory, 'data', desktop, id) }, ...extra,
        ...(modes === undefined ? {} : { interactionModes: modes }),
    });
}
function scope(runtime: any, desktop = 'd', id = 'a') {
    const controls = { project: (context: any): any => grant(context), authorize: (_context: any): any => true, read: (_meta: any, _signal: any): any => true };
    function grant({ source, selection }: any) {
        const views = source.views.filter((view: any) => selection.viewIds.includes(view.id));
        return {
        views: views.map((view: any) => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
        refs: Object.values(source.refs).filter((r: any) => selection.viewIds.includes(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(source.tools).flatMap((t: any) => t.targets.filter((target: any) => selection.viewIds.includes(target.viewId)).map((target: any) => ({ toolId: t.id, target }))),
        content: views.map((view: any) => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
    }; }
    const policy = { project: (context: any) => controls.project(context), authorize: (context: any) => controls.authorize(context), canReadReceipt: (meta: any, signal: any) => controls.read(meta, signal) };
    const result = runtime.createAppScope(desktop, id, policy);expect(result.status).toBe('opened');if (result.status !== 'opened') throw Error(result.issue.code);
    async function observe() { let observation: any;await vi.waitFor(async () => { const result = await resultClient.observe({ viewIds: ['detail'] });expect(result.status).toBe('observed');if (result.status === 'observed') observation = result.observation; }, { timeout: 6000 });return observation; }
    const resultClient = result.client;return { client: resultClient, controls, policy, observe };
}
function request(observation: any, name = 'ordinary', input: any = { text: 'change' }, invocationId = 'call') {
    const tool = observation.tools.find((tool: any) => tool.name === name), binding = observation.bindings.find((binding: any) => binding.toolId === tool?.id && binding.target.viewId === 'detail');
    if (!binding) throw Error('Missing tool binding ' + name);return { invocationId, observationId: observation.observationId, bindingId: binding.bindingId, input };
}
async function waitForViewText(client: any, expected: string) {
    const deadline = Date.now() + 6000;let last: unknown;
    while (Date.now() < deadline) {
        const result = await client.observe({ viewIds: ['detail'] });
        if (result.status === 'observed') {
            const view = result.observation.views.find((entry: any) => entry.id === 'detail');
            client.releaseObservation(result.observation.observationId);
            const content = String(view?.content?.value ?? '');
            if (content.includes(expected)) return content;
            last = content;
        } else last = result;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('View update deadline: ' + JSON.stringify({ expected, last }));
}

it('B2 C08/26 omitted interactionModes enables both V2 contracts in the actual tar package', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), observation = await s.observe(), outputs: any[] = [];
        for (const [index, [name, input]] of ([['ordinary', { text: 'change' }], ['ref', { file: 'file' }]] as const).entries()) {
            const result = await s.client.invoke(request(observation, name, input, 'mode-' + index));expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });outputs.push(result);
        }
        expect(outputs[1].receipt.outcome.value.data.currentValueAvailable).toBe(true);
        await waitForViewText(s.client, 'Completed operations: 1');
        expect(runtime.createAppScope('d', 'a', {}).issue.code).toBe('SCOPE_INVALID');s.client.close();facts.push({ case: 'default-v2-public', outputs });
    } finally { expect((await runtime.beginShutdown().completion).ok).toBe(true); }
}, 15000);

it.each(allModes)('B2 C09 public single-mode %s keeps other execution modes unavailable without handler fallback', async mode => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', [mode]);const s = scope(runtime), observation = await s.observe();
        const choices = mode === 'ordinary-v2'
            ? { enabled: ['ordinary', { text: 'change' }] as const, disabled: ['ref', { file: 'file' }] as const }
            : { enabled: ['ref', { file: 'file' }] as const, disabled: ['ordinary', { text: 'change' }] as const };
        expect(observation.bindings.some((binding: any) => binding.toolId === observation.tools.find((tool: any) => tool.name === choices.enabled[0])?.id)).toBe(true);
        expect(observation.bindings.some((binding: any) => binding.toolId === observation.tools.find((tool: any) => tool.name === choices.disabled[0])?.id)).toBe(false);
        const [name, input] = choices.enabled;
        const first = await s.client.invoke(request(observation, name, input));expect(first.receipt.outcome.status).toBe('succeeded');
        const again = await s.client.invoke(request(observation, name, input, 'next'));
        if (name === 'ref') expect(again.receipt.outcome.value.data.currentValueAvailable).toBe(true);
        s.client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('B2 C05 explicit empty interactionModes preserves Views but grants no executable bindings', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', []);const s = scope(runtime), observation = await s.observe();
        expect(observation.views.some((view: any) => view.id === 'detail')).toBe(true);
        expect(observation.bindings).toEqual([]);
        s.client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('B2 C05 invalid public interactionModes reject before registering the app', async () => {
    const runtime = makeRuntime();try {
        await expect(install(runtime, 'd', 'duplicate', ['ordinary-v2', 'ordinary-v2'])).rejects.toMatchObject({ code: 'INTERACTION_MODES_INVALID' });
        await expect(install(runtime, 'd', 'unknown', ['ordinary-v2', 'future-v3'])).rejects.toMatchObject({ code: 'INTERACTION_MODES_INVALID' });
        expect(runtime.getDesktop('d').getInstalledApps()).toEqual([]);
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('B2 C09 source authorization denies entry and unknown handler results are not retried', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), observation = await s.observe();
        s.controls.authorize = () => false;
        const denied = await s.client.invoke(request(observation, 'ordinary', { text: 'change' }, 'denied'));
        expect(denied).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'not-dispatched', outcome: { status: 'rejected' } } });
        s.controls.authorize = () => true;
        const first = await s.client.invoke(request(observation, 'ordinary', { text: 'throw' }, 'unknown'));
        expect(first).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'unknown' } } });
        expect(await s.client.invoke(request(observation, 'ordinary', { text: 'throw' }, 'unknown'))).toEqual(first);
        const later = await s.client.invoke(request(observation, 'ordinary', { text: 'change' }, 'after-unknown'));
        expect(later.receipt.outcome.status).toBe('succeeded');
        await waitForViewText(s.client, 'Completed operations: 1');
        s.client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it.each(allModes)('B2 C09/24 missing or wrong ACK denies public %s while known-empty Core remains verifiable', async mode => {
    for (const wrong of [false, true]) {
        const runtime = makeRuntime(), script = join(directory, `ack-${mode}-${wrong}.mjs`);
        await capture(script, `import {parentPort} from 'node:worker_threads';
let instanceId, closePending;
function respond(m) {
  const init=m.type==='INIT', completed=m.type==='APP_CLOSE';
  if(init) instanceId=m.appInstanceId;
  const flush={status:'completed',ok:true,entries:[]};
  const persistence=init?{protocol:'state-session-v1',version:1,instanceId}
    :m.type==='APP_SHUTDOWN'?{protocol:'state-session-v1',instanceId,ok:false,unmount:'pending',flush}
    :completed?{protocol:'state-session-v1',instanceId,ok:true,unmount:'completed',flush,dispose:{status:'disposed',unsaved:[],release:{status:'released'}}}:undefined;
  const appCleanup=['APP_STOP','APP_SHUTDOWN','APP_CLOSE'].includes(m.type)?{protocol:'app-lifecycle-v2',instanceId,state:completed?'completed':'stopped',issues:[]}:undefined;
  parentPort.postMessage({type:init?'INIT_RESPONSE':m.type==='RESET'?'RESET_RESPONSE':'LIFECYCLE_RESPONSE',requestId:m.requestId,success:true,
    ...(init?{appInstanceId:m.appInstanceId,appLifecycle:{protocol:'app-lifecycle-v2',version:2,instanceId:m.appInstanceId},persistence${wrong ? ",acceptedCapabilities:['unknown-capability']" : ''}}:{}),
    ...(!init&&persistence?{persistence}:{}),...(appCleanup?{appCleanup}:{})});
  if(init) parentPort.postMessage({type:'SNAPSHOT_PREPARED',draft:{schemaVersion:2,appId:m.appId,instanceId:m.appInstanceId,producerSeq:1,sourceEpoch:1,capturedAt:Date.now(),
    views:[{id:'detail',viewInstanceId:'view-instance',type:'Detail',name:'Details',kind:'state',content:{format:'markdown-v1',value:'Available'} }],refs:{},
    tools:{[JSON.stringify([m.appId,'Detail','probe'])]:{id:JSON.stringify([m.appId,'Detail','probe']),name:'probe',viewType:'Detail',description:'Probe the current View',
      inputSchema:{type:'object',properties:{},required:[],additionalProperties:false,'x-aotui-parameter-contract':'ordinary-params-v1'},isMutating:true,
      targets:[{viewId:'detail',viewInstanceId:'view-instance',bindingVersion:1}]}}}});
}
parentPort.on('message',m=>{
  if(m.type==='STATE_STORAGE_RESPONSE') { if(closePending) { const request=closePending;closePending=undefined;respond(request); } return; }
  if(m.type==='APP_CLOSE') { closePending=m;parentPort.postMessage({type:'STATE_STORAGE_REQUEST',version:1,instanceId,sequence:1,operation:'release'});return; }
  respond(m);
});
`);
        try {
            await install(runtime, 'd', 'a', [mode], { workerScriptPath: script });
            const s = scope(runtime), observation = await s.observe();
            expect(observation.views.find((view: any) => view.id === 'detail')?.content.value).toBe('Available');
            expect(observation.tools).toEqual([]);
            expect(observation.bindings).toEqual([]);
            s.client.close();
            const report = await runtime.beginShutdown().completion;
            facts.push({ case: `capability-ack-${mode}-${wrong ? 'wrong' : 'missing'}`, report });
            expect(report).toMatchObject({ resourcesReleased: true, hasFailures: false, verification: 'managed', interactions: { verified: true, retainedScopes: 0, retainedBytes: 0 } });
        } finally { await runtime.beginShutdown().completion; }
    }
}, 15000);

it('B2 C10 public scope capacity shares the existing single authority and can release its slots', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), clients = [s.client];
        for (let index = 1; index < 16; index++) clients.push(scope(runtime).client);
        expect(runtime.createAppScope('d', 'a', s.policy)).toMatchObject({ issue: { code: 'INVOCATION_CAPACITY' } });
        clients[0].close();const next = scope(runtime);next.client.close();for (const client of clients) client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it.each((['runtime', 'desktop', 'app', 'delete'] as const).flatMap(parent => [false, true].map(reject => [parent, reject] as const)))('B2 C14/17 actual %s close holds project until reject=%s resolves actual ownership', async (parent, reject) => {
    const runtime = makeRuntime(), gate = deferred(), entered = deferred();let closing: any;
    try {
        await install(runtime);const s = scope(runtime);await s.observe();let calls = 0;
        s.controls.project = (context: any) => { calls++;entered.resolve();context.signal.addEventListener('abort', () => {
        expect(runtime.createAppScope('d', 'a', s.policy).status).toBe('rejected');
        });return gate.promise; };
        const observing = s.client.observe({ viewIds: ['detail'] });await entered.promise;const desktop = runtime.getDesktop('d');
        closing = parent === 'runtime' ? runtime.beginShutdown() : parent === 'desktop' || parent === 'delete' ? runtime.beginDesktopShutdown('d', parent === 'delete' ? { intent: 'delete' } : undefined) : undefined;
        const appClosing = parent === 'app' ? desktop.closeApp('a') : undefined;
        const previous = calls, sameStack = s.client.observe({ viewIds: ['detail'] });
        expect(await s.client.invoke({ invocationId: 'late', observationId: 'old', bindingId: 'old', input: {} })).not.toHaveProperty('kind', 'receipt');
        expect(await s.client.readReceipt('late')).toHaveProperty('code', 'SCOPE_UNAVAILABLE');
        expect(runtime.createAppScope('d', 'a', s.policy).status).toBe('rejected');await sameStack;expect(calls).toBe(previous);
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
            const original = await readFile(app, 'utf8'), traced = original.replace('setCount(current => current + 1);',
                `await appendFile(${JSON.stringify(trace)}, 'entered\\n');setCount(current => current + 1);`);
            expect(traced).not.toBe(original);await capture(tracedApp, "import { appendFile } from 'node:fs/promises';\n" + traced);
            const handlerCount = async () => (await readFile(trace, 'utf8').catch(error => { if (error.code === 'ENOENT') return '';throw error; })).split('\n').filter(Boolean).length;
            await install(runtime, 'd', 'a', undefined, {}, tracedApp);const s = scope(runtime), observation = await s.observe(), input = request(observation);let calls = 0;
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
        const id = await runtime.createDesktop('d'), desktop = runtime.getDesktop(id), modes: Array<(typeof allModes)[number]> = ['ordinary-v2'];
        await desktop.registerPendingApp({ appId: 'a', modulePath: pathToFileURL(app).href, interactionModes: modes });modes.length = 0;
        expect(desktop.getInstalledApps().find((entry: any) => entry.appId === 'a')?.interactionModes).toEqual(['ordinary-v2']);
        expect(runtime.createAppScope(id, 'a', {}).issue.code).toBe('SCOPE_UNAVAILABLE');await desktop.openApp('a');
        const s = scope(runtime), first = await s.observe();await desktop.collapseApp('a');const collapsed = scope(runtime);collapsed.client.close();
        await runtime.suspend(id);expect(runtime.createAppScope(id, 'a', s.policy).issue.code).toBe('SCOPE_UNAVAILABLE');
        const paused = await s.client.invoke(request(first));expect(paused.receipt?.outcome.status).toBe('rejected');await runtime.resume(id);
        expect((await s.client.invoke(request(first, 'ordinary', { text: 'change' }, 'resumed'))).receipt.outcome.status).toBe('succeeded');
        await desktop.closeApp('a');expect((await s.client.observe({ viewIds: ['detail'] })).status).toBe('rejected');await desktop.openApp('a');
        const reopened = scope(runtime), next = await reopened.observe();expect(next.source.instanceId).not.toBe(first.source.instanceId);
        const reinitializing = runtime.reinitializeDesktopApps(id);expect(runtime.createAppScope(id, 'a', s.policy).status).toBe('rejected');
        expect((await reopened.client.observe({ viewIds: ['detail'] })).status).toBe('rejected');await reinitializing;
        const fresh = scope(runtime), last = await fresh.observe();expect(last.source.instanceId).not.toBe(next.source.instanceId);
        expect((await fresh.client.invoke(request(last))).receipt.outcome.status).toBe('succeeded');fresh.client.close();
        facts.push({ case: 'instance-boundaries', instances: [first.source.instanceId, next.source.instanceId, last.source.instanceId], registeredModes: ['ordinary-v2'] });
    } finally { await runtime.beginShutdown().completion; }
}, 20000);

it('Semantic lifecycle controls stay bound to the App instance observed by each live Agent Context', async () => {
    const runtime = makeRuntime(), contexts: any[] = [];
    const call = async (context: any, name: string, args: any, callId: string) => {
        expect(context.tools[name]).toBeDefined();
        return context.executeTool(name, args, callId);
    };
    const context = async () => { const value = await source.getContext();contexts.push(value);return value; };
    const desktopId = 'controls';
    const desktop = await runtime.createDesktop(desktopId).then((id: string) => runtime.getDesktop(id));
    const source = new adaptersPackage.SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: false });
    try {
        await install(runtime, desktopId, 'a', undefined, { name: 'interaction_example' });
        const first = await context();
        const dynamicTool = Object.keys(first.tools).find(name => name === 'interaction_example-Detail-ordinary');
        expect(dynamicTool).toBeDefined();
        const firstInstance = desktop.getInstalledApps().find((entry: any) => entry.appId === 'a')?.appInstanceId;
        expect(typeof firstInstance).toBe('string');
        expect(JSON.stringify(first.messages)).not.toContain(firstInstance);
        expect((await call(first, dynamicTool!, { text: 'change' }, 'first-read'))?.outcomeStatus).toBe('succeeded');

        expect((await call(first, 'system-collapse_app', { app_id: 'a' }, 'first-collapse'))?.outcomeStatus).toBe('succeeded');
        const collapsedFirst = await context();
        expect((await call(collapsedFirst, 'system-show_app', { app_id: 'a' }, 'first-show'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, 'system-close_app', { app_id: 'a' }, 'first-close'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, dynamicTool!, { text: 'change' }, 'closed-read'))?.error?.code).toBe('SCOPE_UNAVAILABLE');

        const closed = await context();
        expect((await call(closed, 'system-open_app', { app_id: 'a' }, 'reopen'))?.outcomeStatus).toBe('succeeded');
        const successor = await context();
        const successorInstance = desktop.getInstalledApps().find((entry: any) => entry.appId === 'a')?.appInstanceId;
        expect(successorInstance).toEqual(expect.any(String));
        expect(successorInstance).not.toBe(firstInstance);
        expect(JSON.stringify(successor.messages)).not.toContain(successorInstance);
        expect((await call(successor, dynamicTool!, { text: 'change' }, 'successor-read'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, dynamicTool!, { text: 'change' }, 'old-read-after-reopen'))?.error?.code).toBe('SCOPE_UNAVAILABLE');

        for (const [name, callId] of [['system-close_app', 'stale-close'], ['system-collapse_app', 'stale-collapse']] as const) {
            expect((await call(first, name, { app_id: 'a' }, callId))?.error?.code).toBe('APP_INSTANCE_CHANGED');
        }

        expect((await call(successor, 'system-collapse_app', { app_id: 'a' }, 'successor-collapse'))?.outcomeStatus).toBe('succeeded');
        const collapsedSuccessor = await context();
        expect((await call(collapsedFirst, 'system-show_app', { app_id: 'a' }, 'stale-show'))?.error?.code).toBe('APP_INSTANCE_CHANGED');
        expect((await call(collapsedSuccessor, 'system-show_app', { app_id: 'a' }, 'successor-show'))?.outcomeStatus).toBe('succeeded');
        const runningSuccessor = await context();
        expect((await call(runningSuccessor, 'system-close_app', { app_id: 'a' }, 'successor-close'))?.outcomeStatus).toBe('succeeded');
    } finally {
        for (const entry of contexts) await entry.release?.();
        source.dispose();
        await runtime.beginShutdown().completion;
    }
}, 30000);

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

it('B2 C07 app launch config cannot grant modes disabled by the trusted Host', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', [], { config: { interactionModes: allModes } });
        const s = scope(runtime), observation = await s.observe();
        expect(observation.views.find((view: any) => view.id === 'detail')?.content.value).toContain('Completed operations: 0');
        expect(observation.bindings).toEqual([]);
        s.client.close();
    } finally { await runtime.beginShutdown().completion; }
}, 15000);
