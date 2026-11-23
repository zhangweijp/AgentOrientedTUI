import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime, type AppInteractionPolicy, type AppInvocation, type IDesktop, type InvocationContext,
    type Observation, type RequestSourceSelection } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { fixtureAppPath, appClient, CHANGED, MAIL_TOOL, ORIGINAL, TO_CONTACTS, fixtureProvider, installFixture, journal, modelCall,
    observe, setContacts, watchUntil } from '../fixtures/batch-two-support.mjs';

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
    const desktop = runtime.getDesktop(await runtime.createDesktop());
    const provider = await fixtureProvider();
    const history: MessageWithTimestamp[] = [];
    const auth: ReturnType<typeof recorded>[] = [];
    const errors: any[] = [];
    const facts: Record<string, unknown> = { authorize: auth, errors, requests: provider.requests };
    const policy: AppInteractionPolicy = { project: grant, authorize: context => { auth.push(recorded(context)); return true; },
        canReadReceipt: () => true };
    let captureMailCandidate = false;
    let candidate: string | undefined;
    const sourceKernel = { getAppInteraction: (...args: Parameters<typeof runtime.getAppInteraction>) => {
        const result = runtime.getAppInteraction(...args);
        if (!captureMailCandidate || args[1] !== 'mail' || result.status !== 'ready') return result;
        return { ...result, interaction: { ...result.interaction, async observe(selection: { all: true }) {
            const observed = await result.interaction.observe(selection);
            if (observed.status === 'observed') candidate = observed.observation.observationId;
            return observed;
        } } };
    } } as typeof runtime;
    const source = new SemanticAOTUIDrivenSource(desktop, sourceKernel, { policy: () => policy });
    const bind = desktop.bindRequestSources.bind(desktop);
    const bindingCalls = vi.spyOn(desktop, 'bindRequestSources');
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
        const contacts = await installFixture(runtime, desktop, 'contacts', 'contacts_install', moduleURL('contacts'), folder);
        const mail = await installFixture(runtime, desktop, 'mail', 'mail_install', moduleURL('mail'), folder);
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
            message.content.includes('Public Refs can also be passed to tools in other Apps presented in the current request'))).toBe(true);
        expect(auth[0]).toMatchObject({ rawInput: TO_CONTACTS, effectiveInput: { to: ORIGINAL },
            refSources: [{ appId: 'contacts', scope: 'public', consumerInstanceId: mail.app.appInstanceId }] });
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
        for (const stage of ['binding', 'adoption', 'window-change']) {
            const previous = await source.getContext();
            await previous.adopt!();
            const previouslyBound = bindingCalls.mock.calls.at(-1)![0];
            expect(previouslyBound.apps).toHaveLength(2);
            let failedSelection: RequestSourceSelection | undefined;
            if (stage === 'binding') bindingCalls.mockImplementationOnce(selection => {
                failedSelection = selection;
                return bind({ apps: [...selection.apps, selection.apps[0]!] });
            });
            else if (stage === 'adoption') {
                captureMailCandidate = true;
                beforeAdoption = async () => {
                    expect(candidate).toBeDefined();
                    mail.client.releaseObservation(candidate!);
                };
            } else beforeAdoption = () => desktop.closeApp(mail.app.appId, mail.app.appInstanceId);
            const sends = provider.requests.length;
            history.push({ role: 'user', content: stage + '-failure', timestamp: Date.now() });
            await settle(driver);
            beforeAdoption = undefined;
            captureMailCandidate = false;
            const lastError = errors.at(-1);
            const chain = [lastError?.code, lastError?.cause?.code, lastError?.cause?.cause?.code];
            expect(chain).toContain(stage === 'binding' ? 'SEMANTIC_BINDING_FAILED'
                : stage === 'adoption' ? 'SEMANTIC_ADOPTION_PARTIAL' : 'SEMANTIC_WINDOW_CHANGED');
            expect(provider.requests).toHaveLength(sends);
            expect(await journal(folder, 'draft-handler')).toHaveLength(2);
            expect(await journal(folder, 'draft-writes')).toHaveLength(2);
            const onlyContacts = (selection: RequestSourceSelection) => ({ apps: selection.apps.filter(entry => entry.client === contacts.client) });
            expect(onlyContacts(previouslyBound).apps).toHaveLength(1);
            if (stage === 'window-change') {
                expect(() => bind(onlyContacts(previouslyBound))).not.toThrow();
                await previous.release?.();
            } else {
                expect(() => bind(onlyContacts(previouslyBound))).toThrow(expect.objectContaining({ code: 'REQUEST_SOURCES_INVALID' }));
                expect((await previous.executeTool!(MAIL_TOOL, TO_CONTACTS, 'old-' + stage))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
            }
            if (failedSelection)
                expect(() => bind(onlyContacts(failedSelection!))).toThrow(expect.objectContaining({ code: 'REQUEST_SOURCES_INVALID' }));
            failureEvidence.push({ stage, errorCodes: chain, newRequests: provider.requests.length - sends, newWrites: 0 });
        }
        facts.requestFailures = failureEvidence;
    } finally {
        await rm(join(folder, 'park-draft'), { force: true });
        driver.dispose();
        source.dispose();
        facts.shutdown = await runtime.beginShutdown().completion;
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
        const access = appClient(runtime, desktop, id, id === 'mail' ? policy : undefined);
        return { ...access, observation: await observe(access.client, true) as Observation };
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
    const selection = (...apps: { client: import('@aotui/runtime').AppInteraction; observation: Observation }[]) =>
        ({ apps: apps.map(({ client, observation }) => ({ client, observationId: observation.observationId })) });
    const request = (observation: Observation, invocationId: string, to: string | string[] = TO_CONTACTS.to): AppInvocation =>
        ({ invocationId, observationId: observation.observationId, toolId: observation.tools[0]!.id, input: { to } });
    const invalidBind = (desktop: IDesktop, label: string, selection: RequestSourceSelection) => {
        try { desktop.bindRequestSources(selection); throw new Error('The invalid request was bound.'); }
        catch (error) { expect(error).toMatchObject({ code: 'REQUEST_SOURCES_INVALID' }); outcomes[label] = { stage: 'binding', code: 'REQUEST_SOURCES_INVALID' }; }
    };
    const rejected = (label: string, result: any, code: string, stage = 'not-dispatched') => {
        outcomes[label] = result;
        expect(result).toMatchObject(stage === 'not-dispatched'
            ? { kind: 'receipt', receipt: { executionPhase: stage, outcome: { status: 'rejected', code } } }
            : { kind: stage, code });
    };
    let shutdown: unknown;
    try {
        const desktop = runtime.getDesktop(await runtime.createDesktop('qualification'));
        const foreign = runtime.getDesktop(await runtime.createDesktop('foreign'));
        for (const [installationId, sourceFolder] of [['contacts_a', peerFolder], ['contacts_b', folder]]) {
            await desktop.registerPendingApp({ installationId: installationId!, localPath: await fixtureAppPath(moduleURL('contacts'), 'contacts', sourceFolder), config: { folder: sourceFolder } });
        }
        const launches = [await desktop.openApp('contacts_b'), await desktop.openApp('contacts_a')];
        expect(launches).toEqual(['contacts', 'contacts_1']);
        const other = await installFixture(runtime, foreign, 'contacts', 'foreign_contacts', moduleURL('contacts'), foreignFolder);
        const otherObservation = await observe(other.client, true) as Observation;
        const mail = await installFixture(runtime, desktop, 'mail', 'mail_install', moduleURL('mail'), folder, policy);
        const unadopted = await observe(mail.client) as Observation;
        invalidBind(desktop, 'unadopted', selection({ ...mail, observation: unadopted }));
        mail.client.releaseObservation(unadopted.observationId);
        invalidBind(desktop, 'released', selection({ ...mail, observation: unadopted }));
        let [contacts, peer, draft] = await byId(desktop, ...launches, 'mail');
        const first = desktop.bindRequestSources(selection(contacts!, peer!, draft!));
        expect(Object.isFrozen(first)).toBe(true);
        const preview = await contacts!.client.preview();
        if (preview.status !== 'previewed') throw new Error('Expected a read-only preview');
        invalidBind(desktop, 'preview', { apps: [{ client: contacts!.client, observationId: preview.source.snapshotId }] });
        invalidBind(desktop, 'other desktop', selection(draft!, { ...other, observation: otherObservation }));
        invalidBind(foreign, 'target from other desktop', selection(draft!));
        invalidBind(desktop, 'duplicated', selection(draft!, contacts!, contacts!));
        invalidBind(desktop, 'wrong observation for client', selection({ ...peer!, observation: contacts!.observation }));
        invalidBind(desktop, 'copied client', selection({ ...contacts!, client: { ...contacts!.client } }));
        rejected('copied binding', await draft!.client.invoke(request(draft!.observation, 'fake'), undefined, { ...first }), 'REQUEST_SOURCES_INVALID', 'refused');
        rejected('target absent', await draft!.client.invoke(request(draft!.observation, 'no-target'), undefined,
            desktop.bindRequestSources(selection(contacts!))), 'REQUEST_SOURCES_INVALID', 'refused');
        rejected('private', await draft!.client.invoke(request(draft!.observation, 'private', '$contacts.list.personal'), undefined, first), 'TOOL_PERMISSION_DENIED');
        rejected('protected', await draft!.client.invoke(request(draft!.observation, 'protected', '$contacts.list.team'), undefined, first), 'TOOL_PERMISSION_DENIED');
        rejected('no cohort', await draft!.client.invoke(request(draft!.observation, 'no-cohort')), 'REF_NOT_VISIBLE');
        rejected('one of two unavailable', await draft!.client.invoke(request(draft!.observation, 'mixed-denied',
            ['$contacts.list.emails[0]', '$contacts_1.list.team[0]']), undefined, first), 'TOOL_PERMISSION_DENIED');
        expect(auth).toHaveLength(0);
        expect(await journal(folder, 'draft-handler')).toEqual([]);
        expect(await journal(folder, 'draft-writes')).toEqual([]);

        const secondContacts = await observe(contacts!.client, true) as Observation;
        rejected('source superseded', await draft!.client.invoke(request(draft!.observation, 'superseded'), undefined, first), 'OBSERVATION_UNAVAILABLE');
        invalidBind(desktop, 'superseded at binding', selection(contacts!, draft!));
        contacts = { ...contacts!, observation: secondContacts };
        const newerDraft = await observe(draft!.client, true) as Observation;
        rejected('target binding generation mismatch', await draft!.client.invoke(request(newerDraft, 'different-target-candidate'), undefined, first),
            'REQUEST_SOURCES_INVALID', 'refused');
        draft = { ...draft!, observation: newerDraft };

        const inAuthorization = (id: string) => {
            const held = gate();
            gates.set(id, held);
            const binding = desktop.bindRequestSources(selection(contacts!, draft!));
            const original = request(draft!.observation, id);
            const result = draft!.client.invoke(original, 5000, binding);
            return { ...held, binding, original, result };
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

        await desktop.closeApp(peer!.app.appId, peer!.app.appInstanceId);
        const staleSource = inAuthorization('source-reopened');
        await staleSource.entered.promise;
        const originalSource = contacts!;
        await desktop.closeApp(originalSource.app.appId, originalSource.app.appInstanceId);
        const reopenedSource = await desktop.openApp('contacts_b');
        expect(reopenedSource).toBe('contacts');
        [contacts] = await byId(desktop, reopenedSource);
        expect(contacts!.app.appInstanceId).not.toBe(originalSource.app.appInstanceId);
        staleSource.decision.resolve(true);
        rejected('source reopened in authorization', await staleSource.result, 'REF_VIEW_UNAVAILABLE');

        const staleTarget = inAuthorization('target-reopened');
        const targetContext = await staleTarget.entered.promise;
        const oldDraft = draft!;
        const stopping = desktop.closeApp(oldDraft.app.appId, oldDraft.app.appInstanceId);
        await watchUntil(() => targetContext.signal.aborted);
        staleTarget.decision.resolve(true);
        await stopping;
        expect(await desktop.openApp('mail_install')).toBe('mail');
        [draft] = await byId(desktop, 'mail');
        expect(draft!.app.appInstanceId).not.toBe(oldDraft.app.appInstanceId);
        rejected('target closed in authorization', await staleTarget.result, 'APP_INTERACTION_UNAVAILABLE', 'unavailable');
        rejected('old token on reopened target', await draft!.client.invoke(staleTarget.original, undefined, staleTarget.binding), 'REQUEST_SOURCES_INVALID', 'refused');
        expect(await journal(folder, 'draft-handler')).toEqual([]);
        expect(await journal(folder, 'draft-writes')).toEqual([]);

        // The ID of the running source, including its suffix, is the address authority.
        const reopenedPeer = await desktop.openApp('contacts_a');
        expect(reopenedPeer).toBe('contacts_1');
        [peer] = await byId(desktop, reopenedPeer);
        const input = ['$contacts_1.list.emails[1]', 'literal@example.test', '$contacts.list.emails[0]', '$contacts_1.list.emails[1]'];
        const expected = [peerEmails[1], input[1], ORIGINAL[0], peerEmails[1]];
        const both = desktop.bindRequestSources(selection(contacts!, peer!, draft!));
        const valid = await draft!.client.invoke(request(draft!.observation, 'two-origins', input), undefined, both);
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
        shutdown = await runtime.beginShutdown().completion;
        await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ outcomes, authorize: auth, shutdown,
            handlers: await journal(folder, 'draft-handler'), writes: await journal(folder, 'draft-writes') }, null, 2));
    }
    expect(shutdown).toMatchObject({ ok: true, resourcesReleased: true, interactions: { retainedOperations: 0, retainedBytes: 0 } });
}, 35_000);
