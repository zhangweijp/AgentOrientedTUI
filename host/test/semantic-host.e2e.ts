/** Real Workers + standard Host installation; no model credentials or external services required. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { migrateAgentAppReferences } from '../src/config/app-reference-migration.js';
import { createSourceControlsFromAgent, applySourceControlsToSources } from '../src/core/source-controls.js';
import { appSourceControls } from '../src/shared/source-control-keys.js';
import { parseTuiSnapshot } from '../src/gui/components/TuiParser.js';

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
delete process.env.AOTUI_HOST_SEMANTIC_DEV;
delete process.env.AOTUI_HOST_SEMANTIC_PROJECT;
delete process.env.AOTUI_HOST_SEMANTIC_DATA;

const { createRuntime, AppRegistry } = await import('@aotui/runtime');
const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const runtime = createRuntime();
const registry = new AppRegistry({ configPath: path.join(work, 'registry.json') });
const manager = new DesktopManager({ kernel: runtime, appRegistry: registry });
const facts: { passed: boolean; cases: string[]; calls: Array<Record<string, unknown>>; initialProjection?: unknown; initialPreview?: unknown } = { passed: false, cases: [], calls: [] };
let source: InstanceType<typeof SemanticAOTUIDrivenSource> | undefined;
let sequence = 0;
const contexts = new Set<any>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<h1>SEMANTIC_BROWSER_OK</h1><p>Current page fixture.</p>');
});

function content(context: any): string {
    return context.messages.map((message: any) => typeof message.content === 'string' ? message.content
        : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')).join('\n');
}
function instruction(context: any, appName: string): string {
    const message = context.messages.find((message: any) => String(message.content).startsWith('<view id="root"') &&
        String(message.content).includes(`app_name="${appName}"`));
    assert.ok(message, `Application Instruction for ${appName}`);
    assert.equal(message.region, 'static');
    return String(message.content);
}
function tool(context: any, name: string): string {
    const matches = Object.keys(context.tools).filter(key => key.includes(name));
    assert.equal(matches.length, 1, `Expected one ${name}; got ${matches.join(', ')}`);
    return matches[0]!;
}
async function observe() {
    const context = await source!.getContext();
    assert.equal(typeof context.executeTool, 'function', 'A context captures its own execution bindings');
    contexts.add(context);
    for (const message of context.messages) {
        const text = String(message.content);
        if (text.startsWith('<view ') && !text.startsWith('<view id="root"')) {
            assert.ok(!/^#{1,6} Available Tools\s*$/m.test(text), 'Instance Views do not repeat the static tool catalog');
            assert.ok(!/<tool-ref\b/.test(text), 'Instance Views do not render tool references');
        }
    }
    return context;
}
function release(context: any) { context.release?.(); contexts.delete(context); }
async function invoke(context: any, name: string, args: unknown, expected = 'succeeded') {
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
        { name: 'lite_browser', source: `local:${path.join(repo, 'demo-apps/lite-browser-app')}`, enabled: true, autoStart: false },
    ] });
    const info = await manager.createDesktop('semantic-default-e2e' as any, { projectPath: project });
    const desktop = manager.getDesktop(info.desktopId)!;
    assert.equal(info.thirdPartyAppCount, 3);
    const forbidden = () => { throw new Error('LEGACY_INTERACTION_USED'); };
    runtime.acquireSnapshot = forbidden;
    runtime.execute = forbidden;
    desktop.getSnapshotFragments = forbidden;
    source = new SemanticAOTUIDrivenSource(desktop, runtime, { includeInstruction: true });
    const preview = async () => {
        const markup = await manager.getSnapshot(info.desktopId);
        assert.ok(markup, 'Host returns preview markup');
        const parsed = parseTuiSnapshot(markup);
        assert.deepEqual(parsed.parseErrors, []);
        assert.ok(parsed.desktop);
        return parsed.desktop.applications;
    };

    const initial = await eventually(context => Object.keys(context.tools).some(key => key.includes('multi_open_file')), 'IDE ready');
    assert.ok(!Object.keys(initial.tools).some(key => key.includes('edit_file')), 'No file edit tool before a FileDetail exists');
    assert.ok(Object.keys(initial.tools).some(key => key.includes('new_terminal_and_send_command')));
    assert.ok(!Object.keys(initial.tools).some(key => key.includes('send_command_to_exist_terminal')));
    for (const name of ['system_ide-Workspace-multi_open_file', 'terminal-TerminalConsole-new_terminal_and_send_command', 'system-open_app', 'system-close_app'])
        assert.ok(initial.tools[name], `Public name: ${name}`);
    for (const message of initial.messages.filter((message: any) => String(message.content).startsWith('<view '))) {
        assert.equal(String(message.content).match(/<view\b/g)?.length, 1, 'One View envelope');
        assert.ok(!/ instance=| revision=/.test(String(message.content)), 'Internal identity stays out of presentation');
        if (String(message.content).includes('id="root"')) assert.equal(message.region, 'static');
    }
    const workspace = String(initial.messages.find((message: any) => String(message.content).startsWith('<view id="workspace"'))?.content);
    assert.ok(workspace.includes('📁') && workspace.includes('project') && workspace.includes('Path: ' + project));
    assert.ok(workspace.includes('├── src/') && workspace.includes('└── other.ts'), 'Directory tree has hierarchy');
    assert.ok(workspace.includes('No files open.'));
    assert.ok(!workspace.includes('batch_edit'), 'Workspace contains current data rather than a tool catalog');
    const ideInstruction = instruction(initial, 'system_ide');
    assert.ok(ideInstruction.includes('### Workspace') && ideInstruction.includes('### FileDetail') && ideInstruction.includes('### SearchResult'));
    assert.equal(ideInstruction.match(/^#### Available Tools$/gm)?.length, 3, 'One catalog per IDE View Type');
    assert.ok(ideInstruction.includes('- edit_file') && ideInstruction.includes('- batch_edit') && ideInstruction.includes('- close_search_view'),
        'The static catalog includes tools whose Views or enabling state do not exist yet');
    assert.ok(!initial.tools['system_ide-Workspace-batch_edit']);
    assert.ok(!initial.tools['system_ide-SearchResult-close_search_view']);
    const terminalInstruction = instruction(initial, 'terminal');
    assert.equal(terminalInstruction.match(/^#### Available Tools$/gm)?.length, 2);
    assert.ok(terminalInstruction.includes('- send_command_to_exist_terminal'));
    assert.ok(content(initial).includes('## System Logs'));
    facts.initialProjection = { messages: initial.messages, tools: Object.keys(initial.tools) };
    const initialPreview = await preview();
    assert.deepEqual(initialPreview.map(app => app.name), ['system_ide', 'terminal', 'lite_browser']);
    assert.ok(initialPreview[0].views.some(view => view.id === 'workspace'));
    assert.ok(initialPreview[1].views.some(view => view.id === 'term_console'));
    assert.equal(initialPreview[2].status, 'pending');
    assert.equal(initialPreview[2].views.length, 0);
    facts.initialPreview = initialPreview;
    release(initial);
    pass('normal AppRegistry installation exposes multiple semantic apps without a dev flag');

    // Reproduce the real failure with an old Agent template and installed Workers.
    const registeredApps = await manager.getAppsConfig();
    const oldAgent = { id: 'old-agent', name: 'Old Agent', prompt: '', modelId: '', skin: {},
        enabledApps: ['aotui-ide', 'terminal-app', 'lite-browser-app'], enabledSkills: {}, enabledMCPs: [] };
    const broken = createSourceControlsFromAgent(oldAgent, {}, Object.keys(registeredApps));
    applySourceControlsToSources(broken, { aotuiSource: source });
    const filtered = await observe();
    assert.equal(filtered.messages.filter((message: any) => String(message.content).startsWith('<view ')).length, 0);
    assert.deepEqual(Object.keys(filtered.tools), []);
    assert.ok(content(filtered).includes('No applications enabled for this context.'));
    assert.equal((await preview()).length, 3, 'Inspection still sees installed apps');
    release(filtered);
    const migrated = migrateAgentAppReferences({ agents: { list: [oldAgent] } }, registeredApps,
        { 'aotui-ide': 'system_ide', 'terminal-app': 'terminal', 'lite-browser-app': 'lite_browser' });
    const selectedAgent = migrated.config.agents!.list[0];
    const fixed = createSourceControlsFromAgent(selectedAgent, {}, Object.keys(registeredApps));
    assert.deepEqual(fixed.apps, appSourceControls(selectedAgent.enabledApps, Object.keys(registeredApps)), 'GUI and backend app controls agree');
    for (const name of Object.keys(registeredApps)) source.setAppEnabled(name, !fixed.apps.disabledItems.includes(name));
    applySourceControlsToSources(fixed, { aotuiSource: source });
    const restored = await observe();
    assert.ok(restored.messages.some((message: any) => String(message.content).includes('id="workspace"')));
    assert.ok(restored.tools['system_ide-Workspace-multi_open_file']);
    assert.ok(restored.tools['terminal-TerminalConsole-new_terminal_and_send_command']);
    assert.ok(content(restored).includes('lite_browser'), 'Pending Browser remains discoverable');
    release(restored);
    source.setAppEnabled('terminal', false);
    const explicitlyDisabled = await observe();
    assert.ok(explicitlyDisabled.tools['system_ide-Workspace-multi_open_file']);
    assert.ok(!Object.keys(explicitlyDisabled.tools).some(name => name.startsWith('terminal-')));
    assert.ok(!content(explicitlyDisabled).includes('app_name="terminal"'));
    release(explicitlyDisabled);
    source.setAppEnabled('terminal', true);
    pass('old Agent configuration migrates to matching Messages/Tools and preserves explicit Topic disables');


    await call('multi_open_dirs', { dirPaths: [path.join(project, 'src')] });
    const expanded = await observe();
    assert.ok(content(expanded).includes('│   └── nested.ts'), 'Expanded directories retain tree guides');
    release(expanded);

    await call('multi_open_file', { filePaths: [file] });
    const opened = await observe();
    assert.ok(content(opened).includes('export const answer = 42;'), 'The next context sees the completed open');
    tool(opened, 'edit_file');
    tool(opened, 'read_loaded_diagnostics');
    assert.equal(instruction(opened, 'system_ide'), ideInstruction, 'Opening a file does not rewrite the catalog');
    assert.equal((await preview())[0].views.filter(view => view.content.includes('export const answer = 42;')).length, 1);
    pass('opening a file publishes its View and enables its local tools before the next observation');

    // Exercise the real default clock beyond the previous fixed 30-second expiry.
    await sleep(31_000);
    await invoke(opened, 'read_loaded_diagnostics', { filePath: file });
    release(opened);
    pass('a held observation remains callable after 31 seconds; read-only diagnostics execute with a stable filePath');

    await call('edit_file', { filePath: file, oldString: 'answer = 42', newString: 'answer = 43' });
    const edited = await observe();
    assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 43;\n');
    assert.ok(content(edited).includes('export const answer = 43;'));
    assert.ok(!content(edited).includes('export const answer = 42;'));
    assert.equal(instruction(edited, 'system_ide'), ideInstruction, 'Editing data does not rewrite the catalog');
    assert.equal(edited.messages.filter((message: any) => JSON.stringify(message.content).includes('export const answer = 43;')).length, 1);
    const editedPreview = (await preview())[0].views;
    assert.equal(editedPreview.filter(view => view.content.includes('export const answer = 43;')).length, 1);
    assert.ok(!editedPreview.some(view => view.content.includes('export const answer = 42;')));
    pass('editing replaces the current file projection with exactly one latest View');

    await call('multi_open_file', { filePaths: [otherFile] });
    const twoFiles = await observe();
    assert.ok(twoFiles.tools['system_ide-FileDetail-edit_file']);
    assert.equal(instruction(twoFiles, 'system_ide'), ideInstruction, 'Multiple instances share one static catalog');
    assert.equal(Object.keys(twoFiles.tools).filter(name => name.endsWith('-edit_file')).length, 1);
    assert.deepEqual(twoFiles.tools['system_ide-FileDetail-edit_file'].inputSchema.jsonSchema, edited.tools['system_ide-FileDetail-edit_file'].inputSchema.jsonSchema, 'Opening another file does not change the Tool schema');
    await invoke(twoFiles, 'edit_file', { oldString: 'other = 100', newString: 'bad' }, 'rejected');
    const otherView = twoFiles.messages.find((message: any) => String(message.content).includes('export const other = 100;'));
    const otherViewId = /^<view id="([^"]+)"/.exec(String(otherView?.content))?.[1];
    assert.ok(otherViewId);
    await invoke(twoFiles, 'edit_file', { filePath: otherFile, oldString: 'other = 100', newString: 'other = 200' });
    assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 43;\n', 'First file is untouched');
    assert.equal(await fs.readFile(otherFile, 'utf8'), 'export const other = 200;\n');
    await invoke(edited, 'read_loaded_diagnostics', { filePath: file });
    await call('multi_close_file', { filePaths: [otherFile] });
    await invoke(twoFiles, 'edit_file', { filePath: otherFile, oldString: 'other = 200', newString: 'other = 300' }, 'rejected');
    release(twoFiles);
    pass('one readable Tool routes two FileDetails correctly and rejects a closed target without retargeting');

    await call('multi_close_file', { filePaths: [file] });
    const closed = await observe();
    assert.ok(!content(closed).includes('export const answer = 43;'));
    assert.ok(!Object.keys(closed.tools).some(key => key.includes('edit_file')));
    assert.equal(instruction(closed, 'system_ide'), ideInstruction, 'Closing the last file preserves the catalog but removes its tools');
    assert.ok(!(await preview())[0].views.some(view => view.content.includes('export const answer = 43;')));
    release(closed);
    await invoke(edited, 'read_loaded_diagnostics', { filePath: file }, 'rejected');
    await call('multi_open_file', { filePaths: [file] });
    await invoke(edited, 'read_loaded_diagnostics', { filePath: file }, 'rejected');
    release(edited);
    pass('closing/reopening a file revokes its old binding without rebinding it to the new View');

    const createdTerminal = await call('new_terminal_and_send_command', { command: "printf 'SEMANTIC_TERMINAL_OK\\n'" });
    const terminal = await eventually(context => content(context).includes('SEMANTIC_TERMINAL_OK') &&
        Object.keys(context.tools).some(key => key.includes('send_command_to_exist_terminal')), 'terminal completion');
    const terminalId = (createdTerminal.result as any).terminal_id;
    assert.equal(instruction(terminal, 'terminal'), terminalInstruction);
    assert.equal(typeof terminalId, 'string');
    const createdSecond = await call('new_terminal_and_send_command', { command: "printf 'SECOND_TERMINAL_OK\\n'" });
    const secondId = (createdSecond.result as any).terminal_id;
    const twoTerminals = await eventually(context => content(context).includes('SECOND_TERMINAL_OK') && Object.keys(context.tools).some(key => key.includes('send_command_to_exist_terminal')), 'second terminal completion');
    assert.equal(instruction(twoTerminals, 'terminal'), terminalInstruction);
    assert.deepEqual(twoTerminals.tools[tool(twoTerminals, 'load_more_output')].inputSchema.jsonSchema, terminal.tools[tool(terminal, 'load_more_output')].inputSchema.jsonSchema);
    await invoke(twoTerminals, 'load_more_output', { terminal_id: secondId, tail_lines: 10 });
    await invoke(twoTerminals, 'close_terminal', { terminal_id: secondId });
    await invoke(twoTerminals, 'load_more_output', { terminal_id: secondId, tail_lines: 10 }, 'rejected');
    release(twoTerminals);
    await invoke(terminal, 'load_more_output', { terminal_id: terminalId, tail_lines: 10 });
    await invoke(terminal, 'close_terminal', { terminal_id: terminalId });
    await invoke(terminal, 'load_more_output', { terminal_id: terminalId, tail_lines: 10 }, 'rejected');
    release(terminal);
    const terminalsClosed = await observe();
    assert.equal(instruction(terminalsClosed, 'terminal'), terminalInstruction);
    assert.ok(!Object.keys(terminalsClosed.tools).some(name => name.startsWith('terminal-Terminal-')));
    release(terminalsClosed);
    pass('Terminal runs through View-local tools and rejects a closed terminal binding');

    const browserId = desktop.getInstalledApps().find(app => app.name === 'lite_browser')?.appId;
    assert.ok(browserId);
    await call('open_app', { app_id: browserId });
    const browser = await eventually(context => Object.keys(context.tools).some(key => key.includes('fetch_url')), 'lazy browser ready');
    assert.ok(!Object.keys(browser.tools).some(key => key.includes('close_page')));
    const browserInstruction = instruction(browser, 'lite_browser');
    assert.equal(browserInstruction.match(/^#### Available Tools$/gm)?.length, 4);
    assert.ok(browserInstruction.includes('- close_page') && browserInstruction.includes('- open_result'));
    release(browser);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    await call('fetch_url', { url: `http://127.0.0.1:${address.port}/fixture`, format: 'text' });
    const page = await observe();
    assert.ok(content(page).includes('SEMANTIC_BROWSER_OK'));
    assert.equal(instruction(page, 'lite_browser'), browserInstruction);
    const browserPreview = (await preview()).find(app => app.name === 'lite_browser');
    assert.equal(browserPreview?.status, 'running');
    assert.ok(browserPreview?.views.some(view => view.content.includes('SEMANTIC_BROWSER_OK')));
    await invoke(page, 'close_page', {});
    await invoke(page, 'close_page', {}, 'rejected');
    release(page);
    const pageClosed = await observe();
    assert.equal(instruction(pageClosed, 'lite_browser'), browserInstruction);
    assert.ok(!Object.keys(pageClosed.tools).some(key => key.includes('close_page')));
    release(pageClosed);
    pass('a lazy Browser uses the same installation, discovery, invocation and View lifecycle');
    pass('static per-type catalogs stay in Application Instruction while instance data and callable tools change');

    facts.passed = true;
} finally {
    for (const context of contexts) release(context);
    await source?.dispose();
    await runtime.shutdown('semantic-default-e2e');
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const factsFile = process.argv[2];
    if (factsFile) await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
    console.log(JSON.stringify({ passed: facts.passed, cases: facts.cases.length, calls: facts.calls.length }));
    await fs.rm(work, { recursive: true, force: true });
}
