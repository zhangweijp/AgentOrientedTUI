import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createDesktopId, createRuntime, type IDesktop } from '@aotui/runtime';
import { AppCatalog } from '../src/app-distribution/app-catalog.js';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import type { AgentDriverV2, LLMConfig } from '@aotui/agent-driver-v2';
import type { GuiUpdateEvent } from '../src/types/session.js';
import type { IMSession } from '../src/im/types.js';
import { appClient, fixtureProvider, journal, observe, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { APP, INPUT, OUTPUT, onFile, setupFiles } from '../../tests/fixtures/batch-four-support.mjs';

const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer, 'Pass the clean batch-seven consumer');
const project = await mkdtemp(join(tmpdir(), 'aotui-b7-product-'));
const sqliteFile = join(project, 'chat.sqlite');
process.env.DB_PATH = sqliteFile;
process.env.AOTUI_DATA_DIR = join(project, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const { getIMSession } = await import('../src/im/session-store.js');
const { appRouter } = await import('../src/trpc/router.js');

const runtime = createRuntime();
const provider = await fixtureProvider();
const registry = new AppCatalog({ configPath: join(project, 'fixture-apps.json') });
const desktops = new DesktopManager({ kernel: runtime, appCatalog: registry });
const llm: LLMConfig = { provider: { id: 'batch-seven', baseURL: provider.url }, model: 'owner-fixture', apiKey: 'local-fixture',
    inputBudget: () => ({ contextWindow: INPUT + OUTPUT, maxOutputTokens: OUTPUT }) };
let currentLLM = llm;
const config = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'owner', prompt: 'Use the current file view.', enabledApps: ['files_install'] }] },
}));
const host = new HostManagerV2('owner-topic', {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => currentLLM);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (value: LLMConfig) => value);
const im = () => host['imSessionManager']!;
const saved: GuiUpdateEvent[] = [];
const unsubscribe = host.onGuiUpdate((event: GuiUpdateEvent) => {
    if (event.type !== 'tool') return;
    saved.push(event);
    const imSession = im()?.getSession(event.topicId);
    if (imSession) (imSession.agentDriver as AgentDriverV2).pause();
    else host.pauseAgent(event.topicId);
});
function gate() { return Promise.withResolvers<void>(); }
const releases: Array<() => void> = [];
const pendingOpenings: Promise<unknown>[] = [];
const folders = new Map<IDesktop, string>();
function interceptLogCleanup(desktop: IDesktop, action: () => void | Promise<void>) {
    const logger = (desktop as unknown as { logger: { cleanup(id: string): void } }).logger;
    const cleanup = logger.cleanup.bind(logger);
    mock.method(logger, 'cleanup', async id => { await action(); cleanup(id); }, { times: 1 });
}

type HeldInstall = { entered: ReturnType<typeof Promise.withResolvers<IDesktop>>; resume: ReturnType<typeof gate>; failure?: Error };
const heldInstalls = new Map<string, HeldInstall>();
const installAll = registry.installAll.bind(registry);
mock.method(registry, 'installAll', async (desktop: IDesktop, options?: Parameters<typeof installAll>[1]) => {
    const hold = heldInstalls.get(desktop.id);
    heldInstalls.delete(desktop.id);
    const folder = join(project, 'files-' + folders.size);
    folders.set(desktop, folder);
    await setupFiles(folder);
    const result = await installAll(desktop, { ...options, dynamicConfig: { ...options?.dynamicConfig, folder } });
    assert.ok(result.length === 1 && result[0]?.status !== 'failed', JSON.stringify(result));
    if (hold) {
        hold.entered.resolve(desktop);
        await hold.resume.promise;
        if (hold.failure) throw hold.failure;
    }
    return result;
});
const facts: any = { requests: provider.requests, assembly: [], passed: false };

async function invoke(desktop: IDesktop, name: string, input: object, invocationId: string, viewId?: string) {
    const { client } = appClient(desktop, APP);
    const observation = await observe(client, true);
    try {
        const tool = observation.tools.find(tool => tool.name === name);
        assert.ok(tool);
        const result = await client.invoke({ invocationId, observationId: observation.observationId, toolId: tool.id, input, ...(viewId ? { viewId } : {}) });
        assert.equal(result.kind, 'receipt');
        assert.equal(result.receipt.outcome.status, 'succeeded');
        return result.receipt;
    } finally { client.release(observation.observationId); }
}
async function verifyWrite(desktop: IDesktop) {
    const folder = folders.get(desktop)!;
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'B-EDITED');
    const writes = await journal(folder, 'writes');
    assert.deepEqual(writes.map(item => item.name), ['B']);
    return writes;
}
function topic(id: string) {
    const time = Date.now();
    db.createTopic({ id, agentId: 'owner', title: id, status: 'hot', createdAt: time, updatedAt: time,
        sourceControls: { apps: { enabled: true, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] } } });
}
async function shutdownThroughRpc(id: string) {
    const response = await fetchRequestHandler({
        endpoint: '/trpc', router: appRouter,
        req: new Request('http://localhost/trpc/session.shutdown', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: { id } }),
        }),
        createContext: () => ({ hostManager: host } as Parameters<typeof appRouter.createCaller>[0]),
    });
    const payload = await response.json();
    return { status: response.status, error: payload.error?.json?.data?.desktopClose };
}
const imMessage = (sessionKey: string, body: string, triggerAgent = false) => ({
    sessionKey, agentId: 'owner', channel: 'local', chatType: 'direct' as const, peerId: sessionKey.split(':').at(-1)!,
    body, messageId: body, senderId: 'fixture', chatId: 'fixture', timestamp: Date.now(), triggerAgent,
});
async function onModelEdit(sessionId: string, desktop: IDesktop, send: (label: string) => Promise<void>) {
    await invoke(desktop, 'open_file', { names: ['B'] }, 'open-for-model');
    const label = 'edit ' + sessionId, callId = 'edit-once';
    provider.replyNext({ label, calls: [onFile(callId, 'edit', 'B', { mode: 'short' })] });
    await send(label);
    const result = await watchUntil(() => saved.find(event => event.topicId === sessionId));
    const request = provider.requests.find(request => request.label === label);
    assert.ok(request);
    assert.equal(result.message?.role, 'tool');
    assert.match(JSON.stringify(result.message.content), /"toolCallId":"edit-once".*"saved":true/);
    const history = sessionId.startsWith('agent:') ? host.getIMMessages(sessionId) : host.getMessages(sessionId);
    assert.ok(history.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(callId)));
    assert.ok(history.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(callId)));
    return { result, writes: await verifyWrite(desktop) };
}

async function verifyTopicStartupRollback(fault: 'model' | 'agent_state' | 'snapshot') {
    const key = 'startup-' + fault;
    topic(key);
    const sessions = host.getSessionManager()!;
    const hold: HeldInstall = { entered: Promise.withResolvers<IDesktop>(), resume: gate() };
    heldInstalls.set(key, hold);
    releases.push(hold.resume.resolve);
    const failure = new Error('startup observer failed');
    const notifications: Array<{ type: string; visible: boolean }> = [];
    const disposeSource = mock.method(SemanticAOTUIDrivenSource.prototype, 'dispose');
    const unsubscribe = host.onGuiUpdate((event: GuiUpdateEvent) => {
        if (event.topicId !== key) return;
        notifications.push({ type: event.type, visible: !!sessions.getSession(key) });
        if (event.type === fault) throw failure;
    });
    if (fault === 'model') currentLLM = { ...llm, model: ' ' };
    const opening = host.ensureSessionForTopic(key).then(() => null, error => error);
    pendingOpenings.push(opening);
    const original = await hold.entered.promise;
    const client = appClient(original, APP).client;
    if (fault === 'snapshot') {
        interceptLogCleanup(original, () => { throw Error('startup logger cleanup failed'); });
    }
    hold.resume.resolve();
    const error = await opening;
    currentLLM = llm;
    unsubscribe();
    disposeSource.mock.restore();
    assert.equal(disposeSource.mock.calls.length, 1);
    assert.ok(error instanceof Error);
    if (fault === 'model') assert.match(error.message, /A nonempty model ID is required/);
    if (fault === 'agent_state') assert.equal(error, failure);
    let closeReport;
    if (fault === 'snapshot') {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure);
        assert.equal(error.errors[0], failure);
        assert.equal(error.errors[1].code, 'DESKTOP_CLOSE_FAILED');
        closeReport = error.errors[1].report;
        assert.equal(closeReport.resourcesReleased, false);
        assert.equal((await original.beginClose().completion).resourcesReleased, true);
    }
    assert.ok(notifications.every(event => event.visible));
    assert.deepEqual(notifications.map(event => event.type),
        fault === 'model' ? [] : fault === 'agent_state' ? ['agent_state'] : ['agent_state', 'snapshot']);
    assert.equal(sessions.getSession(key), undefined);
    assert.throws(() => runtime.getDesktop(createDesktopId(key)), { code: 'DESKTOP_NOT_FOUND' });
    assert.equal((await client.preview()).status, 'rejected');
    const lifecycle = await journal(folders.get(original), 'lifecycle');
    assert.deepEqual(lifecycle.map((event: { event: string }) => event.event), ['start', 'stop']);
    await host.shutdownSession(key);

    await host.ensureSessionForTopic(key);
    const successor = sessions.getSession(key)!.desktop;
    assert.notEqual(successor, original);
    const operation = await onModelEdit(key, successor, label => host.sendUserMessage(label, key));
    await host.shutdownSession(key);
    return { fault, error: error.message, closeReport, notifications, lifecycle, sourceDisposals: disposeSource.mock.calls.length, ...operation };
}

async function verifyIMSaveRollback(phase: 'first' | 'reuse') {
    const key = `agent:owner:local:direct:startup-save-${phase}`;
    if (phase === 'reuse') await im().ensureSession(key, 'owner');
    const entered = Promise.withResolvers<IMSession>(), resume = gate();
    releases.push(resume.resolve);
    const actions: string[] = [];
    const options = im()['options'];
    const persist = options.persistSession!, remove = options.deletePersistedSession!;
    const save = mock.method(options, 'persistSession', async (session: IMSession) => {
        await persist(session);
        if (session.sessionKey !== key) return;
        actions.push('save');
        if (actions.length === 1) { entered.resolve(session);await resume.promise; }
    });
    const deleteRow = mock.method(options, 'deletePersistedSession', async (sessionKey: string) => {
        await remove(sessionKey);
        if (sessionKey === key) actions.push('delete');
    });
    const ensure = () => im().ensureSession(key, 'owner');
    const opening = ensure().then(() => null, error => error);
    pendingOpenings.push(opening);
    const original = await entered.promise;
    const visibleDuringSave = im().getSession(key);
    assert.equal(visibleDuringSave, phase === 'first' ? undefined : original);
    const oldRow = getIMSession(key);
    assert.equal(oldRow?.createdAt, original.createdAt);
    const joining = phase === 'first' ? ensure().then(() => null, error => error) : undefined;
    if (joining) pendingOpenings.push(joining);
    const oldClient = appClient(original.desktop, APP).client;
    const released = await original.desktop.beginClose().completion;
    assert.equal(released.resourcesReleased, true);
    assert.equal(im().getSession(key), undefined);
    const intervening = await desktops.createDesktop(createDesktopId(key));
    resume.resolve();
    const [error, joinedError] = await Promise.all([opening, joining]);
    assert.equal(error?.code, 'DESKTOP_DISPOSED');
    if (joining) assert.equal(joinedError, error);
    assert.equal(getIMSession(key), null);
    assert.deepEqual(actions, ['save', 'delete']);
    await assert.rejects(ensure(), { code: 'DESKTOP_ALREADY_EXISTS' });
    assert.equal(im().getSession(key), undefined);
    assert.equal((await oldClient.preview()).status, 'rejected');
    assert.equal(runtime.getDesktop(createDesktopId(key)), intervening);
    const lifecycle = await journal(folders.get(original.desktop), 'lifecycle');
    assert.deepEqual(lifecycle.map((event: { event: string }) => event.event), ['start', 'stop']);
    const interveningReceipt = await invoke(intervening, 'open_file', { names: ['B'] }, 'open-intervening');
    assert.equal((await intervening.beginClose().completion).resourcesReleased, true);

    const current = await ensure();
    assert.notEqual(current.desktop, original.desktop);
    assert.notEqual(current.desktop, intervening);
    assert.deepEqual(actions, ['save', 'delete', 'save']);
    const currentRow = getIMSession(key);
    assert.equal(currentRow?.createdAt, current.createdAt);
    const operation = await onModelEdit(key, current.desktop, label => host.sendIMMessage(imMessage(key, label, true)));
    save.mock.restore();
    deleteRow.mock.restore();
    await im().destroySession(key);
    return { phase, visibleWhileSaving: !!visibleDuringSave, oldRow, currentRow, actions: actions.slice(), release: released,
        error: error.code, lifecycle, interveningReceipt, ...operation };
}

try {
    const directory = join(project, 'file-app');
    await mkdir(directory);
    const moduleURL = pathToFileURL(resolve(consumer, 'dist/batch-four-files.js')).href;
    await writeFile(join(directory, 'entry.mjs'), 'export { default } from ' + JSON.stringify(moduleURL) + ';\n');
    await writeFile(join(directory, 'aoapp.json'), JSON.stringify({
        app_name: APP, version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v8',
        appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './entry.mjs' },
    }));
    await desktops.initialize({ appEntries: [{ name: 'files_install', source: 'local:' + directory, enabled: true, autoStart: true }] });
    for (const mode of ['failure', 'late-success', 'double-failure'] as const) {
        const key = createDesktopId('install-' + mode);
        const failure = mode === 'late-success' ? undefined : new Error('isolated-install-failure');
        const hold: HeldInstall = { entered: Promise.withResolvers<IDesktop>(), resume: gate(), failure };
        heldInstalls.set(key, hold);releases.push(hold.resume.resolve);
        const opening = desktops.createDesktop(key).then(info => ({ info }), error => ({ error }));
        const original = await hold.entered.promise;
        if (mode === 'double-failure') interceptLogCleanup(original, () => { throw Error('fixture logger cleanup failure'); });
        const initial = await original.beginClose().completion;
        if (mode === 'double-failure') assert.equal(initial.resourcesReleased, false);
        const closed = await original.beginClose().completion;
        assert.equal(closed.resourcesReleased, true);
        const successor = await desktops.createDesktop(key);
        const opened = await invoke(successor, 'open_file', { names: ['B'] }, 'open-successor');
        const current = appClient(successor, APP).client;
        assert.match(JSON.stringify((await current.preview()).views), /B-INITIAL/);
        hold.resume.resolve();
        const rejected = await opening;
        assert.ok('error' in rejected);
        if (mode === 'late-success') assert.equal(rejected.error.code, 'DESKTOP_DISPOSED');
        if (mode === 'failure') assert.equal(rejected.error, failure);
        if (mode === 'double-failure') {
            assert.ok(rejected.error instanceof AggregateError);
            assert.equal(rejected.error.cause, failure);
            assert.equal(rejected.error.errors[0], failure);
            assert.equal(rejected.error.errors[1].code, 'DESKTOP_CLOSE_FAILED');
            assert.equal(rejected.error.errors[1].report, closed);
        }
        assert.equal(runtime.getDesktop(key), successor);
        const edited = await invoke(successor, 'edit', { mode: 'short' }, 'write-successor-once', 'file_B_1');
        facts.assembly.push({ mode, closed, opened, edited, originalWorker: await journal(folders.get(original), 'lifecycle'),
            error: { message: rejected.error.message, code: rejected.error.code }, writes: await verifyWrite(successor) });
        assert.equal((await successor.beginClose().completion).ok, true);
    }

    await db.initDatabase();
    await host.initAgentDriver(desktops);
    const sessions = host.getSessionManager()!;
    const unrelated = await desktops.createDesktop(createDesktopId('startup-unrelated'));
    await invoke(unrelated, 'open_file', { names: ['B'] }, 'open-unrelated');
    facts.startupRollback = { topic: [], im: [] };
    for (const fault of ['model', 'agent_state', 'snapshot'] as const) {
        facts.startupRollback.topic.push(await verifyTopicStartupRollback(fault));
    }
    for (const phase of ['first', 'reuse'] as const) {
        facts.startupRollback.im.push(await verifyIMSaveRollback(phase));
    }
    const unrelatedReceipt = await invoke(unrelated, 'edit', { mode: 'short' }, 'edit-unrelated', 'file_B_1');
    facts.startupRollback.unrelated = { receipt: unrelatedReceipt, writes: await verifyWrite(unrelated) };
    assert.equal((await unrelated.beginClose().completion).ok, true);
    facts.startupClose = [];
    for (const kind of ['topic', 'im'] as const) {
        const key = kind === 'topic' ? 'closing-during-startup' : 'agent:owner:local:direct:closing-during-startup';
        if (kind === 'topic') topic(key);
        const hold: HeldInstall = { entered: Promise.withResolvers<IDesktop>(), resume: gate() };
        heldInstalls.set(key, hold);releases.push(hold.resume.resolve);
        const open = kind === 'topic'
            ? async () => { await host.ensureSessionForTopic(key);return sessions.getSession(key)?.desktop; }
            : async () => (await im().ensureSession(key, 'owner')).desktop;
        const first = open();
        const original = await hold.entered.promise;
        const ending = kind === 'topic' ? host.shutdownSession(key) : im().destroySession(key);
        const duplicate = kind === 'topic' ? sessions.destroySession(key) : im().destroySession(key);
        if (kind === 'im') assert.equal(ending, duplicate);
        const reopening = open();
        hold.resume.resolve();
        const [, successor] = await Promise.all([first, reopening, ending, duplicate]);
        assert.ok(successor && successor !== original && !successor.isClosing, `${kind} returned the original closing Desktop`);
        assert.equal(runtime.getDesktop(createDesktopId(key)), successor);
        if (kind === 'im') assert.equal(getIMSession(key)?.createdAt, im().getSession(key)?.createdAt);
        const receipt = await invoke(successor, 'open_file', { names: ['C'] }, 'open-during-replacement');
        const lifecycle = await journal(folders.get(original), 'lifecycle');
        assert.deepEqual(lifecycle.map((event: { event: string }) => event.event), ['start', 'stop']);
        facts.startupClose.push({ kind, receipt, lifecycle });
        await (kind === 'topic' ? host.shutdownSession(key) : im().destroySession(key));
    }
    const key = 'owner-topic', another = 'other-topic';
    topic(key);topic(another);
    await host.ensureSessionForTopic(key);
    const old = sessions.getSession(key)!;
    const receiptsCleared = mock.method(old.appReceipts, 'clear');
    const sourceDisposed = mock.method(old.sources.aotui, 'dispose');
    const entered = gate(), release = gate();releases.push(release.resolve);
    let callbacks = 0;
    interceptLogCleanup(old.desktop, async () => { callbacks++; entered.resolve(); await release.promise; });
    const originalHandle = old.desktop.beginClose();
    await entered.promise;
    const ending = sessions.destroySession(key);
    assert.equal(sessions.destroySession(key), ending);
    const timed = host.shutdownSession(key).then(() => null, error => error);
    const timedRpc = shutdownThroughRpc(key);
    let ready = false;
    const opening = host.ensureSessionForTopic(key).then(() => { ready = true;return sessions.getSession(key)!; });
    pendingOpenings.push(opening);
    await host.ensureSessionForTopic(another);
    host.pauseAgent(another);
    const unaffected = sessions.getSession(another)!.desktop;
    const otherReceipt = await invoke(unaffected, 'open_file', { names: ['C'] }, 'other-topic-still-running');
    provider.replyNext({ label: 'other topic during close', text: 'The other topic is still working.' });
    await host.sendUserMessage('Check the other topic during close', another);
    host.resumeAgent(another);
    const otherReply = await watchUntil(() => host.getMessages(another).find(message =>
        message.role === 'assistant' && message.content === 'The other topic is still working.'));
    const timeout = await timed;
    assert.equal(timeout?.code, 'CLOSE_DEADLINE_EXCEEDED');
    assert.equal(timeout.report.resourcesReleased, false);
    const rpcDeadline = await timedRpc;
    assert.equal(rpcDeadline.error?.code, timeout.code);
    assert.deepEqual(rpcDeadline.error.report, timeout.report);
    assert.equal(ready, false);
    assert.equal(runtime.getDesktop(createDesktopId(key)), old.desktop);
    release.resolve();
    await ending;
    const next = await opening;
    assert.notEqual(next.desktop, old.desktop);
    assert.equal(callbacks, 1);
    assert.equal(receiptsCleared.mock.calls.length, 1);
    assert.equal(sourceDisposed.mock.calls.length, 1);
    const topicContent = await onModelEdit(key, next.desktop, label => host.sendUserMessage(label, key));
    facts.topic = { timeout: timeout.report, rpcDeadline, originalReport: await originalHandle.completion, callbacks,
        receiptsCleared: receiptsCleared.mock.calls.length, sourceDisposed: sourceDisposed.mock.calls.length, otherReceipt, otherReply, ...topicContent };

    const imKey = 'agent:owner:local:direct:original', imOther = 'agent:owner:local:direct:other';
    await host.sendIMMessage(imMessage(imKey, 'first IM message'));
    const previousIM = im().getSession(imKey)!;
    const oldRow = getIMSession(imKey)!;
    assert.equal((await previousIM.desktop.beginClose().completion).resourcesReleased, true);
    const stopEntered = gate(), stopRelease = gate();releases.push(stopRelease.resolve);
    const stop = previousIM.agentDriver.stop!.bind(previousIM.agentDriver);
    const stopMock = mock.method(previousIM.agentDriver, 'stop', async () => { stop();stopEntered.resolve();await stopRelease.promise; });
    const endIM = im().destroySession(imKey);
    assert.equal(im().destroySession(imKey), endIM);
    await stopEntered.promise;
    let imReady = false;
    const reopeningIM = im().ensureSession(imKey, 'owner').then(session => { imReady = true;return session; });
    pendingOpenings.push(reopeningIM);
    await host.sendIMMessage(imMessage(imOther, 'other IM during close'));
    assert.ok(getIMSession(imOther));
    assert.deepEqual(getIMSession(imKey), oldRow);
    assert.equal(imReady, false);
    assert.throws(() => runtime.getDesktop(createDesktopId(imKey)), { code: 'DESKTOP_NOT_FOUND' });
    stopRelease.resolve();
    await endIM;
    const successorIM = await reopeningIM;
    assert.equal(stopMock.mock.calls.length, 1);
    assert.equal(im().getSession(imKey), successorIM);
    assert.notEqual(successorIM.desktop, previousIM.desktop);
    const imContent = await onModelEdit(imKey, successorIM.desktop, label => host.sendIMMessage(imMessage(imKey, label, true)));
    const newRow = getIMSession(imKey)!;
    assert.equal(newRow.createdAt, successorIM.createdAt);
    assert.notEqual(newRow.createdAt, oldRow.createdAt);
    const sqlite = (await readFile(sqliteFile)).subarray(0, 15).toString();
    assert.equal(sqlite, 'SQLite format 3');
    facts.im = { oldRow, newRow, sqlite, stops: stopMock.mock.calls.length, otherRow: getIMSession(imOther), ...imContent };

    const explicitFailure = 'explicit-close-failure';topic(explicitFailure);
    await host.ensureSessionForTopic(explicitFailure);
    const explicit = sessions.getSession(explicitFailure)!.desktop;
    interceptLogCleanup(explicit, () => { throw Error('explicit logger cleanup failure'); });
    assert.equal((await explicit.beginClose().completion).resourcesReleased, false);
    const failed = await shutdownThroughRpc(explicitFailure);
    assert.equal(failed.error?.code, 'DESKTOP_CLOSE_FAILED');
    assert.equal(failed.error.report.resourcesReleased, true);
    assert.deepEqual(failed.error.report, await explicit.beginClose().completion);

    interceptLogCleanup(unaffected, () => { throw Error('batch logger cleanup failure'); });
    assert.equal((await unaffected.beginClose().completion).resourcesReleased, false);
    const batch = await host.dispose().then(() => null, error => error);
    assert.equal(batch?.code, 'DESKTOP_CLOSE_FAILED');
    assert.equal(batch.report.resourcesReleased, true);
    for (const id of [key, another, imKey, imOther]) {
        assert.throws(() => runtime.getDesktop(createDesktopId(id)), { code: 'DESKTOP_NOT_FOUND' });
    }
    assert.equal(getIMSession(imKey), null);
    assert.equal(getIMSession(imOther), null);
    facts.failures = { explicit: failed.error.report, rpcStatus: failed.status, batch: batch.report };
    assert.equal(provider.requests.length, 8);
    assert.ok(provider.requests.every(request => request.label));
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    for (const release of releases) release();
    await Promise.allSettled(pendingOpenings);
    unsubscribe();
    await host.dispose().catch(() => {});
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    config.mock.restore();
    db.closeDatabase();
    if (evidence) await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(project, { recursive: true, force: true });
}
assert.equal(facts.shutdown.resourcesReleased, true);
console.log('PASS product Desktop ownership, Topic lifecycle and actual IM SQLite row after same-key reopen');
