import { fixtureAppPath, singleAppHost } from '../fixtures/batch-two-support.mjs';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

let directory: string, app: string, runtimePackage: any, adaptersPackage: any;
const authorName = 'interaction_example';
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
    if (installedConsumer) {
        if (!isAbsolute(installedConsumer)) throw new Error('AOTUI_PACKAGE_CONSUMER_DIR must be absolute');
        const consumer = await realpath(installedConsumer);
        const modules = join(consumer, 'node_modules', '@aotui');
        for (const pkg of ['core', 'runtime', 'sdk', 'agent-driver-adapter', 'agent-driver-v2']) {
            const path = await realpath(join(modules, pkg));
            expect(path.startsWith(join(consumer, 'node_modules') + '/')).toBe(true);
            const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
            facts.push({ package: manifest.name, version: manifest.version, path });
        }
        directory = await mkdtemp(join(consumer, 'runtime-lifecycle-'));
        await capture(join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }));
        facts.push({ consumer, mode: 'provided-installation', fixtures: directory });
    } else {
        directory = await mkdtemp(join(output ?? tmpdir(), 'aotui-b2-public-'));
        await capture(join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }));
        const modules = join(directory, 'node_modules');
        await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const pkg of ['core', 'runtime', 'sdk', 'agent-driver-adapter', 'agent-driver-v2']) {
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
        for (const pkg of ['core', 'runtime', 'sdk', 'agent-driver-adapter', 'agent-driver-v2']) for (const entry of await readdir(join(repo, pkg, 'node_modules'), { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '@aotui') continue;
            const target = join(modules, entry.name);try { await symlink(join(repo, pkg, 'node_modules', entry.name), target, 'dir');links.push({ path: target, source: join(repo, pkg, 'node_modules', entry.name) }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
        }
        facts.push({ consumer: directory, selfPackageLinks: false, thirdPartyLinks: links, completeCleanInstall: false });
    }
    app = join(directory, 'app.mjs');
    await capture(app, `import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, refParam } from '@aotui/sdk';

const FileSchema = Type.Object({ filePath: Type.String(), text: Type.String() }, { additionalProperties: false });
const Guide = defineViewType({ multiplicity: 'multiple', name: 'Root' });
const FileDetail = defineViewType()({ multiplicity: 'multiple', name: 'Detail', tools: {
  ordinary: {
    description: 'Apply text to the selected file. Read the updated Detail.',
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    async execute({ input, context: { edit } }) {
      if (input.text === 'throw') throw new Error('PRIVATE_CONTROLLED_FAILURE');
      if (input.text === 'business') return { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Application declined the edit.' },
        data: { refreshed: false } };
      edit(input.text);
      return { success: true, data: { message: 'Change completed.' } };
    },
  },
  ref: {
    description: 'Inspect the displayed File Ref.',
    inputSchema: Type.Object({ file: refParam('File', FileSchema) }, { additionalProperties: false }),
    async execute({ input, context }) {
      if (input.file.filePath !== context.filePath) return { success: false,
        error: { code: 'REF_WRONG_FILE', message: 'Select the displayed file.' } };
      return { success: true, data: { currentValueAvailable: true } };
    },
  },
} });
const viewTypes = [Guide, FileDetail];

export default createApp({ app_name: 'interaction_example', viewTypes,
  initialize({ prepareProjection }) {
    let count = 0, text = 'original';
    const filePath = '/open/note.txt';
    const root = createView(Guide, { idPrefix: 'root', region: 'static', render: () => ({
      body: '# File Application Instruction\\n\\nSelect the receiving View by view_id. Use the published File Ref address.',
    }) });
    const detail = createView(FileDetail, { idPrefix: 'detail', region: 'dynamic', render: () => {
      const file = ref('file', { filePath, text }, { scope: 'protected', refType: 'File', schema: FileSchema });
      return {
        refs: [file],
        body: ['Open file: ' + filePath, formatRef('Current file value', file), text, 'Completed actions: ' + count].join('\\n\\n'),
        context: { filePath, edit(value) { text = value; count++; publish(); } },
      };
    } });
    function publish() { prepareProjection({ views: [root, detail] }); }
    publish();
  },
});
`);
    const entry = join(directory, 'entry.mjs');await capture(entry, "export * from '@aotui/runtime';\n");runtimePackage = await import(pathToFileURL(entry).href);
    const adaptersEntry = join(directory, 'adapters.mjs');await capture(adaptersEntry, "export * from '@aotui/agent-driver-adapter';\n");adaptersPackage = await import(pathToFileURL(adaptersEntry).href);
}, 30000);
afterAll(async () => {
    if (output) await writeFile(join(output, 'b2-public-e2e.json'), JSON.stringify(facts, null, 2));
    else if (directory) await rm(directory, { recursive: true, force: true });
});

function makeRuntime() { return runtimePackage.createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 8 } }); }
const appPolicies = new WeakMap<object, Map<string, ReturnType<typeof createPolicy>>>();
function createPolicy() {
    const controls = {
        project: ({ source }: any): any => ({
            refs: Object.values(source.refs).map((ref: any) => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
            toolIds: Object.keys(source.tools),
        }),
        authorize: (_context: any): any => true,
        read: (_meta: any, _signal: any): any => true,
    };
    const policy = { project: (context: any) => controls.project(context), authorize: (context: any) => controls.authorize(context),
        canReadReceipt: (meta: any, signal: any) => controls.read(meta, signal) };
    return { controls, policy };
}
function policyFor(runtime: object, desktop: string, id: string) {
    let entries = appPolicies.get(runtime);
    if (!entries) { entries = new Map(); appPolicies.set(runtime, entries); }
    const key = JSON.stringify([desktop, id]);
    let entry = entries.get(key);
    if (!entry) { entry = createPolicy(); entries.set(key, entry); }
    return entry;
}
async function install(runtime: any, desktop = 'd', id = 'a', toolsEnabled?: boolean, extra = {}, appPath = app) {
    try { runtime.getDesktop(desktop); } catch { await runtime.createDesktop(desktop); }
    const running = await runtime.getDesktop(desktop).installDynamicWorkerApp(pathToFileURL(appPath).href, {
        installationId: id, name: authorName, config: { AOTUI_DATA_DIR: join(directory, 'data', desktop, id) }, ...extra,
        policy: policyFor(runtime, desktop, id).policy,
        ...(toolsEnabled === undefined ? {} : { toolsEnabled }),
    });
    return running.appId;
}
function scope(runtime: any, desktop = 'd', id = 'a') {
    const { controls } = policyFor(runtime, desktop, id);
    const owner = runtime.getDesktop(desktop);
    const current = owner.listApps().find((app: any) => app.installationId === id);
    const appId = current?.appId, instanceId = current?.appInstanceId;
    const result = owner.getRunningApp(appId, instanceId);expect(result.status).toBe('ready');if (result.status !== 'ready') throw Error(result.issue.code);
    const resultClient = singleAppHost(owner, result.app);
    async function prepare() { let observation: any;await vi.waitFor(async () => { const result = await resultClient.observe();expect(result.status).toBe('observed');if (result.status === 'observed') observation = result.observation; }, { timeout: 6000 });return observation; }
    async function observe() { const observation = await prepare();expect(resultClient.adopt(observation.observationId).status).toBe('adopted');return observation; }
    return { client: resultClient, running: result.app, controls, prepare, observe, appId, instanceId };
}
function request(observation: any, name = 'ordinary', input: any = { text: 'change' }, invocationId = 'call') {
    const tool = observation.tools.find((tool: any) => tool.name === name);
    if (!tool) throw Error('Missing Tool ' + name);
    return { invocationId, observationId: observation.observationId, toolId: tool.id, viewId: 'detail_1', input: {  ...input } };
}
async function waitForViewText(client: any, expected: string) {
    const deadline = Date.now() + 6000;let last: unknown;
    while (Date.now() < deadline) {
        const result = await client.observe();
        if (result.status === 'observed') {
            const view = result.observation.views.find((entry: any) => entry.id === 'detail_1');
            client.release(result.observation.observationId);
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
        for (const [index, [name, input]] of ([['ordinary', { text: 'change' }], ['ref', { file: '$ref.' + observation.source.appId + '.detail_1.file' }]] as const).entries()) {
            const result = await s.client.invoke(request(observation, name, input, 'mode-' + index));expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });outputs.push(result);
        }
        expect(outputs[1].receipt.outcome.value.data.currentValueAvailable).toBe(true);
        await waitForViewText(s.client, 'Completed actions: 1');
        expect(runtime.getDesktop('d').getRunningApp(s.appId, s.instanceId).app).toBe(s.running);
        facts.push({ case: 'default-qualified-public', outputs });
    } finally { expect((await runtime.beginClose().completion).ok).toBe(true); }
}, 15000);

it('B2 C09 toolsEnabled true exposes ordinary and Ref tools through the same contract', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', true);const s = scope(runtime), observation = await s.observe();
        for (const [name, input] of [['ordinary', { text: 'change' }], ['ref', { file: '$ref.' + observation.source.appId + '.detail_1.file' }]] as const) {
            expect(observation.tools.some((tool: any) => tool.name === name)).toBe(true);
            const first = await s.client.invoke(request(observation, name, input, name));
            expect(first.receipt.outcome.status).toBe('succeeded');
            const again = await s.client.invoke(request(observation, name, input, name + '-next'));
            expect(again.receipt.outcome.status).toBe('succeeded');
            if (name === 'ref') expect(again.receipt.outcome.value.data.currentValueAvailable).toBe(true);
        }

    } finally { await runtime.beginClose().completion; }
}, 15000);

it('B2 C05 toolsEnabled false preserves Views but grants no executable bindings', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', false);const s = scope(runtime), observation = await s.observe();
        expect(observation.views.some((view: any) => view.id === 'detail_1')).toBe(true);
        expect(observation.tools).toEqual([]);

    } finally { await runtime.beginClose().completion; }
}, 15000);

it('rejects invalid tool settings and the retired Host key before registering an App', async () => {
    const runtime = makeRuntime();
    try {
        await expect(install(runtime, 'd', 'bad-value', 'false' as any)).rejects.toMatchObject({ code: 'TOOLS_ENABLED_INVALID' });
        for (const value of [[], ['view-type-parameters-v1'], undefined]) {
            await expect(install(runtime, 'd', 'retired', undefined, { interactionModes: value })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
        }
        expect(runtime.getDesktop('d').listApps()).toEqual([]);
    } finally { await runtime.beginClose().completion; }
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

    } finally { await runtime.beginClose().completion; }
}, 15000);

it('checks the complete Tool Schema at the packed SDK, Runtime and Snapshot boundaries', async () => {
    const entry = join(directory, 'capacity-app.mjs');
    await capture(entry, `import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk';
import { projectNativeToolSchema } from '@aotui/runtime/adapters';

export const modelSchemaFor = inputSchema => projectNativeToolSchema({ multiplicity: 'multiple',
    viewType: 'Detail', inputSchema }, { appId: 'schema_capacity', instanceId: 'capacity' }, [], []);

const limit = 64 * 1024;
const base = { type: 'object', properties: {}, required: [], additionalProperties: false, description: '' };
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const unit = '界😀\\n';
const fill = limit - bytes(modelSchemaFor(base));
const unitBytes = bytes(unit) - 2;
const description = unit.repeat(Math.floor(fill / unitBytes)) + 'x'.repeat(fill % unitBytes);
export const define = delta => defineViewType()({ multiplicity: 'multiple', name: 'Detail', tools: { wide: {
    description: 'Exercise a Tool at its model schema boundary',
    inputSchema: Type.Object({}, { description: description + 'x'.repeat(delta) }),
    execute: () => ({ success: true }),
} } });
const Detail = define(0);
export const oversizedSchema = { ...base, description: 'x'.repeat(limit) };
export const modelSchema = modelSchemaFor(Detail.tools.wide.inputSchema);
export const modelBytes = bytes(modelSchema);
export const schemaBytes = bytes(Detail.tools.wide.inputSchema);
export default createApp({ app_name: 'schema_capacity', viewTypes: [Detail], initialize({ prepareProjection }) {
    const detail = createView(Detail, { idPrefix: 'detail', region: 'dynamic', render: () => ({
        body: 'Schema ready', context: {},
    }) });
    prepareProjection({ views: [detail] });
} });
`);
    const fixture = await import(pathToFileURL(entry).href);
    expect(fixture.modelBytes).toBe(64 * 1024);
    expect(fixture.schemaBytes).toBeLessThan(fixture.modelBytes);
    const overLimit = fixture.define(1);
    expect(() => fixture.modelSchemaFor(overLimit.tools.wide.inputSchema)).toThrow(expect.objectContaining({
        code: 'TOOL_SCHEMA_CAPACITY', path: '$',
    }));
    const coreEntry = join(directory, 'capacity-core.mjs');
    await capture(coreEntry, "export { compileToolParameters } from '@aotui/core';\n");
    const { compileToolParameters } = await import(pathToFileURL(coreEntry).href);
    expect(compileToolParameters(fixture.oversizedSchema)).toMatchObject({ ok: false });

    const runtime = makeRuntime();
    try {
        await install(runtime, 'd', 'a', true, { name: 'schema_capacity' }, entry);
        const s = scope(runtime), observation = await s.observe();
        const schema = observation.tools.find((tool: any) => tool.name === 'wide')?.inputSchema;
        expect(new TextEncoder().encode(JSON.stringify(schema)).byteLength).toBe(fixture.schemaBytes);
        expect(fixture.modelSchemaFor(schema)).toEqual(fixture.modelSchema);
        const result = await s.client.invoke(request(observation, 'wide', {}, 'at-limit'));
        expect(result).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });
        facts.push({ case: 'canonical-schema-capacity', bytes: fixture.schemaBytes, oversized: 'TOOL_SCHEMA_CAPACITY', result });
    } finally {
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15000);

it('rejects retired package entry points and an incompatible SDK factory in a real Worker', async () => {
    const exportsEntry = join(directory, 'b01-exports.mjs');
    await capture(exportsEntry, `
export * as core from '@aotui/core';
export * as sdk from '@aotui/sdk';
`);
    const { core, sdk } = await import(pathToFileURL(exportsEntry).href);
    expect(core).not.toHaveProperty('ORDINARY_INVOKER_ABI_V4');
    expect(core).not.toHaveProperty('ORDINARY_INVOKER_ABI_V3');
    expect(core).not.toHaveProperty('ORDINARY_INVOCATION_MODE');
    const retired = execFileSync(process.execPath, ['--input-type=module', '--eval', `
        const results = await Promise.allSettled(['@aotui/core/internal', '@aotui/runtime/core', '@aotui/runtime/adapters/dom', '@aotui/runtime/spi'].map(name => import(name)));
        console.log(JSON.stringify(results.map(result => result.reason?.code)));
    `], { cwd: directory, encoding: 'utf8' });
    expect(JSON.parse(retired)).toEqual(Array(4).fill('ERR_PACKAGE_PATH_NOT_EXPORTED'));
    expect(sdk).not.toHaveProperty('useLLMUsage');
    expect(sdk).not.toHaveProperty('ToolCatalog');
    expect(sdk).not.toHaveProperty('getToolCatalog');
    expect(core).not.toHaveProperty('ordinaryParameterProfile');
    expect(runtimePackage.createAppId('0notes')).toBe('0notes');
    expect(() => runtimePackage.createAppId(0)).toThrow(TypeError);

    const runtime = makeRuntime();
    try {
        for (const variant of ['import', 'view-type-tools-v5', 'invalid-export']) {
            const file = join(directory, `legacy-${variant.replace('/', '-')}.mjs`);
            const declaration = variant === 'import'
                ? "import { ORDINARY_INVOCATION_MODE as abi } from '@aotui/core';"
                : `const abi = ${JSON.stringify(variant)};`;
            await capture(file, `
${declaration}
export default ${variant === 'invalid-export' ? '[' : ''}{
    app_name: 'legacy_sdk',
    toolAuthoringProtocol: abi, appLifecycleSupport: 'app-lifecycle-v2',
    initialize() {
        throw Error('INCOMPATIBLE_FACTORY_ENTERED');
    }
}${variant === 'invalid-export' ? ']' : ''};\n`);
            const issue = variant === 'import'
                ? { code: 'E_INIT_FAILED', cause: { message: expect.stringContaining('ORDINARY_INVOCATION_MODE') } }
                : variant === 'invalid-export' ? { code: 'E_INIT_FAILED', cause: { code: 'APP_INVALID_EXPORT' } }
                : { code: 'APP_AUTHORING_PROTOCOL_UNSUPPORTED', message: expect.stringContaining('view-type-tools-v8') };
            await expect(install(runtime, 'd', variant, undefined, { name: 'legacy_sdk' }, file)).rejects.toMatchObject({
                code: 'INSTALL_FAILED', cause: issue,
            });
            expect(runtime.getDesktop('d').listApps()).toEqual([]);
        }
        facts.push({ case: 'rejects-retired-import-and-invalid-factories', variants: ['import', 'view-type-tools-v5', 'invalid-export'] });
    } finally {
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15000);

it.each([
    ['missing', 'WORKER_PROTOCOL_UNSUPPORTED'],
    ['wrong-protocol', 'WORKER_PROTOCOL_UNSUPPORTED'],
    ['wrong-authorization', 'APP_INIT_ACK_INVALID'],
] as const)('rejects the bundled Worker ACK before installing an App (%s)', async (variant, reason) => {
    const runtime = makeRuntime(), post = Worker.prototype.postMessage, emit = Worker.prototype.emit;
    const appUrl = pathToFileURL(app).href;
    let worker: Worker | undefined, init: Record<string, unknown> | undefined;
    const sent: string[] = [];
    const replies: { threadId: number; original: Record<string, unknown>; delivered: Record<string, unknown> }[] = [];
    const outgoing = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, ...args) {
        if (message.type === 'INIT' && message.appModulePath === appUrl) {
            worker = this;
            init = message;
        }
        if (this === worker) sent.push(message.type);
        return post.call(this, message, ...args);
    });
    const incoming = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
        if (this !== worker || event !== 'message' || args[0]?.type !== 'INIT_RESPONSE')
            return emit.call(this, event, ...args);
        const original = args[0], delivered = { ...original };
        if (variant === 'missing') delete delivered.protocol;
        else if (variant === 'wrong-protocol') delivered.protocol = 'app-worker/v5';
        else delivered.toolsEnabled = !original.toolsEnabled;
        replies.push({ threadId: this.threadId, original, delivered });
        return emit.call(this, event, delivered);
    });
    try {
        const failure = await install(runtime).then(() => undefined, error => error);
        expect(failure).toMatchObject({ code: 'INSTALL_FAILED', cause: { code: reason },
            closeReport: { resourcesReleased: true, worker: 'exited', interactions: { retainedOperations: 0 } } });
        expect(replies).toHaveLength(1);
        expect(replies[0]!.threadId).toBeGreaterThan(0);
        expect(init).toMatchObject({ protocol: expect.any(String), toolsEnabled: true });
        expect(replies[0]!.original).toMatchObject({
            requestId: init!.requestId, protocol: init!.protocol, appInstanceId: init!.appInstanceId, toolsEnabled: init!.toolsEnabled,
        });
        expect(sent).not.toContain('APP_OPEN');
        expect(runtime.getDesktop('d').listApps()).toEqual([]);
        const report = await runtime.beginClose().completion;
        expect(report).toMatchObject({ resourcesReleased: true, hasFailures: false, verification: 'managed',
            interactions: { verified: true, retainedOperations: 0 }, workers: { report: { total: 0 } } });
        facts.push({ case: `worker-ack-${variant}`, reason, sent, replies, report, failedStartup: failure.closeReport });
    } finally {
        incoming.mockRestore();
        outgoing.mockRestore();
        await runtime.beginClose().completion;
    }
}, 15000);

it('a real bundled Worker rejects an old INIT marker before App publication', async () => {
    const runtime = makeRuntime(), post = Worker.prototype.postMessage;
    let replaced = 0;
    const patch = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, ...args) {
        if (message.type === 'INIT' && message.appModulePath === pathToFileURL(app).href) {
            replaced++;
            return post.call(this, { ...message, protocol: 'app-worker/v5' }, ...args);
        }
        return post.call(this, message, ...args);
    });
    try {
        await expect(install(runtime)).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        });
        expect(replaced).toBe(1);
        expect(runtime.getDesktop('d').listApps()).toEqual([]);
        patch.mockRestore();
        await install(runtime);
        expect(await waitForViewText(scope(runtime).client, 'Completed actions: 0')).toContain('Open file:');
        facts.push({ case: 'worker-rejects-old-request-and-accepts-current', replaced, issue: 'WORKER_PROTOCOL_UNSUPPORTED' });
    } finally { patch.mockRestore();await runtime.beginClose().completion; }
}, 15000);

it.each([false, true])('frees the original Desktop ID after release (logger failure=%s)', async fail => {
    const runtime = makeRuntime(), entered = deferred(), gate = deferred();
    try {
        await install(runtime, 'first');await install(runtime, 'other');
        const original = runtime.getDesktop('first'), firstApp = scope(runtime, 'first'), otherApp = scope(runtime, 'other');
        const cleanup = vi.spyOn((original as any).logger, 'cleanup').mockImplementationOnce(async () => {
            entered.resolve(); await gate.promise; if (fail) throw Error('cleanup test');
        });
        const handle = original.beginClose();
        expect(original.beginClose()).toBe(handle);
        await entered.promise;
        const deadline = await handle.wait({ timeoutMs: 5 });
        expect(deadline).toMatchObject({ status: 'deadline', report: { resourcesReleased: false } });
        await expect(runtime.createDesktop('first')).rejects.toHaveProperty('code', 'DESKTOP_ALREADY_EXISTS');
        expect(runtime.getDesktop('first')).toBe(original);
        const observation = await otherApp.observe();
        const receipt = await otherApp.client.invoke(request(observation, 'ordinary', { text: 'other kept working' }, 'other-once'));
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });
        otherApp.client.release(observation.observationId);
        expect(await waitForViewText(otherApp.client, 'Completed actions: 1')).toContain('other kept working');
        gate.resolve();
        const report = await handle.completion;
        expect(report).toMatchObject({ resourcesReleased: !fail, hasFailures: fail, desktops: { accepted: 1, settled: 1 } });
        expect(cleanup).toHaveBeenCalledOnce();
        const released = original.beginClose();
        expect(await released.completion).toMatchObject({ resourcesReleased: true, hasFailures: fail, failures: report.failures });
        expect(() => runtime.getDesktop('first')).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        await install(runtime, 'first');
        const successor = runtime.getDesktop('first'), newApp = scope(runtime, 'first');
        expect(successor).not.toBe(original);
        expect(newApp.instanceId).not.toBe(firstApp.instanceId);
        expect(original.beginClose()).toBe(released);
        expect(await handle.completion).toBe(report);
        expect(await firstApp.client.preview()).toMatchObject({ status: 'rejected' });
        expect(await waitForViewText(newApp.client, 'Completed actions: 0')).toContain('original');
        const newClose = successor.beginClose();
        expect(newClose).not.toBe(handle);
        expect(successor.beginClose()).toBe(newClose);
        await newClose.completion;
        const final = await runtime.beginClose().completion;
        expect(final).toMatchObject({ ok: true, resourcesReleased: true, desktops: { accepted: 1, settled: 1 } });
        facts.push({ case: 'desktop-owner', fail, deadline, report, receipt, final, callbackCount: cleanup.mock.calls.length,
            previousInstanceId: firstApp.instanceId, successorInstanceId: newApp.instanceId });
    } finally { gate.resolve();await runtime.beginClose().completion; }
}, 20000);

it('global shutdown drains a started Worker install and a late admitted Desktop alongside a held Desktop', async () => {
    const runtime = makeRuntime(), callbackEntered = deferred(), allowCallback = deferred();
    const pendingApp = join(directory, 'held-install.mjs'), importing = join(directory, 'importing'), resume = join(directory, 'resume-import');
    await capture(pendingApp, `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(importing)}, 'Worker imported the module');
while (!existsSync(${JSON.stringify(resume)})) await new Promise(resolve => setTimeout(resolve, 10));
export { default } from ${JSON.stringify(pathToFileURL(app).href)};
`);
    try {
        await install(runtime, 'held');
        const heldDesktop = runtime.getDesktop('held');
        vi.spyOn((heldDesktop as any).logger, 'cleanup').mockImplementationOnce(async () => {
            callbackEntered.resolve(); await allowCallback.promise;
        });
        const held = heldDesktop.beginClose();
        await callbackEntered.promise;
        const installing = install(runtime, 'initializing', 'pending', undefined, {}, pendingApp)
            .then(() => undefined, error => error);
        await vi.waitFor(async () => expect(await readFile(importing, 'utf8')).toBe('Worker imported the module'), { timeout: 6000 });
        const initializing = runtime.getDesktop('initializing');
        const accepted = runtime.createDesktop('late-created');
        const shutdown = runtime.beginClose();
        expect(initializing.isClosing).toBe(true);
        expect(runtime.beginClose()).toBe(shutdown);
        await expect(runtime.createDesktop('unadmitted')).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
        await expect(accepted).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
        await writeFile(resume, 'release held import');
        const installError = await installing;
        expect(installError).toHaveProperty('code', 'INSTALL_FAILED');
        const deadline = await shutdown.wait({ timeoutMs: 5 });
        expect(deadline).toMatchObject({ status: 'deadline', report: { desktops: { accepted: 3, settled: 2, pending: 1 },
            resourcesReleased: false, workers: { report: { state: 'closed', total: 0 } } } });
        expect(held.inspect().cleanup.logger).toBe('pending');
        allowCallback.resolve();
        const report = await shutdown.completion;
        expect(report).toMatchObject({ resourcesReleased: true, hasFailures: false, pendingTasks: 0,
            desktops: { accepted: 3, settled: 3, notVerifiedReleased: 0 },
            workers: { report: { state: 'closed', total: 0 } } });
        for (const key of ['held', 'initializing', 'late-created']) {
            expect(() => runtime.getDesktop(key)).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        }
        facts.push({ case: 'global-admitted-install-and-create', installCode: installError.code,
            createCode: 'RUNTIME_SHUTDOWN', deadline, report });
    } finally {
        allowCallback.resolve();
        await writeFile(resume, 'allow pending Worker import to finish');
        await runtime.beginClose().completion;
    }
}, 20000);

it('reuses one instance handle and keeps read-only preview independent of the candidate', async () => {
    const runtime = makeRuntime();
    try {
        await install(runtime);
        const s = scope(runtime), current = await s.observe();
        expect(runtime.getDesktop('d').getRunningApp(s.appId, s.instanceId).app).toBe(s.running);
        expect(runtime.getDesktop('d').getRunningApp(s.appId, 'wrong')).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
        const pending = await s.client.observe();
        expect(pending.status).toBe('observed');
        expect((await s.client.preview()).status).toBe('previewed');
        expect(await s.client.observe()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        s.client.release(pending.observation.observationId);
        expect(await s.client.invoke(request(current))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect((await s.client.observe()).status).toBe('observed');
    } finally { await runtime.beginClose().completion; }
}, 15000);

it.each((['runtime', 'desktop', 'app'] as const).flatMap(parent => [false, true].map(reject => [parent, reject] as const)))('B2 C14/17 actual %s close holds project until reject=%s resolves actual ownership', async (parent, reject) => {
    const runtime = makeRuntime(), gate = deferred(), entered = deferred();let closing: any;
    try {
        await install(runtime);const s = scope(runtime);const observation = await s.observe();let calls = 0;
        s.controls.project = (context: any) => { calls++;entered.resolve();context.signal.addEventListener('abort', () => {
        expect(runtime.getDesktop('d').getRunningApp(s.appId, s.instanceId).status).toBe('rejected');
        });return gate.promise; };
        const observing = s.client.observe();await entered.promise;const desktop = runtime.getDesktop('d');
        closing = parent === 'runtime' ? runtime.beginClose() : parent === 'desktop' ? desktop.beginClose() : s.running.beginClose();
        const previous = calls, sameStack = s.client.observe();
        expect(await s.client.invoke({ invocationId: 'late', observationId: 'old', toolId: 'old', input: {} })).not.toHaveProperty('kind', 'receipt');
        expect(await s.client.invoke({ ...request(observation), invocationId: 'late' })).toMatchObject({ kind: 'refused' });
        expect(desktop.getRunningApp(s.appId, s.instanceId).status).toBe('rejected');await sameStack;expect(calls).toBe(previous);
        if (closing) {
            const deadline = await closing.wait({ timeoutMs: 5 });expect(deadline).toMatchObject({ status: 'deadline', report: { resourcesReleased: false, hasFailures: false, interactions: { verified: true, retainedOperations: 1 } } });
            facts.push({ case: 'held-project-' + parent, pending: deadline.report });
        }
        if (reject) gate.reject(Error('held project'));else gate.resolve({ refs: [], toolIds: [] });expect((await observing).status).toBe('rejected');
        if (closing) expect(await closing.completion).toMatchObject({ resourcesReleased: true, interactions: { verified: true, retainedOperations: 0 } });
    } finally { gate.resolve({ refs: [], toolIds: [] });await runtime.beginClose().completion; }
}, 15000);

it.each((['authorize', 'auto-read', 'duplicate-read'] as const).flatMap(stage => (['runtime', 'desktop', 'app'] as const).map(parent => [stage, parent] as const)))('B2 C18 actual SDK/Node %s remains owned through %s close until resolve/reject', async (stage, parent) => {
    for (const reject of [false, true]) {
        const runtime = makeRuntime(), entered = deferred(), gate = deferred();try {
            const trace = join(directory, `handlers-${stage}-${parent}-${reject}`), tracedApp = trace + '.mjs';
            const original = await readFile(app, 'utf8'), traced = original.replace('edit(input.text);',
                `await appendFile(${JSON.stringify(trace)}, 'entered\\n');edit(input.text);`);
            expect(traced).not.toBe(original);await capture(tracedApp, "import { appendFile } from 'node:fs/promises';\n" + traced);
            const handlerCount = async () => (await readFile(trace, 'utf8').catch(error => { if (error.code === 'ENOENT') return '';throw error; })).split('\n').filter(Boolean).length;
            await install(runtime, 'd', 'a', undefined, {}, tracedApp);const s = scope(runtime), observation = await s.observe(), input = request(observation);let calls = 0;
            if (stage === 'duplicate-read') await s.client.invoke(input);
            const hold = () => { calls++;entered.resolve();return gate.promise; };
            if (stage === 'authorize') s.controls.authorize = hold;else s.controls.read = hold;
            const work = s.client.invoke(input);await entered.promise;
            const handlersBeforeClose = await handlerCount();expect(handlersBeforeClose).toBe(stage === 'authorize' ? 0 : 1);
            const closing = parent === 'desktop' ? runtime.getDesktop('d').beginClose()
                : parent === 'app' ? s.running.beginClose() : runtime.beginClose(), before = closing.inspect();expect((await closing.wait({ timeoutMs: 5 })).status).toBe('deadline');
            expect(closing.inspect()).toMatchObject({ resourcesReleased: false, hasFailures: false, interactions: { verified: true, retainedOperations: stage === 'authorize' ? 2 : 1 } });
            expect(await s.client.invoke(input)).toHaveProperty('code', parent === 'app' ? 'OBSERVATION_UNAVAILABLE' : 'TURN_NOT_ACTIVE');expect(calls).toBe(1);
            if (reject) gate.reject(Error('held policy'));else gate.resolve(true);
            expect(await work).not.toHaveProperty('kind', 'receipt');const report = await closing.completion;
            expect(report).toMatchObject({ ok: true, resourcesReleased: true, interactions: { verified: true, retainedOperations: 0 } });
            const handlersAfterClose = await handlerCount();expect(handlersAfterClose).toBe(handlersBeforeClose);
            expect(before.interactions.retainedOperations).toBe(stage === 'authorize' ? 2 : 1);facts.push({ case: stage, parent, reject, handlersBeforeClose, handlersAfterClose, before, report });
        } finally { gate.resolve(true);await runtime.beginClose().completion; }
    }
}, 25000);

it('keeps the trusted setting through collapse, expand and reopen while revoking the old routes', async () => {
    const pendingApp = join(directory, 'pending-limits.mjs');
    const original = await readFile(app, 'utf8');
    const author = original
        .replace('initialize({ prepareProjection }) {', 'initialize({ prepareProjection, projectionLimits: { maxViews, observation } }) {')
        .replace("'# File Application Instruction", "'Configured limits ' + maxViews + '/' + observation.maxCanonicalBytes + '");
    expect(author).not.toBe(original);
    await capture(pendingApp, author);
    const expectLimits = (frame: any) => expect(frame.views.find((view: any) => view.id === 'root_1')?.content.value)
        .toContain('Configured limits 2/8192');
    const runtime = makeRuntime();try {
        const id = (await runtime.createDesktop('d')).id, desktop = runtime.getDesktop(id);
        const pending = { installationId: 'a', localPath: await fixtureAppPath(pendingApp, authorName, directory), toolsEnabled: true,
            projectionLimits: { maxViews: 2, observation: { maxCanonicalBytes: 8192 } },
            config: { projectionLimits: { maxViews: 256 } },
        };
        await desktop.registerPendingApp(pending); pending.toolsEnabled = false;
        pending.projectionLimits.maxViews = 1;
        pending.projectionLimits.observation.maxCanonicalBytes = 1;
        const { policy } = policyFor(runtime, id, 'a');
        expect(desktop.getRunningApp(authorName, 'missing').issue.code).toBe('APP_INTERACTION_UNAVAILABLE');await desktop.openApp('a', { policy });
        const s = scope(runtime), first = await s.prepare();
        const adopted = s.client.adopt(first.observationId);
        expect(adopted.status).toBe('adopted');
        desktop.revokeWindowAccess(adopted.turn, { appId: s.appId, instanceId: s.instanceId });
        expect(desktop.getRunningApp(authorName, s.instanceId).app).toBe(s.running);
        expectLimits(first);
        expect(await s.client.invoke(request(first, 'ordinary', { text: 'change' }, 'old-expanded-route'))).toMatchObject({
            receipt: { executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'TOOL_UNAVAILABLE' } },
        });
        const expanded = await s.observe();
        expect((await s.client.invoke(request(expanded, 'ordinary', { text: 'change' }, 'fresh-expanded-route'))).receipt.outcome.status).toBe('succeeded');
        expect((await s.running.beginClose().completion).ok).toBe(true);expect((await s.client.observe()).status).toBe('rejected');await desktop.openApp('a', { policy });
        const reopened = scope(runtime), next = await reopened.observe();expect(next.source.instanceId).not.toBe(first.source.instanceId);
        expectLimits(next);
        const closing = reopened.running.beginClose();expect(desktop.getRunningApp(authorName, s.instanceId).status).toBe('rejected');
        expect((await reopened.client.observe()).status).toBe('rejected');expect((await closing.completion).ok).toBe(true);await desktop.openApp('a', { policy });
        const fresh = scope(runtime), last = await fresh.observe();expect(last.source.instanceId).not.toBe(next.source.instanceId);
        expectLimits(last);
        expect((await fresh.client.invoke(request(last))).receipt.outcome.status).toBe('succeeded');
        facts.push({ case: 'instance-boundaries', instances: [first.source.instanceId, next.source.instanceId, last.source.instanceId], toolsEnabled: true });
    } finally { await runtime.beginClose().completion; }
}, 20000);

it('fails an initially over-limit projection and releases its Worker even when the App catches preparation', async () => {
    const entry = join(directory, 'initial-projection-limit.mjs'), disposed = join(directory, 'initial-projection-limit-closed');
    await capture(entry, `
import { appendFileSync } from 'node:fs';
import { createApp, createView, defineViewType } from '@aotui/sdk';
const Page = defineViewType({ multiplicity: 'multiple', name: 'Page' });
export default createApp({ app_name: 'initial_projection_limit', viewTypes: [Page], initialize({ prepareProjection, registerCleanup }) {
    registerCleanup({ close() { appendFileSync(${JSON.stringify(disposed)}, 'closed'); } });
    const views = ['a','b'].map(id => createView(Page, { idPrefix: id, region: 'dynamic', render: () => ({ body: id }) }));
    try { prepareProjection({ views }); }
    catch (error) { if (error.code !== 'OBSERVATION_CAPACITY') throw error; }
}});
`);
    const runtime = runtimePackage.createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 1 } });
    try {
        await expect(install(runtime, 'd', 'a', undefined, { name: 'initial_projection_limit', projectionLimits: { maxViews: 1 } }, entry)).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'E_OPEN_FAILED', cause: { code: 'OBSERVATION_CAPACITY', path: '$.views' } },
        });
        expect(await readFile(disposed, 'utf8')).toBe('closed');
        expect(runtime.getDesktop('d').listApps()).toEqual([]);
        await install(runtime, 'd', 'a', undefined, { name: 'initial_projection_limit', projectionLimits: { maxViews: 2 } }, entry);
        expect((await scope(runtime).observe()).views.map((view: any) => view.id)).toEqual(['a_1', 'b_1']);
    } finally {
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 15_000);

it('Semantic lifecycle controls stay bound to the App instance observed by each live Agent Context', async () => {
    const runtime = makeRuntime(), contexts: any[] = [], sources: any[] = [];
    const definitions = (context: any) => ['system-open_app', 'system-close_app'].map(name => {
        const tool = context.tools[name];
        expect(tool).toBeDefined();
        const field = name === 'system-open_app' ? 'installation_id' : 'app_id';
        expect(tool.inputSchema.jsonSchema).toEqual({ type: 'object', properties: { [field]: { type: 'string' } },
            required: [field], additionalProperties: false });
        return { name, description: tool.description, schema: tool.inputSchema.jsonSchema };
    });
    const call = async (context: any, name: string, args: any, callId: string) => {
        expect(context.tools[name]).toBeDefined();
        return context.executeTool(name, args, callId);
    };
    const desktopId = 'controls';
    const desktop = await runtime.createDesktop(desktopId);
    const source = new adaptersPackage.SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
    sources.push(source);
    const context = async () => {
        const value = await source.getContext();contexts.push(value);await value.adopt();return value;
    };
    try {
        const empty = await context(), base = definitions(empty);
        expect(Object.keys(empty.tools).sort()).toEqual(['run_code', 'system-close_app', 'system-open_app']);
        for (const name of ['system-open_app', 'system-close_app']) {
            expect((await call(empty, name, { [name === 'system-open_app' ? 'installation_id' : 'app_id']: 'a' }, 'empty-' + name))?.error?.code).toBe('INVALID_APP_TARGET');
        }
        expect(desktop.listApps()).toEqual([]);
        await install(runtime, desktopId, 'a', undefined, { name: 'interaction_example' });
        const first = await context();
        expect(definitions(first)).toEqual(base);
        expect((await call(first, 'system-open_app', { installation_id: 'a' }, 'already-open'))?.error?.code).toBe('INVALID_APP_TARGET');
        expect(first.tools['system-expand_app']).toBeUndefined();
        const dynamicTool = Object.keys(first.tools).find(name => name === 'interaction_example-ordinary');
        expect(dynamicTool).toBeDefined();
        const firstInstance = desktop.listApps().find((entry: any) => entry.installationId === 'a')?.appInstanceId;
        expect(typeof firstInstance).toBe('string');
        expect(JSON.stringify(first.messages)).not.toContain(firstInstance);
        expect((await call(first, dynamicTool!, { view_id: 'detail_1', text: 'change' }, 'first-read'))?.outcomeStatus).toBe('succeeded');

        expect((await call(first, 'system-collapse_app', { app_id: authorName }, 'first-collapse'))?.outcomeStatus).toBe('succeeded');
        const anotherSource = new adaptersPackage.SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
        sources.push(anotherSource);
        const otherLayout = await anotherSource.getContext();
        expect(otherLayout.tools[dynamicTool!]).toBeDefined();
        await otherLayout.release();
        const collapsedFirst = await context();
        expect(definitions(collapsedFirst)).toEqual(base);
        expect(collapsedFirst.tools['system-collapse_app']).toBeUndefined();
        expect(collapsedFirst.tools[dynamicTool!]).toBeUndefined();
        expect((await call(collapsedFirst, 'system-expand_app', { app_id: authorName }, 'first-show'))?.outcomeStatus).toBe('succeeded');
        expect((await call(collapsedFirst, 'system-close_app', { app_id: authorName }, 'first-close'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, dynamicTool!, { view_id: 'detail_1', text: 'change' }, 'closed-read'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');

        const closed = await context();
        expect(definitions(closed)).toEqual(base);
        expect(closed.tools[dynamicTool!]).toBeUndefined();
        expect((await call(closed, 'system-close_app', { app_id: authorName }, 'already-closed'))?.error?.code).toBe('INVALID_APP_TARGET');
        expect((await call(closed, 'system-open_app', { installation_id: 'a' }, 'reopen'))?.outcomeStatus).toBe('succeeded');
        const successor = await context();
        expect(definitions(successor)).toEqual(base);
        const successorInstance = desktop.listApps().find((entry: any) => entry.installationId === 'a')?.appInstanceId;
        expect(successorInstance).toEqual(expect.any(String));
        expect(successorInstance).not.toBe(firstInstance);
        expect(JSON.stringify(successor.messages)).not.toContain(successorInstance);
        expect((await call(successor, dynamicTool!, { view_id: 'detail_1', text: 'change' }, 'successor-read'))?.outcomeStatus).toBe('succeeded');
        expect((await call(first, dynamicTool!, { view_id: 'detail_1', text: 'change' }, 'old-read-after-reopen'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');

        for (const [name, callId] of [['system-close_app', 'stale-close'], ['system-collapse_app', 'stale-collapse']] as const) {
            expect((await call(first, name, { app_id: authorName }, callId))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        }
        expect(desktop.listApps().find((entry: any) => entry.installationId === 'a')).toMatchObject({
            status: 'running', appInstanceId: successorInstance,
        });

        expect((await call(successor, 'system-collapse_app', { app_id: authorName }, 'successor-collapse'))?.outcomeStatus).toBe('succeeded');
        const collapsedSuccessor = await context();
        expect((await call(collapsedFirst, 'system-expand_app', { app_id: authorName }, 'stale-show'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect((await call(collapsedSuccessor, 'system-expand_app', { app_id: authorName }, 'successor-show'))?.outcomeStatus).toBe('succeeded');
        const runningSuccessor = await context();
        expect((await call(runningSuccessor, 'system-close_app', { app_id: authorName }, 'successor-close'))?.outcomeStatus).toBe('succeeded');
        facts.push({ case: 'persistent-lifecycle-controls', definitions: base, emptyDesktopRejected: true,
            firstInstance, successorInstance, staleCloseRejected: true });
    } finally {
        for (const entry of contexts) await entry.release?.();
        for (const source of sources) source.dispose();
        await runtime.beginClose().completion;
    }
}, 30000);

it('B2 C12/21 two Desktop/three App actual owners aggregate held callbacks without rerouting same IDs', async () => {
    const runtime = makeRuntime(), gates = [deferred(), deferred(), deferred()], entered = [deferred(), deferred(), deferred()];try {
        await install(runtime, 'one', 'a');await install(runtime, 'one', 'b');await install(runtime, 'two', 'a');
        const scopes = [scope(runtime, 'one', 'a'), scope(runtime, 'one', 'b'), scope(runtime, 'two', 'a')];
        const observations = await Promise.all(scopes.map(s => s.prepare()));
        const apps = scopes.map((s, index) => ({ candidate: s.client.candidate(observations[index].observationId) }));
        const first = runtime.getDesktop('one').adoptTurn({ apps: apps.slice(0, 2) });
        const second = runtime.getDesktop('two').adoptTurn({ apps: apps.slice(2) });
        expect(first.status).toBe('adopted'); expect(second.status).toBe('adopted');
        const foreign = await first.turn.invoke(scopes[1].appId, request(observations[0]));
        expect(foreign).toMatchObject({ kind: 'refused', code: 'TURN_SELECTION_INVALID' });
        const works = scopes.map((s, index) => { s.controls.project = () => { entered[index].resolve();return gates[index].promise; };return s.client.observe(); });await Promise.all(entered.map(g => g.promise));
        const one = runtime.getDesktop('one').beginClose(), two = runtime.getDesktop('two').beginClose();
        const closing = runtime.beginClose(), previous = closing.inspect();expect(previous.interactions).toMatchObject({ verified: true, retainedOperations: 3 });
        expect(one.inspect().interactions.retainedOperations).toBe(2);expect(two.inspect().interactions.retainedOperations).toBe(1);
        expect(previous.interactions.retainedOperations).toBe(one.inspect().interactions.retainedOperations + two.inspect().interactions.retainedOperations);
        for (const [index, remaining] of [2, 1, 0].entries()) { gates[index].resolve({ refs: [], toolIds: [] });await works[index];
            await vi.waitFor(() => expect(closing.inspect().interactions.retainedOperations).toBe(remaining));
            expect(closing.inspect().interactions.retainedOperations).toBe(one.inspect().interactions.retainedOperations + two.inspect().interactions.retainedOperations); }
        const report = await closing.completion;expect(report).toMatchObject({ resourcesReleased: true, interactions: { verified: true, retainedOperations: 0 } });
        expect(previous.interactions.retainedOperations).toBe(3);facts.push({ case: 'three-owners', previous, report });
    } finally { for (const gate of gates) gate.resolve({ refs: [], toolIds: [] });await runtime.beginClose().completion; }
}, 20000);

it('B2 C07 app launch config cannot grant tools disabled by the trusted Host', async () => {
    const runtime = makeRuntime();try {
        await install(runtime, 'd', 'a', false, { config: { toolsEnabled: true } });
        const s = scope(runtime), observation = await s.observe();
        expect(observation.views.find((view: any) => view.id === 'detail_1')?.content.value).toContain('Completed actions: 0');
        expect(observation.tools).toEqual([]);

    } finally { await runtime.beginClose().completion; }
}, 15000);
