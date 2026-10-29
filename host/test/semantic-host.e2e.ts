/** Real Workers + standard Host installation; no model credentials or external services required. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
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
const { SemanticAOTUIDrivenSource } = await import('@aotui/runtime/adapters');
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
function tool(context: any, name: string): string {
    const matches = Object.keys(context.tools).filter(key => key.includes(name));
    assert.equal(matches.length, 1, `Expected one ${name}; got ${matches.join(', ')}`);
    return matches[0]!;
}
async function observe() {
    const context = await source!.getContext();
    assert.equal(typeof context.executeTool, 'function', 'A context captures its own execution bindings');
    contexts.add(context);
    return context;
}
function release(context: any) { context.release?.(); contexts.delete(context); }
async function invoke(context: any, name: string, args: unknown, expected = 'succeeded') {
    const result = await context.executeTool(tool(context, name), args, `semantic-e2e-${++sequence}`);
    assert.ok(result, 'Source owns the advertised tool');
    const status = result.status ?? result.outcomeStatus ?? result.result?.receipt?.outcome?.status;
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
    assert.ok(!workspace.includes('batch_edit'), 'Disabled batch edit is absent from View affordances');
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

    await call('multi_open_dirs', { dirPaths: [path.join(project, 'src')] });
    const expanded = await observe();
    assert.ok(content(expanded).includes('│   └── nested.ts'), 'Expanded directories retain tree guides');
    release(expanded);

    await call('multi_open_file', { filePaths: [file] });
    const opened = await observe();
    assert.ok(content(opened).includes('export const answer = 42;'), 'The next context sees the completed open');
    tool(opened, 'edit_file');
    tool(opened, 'read_loaded_diagnostics');
    assert.equal((await preview())[0].views.filter(view => view.content.includes('export const answer = 42;')).length, 1);
    pass('opening a file publishes its View and enables its local tools before the next observation');

    // Exercise the real default clock beyond the previous fixed 30-second expiry.
    await sleep(31_000);
    await invoke(opened, 'read_loaded_diagnostics', {});
    release(opened);
    pass('a held observation remains callable after 31 seconds; ordinary-v1 diagnostics execute');

    await call('edit_file', { oldString: 'answer = 42', newString: 'answer = 43' });
    const edited = await observe();
    assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 43;\n');
    assert.ok(content(edited).includes('export const answer = 43;'));
    assert.ok(!content(edited).includes('export const answer = 42;'));
    assert.equal(edited.messages.filter((message: any) => JSON.stringify(message.content).includes('export const answer = 43;')).length, 1);
    const editedPreview = (await preview())[0].views;
    assert.equal(editedPreview.filter(view => view.content.includes('export const answer = 43;')).length, 1);
    assert.ok(!editedPreview.some(view => view.content.includes('export const answer = 42;')));
    pass('editing replaces the current file projection with exactly one latest View');

    await call('multi_open_file', { filePaths: [otherFile] });
    const twoFiles = await observe();
    assert.ok(twoFiles.tools['system_ide-FileDetail-edit_file']);
    assert.equal(Object.keys(twoFiles.tools).filter(name => name.endsWith('-edit_file')).length, 1);
    const otherView = twoFiles.messages.find((message: any) => String(message.content).includes('export const other = 100;'));
    const otherViewId = /^<view id="([^"]+)"/.exec(String(otherView?.content))?.[1];
    assert.ok(otherViewId);
    await invoke(twoFiles, 'edit_file', { aotui_view_id: otherViewId, oldString: 'other = 100', newString: 'other = 200' });
    assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 43;\n', 'First file is untouched');
    assert.equal(await fs.readFile(otherFile, 'utf8'), 'export const other = 200;\n');
    await invoke(edited, 'read_loaded_diagnostics', {});
    await call('multi_close_file', { filePaths: [otherFile] });
    await invoke(twoFiles, 'edit_file', { aotui_view_id: otherViewId, oldString: 'other = 200', newString: 'other = 300' }, 'rejected');
    release(twoFiles);
    pass('one readable Tool routes two FileDetails correctly and rejects a closed target without retargeting');

    await call('multi_close_file', { filePaths: [file] });
    const closed = await observe();
    assert.ok(!content(closed).includes('export const answer = 43;'));
    assert.ok(!Object.keys(closed.tools).some(key => key.includes('edit_file')));
    assert.ok(!(await preview())[0].views.some(view => view.content.includes('export const answer = 43;')));
    release(closed);
    await invoke(edited, 'read_loaded_diagnostics', {}, 'rejected');
    await call('multi_open_file', { filePaths: [file] });
    await invoke(edited, 'read_loaded_diagnostics', {}, 'rejected');
    release(edited);
    pass('closing/reopening a file revokes its old binding without rebinding it to the new View');

    await call('new_terminal_and_send_command', { command: "printf 'SEMANTIC_TERMINAL_OK\\n'" });
    const terminal = await eventually(context => content(context).includes('SEMANTIC_TERMINAL_OK') &&
        Object.keys(context.tools).some(key => key.includes('send_command_to_exist_terminal')), 'terminal completion');
    await invoke(terminal, 'load_more_output', { tail_lines: 10 });
    await invoke(terminal, 'close_terminal', {});
    await invoke(terminal, 'load_more_output', { tail_lines: 10 }, 'rejected');
    release(terminal);
    pass('Terminal runs through View-local tools and rejects a closed terminal binding');

    const browserId = desktop.getInstalledApps().find(app => app.name === 'lite_browser')?.appId;
    assert.ok(browserId);
    await call('open_app', { app_id: browserId });
    const browser = await eventually(context => Object.keys(context.tools).some(key => key.includes('fetch_url')), 'lazy browser ready');
    assert.ok(!Object.keys(browser.tools).some(key => key.includes('close_page')));
    release(browser);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    await call('fetch_url', { url: `http://127.0.0.1:${address.port}/fixture`, format: 'text' });
    const page = await observe();
    assert.ok(content(page).includes('SEMANTIC_BROWSER_OK'));
    const browserPreview = (await preview()).find(app => app.name === 'lite_browser');
    assert.equal(browserPreview?.status, 'running');
    assert.ok(browserPreview?.views.some(view => view.content.includes('SEMANTIC_BROWSER_OK')));
    await invoke(page, 'close_page', {});
    await invoke(page, 'close_page', {}, 'rejected');
    release(page);
    pass('a lazy Browser uses the same installation, discovery, invocation and View lifecycle');

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
