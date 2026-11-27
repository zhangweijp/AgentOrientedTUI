import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { DrivenSourceContext, LLMConfig, Tool } from '@aotui/agent-driver-v2';
import { readDesktopPreview } from '../src/core/desktop-preview.js';
import { modelViews } from './fixtures/model-views.js';

const [reportPath] = process.argv.slice(2);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = await realpath(await mkdtemp(join(os.tmpdir(), 'aotui-semantic-app-acceptance-')));
const home = join(fixture, 'home');
const project = join(fixture, 'project');
const planning = join(fixture, 'planning');
const planningPackage = resolve(repo, process.env.AOTUI_ACCEPTANCE_PLANNING_PACKAGE ?? 'demo-apps/planning-app');
const idePackage = resolve(repo, process.env.AOTUI_ACCEPTANCE_IDE_PACKAGE ?? 'demo-apps/aotui-ide');
const browserPackage = join(repo, 'demo-apps/lite-browser-app');
const file = join(project, 'a.ts');
const greet = 'export function greet(name: string): string {\n  return `A-v2 你好 <A> & ${name}`;\n}\n';
type Schema = { type?: string; required?: string[]; items?: Schema; properties?: Record<string, Schema>; anyOf?: Schema[];
    description?: string; additionalProperties?: boolean };
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
mock.method(os, 'homedir', () => home);
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

const { createRuntime } = await import('@aotui/runtime');
const { AppCatalog } = await import('../src/app-distribution/app-catalog.js');
const { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } = await import('@aotui/runtime/adapters');
const { DesktopManager, desktopManager } = await import('../src/core/desktop-manager.js');
const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
const { LLMConfigService } = await import('../src/core/llm-config-service.js');
const { MessageService } = await import('../src/core/message-service.js');
const { projectService } = await import('../src/core/project-service.js');
const { ModelRegistry } = await import('../src/services/model-registry.js');
const db = await import('../src/db/index.js');
const runtime = createRuntime();
const installation = new DesktopManager({ kernel: runtime, appCatalog: new AppCatalog({ configPath: join(fixture, 'apps.json') }) });
const llm: LLMConfig = { model: 'fixture', apiKey: 'test-only',
    provider: { id: 'acceptance', baseURL: 'http://127.0.0.1:1/v1' }, modelCapabilities: { toolCall: true } };
class FixtureLLMConfig extends LLMConfigService {
    override async resolveLLMConfig() { return llm; }
    override withModelInputBudget(config: LLMConfig) { return config; }
}
const manager = new SessionManagerV3(installation, new FixtureLLMConfig(new ModelRegistry()), new MessageService());
const topicId = 'semantic-app-acceptance';
manager.on('message', ({ type, message }) => {
    if (type === 'assistant' && typeof message?.content === 'string' && message.content !== 'Captured test request.') {
        errors.push(message.content);
    }
});
const open = 'system-open_app', close = 'system-close_app';
const ideName = 'system_ide', planningName = 'planning_app';
const ideInstallation = 'ide_installation', planInstallation = 'planning_installation', browserInstallation = 'browser_installation';
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
function literal(schema: Schema | undefined, type: string): Schema {
    const branch = schema?.type === type ? schema : schema?.anyOf?.find(branch => branch.type === type);
    assert.ok(branch, 'Expected the ' + type + ' business branch');
    return branch;
}
function controls(tools: Record<string, Tool>) {
    return [[open, 'installation_id'], [close, 'app_id']].map(([name, field]) => {
        const parameters = schema(tools, name);
        assert.deepEqual(parameters, { type: 'object', properties: { [field]: { type: 'string' } },
            required: [field], additionalProperties: false });
        return { name, description: tools[name]?.description, parameters };
    });
}
const views = (context: DrivenSourceContext, appId: string) => modelViews(context.messages).filter(view => view.appId === appId);
const view = (context: DrivenSourceContext, appId: string, type: string, id: string) => views(context, appId)
    .find(page => page.type === type && page.id === id)?.markup ?? '';
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
    await installation.initialize({ appEntries: [
        { name: ideInstallation, source: `local:${idePackage}`, enabled: true, autoStart: false },
        { name: planInstallation, source: `local:${planning}`, enabled: true, autoStart: true },
        { name: browserInstallation, source: `local:${browserPackage}`, enabled: true, autoStart: false },
    ] });
    const linkedProject = projectService.createProject(project, 'Synthetic acceptance project');
    db.createTopic({ id: topicId, title: 'Synthetic acceptance', status: 'hot', projectId: linkedProject.id,
        createdAt: Date.now(), updatedAt: Date.now(), contextCompaction: { enabled: false }, sourceControls: {
            apps: { enabled: true, disabledItems: [browserInstallation] },
            mcp: { enabled: false, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
        } });
    const session = await manager.ensureSession(topicId);
    assert.equal(session.sources.aotui.constructor.name, 'SemanticAOTUIDrivenSource');
    const source = session.sources.aotui;
    const installed = (installationId: string) => {
        const app = session.desktop.listApps().find(app => app.installationId === installationId);
        assert.ok(app, `${installationId} is installed`);
        return app;
    };
    const preview = async (installationId: string) => {
        const { applications, diagnostics } = await readDesktopPreview(session.desktop);
        assert.deepEqual(diagnostics, []);
        const app = applications.find(app => app.installationId === installationId);
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
    function checkIdeStatus(messages: readonly { role: string; content: unknown }[], state: 'pending' | 'closed' | 'running') {
        const { appId } = installed(ideInstallation);
        const directory = messages.find(message => message.role === 'user' && String(message.content).startsWith('<desktop>'));
        const status = { pending: 'available (not started)', closed: 'not launched', running: 'running' }[state];
        const instance = state === 'running' ? `    - app_id: ${appId}\n` : '';
        assert.ok(String(directory?.content).includes(`    - installation_id: ${ideInstallation}\n${instance}    - Status: ${status}`));
    }
    async function openIde(current: DrivenSourceContext, adopted = true) {
        const result = await invoke(current, open, { installation_id: ideInstallation }, adopted);
        assert.equal(result.outcomeStatus, 'succeeded', JSON.stringify(result));
        const { appId, appInstanceId } = installed(ideInstallation);
        assert.ok(appId && appInstanceId);
        assert.deepEqual(result.result, { success: true, app_id: appId });
        assert.equal(appId, ideName);
        return appId;
    }
    async function wire(label: string, toolNames: { present: string[]; absent: string[] }) {
        const first = requests.length;
        const marker = 'Synthetic capture ' + label;
        await manager.sendMessage(topicId, marker);
        const request = await waitFor(async () => requests.slice(first).find(item => JSON.stringify(item.messages).includes(marker)),
            value => value !== undefined, label + ' model request');
        assert.ok(request);
        modelViews(request.messages);
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
        assert.equal(installed(ideInstallation).status, state);
        assert.equal(installed(ideInstallation).appId, undefined);
        assert.deepEqual(await preview(ideInstallation), { status: state, views: [] });
        const projected = await context(current => {
            checkControls(current);
            assert.equal(current.tools[workspace], undefined);
            assert.deepEqual(views(current, ideName), []);
            checkIdeStatus(current.messages, state);
            return Object.keys(current.tools);
        });
        const request = await wire(state, { present: [open, close], absent: [workspace] });
        checkIdeStatus(request.messages, state);
        checkWireControls(request);
        assert.ok(request.messages.some(message => message.role === 'user' && message.content === DEFAULT_AOTUI_SYSTEM_INSTRUCTION));
        lifecycle[state] = { projected, preview: await preview(ideInstallation), request };
    }
    await checkInactive('pending');
    const ide = await context(async current => {
        assert.equal((await invoke(current, open, { installation_id: ideInstallation }, false)).error?.code, 'SEMANTIC_CONTEXT_NOT_ADOPTED');
        await current.adopt?.();
        assert.equal((await invoke(current, open, { installation_id: browserInstallation }, false)).error?.code, 'INVALID_APP_TARGET');
        assert.equal((await invoke(current, close, { app_id: ideInstallation }, false)).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(ideInstallation).status, 'pending');
        return openIde(current, false);
    });
    lifecycle.running = await context(current => {
        assert.equal(installed(ideInstallation).status, 'running');
        assert.ok(view(current, ide, 'Workspace', 'workspace'));
        checkControls(current);
        return Object.keys(current.tools);
    }, current => !!current.tools[workspace]);
    const runningRequest = await wire('running', { present: [workspace, open, close], absent: [] });
    checkIdeStatus(runningRequest.messages, 'running');
    assert.ok(modelViews(runningRequest.messages).some(page => page.type === 'Workspace' && page.appId === ide));
    checkWireControls(runningRequest);
    lifecycle.runningRequest = runningRequest;
    await context(async current => {
        const instance = installed(ideInstallation).appInstanceId;
        assert.equal((await invoke(current, open, { installation_id: ideInstallation })).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(ideInstallation).appInstanceId, instance);
        const result = await invoke(current, close, { app_id: ide });
        assert.equal(result.outcomeStatus, 'succeeded');
        assert.deepEqual(result.result, { success: true, app_id: ide });
    });
    await checkInactive('closed');
    await manager.setSourceItemEnabled(topicId, 'apps', ideInstallation, false);
    const disabled = await context(async current => {
        checkControls(current);
        assert.equal(current.tools[workspace], undefined);
        assert.deepEqual(views(current, ideName), []);
        assert.ok(!current.messages.some(message => String(message.content).includes(ideName)));
        assert.equal((await invoke(current, open, { installation_id: ideInstallation })).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(ideInstallation).status, 'closed');
        return Object.keys(current.tools);
    });
    assert.deepEqual(await preview(ideInstallation), { status: 'closed', views: [] });
    assert.deepEqual(await preview(browserInstallation), { status: 'pending', views: [] });
    const disabledRequest = await wire('disabled', { present: [create, open, close], absent: [workspace] });
    checkWireControls(disabledRequest);
    assert.ok(!disabledRequest.messages.some(message => message.content.includes(`installation_id: ${ideInstallation}`)));
    lifecycle.disabled = { projected: disabled, preview: await preview(ideInstallation), request: disabledRequest };
    await manager.setSourceItemEnabled(topicId, 'apps', planInstallation, false);
    const noTargets = await context(async current => {
        checkControls(current);
        assert.deepEqual(Object.keys(current.tools).sort(), ['run_code', close, open]);
        assert.equal((await invoke(current, close, { app_id: installed(planInstallation).appId })).error?.code, 'INVALID_APP_TARGET');
        assert.equal(installed(planInstallation).status, 'running');
        return Object.keys(current.tools);
    });
    const noTargetsRequest = await wire('all apps filtered', { present: [open, close], absent: [create, workspace] });
    checkWireControls(noTargetsRequest);
    lifecycle.noTargets = { projected: noTargets, request: noTargetsRequest };
    await manager.setSourceEnabled(topicId, 'apps', false);
    await context(current => {
        assert.deepEqual(Object.keys(current.tools), ['run_code']);
        assert.equal(modelViews(current.messages).length, 0);
    });
    lifecycle.sourceDisabled = await wire('apps source disabled', { present: ['run_code'], absent: [open, close, create, workspace] });
    await manager.setSourceItemEnabled(topicId, 'apps', planInstallation, true);
    await manager.setSourceEnabled(topicId, 'apps', true);
    const planAppId = installed(planInstallation).appId;
    assert.equal(planAppId, planningName);
    const planDetail = (current: DrivenSourceContext) => view(current, planAppId, 'PlanDetail', 'plan_detail');
    const planAddress = (current: DrivenSourceContext, name: string) => {
        const detail = views(current, planAppId).find(page => page.type === 'PlanDetail');
        assert.ok(detail);
        return `$ref.${detail.appId}.${detail.id}.${name}`;
    };
    const planningFacts: Record<string, unknown> = cases.planning = {};
    const unchanged = await waitFor(async () => database().catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    }), value => value !== undefined, 'initial synthetic planning database');
    await context(async current => {
        assert.match(view(current, planAppId, 'PlanList', 'plan_list'), /No unfinished plans/);
        const createSchema = schema(current.tools, create);
        assert.ok(!createSchema.required?.includes('view_id'));
        const phases = createSchema.properties?.phases;
        const phase = literal(literal(phases, 'array').items, 'object');
        assert.match(literal(phases, 'string').description ?? '', /\$ref\.app_id\.view_id\.ref_id/);
        planningFacts.createSchema = phases;
        assert.deepEqual(phase.required, ['title']);
        assert.equal(phase.properties?.description?.type, 'string');
        const tasks = phase.properties?.tasks;
        assert.equal(tasks?.type, 'array');
        assert.deepEqual(tasks.items?.required, ['title']);
        assert.equal(tasks.items?.properties?.description?.type, 'string');
        assert.equal(phase.additionalProperties, false);
        assert.equal(phase.properties?.todos, undefined);
        assert.deepEqual(disabledRequest.definitions?.find(tool => tool.function.name === create)?.function.parameters.properties?.phases,
            JSON.parse(JSON.stringify(phases)));
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
        const detail = planDetail(current);
        assert.ok(detail.includes('[Plan tasks](private plan_detail_current: Plan)'));
        assert.ok(detail.includes('[Design tasks](private current_phase: Phase)'));
        assert.ok(detail.includes('[Accepted tasks](pending_tasks[0])'));
        return detail;
    }, current => planDetail(current).includes('Plan tasks'));
    const beforeAdd = await database();
    await context(async current => {
        const tasks = schema(current.tools, addPhase).properties?.tasks;
        const item = literal(literal(tasks, 'array').items, 'object');
        planningFacts.addPhaseSchema = tasks;
        assert.deepEqual(item.required, ['title']);
        assert.equal(item.properties?.description?.type, 'string');
        const plan = planAddress(current, 'plan_detail_current');
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
        const reply = await invoke(current, planAppId + '-PlanDetail-complete_phase', { phase: planAddress(current, 'current_phase') });
        assert.equal(reply.outcomeStatus, 'succeeded');
    }, current => planDetail(current).includes('Added phase'));
    await context(async current => {
        assert.match(planDetail(current), /\[Added task\]\(pending_tasks\[0\]\)/);
        const reply = await invoke(current, planAppId + '-PlanDetail-complete_task', { task: planAddress(current, 'pending_tasks[0]') });
        assert.equal(reply.outcomeStatus, 'succeeded');
    }, current => planDetail(current).includes('[Added phase](private current_phase: Phase)'));
    planningFacts.refCalls = ['Plan', 'Phase', 'Task'];
    planningFacts.final = await context(planDetail, current => planDetail(current).includes('[Added task](completed_tasks[0])'));

    await manager.setSourceItemEnabled(topicId, 'apps', ideInstallation, true);
    const reopenedIde = await context(openIde);
    await context(async current => {
        assert.ok(!schema(current.tools, workspace).required?.includes('view_id'));
        assert.equal((await invoke(current, workspace, { filePaths: [file] })).outcomeStatus, 'succeeded');
    }, current => !!current.tools[workspace]);
    const hoverFacts: Record<string, unknown> = cases.hover = { source: greet, column17: greet[16] };
    assert.equal(greet[16], 'g');
    for (const [label, line, character] of [['symbol', 1, 17], ['empty', 2, 1]] as const) {
        const { id, reply } = await context(async current => {
            const target = views(current, reopenedIde).find(page => page.type === 'FileDetail' && page.markup.includes(file));
            assert.ok(target);
            assert.equal(schema(current.tools, hover).properties?.view_id?.type, 'string');
            assert.ok(schema(current.tools, hover).required?.includes('view_id'));
            return { id: target.id, reply: await invoke(current, hover, { view_id: target.id, line, character }) };
        }, current => !!current.tools[hover]);
        assert.equal(reply.outcomeStatus, 'succeeded', JSON.stringify(reply));
        const receipt = reply.result as { message: string; view_id: string };
        assert.equal(receipt.view_id, id);
        assert.deepEqual(Object.keys(receipt).sort(), ['message', 'view_id']);
        const detail = await context(current => view(current, reopenedIde, 'FileDetail', receipt.view_id), current => {
            const panel = view(current, reopenedIde, 'FileDetail', receipt.view_id).split('### hover\n')[1] ?? '';
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
    const beginClose = session.desktop.beginClose.bind(session.desktop);
    const closeHandles: Array<ReturnType<typeof beginClose>> = [];
    session.desktop.beginClose = (...args) => {
        const handle = beginClose(...args);
        closeHandles.push(handle);
        return handle;
    };
    await manager.shutdownSession(topicId);
    assert.equal(closeHandles.length, 1);
    assert.throws(() => runtime.getDesktop(shutdownDesktop));
    const closeReport = await closeHandles[0]!.completion;
    cases.sessionClose = closeReport;
    assert.equal(closeReport.desktopId, shutdownDesktop);
    assert.equal(closeReport.scope, 'desktop');
    assert.equal(closeReport.state, 'settled');
    assert.equal(closeReport.ok, true);
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
    const shutdown = await runtime.beginClose().completion;
    facts.shutdown = shutdown;
    await manager.shutdownSession(topicId);
    await desktopManager.getKernel().beginClose().completion;
    db.closeDatabase();
    if (reportPath) await writeFile(resolve(reportPath), JSON.stringify(facts, null, 2) + '\n');
    globalThis.fetch = previousFetch;
    await rm(fixture, { recursive: true, force: true });
    assert.equal(shutdown.resourcesReleased, true);
    assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
}
