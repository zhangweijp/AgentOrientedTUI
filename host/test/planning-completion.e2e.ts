import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { createRuntime } from '@aotui/runtime';
import { AppCatalog } from '../src/app-distribution/app-catalog.js';
import { llmConfig } from '../../tests/fixtures/batch-ten-delivery.mjs';
import { fixtureProvider, modelCall, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';

const [builtApp, evidence] = process.argv.slice(2);
assert.ok(builtApp && evidence, 'Supply the built Planning directory and a result JSON path.');
const state = await mkdtemp(join(tmpdir(), 'aotui-planning-completion-'));
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const [{ DesktopManager }, { Config }, { HostManagerV2 }, chat] = await Promise.all([
    import('../src/core/desktop-manager.js'), import('../src/config/config.js'),
    import('../src/core/host-manager-v2.js'), import('../src/db/index.js'),
]);

const topic = 'planning-completion', installation = 'planning-fixture';
const runtime = createRuntime(), provider = await fixtureProvider();
const catalog = new AppCatalog({ configPath: join(state, 'apps.json') });
const manager = new DesktopManager({ kernel: runtime, appCatalog: catalog });
mock.method(Config, 'get', async () => ({ agents: { list: [{ id: topic, prompt: 'Use Planning.', enabledApps: [installation] }] } }));
const host = new HostManagerV2(topic, {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => ({ ...llmConfig(provider.url),
    model: 'deepseek-chat', provider: { id: 'deepseek', baseURL: provider.url } }));

const app = join(state, 'app'), sqliteFile = join(app, 'data', 'planning.sqlite');
function readDisk() {
    const database = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
        const rows = database.prepare(`SELECT phases.title AS phase, phases.status AS phaseStatus, phases.completed_at AS phaseAt,
                                              todos.title AS task, todos.status AS taskStatus, todos.completed_at AS taskAt
            FROM plans JOIN phases ON phases.plan_id = plans.id JOIN todos ON todos.phase_id = phases.id
            WHERE plans.desktop_id = ? ORDER BY phases.position, todos.position`).all(topic);
        const { ino, mtimeNs, size } = statSync(sqliteFile, { bigint: true });
        return { rows, file: { inode: String(ino), mtimeNs: String(mtimeNs), bytes: Number(size) } };
    } finally { database.close(); }
}

const first = 'Preparation', second = 'Verification', taskOne = 'Read workspace', taskTwo = 'Check terminal';
const late = 'Confirm late requirement';
const address = (id: string) => '$ref.planning_app.plan_detail.' + id;
const call = (id: string, name: string, input: object) => modelCall(id, 'planning_app-' + name, input);
const steps = [
    ['create', call('create-plan', 'create_plan', { title: 'Planning completion check', phases: [
        { title: first, tasks: [{ title: taskOne }, { title: taskTwo }] },
        { title: second, tasks: [{ title: 'Review plan' }, { title: 'Review status' }] },
    ] })],
    ['after-create', call('complete-task', 'complete_task', { task: address('pending_tasks[0]') })],
    ['after-task', call('complete-current', 'complete_phase', { phase: address('current_phase') })],
    ['after-current', call('add-late-task', 'add_task', { phase: address('completed_phases[0]'), title: late })],
    ['after-add', call('complete-late', 'complete_phase', { phase: address('completed_phases[0]') })],
    ['after-late', call('complete-again', 'complete_phase', { phase: address('completed_phases[0]') })],
    ['after-repeat', undefined],
] as const;
const disk: Record<string, ReturnType<typeof readDisk>> = {};
const facts: Record<string, unknown> = { requests: provider.requests, disk, passed: false };
function queue(index: number) {
    const step = steps[index];
    if (!step) return;
    const [label, tool] = step;
    provider.replyNext({ label, ...(tool ? { calls: [tool] } : { text: 'Planning checked.' }), beforeReply: () => {
        if (index > 0) disk[label] = readDisk();
        queue(index + 1);
    } });
}

function requestAt(label: string) {
    const request = provider.requests.find(item => item.label === label)?.body;
    assert.ok(request, label);
    return request;
}
function page(label: string, id: string) {
    const messages = requestAt(label).messages as { role: string; content?: string }[];
    const pages = messages.filter(message => message.role === 'user' && message.content?.startsWith(`<view view_id="${id}" `));
    assert.equal(pages.length, 1, `${label} should contain one ${id} page`);
    return pages[0]!.content!;
}
function receipt(label: string, id: string) {
    const messages = requestAt(label).messages as { role: string; tool_call_id?: string; content?: string }[];
    const results = messages.filter(message => message.role === 'tool' && message.tool_call_id === id);
    assert.equal(results.length, 1, `${label} should contain one receipt for ${id}`);
    return JSON.parse(results[0]!.content!);
}
const currentPhase = (label: string) => page(label, 'plan_detail').split('### Current Phase')[1]!.split('### Upcoming Phases')[0]!;

try {
    await mkdir(app);
    for (const file of ['dist', 'package.json', 'aoapp.json'])
        await cp(join(resolve(builtApp), file), join(app, file), { recursive: true });
    await symlink(join(resolve(builtApp), 'node_modules'), join(app, 'node_modules'), 'junction');
    await chat.initDatabase();
    await manager.initialize({ appEntries: [{ name: installation, source: 'local:' + app, enabled: true, autoStart: true }] });
    await host.initAgentDriver(manager);
    const now = Date.now();
    chat.createTopic({ id: topic, agentId: topic, title: topic, createdAt: now, updatedAt: now, status: 'hot' });
    await host.ensureSessionForTopic(topic);
    const session = host.getSessionManager()!.getSession(topic)!;
    assert.equal(session.desktop.listApps().find(item => item.installationId === installation)?.status, 'running');
    queue(0);
    await host.sendUserMessage('Check completion on the two-phase test plan.', topic);
    await watchUntil(() => provider.requests.some(item => item.label === 'after-repeat'), 15_000);
    await watchUntil(() => session.agentDriver.getState() === 'idle');
    assert.deepEqual(provider.failures, []);
    assert.deepEqual(provider.requests.map(item => item.label), steps.map(([label]) => label));

    assert.match(page('after-task', 'plan_list'), /0\/2/);
    assert.match(currentPhase('after-task'), /\[Preparation\]\(private current_phase: Phase\)/);
    assert.match(currentPhase('after-task'), /\[Check terminal\]\(pending_tasks\[0\]\)/);
    assert.match(currentPhase('after-task'), /\[Read workspace\]\(completed_tasks\[0\]\)/);
    assert.deepEqual(disk['after-task']!.rows.map(row => row.taskStatus), ['completed', 'pending', 'pending', 'pending']);
    assert.deepEqual(receipt('after-task', 'complete-task'), { message: `Task "${taskOne}" completed.` });

    assert.match(requestAt('after-task').tools.find((tool: { function: { name: string } }) =>
        tool.function.name === 'planning_app-complete_phase')?.function.description, /all its remaining pending Tasks/);
    assert.match(page('after-current', 'plan_list'), /1\/2/);
    assert.match(currentPhase('after-current'), /\[Verification\]\(private current_phase: Phase\)/);
    assert.match(currentPhase('after-current'), /\[Review plan\]\(pending_tasks\[0\]\)/);
    assert.match(currentPhase('after-current'), /\[Review status\]\(pending_tasks\[1\]\)/);
    const completed = disk['after-current']!.rows;
    assert.deepEqual(completed.map(row => [row.phase, row.phaseStatus, row.taskStatus]), [
        [first, 'completed', 'completed'], [first, 'completed', 'completed'],
        [second, 'pending', 'pending'], [second, 'pending', 'pending'],
    ]);
    assert.deepEqual(receipt('after-current', 'complete-current'), {
        message: `Phase "${first}" completed. Completed 1 remaining task.`, tasksCompleted: 1,
    });

    assert.match(page('after-add', 'plan_detail'), /\[Preparation\]\(completed_phases\[0\]\)/);
    const added = disk['after-add']!.rows.find(row => row.task === late);
    const repaired = disk['after-late']!.rows.find(row => row.task === late);
    assert.equal(added?.taskStatus, 'pending');
    assert.equal(repaired?.taskStatus, 'completed');
    assert.ok(repaired?.taskAt);
    assert.ok(completed[0]!.phaseAt);
    assert.equal(repaired?.phaseAt, completed[0]!.phaseAt);
    assert.deepEqual(disk['after-late']!.rows.filter(row => row.task !== late), completed);
    assert.deepEqual(receipt('after-late', 'complete-late'), {
        message: `Phase "${first}" was already complete. Completed 1 remaining task.`, tasksCompleted: 1,
    });
    assert.deepEqual(receipt('after-repeat', 'complete-again'), {
        message: `Phase "${first}" was already complete. No changes were made.`, tasksCompleted: 0,
    });
    assert.deepEqual(disk['after-repeat'], disk['after-late'], 'The no-op leaves the SQLite file and rows untouched.');
    facts.passed = true;
} finally {
    await host.dispose();
    const closed = await runtime.beginClose().completion;
    facts.closed = closed;
    facts.passed = facts.passed && closed.ok && closed.resourcesReleased;
    facts.providerFailures = provider.failures;
    await provider.close();
    chat.closeDatabase();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
    assert.equal(closed.resourcesReleased, true);
}
