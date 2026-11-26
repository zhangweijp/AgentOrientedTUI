import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRuntime, type AppID, type DesktopID, type RuntimeCloseReport } from '@aotui/runtime';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import type { LLMConfigService } from '../src/core/llm-config-service.js';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { CHANGED, MAIL_TOOL, ORIGINAL, TO_CONTACTS, fixtureProvider, installFixture, journal,
    modelCall, setContacts, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';

const [consumer, evidenceFile] = process.argv.slice(2);
assert.ok(consumer, 'Pass the isolated consumer prepared by tests/fixtures/prepare-batch-two-consumer.mjs');
const scratch = await mkdtemp(join(tmpdir(), 'aotui-b2-topic-'));
process.env.DB_PATH = join(scratch, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(scratch, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;

const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { MessageService } = await import('../src/core/message-service.js');
const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
const config = mock.method(Config, 'get', async () => ({}));
const provider = await fixtureProvider();
const runtime = createRuntime({ worker: { timeoutMs: 1000 } });
const topics = new MessageService();
const topicId = 'batch-two-topic';
const park = join(scratch, 'park-draft');
const appModule = (app: string) => pathToFileURL(resolve(consumer, 'dist', 'batch-two-' + app + '.js')).href;
const setup = {
    async createDesktop(id: DesktopID) {
        const desktopId = (await runtime.createDesktop(id)).id;
        const desktop = runtime.getDesktop(desktopId);
        await installFixture(desktop, 'contacts', 'contacts_install', appModule('contacts'), scratch);
        await installFixture(desktop, 'mail', 'mail_install', appModule('mail'), scratch);
        return desktop;
    },
} as DesktopManager;
const llm: LLMConfig = { model: 'batch-two-topic-fixture', apiKey: 'test-only',
    provider: { id: 'batch-two-topic-fixture', baseURL: provider.url }, modelCapabilities: { toolCall: true } };
const models = { resolveLLMConfig: async () => llm, withModelInputBudget: (settings: LLMConfig) => settings } as LLMConfigService;
const manager = new SessionManagerV3(setup, models, topics);
type SavedToolMessage = NonNullable<GuiUpdateEvent['message']> & { role: 'tool'; id: string };
const delivered: SavedToolMessage[] = [];
const facts: Record<string, unknown> = { passed: false, topicId, delivered, requests: provider.requests };
manager.on('message', (event: GuiUpdateEvent) => {
    if (event.topicId !== topicId || event.message?.role !== 'tool' || !event.message.id) return;
    delivered.push(event.message as SavedToolMessage);
    manager.pauseSession(topicId);
});

try {
    await db.initDatabase();
    const now = Date.now();
    db.createTopic({ id: topicId, title: 'Fixture topic', createdAt: now, updatedAt: now, status: 'hot',
        sourceControls: { apps: { enabled: true, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] } } });
    await setContacts(scratch, ORIGINAL);
    const session = await manager.ensureSession(topicId);
    const mail = session.desktop.listApps().find(app => app.installationId === 'mail_install');
    const contacts = session.desktop.listApps().find(app => app.installationId === 'contacts_install');
    assert.ok(mail?.appId && mail.appInstanceId && contacts?.appId && contacts.appInstanceId);
    const contactsAccess = session.desktop.getRunningApp(contacts.appId, contacts.appInstanceId);
    assert.equal(contactsAccess.status, 'ready');

    // Check the actual resources held while the fixture keeps the handler parked.
    const { appManager } = session.desktop as unknown as {
        appManager: { getManagedApp(id: AppID): { host: { getResourceReport(): { interactions: { retainedOperations: number } } } } };
    };
    const retainedOperations = () => appManager.getManagedApp(mail.appId!).host.getResourceReport().interactions.retainedOperations;
    const turn = async (label: string, calls: ReturnType<typeof modelCall>[], beforeReply?: () => Promise<void>) => {
        const received = delivered.length;
        provider.replyNext({ label, calls, beforeReply });
        await manager.sendMessage(topicId, label);
        manager.resumeSession(topicId);
        const message = await watchUntil(() => delivered[received]) as SavedToolMessage;
        const stored = topics.getMessages(topicId).find(row => row.id === message.id);
        assert.deepEqual(stored?.content, message.content);
        assert.doesNotMatch(JSON.stringify(message.content), /"(observationId|appInstanceId|desktopId)"/);
        return message;
    };
    const fromMessage = (message: SavedToolMessage, index: number) => ({
        messageId: message.id, toolCallId: message.content[index]!.toolCallId,
    });
    const call = (id: string) => modelCall(id, MAIL_TOOL, TO_CONTACTS);

    await writeFile(park, '');
    const first = await turn('late in a saved tool message', [call('reused-call'), modelCall('side-result', 'system-close_app', { app_id: 'missing' })],
        async () => {
            await setContacts(scratch, CHANGED);
            await watchUntil(async () => {
                const snapshot = await contactsAccess.app.preview();
                return snapshot.status === 'previewed' && snapshot.views[0]?.content.value.split('\n')[1] === CHANGED.join(', ');
            });
        });
    const firstQuery = fromMessage(first, 0);
    assert.equal(first.content.length, 2);
    assert.match(JSON.stringify(first.content[0]?.output), /INVOCATION_WAIT_TIMEOUT/);
    await watchUntil(() => retainedOperations() === 1);
    facts.retainedOperationsAfterTimeout = retainedOperations();
    facts.queryFromDeliveredMessage = firstQuery;
    facts.otherPart = await manager.readAppReceipt(topicId, fromMessage(first, 1));
    assert.equal((facts.otherPart as { code: string }).code, 'RECEIPT_LOCATOR_UNAVAILABLE');
    facts.wrongTopic = await manager.readAppReceipt('other-topic', firstQuery);
    assert.equal((facts.wrongTopic as { code: string }).code, 'RECEIPT_LOCATOR_UNAVAILABLE');
    const waiting = await manager.readAppReceipt(topicId, firstQuery, 40);
    assert.equal(waiting.kind, 'unavailable');
    assert.equal(waiting.code, 'INVOCATION_WAIT_TIMEOUT');
    facts.waiting = waiting;

    await manager.setSourceEnabled(topicId, 'apps', false);
    const disabled = await manager.readAppReceipt(topicId, firstQuery);
    assert.equal(disabled.kind, 'unavailable');
    assert.equal(disabled.code, 'APP_DISABLED');
    facts.disabled = disabled;
    await manager.setSourceEnabled(topicId, 'apps', true);
    const heldRead = manager.readAppReceipt(topicId, firstQuery, 5000);
    await watchUntil(() => retainedOperations() === 2);
    await manager.setSourceItemEnabled(topicId, 'apps', 'mail_install', false);
    await rm(park);
    const revokedDuringRead = await heldRead;
    assert.equal(revokedDuringRead.kind, 'unavailable');
    assert.equal(revokedDuringRead.code, 'APP_DISABLED');
    facts.revokedDuringRead = revokedDuringRead;
    await manager.setSourceItemEnabled(topicId, 'apps', 'mail_install', true);

    // Reusing the provider's ID in a later message conflicts at Runtime. That message cannot read the first operation.
    const repeated = await turn('provider reused its call ID', [call(firstQuery.toolCallId)]);
    const repeatedQuery = fromMessage(repeated, 0);
    assert.notEqual(repeatedQuery.messageId, firstQuery.messageId);
    assert.equal(repeatedQuery.toolCallId, firstQuery.toolCallId);
    assert.match(JSON.stringify(repeated.content[0]?.output), /INVOCATION_ID_CONFLICT/);
    const wrongMessage = await manager.readAppReceipt(topicId, repeatedQuery);
    assert.equal(wrongMessage.kind, 'unavailable');
    assert.equal(wrongMessage.code, 'RECEIPT_LOCATOR_UNAVAILABLE');
    facts.wrongMessage = { query: repeatedQuery, read: wrongMessage };
    const recovered = await manager.readAppReceipt(topicId, firstQuery, 5000);
    assert.equal(recovered.kind, 'receipt');
    assert.equal(recovered.receipt.invocationId, firstQuery.toolCallId);
    assert.equal(recovered.receipt.source?.instanceId, mail.appInstanceId);
    assert.equal(recovered.receipt.executionPhase, 'entered-returned');
    assert.equal(recovered.receipt.outcome.status, 'succeeded');
    facts.recovered = recovered;
    facts.firstDraft = JSON.parse(await readFile(join(scratch, 'draft.json'), 'utf8'));
    assert.deepEqual(facts.firstDraft, { to: ORIGINAL });
    const firstWrites = await journal(scratch, 'draft-writes');
    const firstHandlers = await journal(scratch, 'draft-handler');
    assert.deepEqual(firstWrites.map(write => write.to), [ORIGINAL]);
    assert.deepEqual(firstHandlers, firstWrites);
    facts.firstOperation = { handlerEntries: firstHandlers.length, writes: firstWrites.length };
    await watchUntil(() => retainedOperations() === 0);
    facts.afterTerminal = await manager.readAppReceipt(topicId, firstQuery);
    assert.equal((facts.afterTerminal as { code: string }).code, 'RECEIPT_LOCATOR_UNAVAILABLE');

    await writeFile(park, '');
    const beforeReopen = await turn('pending receipt on an instance that will close', [call('before-reopen')]);
    assert.match(JSON.stringify(beforeReopen.content[0]?.output), /INVOCATION_WAIT_TIMEOUT/);
    await watchUntil(() => retainedOperations() === 1);
    await rm(park);
    await watchUntil(() => retainedOperations() === 0);
    const closing = session.desktop.getRunningApp(mail.appId, mail.appInstanceId);
    assert.equal(closing.status, 'ready');
    assert.equal((await closing.app.beginClose().completion).ok, true);
    assert.equal((await session.desktop.openApp('mail_install')).appId, mail.appId);
    const newInstance = session.desktop.listApps().find(app => app.appId === mail.appId)?.appInstanceId;
    assert.ok(newInstance && newInstance !== mail.appInstanceId);
    const oldQuery = fromMessage(beforeReopen, 0);
    const wrongInstance = await manager.readAppReceipt(topicId, oldQuery);
    assert.equal(wrongInstance.kind, 'unavailable');
    assert.equal(wrongInstance.code, 'APP_INSTANCE_MISMATCH');
    facts.reopened = { original: mail.appInstanceId, successor: newInstance, reply: wrongInstance };
    await manager.destroySession(topicId);
    const closed = await manager.readAppReceipt(topicId, oldQuery);
    assert.equal(closed.kind, 'unavailable');
    assert.equal(closed.code, 'RECEIPT_LOCATOR_UNAVAILABLE');
    facts.closed = closed;
    assert.deepEqual((await journal(scratch, 'draft-writes')).map(write => write.to), [ORIGINAL, CHANGED]);
    assert.deepEqual(await journal(scratch, 'draft-handler'), await journal(scratch, 'draft-writes'));
    assert.deepEqual(provider.failures, []);
    assert.equal(provider.requests.length, 3);
    facts.passed = true;
} finally {
    await rm(park, { force: true });
    await manager.cleanup();
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    config.mock.restore();
    db.closeDatabase();
    facts.handlers = await journal(scratch, 'draft-handler');
    facts.writes = await journal(scratch, 'draft-writes');
    if (evidenceFile) await writeFile(resolve(evidenceFile), JSON.stringify(facts, null, 2));
    await rm(scratch, { recursive: true, force: true });
}
assert.equal((facts.shutdown as RuntimeCloseReport).ok, true);
assert.equal((facts.shutdown as RuntimeCloseReport).resourcesReleased, true);
