import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let directory: string, app: string, runtimePackage: any, adaptersPackage: any;
let AppWorkerHost: any;
const facts: any[] = [];
const output = process.env.AOTUI_W08_C1_FACTS_DIR;
const installedConsumer = process.env.AOTUI_PACKAGE_CONSUMER_DIR;
const deferred = () => { let resolve!: (value?: any) => void, reject!: (error: unknown) => void;
    const promise = new Promise<any>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; };
async function capture(path: string, body: string) {
    await writeFile(path, body);
    if (output) { const hash = createHash('sha256').update(body).digest('hex'), folder = join(output, 'b2-inputs');await mkdir(folder, { recursive: true });
        await writeFile(join(folder, hash), body);await writeFile(join(folder, hash + '.json'), JSON.stringify({ path, sha256: hash, capturedBeforeExecution: true })); }
}
beforeAll(async () => {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    if (output) await mkdir(output, { recursive: true });
    let runtimeDocs: string;
    if (installedConsumer) {
        if (!isAbsolute(installedConsumer)) throw new Error('AOTUI_PACKAGE_CONSUMER_DIR must be absolute');
        const consumer = await realpath(installedConsumer);
        const modules = join(consumer, 'node_modules', '@aotui');
        for (const pkg of ['runtime', 'sdk', 'agent-driver-adapter', 'agent-driver-v2']) {
            const path = await realpath(join(modules, pkg));
            expect(path.startsWith(join(consumer, 'node_modules') + '/')).toBe(true);
            const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
            facts.push({ package: manifest.name, version: manifest.version, path });
        }
        directory = await mkdtemp(join(consumer, 'runtime-lifecycle-'));
        await capture(join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }));
        runtimeDocs = join(modules, 'runtime', 'docs');
        facts.push({ consumer, mode: 'provided-installation', fixtures: directory });
    } else {
        directory = await mkdtemp(join(output ?? tmpdir(), 'aotui-b2-public-'));
        await capture(join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }));
        const modules = join(directory, 'node_modules');
        await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const pkg of ['runtime', 'sdk', 'agent-driver-adapter', 'agent-driver-v2']) {
            const pack = join(directory, 'pack-' + pkg), target = join(modules, '@aotui', pkg);await mkdir(pack);await mkdir(target);
            const argv = ['pack', '--ignore-scripts', '--json', '--pack-destination', pack];
            await capture(join(directory, 'pack-' + pkg + '-before.json'), JSON.stringify({ cwd: join(repo, pkg), argv: ['npm', ...argv], env: { NPM_CONFIG_CACHE: join(directory, 'npm-cache') } }));
            const result = JSON.parse(execFileSync('npm', argv, { cwd: join(repo, pkg), env: { ...process.env, NPM_CONFIG_CACHE: join(directory, 'npm-cache') }, encoding: 'utf8' }));
            const archive = join(pack, result[0].filename);execFileSync('tar', ['-xzf', archive, '--strip-components', '1', '-C', target]);
            const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
            facts.push({ package: manifest.name, version: manifest.version, archive,
                sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), actualTar: true });
        }
        const links: any[] = [];
        for (const pkg of ['runtime', 'sdk', 'agent-driver-adapter', 'agent-driver-v2']) for (const entry of await readdir(join(repo, pkg, 'node_modules'), { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '@aotui') continue;
            const target = join(modules, entry.name);try { await symlink(join(repo, pkg, 'node_modules', entry.name), target, 'dir');links.push({ path: target, source: join(repo, pkg, 'node_modules', entry.name) }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
        }
        runtimeDocs = join(modules, '@aotui', 'runtime', 'docs');
        facts.push({ consumer: directory, selfPackageLinks: false, thirdPartyLinks: links, completeCleanInstall: false });
    }
    ({ AppWorkerHost } = await import(pathToFileURL(join(runtimeDocs, '../dist/engine/app/worker-host.js')).href));
    const document = await readFile(join(runtimeDocs, 'runtime-app-interaction.md'), 'utf8');
    const body = document.match(/<!-- b2-app:start -->\n```js\n([\s\S]*?)\n```\n<!-- b2-app:end -->/)?.[1];if (!body) throw Error('App example markers');
    const executableBody = body.replace("if (args.filePath !== '/open/note.txt')", `if (args.text === 'throw') throw new Error('PRIVATE_CONTROLLED_FAILURE');
      if (args.text === 'business') return { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Application declined the edit.' },
        data: { refreshed: false } };
      if (args.filePath !== '/open/note.txt')`);
    if (executableBody === body) throw Error('Expected the documented ordinary Tool guard for the controlled failure fixture');
    app = join(directory, 'app.mjs');await capture(app, executableBody + '\n');
    const entry = join(directory, 'entry.mjs');await capture(entry, "export * from '@aotui/runtime';\n");runtimePackage = await import(pathToFileURL(entry).href);
    const adaptersEntry = join(directory, 'adapters.mjs');await capture(adaptersEntry, "export * from '@aotui/agent-driver-adapter';\n");adaptersPackage = await import(pathToFileURL(adaptersEntry).href);
}, 30000);
afterAll(async () => {
    if (output) await writeFile(join(output, 'b2-public-e2e.json'), JSON.stringify(facts, null, 2));
    else if (directory) await rm(directory, { recursive: true, force: true });
});

function makeRuntime() { return runtimePackage.createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 8 } }); }
async function install(runtime: any, desktop = 'd', id = 'a', toolsEnabled?: boolean, extra = {}, appPath = app) {
    try { runtime.getDesktop(desktop); } catch { await runtime.createDesktop(desktop); }
    return runtime.installDynamicWorkerApp(desktop, pathToFileURL(appPath).href, {
        appId: id, config: { AOTUI_DATA_DIR: join(directory, 'data', desktop, id) }, ...extra,
        ...(toolsEnabled === undefined ? {} : { toolsEnabled }),
    });
}
function scope(runtime: any, desktop = 'd', id = 'a') {
    const controls = { project: (context: any): any => grant(context), authorize: (_context: any): any => true, read: (_meta: any, _signal: any): any => true };
    function grant({ source, selection }: any) {
        const views = source.views.filter((view: any) => selection.viewIds.includes(view.id));
        return {
        views: views.map((view: any) => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
        refs: Object.values(source.refs).filter((r: any) => selection.viewIds.includes(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        toolBindings: Object.values(source.tools).flatMap((tool: any) => 
            views.some((view: any) => view.type === tool.viewType) ? [{ toolId: tool.id, execution: tool.execution }] : []),
        content: views.map((view: any) => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
    }; }
    const policy = { project: (context: any) => controls.project(context), authorize: (context: any) => controls.authorize(context), canReadReceipt: (meta: any, signal: any) => controls.read(meta, signal) };
    const instanceId = runtime.getDesktop(desktop).getInstalledApps().find((app: any) => app.appId === id)?.appInstanceId;
    const result = runtime.getAppInteraction(desktop, id, instanceId, policy);expect(result.status).toBe('ready');if (result.status !== 'ready') throw Error(result.issue.code);
    async function observe() { let observation: any;await vi.waitFor(async () => { const result = await resultClient.observe({ viewIds: ['detail'] });expect(result.status).toBe('observed');if (result.status === 'observed') observation = result.observation; }, { timeout: 6000 });expect(resultClient.adoptObservation(observation.observationId).status).toBe('adopted');return observation; }
    const resultClient = result.interaction;return { client: resultClient, controls, policy, observe, instanceId };
}
function request(observation: any, name = 'ordinary', input: any = { text: 'change' }, invocationId = 'call') {
    const tool = observation.tools.find((tool: any) => tool.name === name), binding = observation.bindings.find((candidate: any) => candidate.toolId === tool?.id &&
        candidate.execution.kind === 'view-type');
    if (!binding) throw Error('Missing tool binding ' + name);
    const args = name === 'ordinary' ? { filePath: '/open/note.txt', ...input } : input;
    return { invocationId, observationId: observation.observationId, bindingId: binding.bindingId, input: args };
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

it('B2 C08/26 omitted toolsEnabled enables ordinary and Ref calls through the shared current contract in the tar package', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), observation = await s.observe(), outputs: any[] = [];
        for (const [index, [name, input]] of ([['ordinary', { text: 'change' }], ['ref', { file: 'detail.file' }]] as const).entries()) {
            const result = await s.client.invoke(request(observation, name, input, 'mode-' + index));expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });outputs.push(result);
        }
        expect(outputs[1].receipt.outcome.value.data.currentValueAvailable).toBe(true);
        await waitForViewText(s.client, 'Completed actions: 1');
        expect(runtime.getAppInteraction('d', 'a', s.instanceId, {}).issue.code).toBe('APP_INTERACTION_POLICY_CONFLICT');facts.push({ case: 'default-qualified-public', outputs });
    } finally { expect((await runtime.beginShutdown().completion).ok).toBe(true); }
}, 15000);

it('B2 C09 toolsEnabled true exposes ordinary and Ref tools through the same contract', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', true);const s = scope(runtime), observation = await s.observe();
        for (const [name, input] of [['ordinary', { text: 'change' }], ['ref', { file: 'detail.file' }]] as const) {
            expect(observation.bindings.some((binding: any) => binding.toolId === observation.tools.find((tool: any) => tool.name === name)?.id)).toBe(true);
            const first = await s.client.invoke(request(observation, name, input, name));
            expect(first.receipt.outcome.status).toBe('succeeded');
            const again = await s.client.invoke(request(observation, name, input, name + '-next'));
            expect(again.receipt.outcome.status).toBe('succeeded');
            if (name === 'ref') expect(again.receipt.outcome.value.data.currentValueAvailable).toBe(true);
        }

    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('B2 C05 toolsEnabled false preserves Views but grants no executable bindings', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', false);const s = scope(runtime), observation = await s.observe();
        expect(observation.views.some((view: any) => view.id === 'detail')).toBe(true);
        expect(observation.bindings).toEqual([]);

    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('rejects invalid tool settings and the retired Host key before registering an App', async () => {
    const runtime = makeRuntime();
    try {
        await expect(install(runtime, 'd', 'bad-value', 'false' as any)).rejects.toMatchObject({ code: 'TOOLS_ENABLED_INVALID' });
        for (const value of [[], ['view-type-parameters-v1'], undefined]) {
            await expect(install(runtime, 'd', 'retired', undefined, { interactionModes: value })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
        }
        expect(runtime.getDesktop('d').getInstalledApps()).toEqual([]);
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('packed SDK separates authorization, a returned E_HANDLER_ERROR and an actual throw', async () => {
    const runtime = makeRuntime();try {
        await install(runtime);const s = scope(runtime), observation = await s.observe();
        s.controls.authorize = () => false;
        const denied = await s.client.invoke(request(observation, 'ordinary', { text: 'change' }, 'denied'));
        expect(denied).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'not-dispatched', outcome: { status: 'rejected' } } });
        s.controls.authorize = () => true;
        const business = request(observation, 'ordinary', { text: 'business' }, 'business');
        const declined = await s.client.invoke(business);
        expect(declined).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: {
            status: 'failed', details: { result: { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Application declined the edit.' },
                data: { refreshed: false } } },
        } } });
        expect(declined.receipt.outcome).not.toHaveProperty('effects');
        const query = { observationId: business.observationId, invocationId: business.invocationId };
        expect(await s.client.readReceipt(query)).toEqual(declined);
        expect(await s.client.readReceipt(business)).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_INVALID' });
        const thrown = request(observation, 'ordinary', { text: 'throw' }, 'unknown');
        const first = await s.client.invoke(thrown);
        expect(first).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'unknown', outcome: { status: 'unknown' } } });
        expect(first.receipt.outcome).not.toHaveProperty('details');
        expect(JSON.stringify(first)).not.toContain('PRIVATE_CONTROLLED_FAILURE');
        expect(await s.client.invoke(thrown)).toEqual(first);
        const later = await s.client.invoke(request(observation, 'ordinary', { text: 'change' }, 'after-unknown'));
        expect(later.receipt.outcome.status).toBe('succeeded');
        await waitForViewText(s.client, 'Completed actions: 1');
        facts.push({ case: 'B01-packed-business-failure-and-throw', declined, unknown: first });

    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it('checks the complete Tool profile at the packed SDK, Runtime and Snapshot boundaries', async () => {
    const entry = join(directory, 'b03-profile.mjs');
    await capture(entry, `import Type from 'typebox';
import { createApp, defineToolSet, defineViewTypeTool } from '@aotui/sdk/app';
import { VIEW_TYPE_PARAMETERS_MODE } from '@aotui/runtime/core';

const limit = 64 * 1024, marker = 'x-aotui-parameter-contract';
const base = { type: 'object', properties: {}, required: [], additionalProperties: true, description: '' };
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const unit = '界😀\\n';
const fill = limit - bytes({ ...base, [marker]: VIEW_TYPE_PARAMETERS_MODE });
const unitBytes = bytes(unit) - 2;
const description = unit.repeat(Math.floor(fill / unitBytes)) + 'x'.repeat(fill % unitBytes);
const metadata = { viewType: 'Detail', name: 'wide', description: 'Exercise a Tool at its profile boundary' };
export const define = delta => defineViewTypeTool({ ...metadata, inputSchema: Type.Object({}, { description: description + 'x'.repeat(delta) }) });
const tools = defineToolSet({ wide: define(0) });
export const oversizedProfile = { ...tools.wide.inputSchema, description: description + 'x', [marker]: VIEW_TYPE_PARAMETERS_MODE };
export const profileBytes = bytes({ ...tools.wide.inputSchema, [marker]: VIEW_TYPE_PARAMETERS_MODE });
export default createApp({ app_name: 'profile_capacity', tools, initialize({ publish }) {
    publish({ views: [{ id: 'detail', type: 'Detail', kind: 'state', body: 'Profile ready' }],
        bindings: { wide: { execute: () => ({ success: true }) } } });
} });
`);
    const fixture = await import(pathToFileURL(entry).href);
    expect(fixture.profileBytes).toBe(64 * 1024);
    expect(() => fixture.define(1)).toThrow(expect.objectContaining({ name: 'TypeBoxSchemaExportError', code: 'TOOL_SCHEMA_CAPACITY', path: '$' }));
    const coreEntry = join(directory, 'b03-profile-core.mjs');
    await capture(coreEntry, "export { compileOrdinaryProfile } from '@aotui/runtime/core';\n");
    const { compileOrdinaryProfile } = await import(pathToFileURL(coreEntry).href);
    expect(compileOrdinaryProfile(fixture.oversizedProfile)).toBeNull();

    const runtime = makeRuntime();
    try {
        await install(runtime, 'd', 'a', true, {}, entry);
        const s = scope(runtime), observation = await s.observe();
        const profile = observation.tools.find((tool: any) => tool.name === 'wide')?.inputSchema;
        expect(new TextEncoder().encode(JSON.stringify(profile)).byteLength).toBe(fixture.profileBytes);
        expect(compileOrdinaryProfile(profile)?.schema).toEqual(fixture.define(0).inputSchema);
        const result = await s.client.invoke(request(observation, 'wide', {}, 'at-limit'));
        expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });
        facts.push({ case: 'B03-complete-profile', bytes: fixture.profileBytes, oversized: 'TOOL_SCHEMA_CAPACITY', result });
    } finally {
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15000);

it('rejects retired imports and an incompatible invoker ABI in a real Worker', async () => {
    const exportsEntry = join(directory, 'b01-exports.mjs');
    await capture(exportsEntry, "export * as core from '@aotui/runtime/core';\nexport * as spi from '@aotui/runtime/spi';\n");
    const { core, spi } = await import(pathToFileURL(exportsEntry).href);
    expect(core.ORDINARY_INVOKER_ABI_V4).toBe('ordinary-invoker/v4');
    expect(core).not.toHaveProperty('ORDINARY_INVOKER_ABI_V3');
    expect(core).not.toHaveProperty('ORDINARY_INVOCATION_MODE');
    expect(spi.PARAMETERS_V5_CAPABILITY).toBe('view-tool-parameters-invoke/v5');
    expect(spi).not.toHaveProperty('PARAMETERS_V4_CAPABILITY');

    const runtime = makeRuntime();
    try {
        for (const variant of ['import', 'ordinary-v2', 'ordinary-invoker/v3']) {
            const file = join(directory, `legacy-${variant.replace('/', '-')}.mjs`);
            const declaration = variant === 'import'
                ? "import { ORDINARY_INVOCATION_MODE as abi } from '@aotui/runtime/core';"
                : `const abi = ${JSON.stringify(variant)};`;
            await capture(file, `
${declaration}
export default {
    kernelConfig: { appName: 'legacy_sdk' },
    toolAuthoringProtocol: 'view-type-tools-v4', persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2',
    initialize({ appTypeTools }) {
        appTypeTools.registerTypeTool({ viewType: 'Detail', name: 'old', description: 'Legacy Tool',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, {
            safeOrdinaryParametersInvocationMode: abi,
            createSafeOrdinaryParametersInvoker: () => { throw Error('UNSUPPORTED_INVOKER_FACTORY_ENTERED'); },
        });
        return { close() {} };
    }
};\n`);
            const issue = variant === 'import'
                ? { code: 'E_INIT_FAILED', cause: { message: expect.stringContaining('ORDINARY_INVOCATION_MODE') } }
                : { code: 'E_OPEN_FAILED', cause: { code: 'TOOL_INVOKER_ABI_UNSUPPORTED',
                    message: expect.stringContaining('Expected ordinary-invoker/v4. Install matching Runtime and SDK packages') } };
            await expect(install(runtime, 'd', variant, undefined, {}, file)).rejects.toMatchObject({
                code: 'INSTALL_FAILED', cause: { code: 'INSTALL_FAILED', cause: issue },
            });
            expect(runtime.getDesktop('d').getInstalledApps()).toEqual([]);
        }
        facts.push({ case: 'rejects-retired-import-and-invoker-abi', variants: ['import', 'ordinary-v2', 'ordinary-invoker/v3'] });
    } finally {
        expect(await runtime.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15000);

it('rejects a missing, invalid or v4 ACK before installing an App', async () => {
    for (const variant of ['missing', 'invalid', 'v4']) {
        const capabilities = variant === 'invalid' ? ['unknown-capability'] : ['app-snapshot/v3', 'view-tool-parameters-invoke/v4'];
        const runtime = makeRuntime(), script = join(directory, `ack-${variant}.mjs`);
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
  parentPort.postMessage({type:init?'INIT_RESPONSE':'LIFECYCLE_RESPONSE',requestId:m.requestId,success:true,
    ...(init?{appInstanceId:m.appInstanceId,appLifecycle:{protocol:'app-lifecycle-v2',version:2,instanceId:m.appInstanceId},persistence${variant === 'missing' ? '' : ',acceptedCapabilities:' + JSON.stringify(capabilities)}}:{}),
    ...(!init&&persistence?{persistence}:{}),...(appCleanup?{appCleanup}:{})});
  if(init) parentPort.postMessage({type:'SNAPSHOT_PREPARED',draft:{schemaVersion:3,appId:m.appId,instanceId:m.appInstanceId,producerSeq:1,sourceEpoch:1,capturedAt:Date.now(),
    views:[{id:'detail',viewInstanceId:'view-instance',type:'Detail',name:'Details',kind:'state',content:{format:'markdown-v1',value:'Available'} }],refs:{},
    tools:{[JSON.stringify([m.appId,'Detail','probe'])]:{id:JSON.stringify([m.appId,'Detail','probe']),name:'probe',viewType:'Detail',description:'Probe the current View',
      inputSchema:{type:'object',properties:{},required:[],additionalProperties:false,'x-aotui-parameter-contract':'view-type-parameters-v1'},execution:{kind:'view-type',activationId:'probe-activation'}}}}});
}
parentPort.on('message',m=>{
  if(m.type==='STATE_STORAGE_RESPONSE') { if(closePending) { const request=closePending;closePending=undefined;respond(request); } return; }
  if(m.type==='APP_CLOSE') { closePending=m;parentPort.postMessage({type:'STATE_STORAGE_REQUEST',version:1,instanceId,sequence:1,action:'release'});return; }
  respond(m);
});
`);
        const start = AppWorkerHost.prototype.start;
        const override = vi.spyOn(AppWorkerHost.prototype, 'start').mockImplementationOnce(function (this: any) {
            this.workerScriptPath = script;
            return start.call(this);
        });
        try {
            await expect(install(runtime, 'd', 'a')).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
            const installed = runtime.getDesktop('d').getInstalledApps().find((entry: any) => entry.appId === 'a');
            expect(installed).toBeUndefined();
            const report = await runtime.beginShutdown().completion;
            facts.push({ case: `capability-ack-${variant}`, report, installedStatus: installed?.status });
            expect(report).toMatchObject({ resourcesReleased: true, hasFailures: false, verification: 'managed', interactions: { verified: true, retainedOperations: 0, retainedBytes: 0 } });
        } finally { override.mockRestore(); await runtime.beginShutdown().completion; }
    }
}, 15000);

it('reuses one instance handle and keeps read-only preview independent of the candidate', async () => {
    const runtime = makeRuntime();
    try {
        await install(runtime);
        const s = scope(runtime), current = await s.observe();
        expect(runtime.getAppInteraction('d', 'a', s.instanceId).interaction).toBe(s.client);
        expect(runtime.getAppInteraction('d', 'a', 'wrong')).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
        const pending = await s.client.observe({ all: true });
        expect(pending.status).toBe('observed');
        expect((await s.client.preview()).status).toBe('previewed');
        expect(await s.client.observe({ all: true })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        s.client.releaseObservation(pending.observation.observationId);
        expect(await s.client.invoke(request(current))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect((await s.client.observe({ all: true })).status).toBe('observed');
    } finally { await runtime.beginShutdown().completion; }
}, 15000);

it.each((['runtime', 'desktop', 'app', 'delete'] as const).flatMap(parent => [false, true].map(reject => [parent, reject] as const)))('B2 C14/17 actual %s close holds project until reject=%s resolves actual ownership', async (parent, reject) => {
    const runtime = makeRuntime(), gate = deferred(), entered = deferred();let closing: any;
    try {
        await install(runtime);const s = scope(runtime);const observation = await s.observe();let calls = 0;
        s.controls.project = (context: any) => { calls++;entered.resolve();context.signal.addEventListener('abort', () => {
        expect(runtime.getAppInteraction('d', 'a', s.instanceId, s.policy).status).toBe('rejected');
        });return gate.promise; };
        const observing = s.client.observe({ viewIds: ['detail'] });await entered.promise;const desktop = runtime.getDesktop('d');
        closing = parent === 'runtime' ? runtime.beginShutdown() : parent === 'desktop' || parent === 'delete' ? runtime.beginDesktopShutdown('d', parent === 'delete' ? { intent: 'delete' } : undefined) : undefined;
        const appClosing = parent === 'app' ? desktop.closeApp('a') : undefined;
        const previous = calls, sameStack = s.client.observe({ viewIds: ['detail'] });
        expect(await s.client.invoke({ invocationId: 'late', observationId: 'old', bindingId: 'old', input: {} })).not.toHaveProperty('kind', 'receipt');
        expect(await s.client.invoke({ ...request(observation), invocationId: 'late' })).toHaveProperty('code', 'APP_INTERACTION_UNAVAILABLE');
        expect(runtime.getAppInteraction('d', 'a', s.instanceId, s.policy).status).toBe('rejected');await sameStack;expect(calls).toBe(previous);
        let appDone = false;void appClosing?.then(() => { appDone = true; });
        if (closing) {
            const deadline = await closing.wait({ timeoutMs: 5 });expect(deadline).toMatchObject({ status: 'deadline', report: { resourcesReleased: false, hasFailures: false, interactions: { verified: true, retainedOperations: 1 } } });
            facts.push({ case: 'held-project-' + parent, pending: deadline.report });
        } else { for (let i = 0; i < 30; i++) await Promise.resolve();expect(appDone).toBe(false); }
        if (reject) gate.reject(Error('held project'));else gate.resolve({ views: [], refs: [], toolBindings: [], content: [] });expect((await observing).status).toBe('rejected');await appClosing;
        if (closing) expect(await closing.completion).toMatchObject({ resourcesReleased: true, interactions: { verified: true, retainedOperations: 0, retainedBytes: 0 } });
    } finally { gate.resolve({ views: [], refs: [], toolBindings: [], content: [] });await runtime.beginShutdown().completion; }
}, 15000);

it.each((['authorize', 'auto-read', 'duplicate-read'] as const).flatMap(stage => (['runtime', 'desktop', 'app'] as const).map(parent => [stage, parent] as const)))('B2 C18 actual SDK/Node %s remains owned through %s close until resolve/reject', async (stage, parent) => {
    for (const reject of [false, true]) {
        const runtime = makeRuntime(), entered = deferred(), gate = deferred();try {
            const trace = join(directory, `handlers-${stage}-${parent}-${reject}`), tracedApp = trace + '.mjs';
            const original = await readFile(app, 'utf8'), traced = original.replace('setCount(current => current + 1);',
                `await appendFile(${JSON.stringify(trace)}, 'entered\\n');setCount(current => current + 1);`);
            expect(traced).not.toBe(original);await capture(tracedApp, "import { appendFile } from 'node:fs/promises';\n" + traced);
            const handlerCount = async () => (await readFile(trace, 'utf8').catch(error => { if (error.code === 'ENOENT') return '';throw error; })).split('\n').filter(Boolean).length;
            await install(runtime, 'd', 'a', undefined, {}, tracedApp);const s = scope(runtime), observation = await s.observe(), input = request(observation);let calls = 0;
            if (stage === 'duplicate-read') await s.client.invoke(input);
            const hold = () => { calls++;entered.resolve();return gate.promise; };
            if (stage === 'authorize') s.controls.authorize = hold;else s.controls.read = hold;
            const work = s.client.invoke(input);await entered.promise;
            const handlersBeforeClose = await handlerCount();expect(handlersBeforeClose).toBe(stage === 'authorize' ? 0 : 1);
            const appClosing = parent === 'app' ? runtime.getDesktop('d').closeApp('a') : undefined;
            const closing = parent === 'desktop' ? runtime.beginDesktopShutdown('d') : runtime.beginShutdown(), before = closing.inspect();expect((await closing.wait({ timeoutMs: 5 })).status).toBe('deadline');
            expect(closing.inspect()).toMatchObject({ resourcesReleased: false, hasFailures: false, interactions: { verified: true, retainedOperations: stage === 'authorize' ? 2 : 1 } });
            expect(await s.client.invoke(input)).toHaveProperty('code', 'APP_INTERACTION_UNAVAILABLE');expect(calls).toBe(1);
            if (reject) gate.reject(Error('held policy'));else gate.resolve(true);
            expect(await work).not.toHaveProperty('kind', 'receipt');const report = await closing.completion;
            expect(report).toMatchObject({ ok: true, resourcesReleased: true, interactions: { verified: true, retainedOperations: 0, retainedBytes: 0 } });
            const handlersAfterClose = await handlerCount();expect(handlersAfterClose).toBe(handlersBeforeClose);
            await appClosing;expect(before.interactions.retainedOperations).toBe(stage === 'authorize' ? 2 : 1);facts.push({ case: stage, parent, reject, handlersBeforeClose, handlersAfterClose, before, report });
        } finally { gate.resolve(true);await runtime.beginShutdown().completion; }
    }
}, 25000);

it('B2 C06/10–12/16 public pending/collapse/pause/reopen/reinitialize keeps the trusted setting and permanently closes old clients', async () => {
    const runtime = makeRuntime();try {
        const id = await runtime.createDesktop('d'), desktop = runtime.getDesktop(id);
        const pending = { appId: 'a', modulePath: pathToFileURL(app).href, toolsEnabled: true };
        await desktop.registerPendingApp(pending); pending.toolsEnabled = false;
        expect(runtime.getAppInteraction(id, 'a', 'missing').issue.code).toBe('APP_INTERACTION_UNAVAILABLE');await desktop.openApp('a');
        const s = scope(runtime), first = await s.observe();await desktop.collapseApp('a');expect(runtime.getAppInteraction(id, 'a', s.instanceId).interaction).toBe(s.client);
        await runtime.suspend(id);expect(runtime.getAppInteraction(id, 'a', s.instanceId, s.policy).issue.code).toBe('APP_INTERACTION_UNAVAILABLE');
        const paused = await s.client.invoke(request(first));expect(paused).toMatchObject({ kind: 'refused', code: 'APP_INTERACTION_UNAVAILABLE' });await runtime.resume(id);
        expect((await s.client.invoke(request(first, 'ordinary', { text: 'change' }, 'resumed'))).receipt.outcome.status).toBe('succeeded');
        await desktop.closeApp('a');expect((await s.client.observe({ viewIds: ['detail'] })).status).toBe('rejected');await desktop.openApp('a');
        const reopened = scope(runtime), next = await reopened.observe();expect(next.source.instanceId).not.toBe(first.source.instanceId);
        const reinitializing = runtime.reinitializeDesktopApps(id);expect(runtime.getAppInteraction(id, 'a', s.instanceId, s.policy).status).toBe('rejected');
        expect((await reopened.client.observe({ viewIds: ['detail'] })).status).toBe('rejected');await reinitializing;
        const fresh = scope(runtime), last = await fresh.observe();expect(last.source.instanceId).not.toBe(next.source.instanceId);
        expect((await fresh.client.invoke(request(last))).receipt.outcome.status).toBe('succeeded');
        facts.push({ case: 'instance-boundaries', instances: [first.source.instanceId, next.source.instanceId, last.source.instanceId], toolsEnabled: true });
    } finally { await runtime.beginShutdown().completion; }
}, 20000);

it('preserves the SPI lifecycle callback receiver for cold restart and delete', async () => {
    const desktopId = 'hook-desktop', name = 'callback_fixture';
    const projectPath = join(directory, 'synthetic-project');
    const trace = join(directory, 'factory-hooks.jsonl');
    const fixture = join(directory, 'factory-hooks.mjs');
    await capture(fixture, `
import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

function record(hook, receiver, context) {
    const { appName, description, whatItIs, whenToUse, signalPolicy } = receiver;
    const row = { hook, threadId, appName, description, whatItIs, whenToUse, signalPolicy,
        copied: receiver !== kernelConfig, ...context };
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify(row) + '\\n');
}
const kernelConfig = {
    appName: '${name}',
    description: 'App metadata',
    whatItIs: 'Lifecycle fixture',
    whenToUse: 'Exercise SPI callbacks',
    signalPolicy: 'never',
    onReinitialize({ appId, desktopId, reason }) {
        record('reinitialize', this, { appId, desktopId, reason });
        this.description = 'Changed only in the first instance';
    },
    onDelete({ appId, desktopId }) {
        record('delete', this, { appId, desktopId });
    },
};
export default {
    kernelConfig,
    toolAuthoringProtocol: 'view-type-tools-v4',
    persistenceSupport: 'state-session-v1',
    appLifecycleSupport: 'app-lifecycle-v2',
    initialize({ launchConfig, publishFrame }) {
        if (launchConfig?.projectPath !== ${JSON.stringify(projectPath)}) throw Error('Host config missing');
        publishFrame(() => ({ views: [], tools: [] }));
        return { close() {} };
    },
};
`);
    const runtime = makeRuntime();
    try {
        const appId = await install(runtime, desktopId, 'hooks', undefined, {
            name, config: { AOTUI_DATA_DIR: join(directory, 'hooks-state'), projectPath },
        }, fixture);
        const desktop = runtime.getDesktop(desktopId);
        const originalInstance = desktop.getInstalledApps()[0]?.appInstanceId;
        expect(originalInstance).toEqual(expect.any(String));
        const reason = 'Refresh the workspace';
        const reset = await runtime.reinitializeDesktopApps(desktopId, { reason });
        expect(reset).toEqual({ desktopId, reinitializedAppIds: [appId], skippedAppIds: [], failedAppIds: [] });
        const newInstance = desktop.getInstalledApps()[0]?.appInstanceId;
        expect(newInstance).toEqual(expect.any(String));
        expect(newInstance).not.toBe(originalInstance);
        await runtime.deleteDesktop(desktopId);
        expect(() => runtime.getDesktop(desktopId)).toThrow();

        const hooks = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        const expected = { appName: name, description: 'App metadata', whatItIs: 'Lifecycle fixture',
            whenToUse: 'Exercise SPI callbacks', signalPolicy: 'never', appId, desktopId, copied: true,
            threadId: expect.any(Number) };
        expect(hooks).toEqual([
            { ...expected, hook: 'reinitialize', reason },
            { ...expected, hook: 'delete' },
        ]);
        expect(hooks[0].threadId).not.toBe(hooks[1].threadId);
        facts.push({ case: 'spi-lifecycle-receiver', hooks, reset, originalInstance, newInstance });
    } finally {
        expect(await runtime.beginShutdown().completion).toMatchObject({
            ok: true, resourcesReleased: true, workers: { report: { total: 0 } },
        });
    }
}, 15000);

it('Semantic lifecycle controls stay bound to the App instance observed by each live Agent Context', async () => {
    const runtime = makeRuntime(), contexts: any[] = [], sources: any[] = [];
    const definitions = (context: any) => ['system-open_app', 'system-close_app'].map(name => {
        const tool = context.tools[name];
        expect(tool).toBeDefined();
        expect(tool.inputSchema.jsonSchema).toEqual({ type: 'object', properties: { app_id: { type: 'string' } },
            required: ['app_id'], additionalProperties: false });
        return { name, description: tool.description, schema: tool.inputSchema.jsonSchema };
    });
    const call = async (context: any, name: string, args: any, callId: string) => {
        expect(context.tools[name]).toBeDefined();
        return context.executeTool(name, args, callId);
    };
    const desktopId = 'controls';
    const desktop = await runtime.createDesktop(desktopId).then((id: string) => runtime.getDesktop(id));
    // Independent consumer sessions keep the old holder, so adoption cannot mask the instance guard.
    const context = async () => {
        const source = new adaptersPackage.SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: false });
        sources.push(source);
        const value = await source.getContext();contexts.push(value);await value.adopt();return value;
    };
    try {
        const empty = await context(), base = definitions(empty);
        expect(Object.keys(empty.tools).sort()).toEqual(['system-close_app', 'system-open_app']);
        for (const name of ['system-open_app', 'system-close_app']) {
            expect((await call(empty, name, { app_id: 'a' }, 'empty-' + name))?.error?.code).toBe('INVALID_APP_TARGET');
        }
        expect(desktop.getInstalledApps()).toEqual([]);
        await install(runtime, desktopId, 'a', undefined, { name: 'interaction_example' });
        const first = await context();
        expect(definitions(first)).toEqual(base);
        expect((await call(first, 'system-open_app', { app_id: 'a' }, 'already-open'))?.error?.code).toBe('INVALID_APP_TARGET');
        expect(first.tools['system-show_app']).toBeUndefined();
        const dynamicTool = Object.keys(first.tools).find(name => name === 'interaction_example-Detail-ordinary');
        expect(dynamicTool).toBeDefined();
        const firstInstance = desktop.getInstalledApps().find((entry: any) => entry.appId === 'a')?.appInstanceId;
        expect(typeof firstInstance).toBe('string');
        expect(JSON.stringify(first.messages)).not.toContain(firstInstance);
        expect((await call(first, dynamicTool!, { filePath: '/open/note.txt', text: 'change' }, 'first-read'))?.outcomeStatus).toBe('succeeded');

        expect((await call(first, 'system-collapse_app', { app_id: 'a' }, 'first-collapse'))?.outcomeStatus).toBe('succeeded');
        const collapsedFirst = await context();
        expect(definitions(collapsedFirst)).toEqual(base);
        expect(collapsedFirst.tools['system-collapse_app']).toBeUndefined();
        expect(collapsedFirst.tools[dynamicTool!]).toBeUndefined();
        expect((await call(collapsedFirst, 'system-show_app', { app_id: 'a' }, 'first-show'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, 'system-close_app', { app_id: 'a' }, 'first-close'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, dynamicTool!, { filePath: '/open/note.txt', text: 'change' }, 'closed-read'))?.error?.code).toBe('APP_INTERACTION_UNAVAILABLE');

        const closed = await context();
        expect(definitions(closed)).toEqual(base);
        expect(closed.tools[dynamicTool!]).toBeUndefined();
        expect((await call(closed, 'system-close_app', { app_id: 'a' }, 'already-closed'))?.error?.code).toBe('INVALID_APP_TARGET');
        expect((await call(closed, 'system-open_app', { app_id: 'a' }, 'reopen'))?.outcomeStatus).toBe('succeeded');
        const successor = await context();
        expect(definitions(successor)).toEqual(base);
        const successorInstance = desktop.getInstalledApps().find((entry: any) => entry.appId === 'a')?.appInstanceId;
        expect(successorInstance).toEqual(expect.any(String));
        expect(successorInstance).not.toBe(firstInstance);
        expect(JSON.stringify(successor.messages)).not.toContain(successorInstance);
        expect((await call(successor, dynamicTool!, { filePath: '/open/note.txt', text: 'change' }, 'successor-read'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, dynamicTool!, { filePath: '/open/note.txt', text: 'change' }, 'old-read-after-reopen'))?.error?.code).toBe('APP_INTERACTION_UNAVAILABLE');

        for (const [name, callId] of [['system-close_app', 'stale-close'], ['system-collapse_app', 'stale-collapse']] as const) {
            expect((await call(first, name, { app_id: 'a' }, callId))?.error?.code).toBe('APP_INSTANCE_CHANGED');
        }
        expect(desktop.getInstalledApps().find((entry: any) => entry.appId === 'a')).toMatchObject({
            status: 'running', appInstanceId: successorInstance,
        });

        expect((await call(successor, 'system-collapse_app', { app_id: 'a' }, 'successor-collapse'))?.outcomeStatus).toBe('succeeded');
        const collapsedSuccessor = await context();
        expect((await call(collapsedFirst, 'system-show_app', { app_id: 'a' }, 'stale-show'))?.error?.code).toBe('APP_INSTANCE_CHANGED');
        expect((await call(collapsedSuccessor, 'system-show_app', { app_id: 'a' }, 'successor-show'))?.outcomeStatus).toBe('succeeded');
        const runningSuccessor = await context();
        expect((await call(runningSuccessor, 'system-close_app', { app_id: 'a' }, 'successor-close'))?.outcomeStatus).toBe('succeeded');
        facts.push({ case: 'persistent-lifecycle-controls', definitions: base, emptyDesktopRejected: true,
            firstInstance, successorInstance, staleCloseRejected: true });
    } finally {
        for (const entry of contexts) await entry.release?.();
        for (const source of sources) source.dispose();
        await runtime.beginShutdown().completion;
    }
}, 30000);

it('B2 C12/21 two Desktop/three App actual owners aggregate held callbacks without rerouting same IDs', async () => {
    const runtime = makeRuntime(), gates = [deferred(), deferred(), deferred()], entered = [deferred(), deferred(), deferred()];try {
        await install(runtime, 'one', 'a');await install(runtime, 'one', 'b');await install(runtime, 'two', 'a');
        const scopes = [scope(runtime, 'one', 'a'), scope(runtime, 'one', 'b'), scope(runtime, 'two', 'a')], observations = await Promise.all(scopes.map(s => s.observe()));
        const foreign = await scopes[1].client.invoke(request(observations[0]));expect(foreign).toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        const works = scopes.map((s, index) => { s.controls.project = () => { entered[index].resolve();return gates[index].promise; };return s.client.observe({ viewIds: ['detail'] }); });await Promise.all(entered.map(g => g.promise));
        const one = runtime.getDesktop('one').beginClose(), two = runtime.getDesktop('two').beginClose();
        const closing = runtime.beginShutdown(), previous = closing.inspect();expect(previous.interactions).toMatchObject({ verified: true, retainedOperations: 3 });
        expect(one.inspect().interactions.retainedOperations).toBe(2);expect(two.inspect().interactions.retainedOperations).toBe(1);
        expect(previous.interactions.retainedBytes).toBe(one.inspect().interactions.retainedBytes + two.inspect().interactions.retainedBytes);
        for (const [index, remaining] of [2, 1, 0].entries()) { gates[index].resolve({ views: [], refs: [], toolBindings: [], content: [] });await works[index];
            await vi.waitFor(() => expect(closing.inspect().interactions.retainedOperations).toBe(remaining));
            expect(closing.inspect().interactions.retainedBytes).toBe(one.inspect().interactions.retainedBytes + two.inspect().interactions.retainedBytes); }
        const report = await closing.completion;expect(report).toMatchObject({ resourcesReleased: true, interactions: { verified: true, retainedOperations: 0, retainedBytes: 0 } });
        expect(previous.interactions.retainedOperations).toBe(3);facts.push({ case: 'three-owners', previous, report });
    } finally { for (const gate of gates) gate.resolve({ views: [], refs: [], toolBindings: [], content: [] });await runtime.beginShutdown().completion; }
}, 20000);

it('B2 C07 app launch config cannot grant tools disabled by the trusted Host', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', false, { config: { toolsEnabled: true } });
        const s = scope(runtime), observation = await s.observe();
        expect(observation.views.find((view: any) => view.id === 'detail')?.content.value).toContain('Completed actions: 0');
        expect(observation.bindings).toEqual([]);

    } finally { await runtime.beginShutdown().completion; }
}, 15000);
