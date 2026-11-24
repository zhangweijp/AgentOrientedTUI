import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime, type AppInteractionPolicy, type AppInvocation, type IDesktop, type InvocationContext,
    type Observation, type ObservationCandidate, type TurnSelection } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { fixtureAppPath, appClient, CHANGED, MAIL_TOOL, ORIGINAL, TO_CONTACTS, fixtureProvider, installFixture, journal, modelCall,
    setContacts, watchUntil } from '../fixtures/batch-two-support.mjs';

const run = promisify(execFile);
let scratch: string, evidence: string, consumer: string;
let independent: any;
const moduleURL = (name: string) => pathToFileURL(join(consumer, 'dist', 'batch-two-' + name + '.js')).href;
const recorded = (context: InvocationContext) => ({ ...context, signal: undefined });
const grant: AppInteractionPolicy['project'] = ({ source }) => ({
    refs: Object.values(source.refs).map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
    toolIds: Object.keys(source.tools),
});
const settle = async (driver: AgentDriverV2) => {
    await driver.trigger();
    await (driver as unknown as { runInFlight?: Promise<void> }).runInFlight;
};
async function candidate(running: import('@aotui/runtime').RunningApp) {
    const result = await running.observe();
    if (result.status === 'rejected') throw new Error(result.issue.message);
    return result.candidate;
}
function adopted(desktop: IDesktop, selection: TurnSelection) {
    const result = desktop.adoptTurn(selection);
    if (result.status === 'rejected') throw new Error(JSON.stringify(result.issue));
    return result.turn;
}

beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aotui-batch-two-test-'));
    evidence = process.env.AOTUI_BATCH_TWO_EVIDENCE || scratch;
    await mkdir(evidence, { recursive: true });
    consumer = process.env.AOTUI_BATCH_TWO_PACKAGE_DIR || join(scratch, 'consumer');
    if (!process.env.AOTUI_BATCH_TWO_PACKAGE_DIR)
        await run(process.execPath, [fileURLToPath(new URL('../fixtures/prepare-batch-two-consumer.mjs', import.meta.url)), consumer]);
    const folder = join(scratch, 'independent');
    await run(process.execPath, [join(consumer, 'batch-two-public-host.mjs'), folder], { cwd: consumer });
    independent = JSON.parse(await readFile(join(folder, 'independent-host.json'), 'utf8'));
    await writeFile(join(evidence, 'independent-comparison.json'), JSON.stringify(independent, null, 2));
}, 120_000);

afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

it('sends the same two-Worker observation through the product Provider and never retries a late write', async () => {
    const folder = join(scratch, 'product');
    await setContacts(folder, ORIGINAL);
    const runtime = createRuntime({ worker: { timeoutMs: 1000 } });
    const provider = await fixtureProvider();
    const history: MessageWithTimestamp[] = [];
    const auth: ReturnType<typeof recorded>[] = [];
    const errors: any[] = [];
    const facts: Record<string, unknown> = { authorize: auth, errors, requests: provider.requests };
    const policy: AppInteractionPolicy = { project: grant, authorize: context => { auth.push(recorded(context)); return true; },
        canReadReceipt: () => true };
    const desktop = await runtime.createDesktop({ policyForApp: () => policy });
    const source = new SemanticAOTUIDrivenSource(desktop);
    const adopt = desktop.adoptTurn.bind(desktop);
    const adoption = vi.spyOn(desktop, 'adoptTurn');
    let beforeAdoption: (() => Promise<unknown>) | undefined;
    const driver = new AgentDriverV2({
        llm: { model: 'batch-two-local', provider: { id: 'fixture', baseURL: provider.url }, apiKey: 'test-only' },
        sources: [
            { name: source.name, onUpdate: () => () => {}, async getContext() {
                const context = await source.getContext();
                await beforeAdoption?.();
                return context;
            } },
            { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } },
        ],
        onAssistantMessage: message => { history.push({ ...message, timestamp: Date.now() }); },
        onToolResult: message => { history.push({ ...message, timestamp: Date.now() }); },
        onRunError: error => { errors.push(error); },
    });
    const step = async (label: string, calls: ReturnType<typeof modelCall>[] = [], beforeReply?: () => Promise<unknown>) => {
        history.push({ role: 'user', content: label, timestamp: Date.now() });
        provider.replyNext({ label, calls, beforeReply });
        await settle(driver);
        expect(errors).toEqual([]);
        expect(provider.failures).toEqual([]);
        const request = provider.requests.find(item => item.label === label);
        expect(request).toBeDefined();
        return request!.body;
    };
    try {
        const contacts = await installFixture(desktop, 'contacts', 'contacts_install', moduleURL('contacts'), folder);
        const mail = await installFixture(desktop, 'mail', 'mail_install', moduleURL('mail'), folder);
        const take = (label: string) => modelCall(label, MAIL_TOOL, TO_CONTACTS);
        const snapshotOf = async (text: string) => watchUntil(async () => {
            const preview = await contacts.client.preview();
            return preview.status === 'previewed' && preview.views[0]?.content.value.split('\n')[1] === text && preview;
        });
        const productWire = await step('original', [take('cross-original')], async () => {
            await setContacts(folder, CHANGED);
            facts.contactsAfterSend = await snapshotOf(CHANGED.join(', '));
            expect((facts.contactsAfterSend as { views: { content: { value: string } }[] }).views[0]!.content.value).not.toContain(ORIGINAL.join(', '));
        });
        const independentWire = independent.requests.find((request: { label: string }) => request.label === 'original').body;
        const wirePages = (wire: { messages: { role: string; content: string }[] }) =>
            wire.messages.filter(message => message.role === 'user' && /^<view /.test(message.content)).map(message => message.content).sort();
        const mailSchema = (wire: { tools: { function: { name: string; parameters: unknown } }[] }) =>
            wire.tools.find(tool => tool.function.name === MAIL_TOOL)?.function.parameters;
        expect(wirePages(productWire)).toEqual(wirePages(independentWire));
        expect(wirePages(productWire)).toHaveLength(2);
        expect(mailSchema(productWire)).toEqual(mailSchema(independentWire));
        expect(mailSchema(productWire)).toMatchObject({ properties: { to: expect.any(Object) }, required: ['to'] });
        expect(mailSchema(productWire)).not.toHaveProperty('properties.view_id');
        expect(productWire.messages.some((message: { content: unknown }) => typeof message.content === 'string' &&
            message.content.includes('public $ref.contacts.list.emails'))).toBe(true);
        expect(auth[0]).toMatchObject({ rawInput: TO_CONTACTS, effectiveInput: { to: ORIGINAL },
            source: { instanceId: mail.app.appInstanceId }, refSources: [{ appId: 'contacts', scope: 'public', param: 'to' }] });
        expect(auth[0]!.refSources[0]!.snapshotId).not.toBe(auth[0]!.source.snapshotId);
        expect(await journal(folder, 'draft-writes')).toMatchObject([{ to: ORIGINAL }]);
        facts.originalReceipt = await mail.client.readReceipt({ observationId: auth[0]!.observationId, invocationId: 'cross-original' });
        expect(facts.originalReceipt).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });

        source.setAppEnabled('contacts_install', false);
        const targetOnly = await step('target-only', [take('absent-contacts')]);
        expect(wirePages(targetOnly)).toHaveLength(1);
        expect(JSON.stringify(history)).toContain('REF_NOT_VISIBLE');
        expect(auth).toHaveLength(1);
        expect(await journal(folder, 'draft-handler')).toHaveLength(1);
        source.setAppEnabled('contacts_install', true);

        const park = join(folder, 'park-draft');
        await writeFile(park, '');
        await step('late', [take('cross-late')]);
        expect(JSON.stringify(history)).toContain('INVOCATION_WAIT_TIMEOUT');
        expect(await journal(folder, 'draft-handler')).toHaveLength(2);
        expect(await journal(folder, 'draft-writes')).toHaveLength(1);
        await rm(park);
        await watchUntil(async () => (await journal(folder, 'draft-writes')).length === 2);
        expect(wirePages(await step('after-late')).join('\n')).toContain('To: ' + CHANGED.join(', '));
        expect(await journal(folder, 'draft-handler')).toMatchObject([{ to: ORIGINAL }, { to: CHANGED }]);
        expect(await journal(folder, 'draft-writes')).toEqual(await journal(folder, 'draft-handler'));
        facts.draft = JSON.parse(await readFile(join(folder, 'draft.json'), 'utf8'));
        expect(facts.draft).toEqual(independent.draft);

        const failureEvidence = [];
        for (const stage of ['duplicate-selection', 'discarded-candidate', 'window-change']) {
            const previous = await source.getContext();
            await previous.adopt!();
            const prior = adoption.mock.results.at(-1)!.value;
            const priorApps = adoption.mock.calls.at(-1)![0].apps;
            expect(priorApps).toHaveLength(2);
            if (stage === 'duplicate-selection') adoption.mockImplementationOnce(selection => {
                const priorContacts = priorApps.find(item => item.candidate.observation.source.appId === 'contacts')!;
                const newContacts = selection.apps.find(item => item.candidate.observation.source.appId === 'contacts')!;
                expect(priorContacts.candidate).not.toBe(newContacts.candidate);
                return adopt({ apps: [...selection.apps, priorContacts] });
            });
            else if (stage === 'discarded-candidate') adoption.mockImplementationOnce(selection => {
                selection.apps.find(item => item.candidate.observation.source.appId === 'mail')!.candidate.discard();
                return adopt(selection);
            });
            else beforeAdoption = () => mail.running.beginClose().completion;
            const sends = provider.requests.length;
            history.push({ role: 'user', content: stage + '-failure', timestamp: Date.now() });
            await settle(driver);
            beforeAdoption = undefined;
            const lastError = errors.at(-1);
            const chain = [lastError?.code, lastError?.cause?.code, lastError?.cause?.cause?.code];
            expect(chain).toContain(stage === 'window-change' ? 'SEMANTIC_WINDOW_CHANGED' : 'SEMANTIC_ADOPTION_FAILED');
            if (stage !== 'window-change')
                expect(chain).toContain(stage === 'discarded-candidate' ? 'OBSERVATION_UNAVAILABLE' : 'TURN_SELECTION_INVALID');
            expect(provider.requests).toHaveLength(sends);
            expect(await journal(folder, 'draft-handler')).toHaveLength(2);
            expect(await journal(folder, 'draft-writes')).toHaveLength(2);
            expect(prior.turn.isCurrent).toBe(true);
            expect(await prior.turn.inspectRef(TO_CONTACTS.to, 'value')).toMatchObject({ status: 'ready', value: CHANGED });
            if (stage === 'window-change') {
                const target = adoption.mock.calls.at(-1)![0].apps.find(item => item.candidate.observation.source.appId === 'mail')!;
                expect(await prior.turn.invoke('mail', {
                    observationId: target.candidate.observation.observationId, toolId: target.candidate.observation.tools[0]!.id,
                    invocationId: 'closed-from-old-turn', input: TO_CONTACTS,
                })).toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
            }
            await previous.release?.();
            failureEvidence.push({ stage, errorCodes: chain, newRequests: provider.requests.length - sends, newWrites: 0 });
        }
        facts.requestFailures = failureEvidence;
    } finally {
        await rm(join(folder, 'park-draft'), { force: true });
        driver.dispose();
        source.dispose();
        facts.shutdown = await runtime.beginClose().completion;
        await provider.close();
        facts.workers = { contacts: await journal(folder, 'contacts-lifecycle'), mail: await journal(folder, 'mail-lifecycle') };
        facts.handler = await journal(folder, 'draft-handler');
        facts.writes = await journal(folder, 'draft-writes');
        facts.history = history;
        await writeFile(join(evidence, 'product-boundary.json'), JSON.stringify(facts, null, 2));
    }
    expect(facts.shutdown).toMatchObject({ ok: true, resourcesReleased: true });
}, 35_000);

it('qualifies the actual source set, rejects revoked grants before dispatch and isolates same-named Workers', async () => {
    const folder = join(scratch, 'qualification');
    const peerFolder = join(folder, 'peer'), foreignFolder = join(folder, 'foreign');
    const peerEmails = ['peer-a@example.test', 'peer-b@example.test'];
    await Promise.all([setContacts(folder, ORIGINAL), setContacts(peerFolder, peerEmails), setContacts(foreignFolder, ['foreign@example.test'])]);
    const runtime = createRuntime();
    const byId = async (desktop: IDesktop, ...ids: string[]) => Promise.all(ids.map(async id => {
        const access = appClient(desktop, id);
        const prepared = await candidate(access.running);
        return { ...access, candidate: prepared, observation: prepared.observation };
    }));
    const auth: ReturnType<typeof recorded>[] = [];
    const outcomes: Record<string, unknown> = {};
    const gate = () => ({ entered: Promise.withResolvers<InvocationContext>(), decision: Promise.withResolvers<boolean>() });
    const gates = new Map<string, ReturnType<typeof gate>>();
    const policy: AppInteractionPolicy = { project: grant, canReadReceipt: () => true,
        authorize(context) {
            auth.push(recorded(context));
            const held = gates.get(context.invocationId);
            if (!held) return true;
            held.entered.resolve(context);
            return held.decision.promise;
        } };
    const selection = (...apps: { candidate: ObservationCandidate }[]): TurnSelection =>
        ({ apps: apps.map(({ candidate }) => ({ candidate })) });
    const request = (observation: Observation, invocationId: string, to: string | string[] = TO_CONTACTS.to): AppInvocation =>
        ({ invocationId, observationId: observation.observationId, toolId: observation.tools[0]!.id, input: { to } });
    const invalidAdoption = (desktop: IDesktop, label: string, selection: TurnSelection, code = 'TURN_SELECTION_INVALID') => {
        const result = desktop.adoptTurn(selection);
        expect(result).toMatchObject({ status: 'rejected', issue: { code } });
        outcomes[label] = result;
    };
    const rejected = (label: string, result: any, code: string, stage = 'not-dispatched') => {
        outcomes[label] = result;
        expect(result).toMatchObject(stage === 'not-dispatched'
            ? { kind: 'receipt', receipt: { executionPhase: stage, outcome: { status: 'rejected', code } } }
            : { kind: stage, code });
    };
    let shutdown: unknown;
    try {
        const desktop = await runtime.createDesktop('qualification');
        const foreign = await runtime.createDesktop('foreign');
        for (const [installationId, sourceFolder] of [['contacts_a', peerFolder], ['contacts_b', folder]]) {
            await desktop.registerPendingApp({ installationId: installationId!, localPath: await fixtureAppPath(moduleURL('contacts'), 'contacts', sourceFolder), config: { folder: sourceFolder } });
        }
        const launches = [(await desktop.openApp('contacts_b')).appId, (await desktop.openApp('contacts_a')).appId];
        expect(launches).toEqual(['contacts', 'contacts_1']);
        const other = await installFixture(foreign, 'contacts', 'foreign_contacts', moduleURL('contacts'), foreignFolder);
        const otherCandidate = await candidate(other.running);
        const mail = await installFixture(desktop, 'mail', 'mail_install', moduleURL('mail'), folder, policy);
        const unadopted = await candidate(mail.running);
        const empty = adopted(desktop, { apps: [] });
        rejected('unadopted', await empty.invoke('mail', request(unadopted.observation, 'unadopted')), 'OBSERVATION_UNAVAILABLE', 'refused');
        unadopted.discard();
        invalidAdoption(desktop, 'released', selection({ candidate: unadopted }), 'OBSERVATION_UNAVAILABLE');
        let [contacts, peer, draft] = await byId(desktop, ...launches, 'mail');
        const first = adopted(desktop, selection(contacts!, peer!, draft!));
        expect(Object.isFrozen(first)).toBe(true);
        const preview = await contacts!.client.preview();
        if (preview.status !== 'previewed') throw new Error('Expected a read-only preview');
        invalidAdoption(desktop, 'preview', selection({ candidate: preview as unknown as ObservationCandidate }));
        invalidAdoption(desktop, 'other desktop', selection(draft!, { candidate: otherCandidate }));
        invalidAdoption(foreign, 'target from other desktop', selection(draft!));
        invalidAdoption(desktop, 'duplicated', selection(draft!, contacts!, contacts!));
        invalidAdoption(desktop, 'copied candidate', selection({ candidate: { ...contacts!.candidate } }));
        rejected('wrong app for observation', await first.invoke('mail', {
            ...request(draft!.observation, 'wrong-observation'), observationId: contacts!.observation.observationId,
        }), 'TURN_SELECTION_INVALID', 'refused');
        rejected('private', await first.invoke('mail', request(draft!.observation, 'private', '$ref.contacts.list.personal')), 'TOOL_PERMISSION_DENIED');
        rejected('protected', await first.invoke('mail', request(draft!.observation, 'protected', '$ref.contacts.list.team')), 'TOOL_PERMISSION_DENIED');
        rejected('one of two unavailable', await first.invoke('mail', request(draft!.observation, 'mixed-denied',
            ['$ref.contacts.list.emails[0]', '$ref.contacts_1.list.team[0]'])), 'TOOL_PERMISSION_DENIED');
        const targetOnly = adopted(desktop, selection(draft!));
        rejected('no source', await targetOnly.invoke('mail', request(draft!.observation, 'no-source')), 'REF_NOT_VISIBLE');
        [contacts, peer] = await byId(desktop, ...launches);
        const sourceOnly = adopted(desktop, selection(contacts!, peer!));
        rejected('target absent', await sourceOnly.invoke('mail', request(draft!.observation, 'no-target')), 'OBSERVATION_UNAVAILABLE', 'refused');
        rejected('old turn', await first.invoke('mail', request(draft!.observation, 'superseded')), 'TURN_NOT_ACTIVE', 'refused');
        expect(auth).toHaveLength(0);
        expect(await journal(folder, 'draft-handler')).toEqual([]);
        expect(await journal(folder, 'draft-writes')).toEqual([]);

        invalidAdoption(desktop, 'omitted candidate retired', selection(contacts!, draft!), 'OBSERVATION_UNAVAILABLE');
        [draft] = await byId(desktop, 'mail');

        const inAuthorization = (id: string) => {
            const held = gate();
            gates.set(id, held);
            const turn = adopted(desktop, selection(contacts!, draft!));
            const original = request(draft!.observation, id);
            const result = turn.invoke('mail', original, 5000);
            return { ...held, turn, original, result };
        };
        const waitContactBody = (matches: (body: string) => boolean) => watchUntil(async () => {
            const current = await contacts!.client.preview();
            return current.status === 'previewed' && matches(current.views[0]?.content.value ?? '');
        });
        for (const change of ['tighten', 'withdraw'] as const) {
            const held = inAuthorization(change);
            const context = await held.entered.promise;
            expect(context.effectiveInput).toMatchObject({ to: ORIGINAL });
            try {
                await setContacts(folder, CHANGED, change === 'tighten' ? { scope: 'protected' } : { withdrawn: true });
                await waitContactBody(body => change === 'tighten' ? body.includes('(protected emails:')
                    : body.includes(CHANGED.join(', ')) && !body.includes('[Recipients]'));
            } finally {
                held.decision.resolve(true);
            }
            rejected(change, await held.result, 'REF_NOT_VISIBLE');
            await setContacts(folder, ORIGINAL);
            await waitContactBody(body => body.includes('(public emails:'));
        }

        await peer!.running.beginClose().completion;
        const staleSource = inAuthorization('source-reopened');
        await staleSource.entered.promise;
        const originalSource = contacts!;
        await originalSource.running.beginClose().completion;
        const reopenedSource = (await desktop.openApp('contacts_b')).appId;
        expect(reopenedSource).toBe('contacts');
        [contacts] = await byId(desktop, reopenedSource);
        expect(contacts!.app.appInstanceId).not.toBe(originalSource.app.appInstanceId);
        staleSource.decision.resolve(true);
        rejected('source reopened in authorization', await staleSource.result, 'REF_VIEW_UNAVAILABLE');

        const staleTarget = inAuthorization('target-reopened');
        const targetContext = await staleTarget.entered.promise;
        const oldDraft = draft!;
        const stopping = oldDraft.running.beginClose().completion;
        await watchUntil(() => targetContext.signal.aborted);
        staleTarget.decision.resolve(true);
        await stopping;
        expect((await desktop.openApp('mail_install', { policy })).appId).toBe('mail');
        [draft] = await byId(desktop, 'mail');
        expect(draft!.app.appInstanceId).not.toBe(oldDraft.app.appInstanceId);
        rejected('target closed in authorization', await staleTarget.result, 'APP_INTERACTION_UNAVAILABLE', 'unavailable');
        rejected('old turn on reopened target', await staleTarget.turn.invoke('mail', staleTarget.original), 'OBSERVATION_UNAVAILABLE', 'refused');
        expect(await journal(folder, 'draft-handler')).toEqual([]);
        expect(await journal(folder, 'draft-writes')).toEqual([]);

        // The ID of the running source, including its suffix, is the address authority.
        const reopenedPeer = (await desktop.openApp('contacts_a')).appId;
        expect(reopenedPeer).toBe('contacts_1');
        [peer] = await byId(desktop, reopenedPeer);
        const input = ['$ref.contacts_1.list.emails[1]', 'literal@example.test', '$ref.contacts.list.emails[0]', '$ref.contacts_1.list.emails[1]'];
        const expected = [peerEmails[1], input[1], ORIGINAL[0], peerEmails[1]];
        const both = adopted(desktop, selection(contacts!, peer!, draft!));
        const valid = await both.invoke('mail', request(draft!.observation, 'two-origins', input));
        expect(valid).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });
        expect(auth.at(-1)!.refSources.map(ref => [ref.appId, ref.instanceId, ref.path[0], ref.index])).toEqual([
            ['contacts_1', peer!.app.appInstanceId, 1, 0], ['contacts', contacts!.app.appInstanceId, 0, 2],
            ['contacts_1', peer!.app.appInstanceId, 1, 3],
        ]);
        expect(await journal(folder, 'draft-handler')).toMatchObject([{ to: expected }]);
        expect(await journal(folder, 'draft-writes')).toEqual(await journal(folder, 'draft-handler'));
        outcomes.sameName = { launches, valid, expected, originalSource, reopenedSource: contacts!.app, peer: peer!.app };
    } finally {
        for (const held of gates.values()) held.decision.resolve(true);
        shutdown = await runtime.beginClose().completion;
        await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ outcomes, authorize: auth, shutdown,
            handlers: await journal(folder, 'draft-handler'), writes: await journal(folder, 'draft-writes') }, null, 2));
    }
    expect(shutdown).toMatchObject({ ok: true, resourcesReleased: true, interactions: { retainedOperations: 0 } });
}, 35_000);
