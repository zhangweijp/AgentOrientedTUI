import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { DrivenSourceContext, LLMConfig, Tool } from '@aotui/agent-driver-v2';
import { parseTuiSnapshot } from '../src/gui/components/TuiParser.js';

const [reportPath] = process.argv.slice(2);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aotui-semantic-app-acceptance-')));
const home = join(fixture, 'home');
const project = join(fixture, 'project');
const planning = join(fixture, 'planning');
const planningPackage = resolve(repo, process.env.AOTUI_ACCEPTANCE_PLANNING_PACKAGE ?? 'demo-apps/planning-app');
const idePackage = resolve(repo, process.env.AOTUI_ACCEPTANCE_IDE_PACKAGE ?? 'demo-apps/aotui-ide');
const browserPackage = join(repo, 'demo-apps/lite-browser-app');
const file = join(project, 'a.ts');
const greet = 'export function greet(name: string): string {\n  return `A-v2 你好 <A> & ${name}`;\n}\n';
type Schema = { type?: string; required?: string[]; items?: Schema; properties?: Record<string, Schema>; enum?: string[]; additionalProperties?: boolean };
type Request = { model: string; messages: Array<{ role: string; content: string }>; tools?: { function: { name: string; description: string; parameters: Schema } }[] };
const requests: Request[] = [];
const errors: string[] = [];
const cases: Record<string, unknown> = {};
const facts: Record<string, unknown> = { cases, requests, errors, passed: false };

await mkdir(home);
await mkdir(project);
await mkdir(planning);
for (const name of ['dist', 'aoapp.json', 'package.json']) {
    await cp(join(planningPackage, name), join(planning, name), { recursive: true });
}
// Planning stores SQLite alongside its module, so even its dist must be a copy.
await symlink(join(planningPackage, 'node_modules'), join(planning, 'node_modules'), 'dir');
await writeFile(file, greet);
await writeFile(join(project, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
process.env.HOME = home;
process.env.DB_PATH = join(fixture, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(fixture, 'runtime-data');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;

const previousFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:1/v1/chat/completions');
    const request = JSON.parse(String(init?.body)) as Request;
    const number = requests.push(request);
    const header = { id: 'test-' + number, object: 'chat.completion.chunk', created: 1, model: request.model };
    const frames = [
        { ...header, choices: [{ index: 0, delta: { role: 'assistant', content: 'Captured test request.' }, finish_reason: null }] },
        { ...header, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
};

const { AppRegistry, createRuntime } = await import('@aotui/runtime');
const { DesktopManager, desktopManager, desktopManagerReady } = await import('../src/core/desktop-manager.js');
const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
const { LLMConfigService } = await import('../src/core/llm-config-service.js');
const { MessageServiceV2 } = await import('../src/core/message-service-v2.js');
const { projectService } = await import('../src/core/project-service.js');
const { ModelRegistry } = await import('../src/services/model-registry.js');
const db = await import('../src/db/index.js');
await desktopManagerReady;
const runtime = createRuntime();
const installation = new DesktopManager({ kernel: runtime, appRegistry: new AppRegistry({ configPath: join(fixture, 'apps.json') }) });
const llm: LLMConfig = { model: 'fixture', apiKey: 'test-only', maxSteps: 1,
    provider: { id: 'acceptance', baseURL: 'http://127.0.0.1:1/v1' }, modelCapabilities: { toolCall: true } };
class FixtureLLMConfig extends LLMConfigService {
    override async resolveLLMConfig() { return llm; }
    override withModelInputBudget(config: LLMConfig) { return config; }
}
const manager = new SessionManagerV3(runtime, installation, new FixtureLLMConfig(new ModelRegistry()), new MessageServiceV2());
const topicId = 'semantic-app-acceptance';
manager.on('message', ({ type, message }) => {
    if (type === 'assistant' && typeof message?.content === 'string' && message.content !== 'Captured test request.') {
        errors.push(message.content);
    }
});
const open = 'system-open_app', close = 'system-close_app';
const ideName = 'system_ide', planningName = 'planning_app';
const workspace = ideName + '-Workspace-multi_open_file';
const hover = ideName + '-FileDetail-lsp_hover';
const create = planningName + '-PlanList-create_plan';
const addPhase = planningName + '-PlanDetail-add_phase';
let callId = 0;

function schema(tools: Record<string, Tool>, name: string) {
    const result = (tools[name]?.inputSchema as { jsonSchema?: Schema } | undefined)?.jsonSchema;
    assert.ok(result, `${name} exposes a JSON Schema`);
    return result;
}
const controlSchema = { type: 'object', properties: { app_id: { type: 'string' } },
    required: ['app_id'], additionalProperties: false };
function controls(tools: Record<string, Tool>) {
    return [open, close].map(name => {
        const parameters = schema(tools, name);
        assert.deepEqual(parameters, controlSchema);
        return { name, description: tools[name]?.description, parameters };
    });
}
const views = (context: DrivenSourceContext, app: string) => context.messages.map(message => String(message.content))
    .filter(message => message.startsWith('<view ') && message.includes(`app_name="${app}"`));
const view = (context: DrivenSourceContext, app: string, id: string) => views(context, app)
    .find(message => message.startsWith(`<view id="${id}"`)) ?? '';
const database = async () => readFile(join(planning, 'data/planning.sqlite'));

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
    const end = Date.now() + 5_000;
    do {
        const value = await read();
        if (ready(value)) return value;
        await delay(20);
    } while (Date.now() < end);
    throw new Error('Timed out waiting for ' + label);
}

try {
    await db.initDatabase();
    await installation.initialize({ loadFromConfig: false, appEntries: [
        { name: ideName, source: `local:${idePackage}`, enabled: true, autoStart: false },
        { name: planningName, source: `local:${planning}`, enabled: true, autoStart: true },
        { name: 'lite_browser', source: `local:${browserPackage}`, enabled: true, autoStart: false },
    ] });
    const linkedProject = projectService.createProject(project, 'Synthetic acceptance project');
    db.createTopic({ id: topicId, title: 'Synthetic acceptance', status: 'hot', projectId: linkedProject.id,
        createdAt: Date.now(), updatedAt: Date.now(), contextCompaction: { enabled: false }, sourceControls: {
            apps: { enabled: true, disabledItems: ['lite_browser'] },
            mcp: { enabled: false, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
        } });
    const session = await manager.ensureSession(topicId);
    assert.equal(session.sources.aotui.constructor.name, 'SemanticAOTUIDrivenSource');
    const source = session.sources.aotui;
    const installed = (name: string) => {
        const app = session.desktop.getInstalledApps().find(app => app.name === name);
        assert.ok(app, `${name} is installed`);
        return app;
    };
    const ide = installed(ideName).appId;
    const preview = async (name: string) => {
        const markup = await installation.getSnapshot(session.desktop.id);
        assert.ok(markup);
        const parsed = parseTuiSnapshot(markup);
        assert.deepEqual(parsed.parseErrors, []);
        const app = parsed.desktop?.applications.find(app => app.name === name);
        assert.ok(app);
        return { status: app.status, views: app.views.map(view => view.id) };
    };
    async function context<T>(check: (context: DrivenSourceContext) => Promise<T> | T, ready?: (value: DrivenSourceContext) => boolean) {
        const current = await waitFor(async () => {
            const captured = await source.getContext();
            if (!ready || ready(captured)) return captured;
            await captured.release?.();
            return undefined;
        }, value => value !== undefined, 'current Source context');
        assert.ok(current);
        try { return await check(current); }
        finally { await current.release?.(); }
    }
    async function invoke(current: DrivenSourceContext, name: string, input: unknown, adopted = true) {
        assert.ok(current.tools[name], name);
        if (adopted) await current.adopt?.();
        const result = await current.executeTool?.(name, input, 'acceptance-' + ++callId);
        assert.ok(result);
        return result;
    }
    const statusLine = (state: 'pending' | 'closed' | 'running') => new RegExp(`App ID: ${ide}\\n    - Status: ${
        state === 'closed' ? 'not launched' : state === 'pending' ? 'available \\(not started\\)' : 'running'}`);
    async function wire(label: string, toolNames: { present: string[]; absent: string[] }) {
        const first = requests.length;
        const marker = 'Synthetic capture ' + label;
        await manager.sendMessage(topicId, marker);
        const request = await waitFor(async () => requests.slice(first).find(item => JSON.stringify(item.messages).includes(marker)),
            value => value !== undefined, label + ' model request');
        assert.ok(request);
        const tools = request.tools?.map(tool => tool.function.name) ?? [];
        for (const name of toolNames.present) assert.ok(tools.includes(name), `${label}: expected ${name}`);
        for (const name of toolNames.absent) assert.ok(!tools.includes(name), `${label}: unexpected ${name}`);
        await waitFor(async () => session.agentDriver.getState(), state => state === 'idle', 'model fixture completion');
        return { tools, messages: request.messages, definitions: request.tools };
    }

    const lifecycle: Record<string, unknown> = cases.lifecycle = {};
    const definitions = await context(current => controls(current.tools));
    function checkControls(current: DrivenSourceContext) {
        assert.deepEqual(controls(current.tools), definitions);
    }
    function checkWireControls(request: Awaited<ReturnType<typeof wire>>) {
        const actual = [open, close].map(name => request.definitions?.find(tool => tool.function.name === name)?.function);
        assert.deepEqual(actual, definitions);
    }
    async function checkInactive(state: 'pending' | 'closed') {
        assert.equal(installed(ideName).status, state);
        assert.deepEqual(await preview(ideName), { status: state, views: [] });
        const projected = await context(current => {
            checkControls(current);
            assert.equal(current.tools[workspace], undefined);
            assert.deepEqual(views(current, ideName), []);
            assert.match(current.messages.map(message => message.content).join('\n'), statusLine(state));
            return Object.keys(current.tools);
        });
        const request = await wire(state, { present: [open, close], absent: [workspace] });
        assert.match(request.messages.map(message => message.content).join('\n'), statusLine(state));
        checkWireControls(request);
        assert.ok(request.messages.some(message => message.content.includes(
            '`system-open_app` and `system-close_app` are available even if there are no eligible targets')));
        lifecycle[state] = { projected, preview: await preview(ideName), request };
    }
    await checkInactive('pending');
    await context(async current => {
        assert.equal((await invoke(current, open, { app_id: ide }, false)).error?.code, 'SEMANTIC_CONTEXT_NOT_ADOPTED');
        await current.adopt?.();
        assert.equal((await invoke(current, open, { app_id: installed('lite_browser').appId }, false)).error?.code, 'INVALID_APP_TARGET');
        assert.equal((await invoke(current, close, { app_id: ide }, false)).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(ideName).status, 'pending');
        assert.equal((await invoke(current, open, { app_id: ide }, false)).outcomeStatus, 'succeeded');
    });
    lifecycle.running = await context(current => {
        assert.equal(installed(ideName).status, 'running');
        assert.ok(view(current, ideName, 'workspace'));
        checkControls(current);
        return Object.keys(current.tools);
    }, current => !!current.tools[workspace]);
    const runningRequest = await wire('running', { present: [workspace, open, close], absent: [] });
    assert.match(runningRequest.messages.map(message => message.content).join('\n'), statusLine('running'));
    checkWireControls(runningRequest);
    lifecycle.runningRequest = runningRequest;
    await context(async current => {
        const instance = installed(ideName).appInstanceId;
        assert.equal((await invoke(current, open, { app_id: ide })).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(ideName).appInstanceId, instance);
        assert.equal((await invoke(current, close, { app_id: ide })).outcomeStatus, 'succeeded');
    });
    await checkInactive('closed');
    await manager.setSourceItemEnabled(topicId, 'apps', ideName, false);
    const disabled = await context(async current => {
        checkControls(current);
        assert.equal(current.tools[workspace], undefined);
        assert.deepEqual(views(current, ideName), []);
        assert.ok(!current.messages.some(message => String(message.content).includes(ideName)));
        assert.equal((await invoke(current, open, { app_id: ide })).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(ideName).status, 'closed');
        return Object.keys(current.tools);
    });
    assert.deepEqual(await preview(ideName), { status: 'closed', views: [] });
    assert.deepEqual(await preview('lite_browser'), { status: 'pending', views: [] });
    const disabledRequest = await wire('disabled', { present: [create, open, close], absent: [workspace] });
    checkWireControls(disabledRequest);
    assert.ok(!disabledRequest.messages.some(message => message.content.includes(`App ID: ${ide}`)));
    lifecycle.disabled = { projected: disabled, preview: await preview(ideName), request: disabledRequest };
    await manager.setSourceItemEnabled(topicId, 'apps', planningName, false);
    const noTargets = await context(async current => {
        checkControls(current);
        assert.deepEqual(Object.keys(current.tools).sort(), [close, open]);
        assert.equal((await invoke(current, close, { app_id: installed(planningName).appId })).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(planningName).status, 'running');
        return Object.keys(current.tools);
    });
    const noTargetsRequest = await wire('all apps filtered', { present: [open, close], absent: [create, workspace] });
    checkWireControls(noTargetsRequest);
    lifecycle.noTargets = { projected: noTargets, request: noTargetsRequest };
    await manager.setSourceEnabled(topicId, 'apps', false);
    assert.deepEqual(await source.getContext(), { messages: [], tools: {} });
    lifecycle.sourceDisabled = await wire('apps source disabled', { present: [], absent: [open, close, create, workspace] });
    await manager.setSourceItemEnabled(topicId, 'apps', planningName, true);
    await manager.setSourceEnabled(topicId, 'apps', true);
    const planningFacts: Record<string, unknown> = cases.planning = {};
    const unchanged = await waitFor(async () => database().catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    }), value => value !== undefined, 'initial synthetic planning database');
    await context(async current => {
        assert.match(view(current, planningName, 'plan_list'), /No unfinished plans/);
        const phases = schema(current.tools, create).properties?.phases;
        assert.ok(phases?.items);
        planningFacts.createSchema = phases;
        assert.deepEqual(phases.items.required, ['title']);
        assert.equal(phases.items.properties?.description?.type, 'string');
        const tasks = phases.items.properties?.tasks;
        assert.equal(tasks?.type, 'array');
        assert.deepEqual(tasks.items?.required, ['title']);
        assert.equal(tasks.items?.properties?.description?.type, 'string');
        assert.equal(phases.items.additionalProperties, false);
        assert.equal(phases.items.properties?.todos, undefined);
        assert.deepEqual(disabledRequest.definitions?.find(tool => tool.function.name === create)?.function.parameters.properties?.phases, phases);
        for (const [label, phase, path] of [
            ['malformedTasks', { title: 'Design', tasks: ['bad task'] }, '$.phases[0].tasks[0]'],
            ['retiredTodos', { title: 'Design', todos: [{ title: 'Retired' }] }, '$.phases[0]'],
            ['mixedTasksAndTodos', { title: 'Design', tasks: [{ title: 'Valid task' }], todos: [{ title: 'Retired' }] }, '$.phases[0]'],
        ] as const) {
            const reply = await invoke(current, create, { title: label, phases: [phase] });
            planningFacts[label] = reply;
            assert.equal(reply.outcomeStatus, 'rejected');
            assert.equal(reply.error?.code, 'TOOL_INVALID_ARGS');
            assert.ok(reply.error?.message.includes(path));
            assert.deepEqual(await database(), unchanged);
        }
    }, current => !!current.tools[create]);
    await context(async current => {
        const phase = { title: 'Design tasks', tasks: [{ title: 'Accepted tasks', description: 'Concrete task' }] };
        const reply = await invoke(current, create, { title: 'Plan tasks', phases: [phase] });
        assert.equal(reply.outcomeStatus, 'succeeded');
        planningFacts.created = reply;
    });
    planningFacts.createdView = await context(current => {
        const detail = view(current, planningName, 'plan_detail');
        assert.ok(detail.includes('[Plan tasks](Plan:plan_detail_current)'));
        assert.ok(detail.includes('[Design tasks](Phase:current_phase)'));
        assert.ok(detail.includes('[Accepted tasks](Task:pending_tasks[0])'));
        return detail;
    }, current => view(current, planningName, 'plan_detail').includes('Plan tasks'));
    const beforeAdd = await database();
    await context(async current => {
        const tasks = schema(current.tools, addPhase).properties?.tasks;
        assert.ok(tasks?.items);
        planningFacts.addPhaseSchema = tasks;
        assert.deepEqual(tasks.items.required, ['title']);
        assert.equal(tasks.items.properties?.description?.type, 'string');
        const plan = 'plan_detail.plan_detail_current';
        const reply = await invoke(current, addPhase, { plan, title: 'Malformed phase', tasks: ['bad'] });
        planningFacts.malformedAddPhase = reply;
        assert.equal(reply.outcomeStatus, 'rejected');
        assert.equal(reply.error?.code, 'TOOL_INVALID_ARGS');
        assert.ok(reply.error?.message.includes('$.tasks[0]'));
        assert.deepEqual(await database(), beforeAdd);
        const missingTitle = await invoke(current, addPhase, { plan, title: 'Missing title phase', tasks: [{ description: 'bad' }] });
        planningFacts.missingTaskTitle = missingTitle;
        assert.equal(missingTitle.outcomeStatus, 'rejected');
        assert.equal(missingTitle.error?.code, 'TOOL_INVALID_ARGS');
        assert.ok(missingTitle.error?.message.includes('$.tasks[0].title'));
        assert.deepEqual(await database(), beforeAdd);
        assert.equal((await invoke(current, addPhase, { plan, title: 'Added phase', tasks: [{ title: 'Added task' }] })).outcomeStatus, 'succeeded');
    });
    await context(async current => {
        const reply = await invoke(current, planningName + '-PlanDetail-complete_phase', { phase: 'plan_detail.current_phase' });
        assert.equal(reply.outcomeStatus, 'succeeded');
    }, current => view(current, planningName, 'plan_detail').includes('Added phase'));
    await context(async current => {
        assert.match(view(current, planningName, 'plan_detail'), /\[Added task\]\(Task:pending_tasks\[0\]\)/);
        const reply = await invoke(current, planningName + '-PlanDetail-complete_task', { task: 'plan_detail.pending_tasks[0]' });
        assert.equal(reply.outcomeStatus, 'succeeded');
    }, current => view(current, planningName, 'plan_detail').includes('[Added phase](Phase:current_phase)'));
    planningFacts.refCalls = ['Plan', 'Phase', 'Task'];
    planningFacts.final = await context(current => view(current, planningName, 'plan_detail'),
        current => view(current, planningName, 'plan_detail').includes('[Added task](Task:completed_tasks[0])'));

    await manager.setSourceItemEnabled(topicId, 'apps', ideName, true);
    await context(async current => {
        assert.equal((await invoke(current, open, { app_id: ide })).outcomeStatus, 'succeeded');
    });
    await context(async current => {
        assert.equal((await invoke(current, workspace, { filePaths: [file] })).outcomeStatus, 'succeeded');
    }, current => !!current.tools[workspace]);
    const hoverFacts: Record<string, unknown> = cases.hover = { source: greet, column17: greet[16] };
    assert.equal(greet[16], 'g');
    for (const [label, line, character] of [['symbol', 1, 17], ['empty', 2, 1]] as const) {
        const reply = await context(current => invoke(current, hover, { file_path: file, line, character }), current => !!current.tools[hover]);
        assert.equal(reply.outcomeStatus, 'succeeded', JSON.stringify(reply));
        const receipt = reply.result as { message: string; view_id: string };
        assert.match(receipt.view_id, /^fd_/);
        assert.deepEqual(Object.keys(receipt).sort(), ['message', 'view_id']);
        const detail = await context(current => view(current, ideName, receipt.view_id), current => {
            const panel = view(current, ideName, receipt.view_id).split('### hover\n')[1] ?? '';
            return label === 'symbol' ? panel.includes('function greet(name: string): string') : panel.includes('"value": null');
        });
        const panel = detail.split('### hover\n')[1];
        hoverFacts[label] = { line, character, reply, panel, detail };
        assert.ok(panel, detail);
        assert.match(receipt.message, /FileDetail.*hover/);
        assert.ok(receipt.message.includes(receipt.view_id));
        if (label === 'symbol') {
            assert.match(receipt.message, /information available/i);
            assert.match(panel, /function greet\(name: string\): string/);
        } else {
            assert.match(receipt.message, /no hover information/i);
            assert.match(panel, /No hover information/i);
            assert.doesNotMatch(panel, /function greet/);
            assert.match(panel, /"value": null/);
        }
    }
    const shutdownDesktop = session.desktop.id;
    const beginDesktopShutdown = runtime.beginDesktopShutdown.bind(runtime);
    const closeHandles: Array<ReturnType<typeof beginDesktopShutdown>> = [];
    runtime.beginDesktopShutdown = (...args) => {
        const handle = beginDesktopShutdown(...args);
        closeHandles.push(handle);
        return handle;
    };
    await manager.shutdownSession(topicId);
    assert.equal(closeHandles.length, 1);
    assert.throws(() => runtime.getDesktop(shutdownDesktop));
    const closeReport = await closeHandles[0]!.completion;
    cases.sessionClose = closeReport;
    assert.equal(closeReport.desktopId, shutdownDesktop);
    assert.equal(closeReport.found, true);
    assert.equal(closeReport.resourcesReleased, true);
    assert.equal(closeReport.hasFailures, false);
    assert.equal(session.state, 'destroyed');
    assert.deepEqual(errors, []);
    facts.passed = true;
    console.log('PASS Planning Schema/Ref, Host lifecycle and model request, native tsgo hover projection');
} catch (error) {
    facts.failure = String(error instanceof Error ? error.stack : error);
    throw error;
} finally {
    manager.stopCleanupTask();
    const shutdown = await runtime.beginShutdown().completion;
    facts.shutdown = shutdown;
    await manager.shutdownSession(topicId);
    await desktopManager.getKernel().beginShutdown().completion;
    db.closeDatabase();
    if (reportPath) await writeFile(resolve(reportPath), JSON.stringify(facts, null, 2) + '\n');
    globalThis.fetch = previousFetch;
    await rm(fixture, { recursive: true, force: true });
    assert.equal(shutdown.resourcesReleased, true);
    assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
}
