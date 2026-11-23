import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime, type AppInteractionPolicy, type InvocationContext, type RefConsumer } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { fixtureProvider, installFixture, journal, MAIL_TOOL, modelCall } from '../fixtures/batch-two-support.mjs';
import { changedPeople, contactHints, deniedAddresses, draftFieldGrants, emailAddress, expectedHint, firstEmail, hasPrivateDetails,
    mixedTurns, secondDraftValue, secondMailTool, setPeople, viewMessages, waitForView } from '../fixtures/batch-three-support.mjs';

const run = promisify(execFile);

it('sends one allowed field from the original contact to the real draft through both Hosts', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aotui-batch-three-test-'));
    const folder = join(scratch, 'product'), independentFolder = join(scratch, 'independent');
    const secondaryFolder = join(folder, 'secondary');
    const evidence = process.env.AOTUI_BATCH_THREE_EVIDENCE || scratch;
    const consumerDirectory = process.env.AOTUI_BATCH_THREE_PACKAGE_DIR || join(scratch, 'consumer');
    const moduleURL = (name: string) => pathToFileURL(join(consumerDirectory, 'dist', 'batch-three-' + name + '.js')).href;
    const runtime = createRuntime();
    const provider = await fixtureProvider();
    const authorized: Omit<InvocationContext, 'signal'>[] = [];
    const history: MessageWithTimestamp[] = [], errors: Error[] = [];
    const facts: Record<string, unknown> = { authorized, requests: provider.requests, order: [] };
    const proceed = Promise.withResolvers<boolean>(), entered = Promise.withResolvers<void>();
    let driver: AgentDriverV2 | undefined, source: SemanticAOTUIDrivenSource | undefined;
    try {
        await mkdir(evidence, { recursive: true });
        if (!process.env.AOTUI_BATCH_THREE_PACKAGE_DIR) await run(process.execPath, [
            fileURLToPath(new URL('../fixtures/prepare-batch-two-consumer.mjs', import.meta.url)), consumerDirectory, 'batch-three',
        ]);
        await run(process.execPath, [join(consumerDirectory, 'batch-three-public-host.mjs'), independentFolder], { cwd: consumerDirectory, timeout: 30_000 });
        const independent = JSON.parse(await readFile(join(independentFolder, 'independent-fields.json'), 'utf8'));
        await writeFile(join(evidence, 'independent-fields.json'), JSON.stringify(independent, null, 2));
        expect(independent.passed).toBe(true);
        const { getDraftConsumer, grantPeople } = await import(pathToFileURL(join(consumerDirectory, 'dist', 'batch-three-readme.js')).href);

        await setPeople(folder, 'initial');
        const desktop = runtime.getDesktop(await runtime.createDesktop());
        const contacts = await installFixture(runtime, desktop, 'contacts', 'contacts_install', moduleURL('contacts'), folder);
        const mail = await installFixture(runtime, desktop, 'mail', 'mail_install', moduleURL('mail'), folder);
        expect(desktop.getInstalledApps().map(app => app.appId)).toEqual(['contacts', 'mail']);
        let consumer: RefConsumer | undefined, secondaryConsumer: RefConsumer | undefined;
        const contactPolicy: AppInteractionPolicy = {
            async project({ source }) {
                consumer ??= await getDraftConsumer(mail.client);
                const refs = Object.values(source.refs);
                facts.contactsDeclared = { refCount: refs.length, size: Array.isArray(refs[0]?.target.payload) ? refs[0].target.payload.length : 0 };
                return grantPeople(source, draftFieldGrants(consumer, secondaryConsumer));
            },
            authorize: () => true, canReadReceipt: () => true,
        };
        const mailPolicy: AppInteractionPolicy = {
            project: ({ source }) => ({ refs: [], toolIds: Object.keys(source.tools) }),
            authorize({ signal, ...context }) {
                authorized.push(context);
                if (context.invocationId === 'withdraw') { entered.resolve(); return proceed.promise; }
                return true;
            },
            canReadReceipt: () => true,
        };
        source = new SemanticAOTUIDrivenSource(desktop, runtime, { policy: app => app.appId === 'contacts' ? contactPolicy : mailPolicy });
        const actual = source;
        driver = new AgentDriverV2({
            llm: { model: 'field-fixture', provider: { id: 'field-fixture', baseURL: provider.url }, apiKey: 'test-only' },
            sources: [{ name: actual.name, onUpdate: () => () => {}, getContext: () => actual.getContext() },
                { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } }],
            onAssistantMessage: message => { history.push({ ...message, timestamp: Date.now() }); },
            onToolResult: message => { history.push({ ...message, timestamp: Date.now() }); },
            onRunError: error => { errors.push(error); },
        });
        const call = (id: string, address = emailAddress) => modelCall(id, MAIL_TOOL, { to: address });
        const step = async (label: string, calls: ReturnType<typeof modelCall>[], beforeReply?: (wire: any) => Promise<void>) => {
            history.push({ role: 'user', content: label, timestamp: Date.now() });
            provider.replyNext({ label, calls, beforeReply });
            await driver!.trigger();
            await (driver as unknown as { runInFlight?: Promise<void> }).runInFlight;
            expect(errors).toEqual([]);
            expect(provider.failures).toEqual([]);
            const request = provider.requests.find(item => item.label === label);
            expect(request).toBeDefined();
            return { wire: request!.body, toolResult: history.filter(message => message.role === 'tool').at(-1) };
        };
        const order = facts.order as string[];
        const original = await step('original', [call('email'), ...deniedAddresses.map((address, index) => call('denied-' + index, address))], async wire => {
            expect(wire.messages.some((message: { role: string; content: string }) =>
                message.role === 'user' && message.content.includes(expectedHint))).toBe(true);
            expect(hasPrivateDetails(wire)).toBe(false);
            order.push('request received');
            await setPeople(folder, 'changed', changedPeople);
            await waitForView(contacts.client, 'Directory version changed');
            order.push('source changed before Provider replied');
        });
        expect(facts.contactsDeclared).toEqual({ refCount: 1, size: 100 });
        facts.originalPublication = facts.contactsDeclared;
        const independentWire = independent.requests[0].body;
        expect(viewMessages(original.wire)).toEqual(viewMessages(independentWire));
        const schema = (wire: any) => wire.tools.find((tool: any) => tool.function.name === MAIL_TOOL).function.parameters;
        expect(schema(original.wire)).toEqual(schema(independentWire));
        expect(schema(original.wire)).toMatchObject({ required: ['to'], properties: { to: { type: 'string' } } });
        expect(schema(original.wire)).not.toHaveProperty('properties.view_id');
        const faults = (original.toolResult?.content as any[]).slice(1).map(part => part.output.value);
        expect(faults).toHaveLength(deniedAddresses.length);
        expect(faults.every(error => error.code === 'REF_NOT_VISIBLE' && error.message === faults[0].message)).toBe(true);
        expect(hasPrivateDetails(faults)).toBe(false);
        expect(authorized).toHaveLength(1);
        expect(authorized[0]).toMatchObject({ rawInput: { to: emailAddress }, effectiveInput: { to: firstEmail },
            refSources: [{ path: [0, 'email'], value: firstEmail, consumerViewInstanceId: consumer?.viewInstanceId }] });
        expect(authorized[0]!.refSources[0]).not.toHaveProperty('refType');
        expect(hasPrivateDetails(authorized[0])).toBe(false);
        expect(await journal(folder, 'draft-handler')).toMatchObject([{ to: firstEmail, generation: 1 }]);
        facts.receipt = await mail.client.readReceipt({ observationId: authorized[0]!.observationId, invocationId: 'email' });
        expect(facts.receipt).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });

        await writeFile(join(folder, 'replace-draft'), '');
        const mounted = await waitForView(mail.client, 'Revision 2');
        expect(mounted.views[0].id).toBe(consumer?.viewId);
        expect(mounted.views[0].viewInstanceId).not.toBe(consumer?.viewInstanceId);
        const wrong = await step('same visible id with another mount', [call('wrong-mount')]);
        expect(JSON.stringify(viewMessages(wrong.wire))).not.toContain(expectedHint);
        expect(JSON.stringify(wrong.toolResult)).toContain('REF_NOT_VISIBLE');
        expect(authorized).toHaveLength(1);

        consumer = undefined;
        const pending = step('withdraw during authorization', [call('withdraw')]);
        try {
            await Promise.race([entered.promise, pending.then(() => { throw new Error('Expected a pending authorization'); })]);
            await setPeople(folder, 'withdrawn', changedPeople, true);
            await waitForView(contacts.client, 'Directory version withdrawn');
        } finally { proceed.resolve(true); }
        expect(JSON.stringify((await pending).toolResult)).toContain('REF_NOT_VISIBLE');
        expect(authorized).toHaveLength(2);
        facts.writes = await journal(folder, 'draft-writes');
        facts.handler = await journal(folder, 'draft-handler');
        expect(facts.writes).toEqual(facts.handler);
        expect(facts.writes).toMatchObject([{ to: firstEmail, generation: 1 }]);
        expect(facts.writes).toHaveLength(1);
        facts.draft = JSON.parse(await readFile(join(folder, 'draft.json'), 'utf8'));
        expect(facts.draft).toEqual(independent.draft);

        await mkdir(secondaryFolder);
        const secondary = await installFixture(runtime, desktop, 'mail', 'secondary_install', moduleURL('mail'), secondaryFolder);
        secondaryConsumer = await getDraftConsumer(secondary.client);
        expect(secondaryConsumer?.appId).toBe('mail_1');
        await setPeople(folder, 'shared');
        await waitForView(contacts.client, 'Directory version shared');
        const nativeSchemas = (wire: any) => wire.tools.filter((tool: any) =>
            [MAIL_TOOL, secondMailTool].includes(tool.function.name)).map((tool: any) => [tool.function.name, tool.function.parameters]);
        const pageMarkup = (wire: any) => viewMessages(wire).map((message: { content: string }) => message.content).sort();
        const compareMixed = async (script: typeof mixedTurns.both, pageCount: number) => {
            const { wire, toolResult } = await step(script.label, script.calls);
            const peer = independent.requests.find((request: { label?: string }) => request.label === script.label).body;
            expect(viewMessages(wire)).toHaveLength(pageCount);
            expect(contactHints(wire)).toEqual(script.hints);
            expect(pageMarkup(wire)).toEqual(pageMarkup(peer));
            expect(nativeSchemas(wire)).toEqual(nativeSchemas(peer));
            return (toolResult?.content as { toolCallId: string; output: { type: string; value: unknown } }[])
                .map(part => ({ id: part.toolCallId, ...part.output }));
        };
        expect(await compareMixed(mixedTurns.both, 3)).toEqual([{ id: 'allowed-secondary', type: 'json', value: { saved: true } }]);
        const beforeDenied = await journal(secondaryFolder, 'draft-writes');
        expect(beforeDenied).toMatchObject([{ to: secondDraftValue, generation: 1 }]);
        expect(beforeDenied).toHaveLength(1);
        expect(await journal(folder, 'draft-writes')).toEqual(facts.writes);

        source.setAppEnabled('secondary_install', false);
        expect(await compareMixed(mixedTurns.missing, 2)).toMatchObject([
            { id: 'absent-secondary-field', type: 'error-json', value: { code: 'REF_NOT_VISIBLE' } },
        ]);
        expect(await journal(folder, 'draft-writes')).toEqual(facts.writes);
        expect(await journal(secondaryFolder, 'draft-writes')).toEqual(beforeDenied);
        await writeFile(join(secondaryFolder, 'replace-draft'), '');
        await waitForView(secondary.client, 'Revision 2');
        const replacement = await getDraftConsumer(secondary.client);
        expect(replacement?.viewId).toBe(secondaryConsumer?.viewId);
        expect(replacement?.viewInstanceId).not.toBe(secondaryConsumer?.viewInstanceId);
        source.setAppEnabled('secondary_install', true);
        expect(await compareMixed(mixedTurns.replaced, 3)).toMatchObject([
            { id: 'stale-secondary-field', type: 'error-json', value: { code: 'REF_NOT_VISIBLE' } },
            { id: 'still-valid-primary', type: 'json', value: { saved: true } },
        ]);
        const primaryWrites = await journal(folder, 'draft-writes');
        const secondaryWrites = await journal(secondaryFolder, 'draft-writes');
        expect(primaryWrites).toHaveLength(2);
        expect(primaryWrites).toMatchObject([{ to: firstEmail, generation: 1 }, { to: firstEmail, generation: 2 }]);
        expect(secondaryWrites).toEqual(beforeDenied);
        expect(primaryWrites).toEqual(await journal(folder, 'draft-handler'));
        expect(secondaryWrites).toEqual(await journal(secondaryFolder, 'draft-handler'));
        expect(authorized.slice(2).map(item => [item.invocationId, item.source.instanceId, item.refSources[0]?.consumerViewInstanceId])).toEqual([
            ['allowed-secondary', secondaryConsumer?.instanceId, secondaryConsumer?.viewInstanceId],
            ['still-valid-primary', consumer?.instanceId, consumer?.viewInstanceId],
        ]);
        facts.mixed = { consumer, secondaryConsumer, replacement, primaryWrites, secondaryWrites };
        facts.passed = true;
    } finally {
        proceed.resolve(true);
        driver?.stop(); driver?.dispose(); source?.dispose();
        facts.shutdown = await runtime.beginShutdown().completion;
        await provider.close();
        facts.handler ??= await journal(folder, 'draft-handler');
        facts.writes ??= await journal(folder, 'draft-writes');
        facts.workers = { contacts: await journal(folder, 'contacts-lifecycle'), mail: await journal(folder, 'mail-lifecycle'),
            secondary: await journal(secondaryFolder, 'mail-lifecycle') };
        facts.history = history;
        await writeFile(join(evidence, 'product-fields.json'), JSON.stringify(facts, null, 2));
        await rm(scratch, { recursive: true, force: true });
    }
    expect(facts.shutdown).toMatchObject({ ok: true, resourcesReleased: true, interactions: { retainedOperations: 0, retainedBytes: 0 } });
}, 120_000);
