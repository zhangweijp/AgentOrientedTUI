/** Real Workers + standard Host installation; no model credentials or external services required. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSourceControlsFromAgent, applySourceControlsToSources } from '../src/core/source-controls.js';
import { appSourceControls } from '../src/shared/source-control-keys.js';
import { readDesktopPreview } from '../src/core/desktop-preview.js';
import { modelViews } from './fixtures/model-views.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-semantic-host-')));
const project = path.join(work, 'project');
await fs.mkdir(project);
const file = path.join(project, 'demo.ts');
const otherFile = path.join(project, 'other.ts');
await fs.writeFile(file, 'export const answer = 42;\n');
await fs.writeFile(otherFile, 'export const other = 100;\n');
await fs.mkdir(path.join(project, 'src'));
await fs.writeFile(path.join(project, 'src', 'nested.ts'), 'export const nested = true;\n');
process.env.AOTUI_DATA_DIR = path.join(work, 'data');

const { createRuntime } = await import('@aotui/runtime');
const { AppCatalog } = await import('../src/app-distribution/app-catalog.js');
const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const browserInstallation = 'browser_installation';
const ideTool = (name: string) => 'system_ide-' + name;
const terminalTool = (name: string) => 'terminal-' + name;
const runtime = createRuntime();
const registry = new AppCatalog({ configPath: path.join(work, 'registry.json') });
const manager = new DesktopManager({ kernel: runtime, appCatalog: registry });
const facts: { passed: boolean; cases: string[]; calls: Array<Record<string, unknown>>; initialProjection?: unknown;
    initialPreview?: unknown; failure?: string; shutdown?: unknown } = { passed: false, cases: [], calls: [] };
let source: InstanceType<typeof SemanticAOTUIDrivenSource> | undefined;
let sequence = 0;
const contexts = new Set<any>();
const adoptedContexts = new WeakSet<object>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<h1>SEMANTIC_BROWSER_OK</h1><p>Current page fixture.</p>');
});

function content(context: any): string {
    return context.messages.map((message: any) => typeof message.content === 'string' ? message.content
        : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')).join('\n');
}
function instruction(context: any, appId: string): string {
    const root = modelViews(context.messages as Array<{ role: string; content: unknown; region: string }>)
        .find(view => view.id === 'root' && view.type === 'Root' && view.appId === appId);
    assert.ok(root, `Application Instruction for ${appId}`);
    assert.equal(root.message.region, 'static');
    return root.markup;
}
function tool(context: any, name: string): string {
    const apps = context.messages.find((message: any) => String(message.content).startsWith('<desktop>'));
    assert.ok(context.tools[name], `Expected ${name}. ${apps?.content ?? ''}`);
    return name;
}
function fileDetail(context: any, filePath: string) {
    const target = modelViews(context.messages).find(page =>
        page.appId === 'system_ide' && page.type === 'FileDetail' && page.markup.includes(filePath));
    assert.ok(target, 'Expected a FileDetail View for ' + filePath);
    return target;
}
async function observe() {
    const context = await source!.getContext();
    assert.equal(typeof context.executeTool, 'function', 'A context captures its own execution bindings');
    contexts.add(context);
    for (const page of modelViews(context.messages)) {
        if (page.type === 'Root') continue;
        assert.ok(!/^## Tools by ViewType\s*$/m.test(page.markup), 'Instance Views do not repeat the static tool catalog');
        assert.ok(!/<tool-ref\b/.test(page.markup), 'Instance Views do not render tool references');
    }
    return context;
}
function release(context: any) { context.release?.(); contexts.delete(context); }
async function switchContext(context: any) {
    await context.adopt();
    adoptedContexts.add(context);
}
async function invoke(context: any, name: string, args: unknown, expected = 'succeeded') {
    if (!adoptedContexts.has(context)) await switchContext(context);
    const result = await context.executeTool(tool(context, name), args, `semantic-e2e-${++sequence}`);
    assert.ok(result, 'Source owns the advertised tool');
    const status = result.outcomeStatus;
    assert.ok(!result.result || !Object.hasOwn(result.result, 'receipt'), 'Core receipts remain internal');
    facts.calls.push({ tool: name, status, error: result.error?.code });
    assert.equal(status, expected, `${name}: ${JSON.stringify(result)}`);
    if (expected === 'rejected' || expected === 'failed') assert.ok(result.error, 'Rejected/failed outcomes are errors');
    return result;
}
async function call(name: string, args: unknown) {
    const context = await observe();
    try { return await invoke(context, name, args); }
    finally { release(context); }
}
async function eventually(check: (context: any) => boolean, label: string) {
    const deadline = Date.now() + 20_000;
    while (true) {
        const context = await observe();
        if (check(context)) return context;
        release(context);
        assert.ok(Date.now() < deadline, `Timed out: ${label}`);
        await sleep(50);
    }
}
function pass(label: string) { facts.cases.push(label); console.log('PASS', label); }

try {
    await manager.initialize({ appEntries: [
        { name: 'system_ide', source: `local:${path.join(repo, 'demo-apps/aotui-ide')}`, enabled: true, autoStart: true },
        { name: 'terminal', source: `local:${path.join(repo, 'demo-apps/terminal-app')}`, enabled: true, autoStart: true },
        { name: browserInstallation, source: `local:${path.join(repo, 'demo-apps/lite-browser-app')}`, enabled: true, autoStart: false },
    ] });
    const desktop = await manager.createDesktop('semantic-default-e2e' as any, { projectPath: project });
    assert.equal(desktop.listApps().length, 3);
    source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: true });
    const preview = async () => {
        const { applications, diagnostics } = await readDesktopPreview(desktop);
        assert.deepEqual(diagnostics, []);
        return applications;
    };

    const initial = await eventually(context => !!context.tools[ideTool('multi_open_file')], 'IDE ready');
    assert.ok(!initial.tools[ideTool('edit_file')], 'No file edit tool before a FileDetail exists');
    assert.ok(initial.tools[terminalTool('new_terminal_and_send_command')]);
    assert.ok(!initial.tools[terminalTool('send_command_to_exist_terminal')]);
    for (const name of ['system_ide-multi_open_file', 'terminal-new_terminal_and_send_command', 'system-open_app', 'system-close_app'])
        assert.ok(initial.tools[name], `Public name: ${name}`);
    assert.ok(!initial.tools[ideTool('multi_open_file')].inputSchema.jsonSchema.properties.view_id);
    const workspace = modelViews(initial.messages).find(page =>
        page.appId === 'system_ide' && page.type === 'Workspace' && page.id === 'workspace')?.markup ?? '';
    assert.ok(workspace.includes('📁') && workspace.includes('project') && workspace.includes('Path: ' + project));
    assert.ok(workspace.includes('├── src/') && workspace.includes('└── other.ts'), 'Directory tree has hierarchy');
    assert.ok(workspace.includes('No files open.'));
    assert.ok(!workspace.includes('batch_edit'), 'Workspace contains current data rather than a tool catalog');
    const ideInstruction = instruction(initial, 'system_ide');
    assert.ok(ideInstruction.includes('### Workspace') && ideInstruction.includes('### FileDetail') && ideInstruction.includes('### SearchResult'));
    assert.ok(!initial.tools['system_ide-batch_edit']);
    assert.ok(!initial.tools['system_ide-close_search_view']);
    const terminalInstruction = instruction(initial, 'terminal');
    assert.match(terminalInstruction, /Select a live Terminal/);
    assert.ok(content(initial).includes('## System Logs'));
    facts.initialProjection = { messages: initial.messages, tools: Object.keys(initial.tools) };
    const initialPreview = await preview();
    assert.deepEqual(initialPreview.map(app => app.name), ['system_ide', 'terminal', 'lite_browser']);
    assert.ok(initialPreview[0].views.some(view => view.id === 'workspace'));
    assert.ok(initialPreview[1].views.some(view => view.id === 'term_console'));
    assert.equal(initialPreview[2].status, 'pending');
    assert.equal(initialPreview[2].installationId, browserInstallation);
    assert.equal(initialPreview[2].views.length, 0);
    facts.initialPreview = initialPreview;
    release(initial);
    pass('normal AppCatalog installation exposes multiple semantic apps without a dev flag');

    // Unknown keys grant no App capabilities.
    const registeredApps = await manager.getAppsConfig();
    const oldAgent = { id: 'old-agent', name: 'Old Agent', prompt: '', modelId: '', skin: {},
        enabledApps: ['aotui-ide', 'terminal-app', 'lite-browser-app'], enabledSkills: {}, enabledMCPs: [] };
    const broken = createSourceControlsFromAgent(oldAgent, Object.keys(registeredApps));
    applySourceControlsToSources(broken, { aotuiSource: source });
    const filtered = await observe();
    assert.equal(filtered.messages.filter((message: any) => String(message.content).startsWith('<view ')).length, 0);
    assert.deepEqual(Object.keys(filtered.tools).sort(), ['run_code', 'system-close_app', 'system-open_app']);
    assert.ok(content(filtered).includes('No applications enabled for this context.'));
    assert.equal((await preview()).length, 3, 'Inspection still sees installed apps');
    release(filtered);
    const selectedAgent = { ...oldAgent, enabledApps: ['system_ide', 'terminal', browserInstallation] };
    const fixed = createSourceControlsFromAgent(selectedAgent, Object.keys(registeredApps));
    assert.deepEqual(fixed.apps, appSourceControls(selectedAgent.enabledApps, Object.keys(registeredApps)), 'GUI and backend app controls agree');
    for (const name of Object.keys(registeredApps)) source.setAppEnabled(name, !fixed.apps.disabledItems.includes(name));
    applySourceControlsToSources(fixed, { aotuiSource: source });
    const restored = await observe();
    assert.ok(modelViews(restored.messages).some(page => page.type === 'Workspace' && page.id === 'workspace'));
    assert.ok(restored.tools['system_ide-multi_open_file']);
    assert.ok(restored.tools['terminal-new_terminal_and_send_command']);
    assert.ok(content(restored).includes('lite_browser'), 'Pending Browser remains discoverable');
    release(restored);
    source.setAppEnabled('terminal', false);
    const explicitlyDisabled = await observe();
    assert.ok(explicitlyDisabled.tools['system_ide-multi_open_file']);
    assert.ok(!Object.keys(explicitlyDisabled.tools).some(name => name.startsWith('terminal-')));
    assert.ok(!content(explicitlyDisabled).includes('app_name="terminal"'));
    release(explicitlyDisabled);
    source.setAppEnabled('terminal', true);
    pass('canonical App keys enable matching Messages and Tools and preserve explicit Topic disables');


    await call(ideTool('multi_open_dirs'), { dirPaths: [path.join(project, 'src')] });
    const expanded = await observe();
    assert.ok(content(expanded).includes('│   └── nested.ts'), 'Expanded directories retain tree guides');
    release(expanded);

    await call(ideTool('multi_open_file'), { filePaths: [file] });
    const opened = await observe();
    assert.ok(content(opened).includes('export const answer = 42;'), 'The next context sees the completed open');
    const firstDetail = fileDetail(opened, file).id;
    tool(opened, ideTool('edit_file'));
    tool(opened, ideTool('read_loaded_diagnostics'));
    assert.equal(instruction(opened, 'system_ide'), ideInstruction);
    assert.equal((await preview())[0].views.filter(view => view.content.includes('export const answer = 42;')).length, 1);
    pass('opening a file publishes its View and enables its local tools before the next observation');

    // Exercise the real default clock beyond the previous fixed 30-second expiry.
    await sleep(31_000);
    await invoke(opened, ideTool('read_loaded_diagnostics'), { view_id: firstDetail });
    release(opened);
    pass('a held observation remains callable after 31 seconds; diagnostics use its FileDetail view_id');

    await call(ideTool('edit_file'), { view_id: firstDetail, oldString: 'answer = 42', newString: 'answer = 43' });
    const edited = await observe();
    assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 43;\n');
    assert.ok(content(edited).includes('export const answer = 43;'));
    assert.ok(!content(edited).includes('export const answer = 42;'));
    assert.equal(instruction(edited, 'system_ide'), ideInstruction);
    assert.equal(edited.messages.filter((message: any) => JSON.stringify(message.content).includes('export const answer = 43;')).length, 1);
    const editedPreview = (await preview())[0].views;
    assert.equal(editedPreview.filter(view => view.content.includes('export const answer = 43;')).length, 1);
    assert.ok(!editedPreview.some(view => view.content.includes('export const answer = 42;')));
    await invoke(edited, ideTool('read_loaded_diagnostics'), { view_id: firstDetail });
    pass('editing replaces the current file projection with exactly one latest View');

    await call(ideTool('multi_open_file'), { filePaths: [otherFile] });
    const twoFiles = await observe();
    assert.ok(twoFiles.tools['system_ide-edit_file']);
    assert.equal(instruction(twoFiles, 'system_ide'), ideInstruction);
    assert.equal(Object.keys(twoFiles.tools).filter(name => name.endsWith('-edit_file')).length, 1);
    assert.deepEqual(twoFiles.tools['system_ide-edit_file'].inputSchema.jsonSchema, edited.tools['system_ide-edit_file'].inputSchema.jsonSchema, 'Opening another file does not change the Tool schema');
    const noTarget = await invoke(twoFiles, ideTool('edit_file'), { oldString: 'other = 100', newString: 'bad' }, 'rejected');
    assert.equal(noTarget.error?.code, 'TOOL_INVALID_ARGS');
    const otherViewId = fileDetail(twoFiles, otherFile).id;
    assert.notEqual(firstDetail, otherViewId);
    await invoke(twoFiles, ideTool('edit_file'), { view_id: otherViewId, oldString: 'other = 100', newString: 'other = 200' });
    assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 43;\n', 'First file is untouched');
    assert.equal(await fs.readFile(otherFile, 'utf8'), 'export const other = 200;\n');
    const stale = await invoke(edited, ideTool('read_loaded_diagnostics'), { view_id: firstDetail }, 'rejected');
    assert.equal(stale.error?.code, 'SEMANTIC_CONTEXT_RELEASED');
    release(edited);
    await invoke(twoFiles, ideTool('multi_close_file'), { filePaths: [otherFile] });
    const closedFile = await invoke(twoFiles, ideTool('edit_file'),
        { view_id: otherViewId, oldString: 'other = 200', newString: 'other = 300' }, 'rejected');
    assert.equal(closedFile.error?.code, 'VIEW_INSTANCE_REVOKED');
    assert.equal(await fs.readFile(otherFile, 'utf8'), 'export const other = 200;\n');
    release(twoFiles);
    pass('one readable Tool routes two FileDetails correctly and rejects a closed target without retargeting');

    const lastOpen = await observe();
    await invoke(lastOpen, ideTool('multi_close_file'), { filePaths: [file] });
    const closed = await observe();
    assert.ok(!content(closed).includes('export const answer = 43;'));
    assert.ok(!closed.tools[ideTool('edit_file')]);
    assert.equal(instruction(closed, 'system_ide'), ideInstruction);
    assert.ok(!(await preview())[0].views.some(view => view.content.includes('export const answer = 43;')));
    release(closed);
    await invoke(lastOpen, ideTool('read_loaded_diagnostics'), { view_id: firstDetail }, 'rejected');
    await call(ideTool('multi_open_file'), { filePaths: [file] });
    const staleAfterReopen = await invoke(lastOpen, ideTool('read_loaded_diagnostics'), { view_id: firstDetail }, 'rejected');
    assert.equal(staleAfterReopen.error?.code, 'SEMANTIC_CONTEXT_RELEASED');
    release(lastOpen);
    pass('closing/reopening a file revokes its old binding without rebinding it to the new View');

    const createdTerminal = await call(terminalTool('new_terminal_and_send_command'), { command: "printf 'SEMANTIC_TERMINAL_OK\\n'" });
    const terminal = await eventually(context => content(context).includes('SEMANTIC_TERMINAL_OK') &&
        !!context.tools[terminalTool('send_command_to_exist_terminal')], 'terminal completion');
    const terminalId = (createdTerminal.result as any).view_id;
    assert.equal(instruction(terminal, 'terminal'), terminalInstruction);
    assert.equal(typeof terminalId, 'string');
    assert.ok(modelViews(terminal.messages).some(page => page.appId === 'terminal' && page.type === 'Terminal' && page.id === terminalId));
    const createdSecond = await invoke(terminal, terminalTool('new_terminal_and_send_command'), { command: "printf 'SECOND_TERMINAL_OK\\n'" });
    const secondId = (createdSecond.result as any).view_id;
    const twoTerminals = await eventually(context => content(context).includes('SECOND_TERMINAL_OK') &&
        !!context.tools[terminalTool('send_command_to_exist_terminal')], 'second terminal completion');
    assert.equal(instruction(twoTerminals, 'terminal'), terminalInstruction);
    const loadMore = terminalTool('load_more_output');
    assert.deepEqual(twoTerminals.tools[loadMore].inputSchema.jsonSchema, terminal.tools[loadMore].inputSchema.jsonSchema);
    assert.ok(modelViews(twoTerminals.messages).some(page => page.appId === 'terminal' && page.type === 'Terminal' && page.id === secondId));
    await invoke(twoTerminals, loadMore, { view_id: secondId, tail_lines: 10 });
    await invoke(twoTerminals, terminalTool('close_terminal'), { view_id: secondId });
    const closedTerminal = await invoke(twoTerminals, loadMore, { view_id: secondId, tail_lines: 10 }, 'rejected');
    assert.equal(closedTerminal.error?.code, 'VIEW_INSTANCE_REVOKED');
    release(twoTerminals);
    const remainingTerminal = await eventually(context =>
        !modelViews(context.messages).some(page => page.appId === 'terminal' && page.type === 'Terminal' && page.id === secondId),
        'second Terminal View removed');
    await invoke(remainingTerminal, loadMore, { view_id: terminalId, tail_lines: 10 });
    await invoke(remainingTerminal, terminalTool('close_terminal'), { view_id: terminalId });
    release(remainingTerminal);
    release(terminal);
    const terminalsClosed = await eventually(context => !context.tools[loadMore], 'last Terminal closed');
    assert.equal(instruction(terminalsClosed, 'terminal'), terminalInstruction);
    assert.ok(!terminalsClosed.tools[terminalTool('close_terminal')]);
    release(terminalsClosed);
    pass('Terminal runs through View-local tools and rejects a closed terminal binding');

    const installedBrowser = () => desktop.listApps().find(app => app.installationId === browserInstallation);
    assert.equal(installedBrowser()?.status, 'pending');
    assert.equal(installedBrowser()?.appId, undefined);
    const launched = await call('system-open_app', { installation_id: browserInstallation });
    const browserId = (launched.result as { app_id: string }).app_id;
    assert.equal(browserId, installedBrowser()?.appId);
    assert.equal(browserId, 'lite_browser');
    const fetchPage = browserId + '-fetch_url', closePage = browserId + '-close_page';
    const browser = await eventually(context => !!context.tools[fetchPage], 'lazy browser ready');
    assert.ok(!browser.tools[closePage]);
    const browserInstruction = instruction(browser, browserId);
    assert.match(browserInstruction, /Use open_result/);
    release(browser);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    await call(fetchPage, { url: `http://127.0.0.1:${address.port}/fixture`, format: 'text' });
    const page = await observe();
    assert.ok(content(page).includes('SEMANTIC_BROWSER_OK'));
    assert.equal(instruction(page, browserId), browserInstruction);
    assert.ok(modelViews(page.messages).some(view => view.appId === browserId && view.type === 'Page' && view.markup.includes('SEMANTIC_BROWSER_OK')));
    const browserPreview = (await preview()).find(app => app.installationId === browserInstallation);
    assert.equal(browserPreview?.status, 'running');
    assert.ok(browserPreview?.views.some(view => view.content.includes('SEMANTIC_BROWSER_OK')));
    await invoke(page, closePage, {});
    release(page);
    const stalePage = await invoke(page, closePage, {}, 'rejected');
    assert.equal(stalePage.error?.code, 'SEMANTIC_CONTEXT_RELEASED');
    const pageClosed = await eventually(context => !context.tools[closePage], 'Browser Page closed');
    assert.equal(instruction(pageClosed, browserId), browserInstruction);
    assert.ok(!modelViews(pageClosed.messages).some(view => view.appId === browserId && view.type === 'Page'));
    release(pageClosed);
    const browserClosed = await call('system-close_app', { app_id: browserId });
    assert.deepEqual(browserClosed.result, { success: true, app_id: browserId });
    assert.equal(installedBrowser()?.status, 'closed');
    assert.equal(installedBrowser()?.appId, undefined);
    assert.equal((await preview()).find(app => app.installationId === browserInstallation)?.status, 'closed');
    pass('a lazy Browser uses the same installation, discovery, invocation and View lifecycle');
    pass('workflow instructions remain available while View data and callable tools change');

    facts.passed = true;
} catch (error) {
    facts.failure = error instanceof Error ? error.stack : String(error);
    throw error;
} finally {
    for (const context of contexts) release(context);
    await source?.dispose();
    const shutdown = await runtime.beginClose().completion;
    facts.shutdown = shutdown;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const factsFile = process.argv[2];
    if (factsFile) await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
    console.log(JSON.stringify({ passed: facts.passed, cases: facts.cases.length, calls: facts.calls.length }));
    await fs.rm(work, { recursive: true, force: true });
    assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
    assert.equal(shutdown.resourcesReleased, true);
}
