import { fixtureAppPath } from '../fixtures/batch-two-support.mjs';
import { expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRuntime, type AppInvocation, type InvocationReceipt } from '@aotui/runtime';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2, type MessageWithTimestamp } from '@aotui/agent-driver-v2';

const execute = promisify(execFile);
async function run(command: string, args: string[], options?: { cwd: string | URL }) {
    try { return await execute(command, args, options); }
    catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n'), { cause: error });
    }
}
const repo = new URL('../../', import.meta.url);
type ProviderRequest = {
    model: string;
    messages: readonly { role: string; content: string }[];
    tools: readonly { function: { name: string; parameters: unknown; description: string } }[];
};
const modelCall = (toolCallId: string, toolName: string, args: object) => ({ toolCallId, toolName, input: JSON.stringify(args) });
type ModelCall = ReturnType<typeof modelCall>;
const userText = (request: ProviderRequest) => request.messages.filter(message => message.role === 'user').map(message => message.content);

async function prepareConsumer(folder: string) {
    const modules = join(folder, 'node_modules');
    await mkdir(join(modules, '@aotui'), { recursive: true });
    for (const name of ['core', 'runtime', 'sdk']) {
        const target = join(modules, '@aotui', name);
        await mkdir(target);
        const pack = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', folder, '--cache', join(folder, 'cache')],
            { cwd: new URL(name + '/', repo) });
        await run('tar', ['-xzf', join(folder, pack.stdout.trim()), '--strip-components', '1', '-C', target]);
    }
    for (const [owner, name] of [['core', 'acorn'], ['runtime', '@types'], ['sdk', 'typebox']]) {
        await symlink(await realpath(new URL(owner + '/node_modules/' + name, repo)), join(modules, name), 'dir');
    }
    await writeFile(join(folder, 'package.json'), '{"type":"module"}');
    await cp(new URL('sdk/tests/fixtures/batch-one-files.ts', repo), join(folder, 'batch-one-files.ts'));
    await cp(new URL('../fixtures/batch-two-support.mjs', import.meta.url), join(folder, 'batch-two-support.mjs'));
    await cp(new URL('../fixtures/batch-one-public-host.mjs', import.meta.url), join(folder, 'public-host.mjs'));
    await run(process.execPath, [
        new URL('sdk/node_modules/@typescript/native/bin/tsc', repo).pathname, '--strict', '--exactOptionalPropertyTypes',
        '--target', 'ES2022', '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', 'batch-one-files.ts',
    ], { cwd: folder });
}

it('uses the same packaged file App through an independent Host and the product model boundary', async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'aotui-batch-one-')));
    const data = join(folder, 'product');
    const runtime = createRuntime();
    let source: SemanticAOTUIDrivenSource | undefined;
    let driver: AgentDriverV2 | undefined;
    let provider: ReturnType<typeof createServer> | undefined;
    try {
        await prepareConsumer(folder);
        const independent = join(folder, 'independent');
        await run(process.execPath, [join(folder, 'public-host.mjs'), independent], { cwd: folder });
        const facts = JSON.parse(await readFile(join(independent, 'independent-host.json'), 'utf8'));
        expect(facts.shutdown).toEqual({ ok: true, resourcesReleased: true });
        expect(facts.budget).toMatchObject({ status: 'budget-rejected', newWrites: 0 });
        expect(facts.budget.bytes).toBeGreaterThan(facts.budget.maxInputBytes);
        expect(facts.budget.after).toEqual(facts.budget.before);

        await mkdir(data);
        await writeFile(join(data, 'A.txt'), 'original A');
        await writeFile(join(data, 'B.txt'), 'original B');
        const desktopId = (await runtime.createDesktop()).id;
        const desktop = runtime.getDesktop(desktopId);
        const localPath = await fixtureAppPath(join(folder, 'dist/batch-one-files.js'), 'batch_files', data);
        const register = (installationId: string) => desktop.registerPendingApp({
            installationId, localPath,
            config: { folder: data },
        });
        await register('files_install');
        await register('OtherInstall');
        const receipts: { request: AppInvocation; receipt: InvocationReceipt }[] = [];
        const refused: { request: AppInvocation; result: Extract<Awaited<ReturnType<import('@aotui/runtime').ActiveTurn['invoke']>>, {kind:'refused'}> }[] = [];
        const adopt = desktop.adoptTurn.bind(desktop);
        vi.spyOn(desktop, 'adoptTurn').mockImplementation(selection => {
            const result = adopt(selection);
            if (result.status === 'rejected') return result;
            const active = result.turn;
            return { ...result, turn: { ...active, get isCurrent() { return active.isCurrent; }, async invoke(appId, request, timeout, signal) {
                const result = await active.invoke(appId, request, timeout, signal);
                if (result.kind === 'receipt') receipts.push({ request, receipt: result.receipt });
                if (result.kind === 'refused') refused.push({request,result});
                return result;
            } } };
        });
        source = new SemanticAOTUIDrivenSource(desktop, { instruction: DEFAULT_AOTUI_SYSTEM_INSTRUCTION });
        source.setAppEnabled('OtherInstall', false);
        const sent: ProviderRequest[] = [];
        const productRequests: Record<string, { request: ProviderRequest; calls: readonly ModelCall[] }> = {};
        const history: MessageWithTimestamp[] = [];
        const errors = vi.fn();
        let desired: { calls: readonly ModelCall[]; beforeReply?: () => Promise<void> } | undefined;
        const server = createServer(async (incoming, reply) => {
            try {
                expect(incoming.method).toBe('POST');
                expect(incoming.url).toBe('/v1/chat/completions');
                const chunks = [];
                for await (const chunk of incoming) chunks.push(chunk);
                const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest;
                sent.push(request);
                const turn = desired;
                desired = undefined;
                await turn?.beforeReply?.();
                const calls = turn?.calls ?? [];
                const toolCalls = calls.map(({ toolCallId, toolName, input }, index) => {
                    expect(request.tools.some(tool => tool.function.name === toolName)).toBe(true);
                    return { index, id: toolCallId, type: 'function', function: { name: toolName, arguments: input } };
                });
                const delta = { role: 'assistant', ...(toolCalls.length ? { tool_calls: toolCalls } : { content: 'Done.' }) };
                const chunk = (value: object, finish_reason: string | null) => 'data: ' + JSON.stringify({
                    id: 'test-' + sent.length, object: 'chat.completion.chunk', model: request.model, created: 1,
                    choices: [{ index: 0, delta: value, finish_reason }],
                }) + '\n\n';
                reply.writeHead(200, { 'content-type': 'text/event-stream' })
                    .end(chunk(delta, null) + chunk({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
            } catch (error) {
                reply.writeHead(500).end(String(error));
            }
        });
        provider = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const addressInfo = server.address();
        if (!addressInfo || typeof addressInfo === 'string') throw new Error('Test Provider did not open a local socket');
        driver = new AgentDriverV2({
            llm: { model: 'local', provider: { id: 'batch-one-fixture', baseURL: `http://127.0.0.1:${addressInfo.port}/v1` }, apiKey: 'test-only' },
            sources: [source, { name: 'history', onUpdate: () => () => {},
                async getContext() { return { messages: history.slice(), tools: {} }; } }],
            onRunError: errors,
            onAssistantMessage: message => { history.push({ ...message, timestamp: Date.now() }); },
            onToolResult: message => { history.push({ ...message, timestamp: Date.now() }); },
        });
        const step = async (label: string, calls: ModelCall[] = [], beforeReply?: () => Promise<void>) => {
            const index = sent.length;
            desired = { calls, ...(beforeReply && { beforeReply }) };
            await driver!.trigger();
            await (driver as any).runInFlight;
            expect(errors.mock.calls).toEqual([]);
            expect(sent.length).toBeGreaterThan(index);
            for (const call of calls) expect(JSON.stringify(history.filter(item => item.role === 'tool'))).toContain(call.toolCallId);
            const request = sent[index]!;
            productRequests[label] = { request, calls };
            return request;
        };
        const inactive = await step('launch', [modelCall('launch', 'system-open_app', { installation_id: 'files_install' })]);
        expect(inactive.tools.find(tool => tool.function.name === 'system-open_app')?.function.parameters).toMatchObject({ required: ['installation_id'] });
        expect(JSON.stringify(inactive.messages)).not.toContain('OtherInstall');
        const home = await step('directory', [modelCall('open-a', 'batch_files-workspace-open_file', { name: 'A.txt' })]);
        expect(home.tools.some(tool => tool.function.name === 'batch_files-file-edit')).toBe(false);
        expect(home.tools.find(tool => tool.function.name === 'batch_files-workspace-open_file')?.function.parameters).toMatchObject({ required: ['name'] });
        const oneFile = await step('one-file', [modelCall('open-b', 'batch_files-workspace-open_file', { name: 'B.txt' })]);
        expect(oneFile.tools.filter(tool => tool.function.name === 'batch_files-file-edit')).toHaveLength(1);
        const address = '$ref.batch_files.doc_1.content';
        const opened = await step('two-files', [modelCall('literal-edit', 'batch_files-file-edit', { view_id: 'doc_2', text: '$' + address })]);
        expect(opened.tools.filter(tool => tool.function.name === 'batch_files-file-edit')).toHaveLength(1);
        const prompt = JSON.stringify(opened.messages);
        expect(prompt).toContain('view_id=\\"doc_1\\" view_type=\\"file\\" app_id=\\"batch_files\\" app_name=\\"batch_files\\"');
        expect(prompt).toContain('view_id=\\"doc_2\\"');
        expect(await readFile(join(data, 'B.txt'), 'utf8')).toBe(address);
        const updatedA = 'new A outside the app';
        const afterLiteral = await step('after-literal', [
            modelCall('reload', 'batch_files-workspace-reload_source', {}),
            modelCall('ref-edit', 'batch_files-file-edit', { view_id: 'doc_2', text: address }),
        ], () => writeFile(join(data, 'A.txt'), updatedA));
        const modelViews = (request: ProviderRequest, id: string) =>
            userText(request).filter(text => text.startsWith('<view view_id="' + id + '"'));
        expect(modelViews(afterLiteral, 'doc_2')).toHaveLength(1);
        expect(modelViews(afterLiteral, 'doc_2')[0]).toContain('[' + address.replaceAll('_', '\\_') + '](protected content: string)');
        expect(await readFile(join(data, 'B.txt'), 'utf8')).toBe('original A');
        await step('before-authorization', [modelCall('disable-a', 'batch_files-workspace-mark_a_readonly', {})]);
        await step('authorization', [modelCall('disabled-a', 'batch_files-file-edit', { view_id: 'doc_1', text: 'must be rejected' })]);
        await step('close-a', [modelCall('close-a', 'batch_files-file-close', { view_id: 'doc_1' })]);
        const after = await step('one-remaining', [modelCall('close-b', 'batch_files-file-close', { view_id: 'doc_2' })]);
        expect(JSON.stringify(after.messages)).not.toContain('<view view_id=\\"doc_1\\"');
        expect(modelViews(after, 'doc_2')).toHaveLength(1);
        expect(modelViews(after, 'doc_2')[0]).toContain('[original A](protected content: string)');
        expect(after.tools.some(tool => tool.function.name === 'batch_files-file-edit')).toBe(true);
        const homeAgain = await step('directory-again');
        expect(homeAgain.tools.some(tool => tool.function.name === 'batch_files-file-edit')).toBe(false);
        const writes = (await readFile(join(data, 'writes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(writes).toEqual([
            { name: 'B.txt', text: address }, { name: 'B.txt', text: 'original A' },
        ]);
        expect(writes).toEqual(facts.writes);
        const files = { 'A.txt': await readFile(join(data, 'A.txt'), 'utf8'), 'B.txt': await readFile(join(data, 'B.txt'), 'utf8') };
        expect(files).toEqual({ 'A.txt': updatedA, 'B.txt': 'original A' });
        for (const [file, value] of Object.entries(files)) expect(value).toBe(await readFile(join(independent, file), 'utf8'));

        for (const independentTurn of facts.requests) {
            const comparable = productRequests[independentTurn.label];
            expect(comparable, independentTurn.label).toBeDefined();
            const { request } = comparable;
            const productPages = userText(request).filter(text => text.startsWith('<view '));
            const independentMessages = independentTurn.request.messages as { role: string; content: string }[];
            const independentPages = independentMessages.filter(message => message.content.startsWith('<view '));
            expect(independentMessages).toContainEqual({ role: 'user', content: DEFAULT_AOTUI_SYSTEM_INSTRUCTION });
            expect(userText(request)).toContain(DEFAULT_AOTUI_SYSTEM_INSTRUCTION.trim());
            expect(productPages).toHaveLength(independentPages.length);
            for (const message of independentPages) {
                expect(message.role).toBe('user');
                const authored = message.content.slice(0, -'\n</view>'.length);
                const expectedPage = authored.replace('<view view_id="doc_3" ', '<view view_id="doc_2" ')
                    .replaceAll('$ref.batch_files.doc_3', '$ref.batch_files.doc_2') + '\n</view>';
                expect(productPages).toContain(expectedPage);
            }
            const appTools = request.tools.filter(tool => tool.function.name.startsWith('batch_files-'));
            expect(appTools.map(tool => tool.function).sort((a, b) => a.name.localeCompare(b.name)))
                .toEqual(independentTurn.request.tools.map((tool: ProviderRequest['tools'][number]) => tool.function)
                    .sort((a, b) => a.name.localeCompare(b.name)));
        }
        for (const id of ['open-a', 'open-b', 'literal-edit', 'reload', 'ref-edit', 'disabled-a', 'close-a', 'close-b']) {
            const product = receipts.find(entry => entry.request.invocationId === id);
            const other = facts.calls.find((entry: { request: AppInvocation }) => entry.request.invocationId === id);
            if (id === 'disabled-a') {
                const denied=refused.find(entry=>entry.request.invocationId===id);
                expect(product).toBeUndefined();
                expect(denied?.request.input).toEqual(other.request.input);
                expect(denied?.request.viewId).toEqual(other.request.viewId);
                expect(denied?.result).toEqual(other.result);
                expect(denied?.result).toMatchObject({kind:'refused',code:'TOOL_UNAVAILABLE',path:'$.view_id'});
                expect(denied?.result).not.toHaveProperty('locator');
                expect(JSON.stringify(history.filter(item=>item.role==='tool'))).toContain('TOOL_UNAVAILABLE');
                continue;
            }
            expect(product, id).toBeDefined();
            expect(product!.request.input).toEqual(other.request.input);
            if (id === 'close-b') {
                expect(product!.request.viewId).toBe('doc_2');
                expect(other.request.viewId).toBe('doc_3');
            } else {
                expect(product!.request.viewId).toEqual(other.request.viewId);
            }
            expect(product!.receipt.executionPhase).toBe(other.result.receipt.executionPhase);
            expect(product!.receipt.outcome).toEqual(other.result.receipt.outcome);
        }
        if (process.env.AOTUI_BATCH_ONE_EVIDENCE) {
            await writeFile(process.env.AOTUI_BATCH_ONE_EVIDENCE, JSON.stringify({
                independent: facts, product: { requests: productRequests, receipts, writes, files },
            }, null, 2) + '\n');
        }
    } finally {
        driver?.stop(); driver?.dispose(); source?.dispose();
        const server = provider;
        if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const closed = await runtime.beginClose().completion;
        await rm(folder, { recursive: true, force: true });
        expect(closed).toMatchObject({ ok: true, resourcesReleased: true });
    }
}, 60_000);
