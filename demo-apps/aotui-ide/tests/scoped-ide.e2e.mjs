import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repo, factsFile, facts, working, consumer, modules, apps, start, scope, snapshot, toolNames, viewText, fileView, invoke, close, eventually, runCase } from './ide-test-harness.mjs';

const workspaceTools = ['search_files_by_pattern', 'search_files_by_content', 'multi_open_file', 'multi_close_file', 'create_file',
    'batch_edit', 'multi_open_dirs', 'multi_close_dirs', 'add_folder_to_workspace', 'remove_folder_from_workspace', 'refresh_workspace'];
const fileMutations = ['write_file', 'edit_file', 'delete_file', 'rename_file'];
const languageTools = ['lsp_hover', 'lsp_goto_definition', 'lsp_find_references', 'lsp_get_diagnostics', 'lsp_document_symbol', 'lsp_incoming_calls', 'lsp_outgoing_calls'];
function panel(app, viewId, name) {
    const text = viewText(app, viewId);
    const section = text.split('### ' + name + '\n')[1];
    const json = section?.match(/```[^\n]*\n([\s\S]*?)\n```/);
    assert.ok(json, 'Expected structured View panel ' + name + ': ' + text);
    return JSON.parse(json[1]);
}
function assertJsonRecord(actual, expected, label) {
    assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual), label + ' is a record');
    const actualKeys = Reflect.ownKeys(actual);
    assert.ok(actualKeys.every(key => typeof key === 'string'), label + ' has only string keys');
    assert.deepEqual(actualKeys.sort(), Object.keys(expected).sort(), label + ' has the exact keys');
    for (const [key, value] of Object.entries(expected)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) assertJsonRecord(actual[key], value, label + '.' + key);
        else assert.equal(actual[key], value, label + '.' + key);
    }
}
async function inspectTools(app, viewId) {
    const client = scope(app);
    const observed = await client.observe({ viewIds: [viewId] });
    assert.equal(observed.status, 'observed', JSON.stringify(observed));
    client.releaseObservation(observed.observation.observationId);
    return observed.observation;
}
try {
    const root = path.join(working, 'workspace'), other = path.join(working, 'workspace-sibling');
    await fs.mkdir(path.join(root, 'src'), { recursive: true }); await fs.mkdir(other);
    const file = path.join(root, 'src/main.ts'), second = path.join(root, 'src/second.ts');
    const source = 'export function leaf(value: number): number { return value + 1; }\nexport function caller(): number { return leaf(1); }\nconst broken: number = "wrong";\n';
    await fs.writeFile(file, source); await fs.writeFile(second, 'export const sibling = 7;\n');
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
    const a = await start(root, 'a'), b = await start(root, 'b');
    await runCase('workspace discovery, ViewType Tool sharing, app-owned open-file check, exact range, two Apps', async () => {
        const initial = await inspectTools(a, 'workspace');
        assert.deepEqual(initial.tools.map(tool => tool.name).sort(), workspaceTools.filter(name => name !== 'batch_edit').sort());
        assert.equal(snapshot(a).views.filter(view => view.type === 'FileDetail').length, 0);
        assert.ok(!toolNames(a).includes('batch_edit'), 'batch_edit is unavailable while no file is loaded');
        for (const name of fileMutations) assert.ok(!toolNames(a).includes(name), name + ' is absent before a file is opened');
        await invoke(a, 'multi_open_file', { filePaths: [file] });
        assert.ok(toolNames(a).includes('batch_edit'), 'batch_edit becomes available after a file is loaded');
        const onlyA = snapshot(a).views.filter(view => view.type === 'FileDetail');
        assert.equal(onlyA.length, 1);
        const secondBefore = await fs.readFile(second, 'utf8');
        const rejectedB = await invoke(a, 'edit_file', { filePath: second, oldString: '7', newString: '8' }, {
            view: onlyA[0].id, status: 'failed', changes: false,
        });
        assert.equal(rejectedB.effects, 'none');
        assert.equal(rejectedB.details.result.error.code, 'IDE_FILE_NOT_LOADED', 'the app rejects b while only a is open');
        assert.equal(await fs.readFile(second, 'utf8'), secondBefore, 'the unopened b file is unchanged');
        await invoke(a, 'multi_close_file', { filePaths: [file] });
        assert.ok(!toolNames(a).includes('batch_edit'), 'batch_edit is withdrawn after the last loaded file closes');
        await invoke(a, 'multi_open_file', { filePaths: [file, second, file], offset: 1, limit: 1 });
        const details = snapshot(a).views.filter(view => view.type === 'FileDetail');
        assert.equal(details.length, 2); assert.equal(new Set(details.map(view => view.id)).size, 2);
        const activations = new Map();
        for (const detail of details) {
            const observed = await inspectTools(a, detail.id);
            for (const name of fileMutations) {
                const tool = observed.tools.find(tool => tool.name === name); assert.ok(tool, name + ' belongs to the loaded FileDetail');
                assert.equal(tool.viewType, 'FileDetail');
                assert.equal(tool.execution.kind, 'view-type', 'ordinary FileDetail Tools bind to the ViewType');
                assert.ok(!Object.hasOwn(tool.execution, 'targets'), 'ordinary ViewType Tools have no per-instance target');
                const priorActivation = activations.get(name);
                if (priorActivation === undefined) activations.set(name, tool.execution.activationId);
                else assert.equal(tool.execution.activationId, priorActivation, name + ' uses the same activation across FileDetail instances');
                const binding = observed.bindings.find(binding => binding.toolId === tool.id);
                assert.deepEqual(binding?.execution, tool.execution, 'the observation binds the shared ViewType activation');
                assert.equal(observed.bindings.filter(binding => binding.toolId === tool.id).length, 1);
                const targetParam = name === 'rename_file' ? 'oldPath' : 'filePath';
                assert.ok(tool.inputSchema.required.includes(targetParam));
            }
        }
        const workspace = await inspectTools(a, 'workspace');
        assert.deepEqual(workspace.tools.map(tool => tool.name).sort(), [...workspaceTools].sort());
        assert.ok(workspace.tools.some(tool => tool.name === 'batch_edit'), 'Batch editing becomes available after files are loaded');
        assert.match(viewText(a, fileView(a, file).id), /00002\|/); assert.doesNotMatch(viewText(a, fileView(a, file).id), /00001\|/);
        assert.equal(snapshot(b).views.filter(view => view.type === 'FileDetail').length, 0);
        await invoke(a, 'multi_open_dirs', { dirPaths: [path.join(root, 'src')] });
        await invoke(a, 'multi_close_dirs', { dirPaths: [path.join(root, 'src')] });
        await invoke(a, 'refresh_workspace', {}, { changes: false });
        await invoke(a, 'add_folder_to_workspace', { folderPath: other });
        await invoke(a, 'remove_folder_from_workspace', { folderPath: root });
        assert.match(viewText(a, 'workspace'), new RegExp(other));
        await invoke(a, 'add_folder_to_workspace', { folderPath: root });
        await invoke(a, 'multi_open_file', { filePaths: [file, second] });
    });
    await runCase('real TypeScript seven queries, current document changes, readonly diagnostic slice', async () => {
        await invoke(b, 'multi_open_file', { filePaths: [second] });
        const otherApp = await invoke(b, 'lsp_hover', { file_path: second, line: 1, character: 14 }, { view: fileView(b, second).id });
        assert.ok(panel(b, fileView(b, second).id, 'hover').value); assert.equal(snapshot(b).views.filter(view => view.type === 'FileDetail').length, 1);
        const otherFile = path.join(other, 'other.ts'); await fs.writeFile(otherFile, 'export const otherRoot = "other";\n');
        await invoke(a, 'multi_open_file', { filePaths: [otherFile] });
        await invoke(a, 'lsp_hover', { file_path: otherFile, line: 1, character: 16 }, { view: fileView(a, otherFile).id });
        assert.ok(panel(a, fileView(a, otherFile).id, 'hover').value);
        let view = fileView(a, file).id;
        const queries = [
            ['lsp_hover', { file_path: file, line: 1, character: 18 }],
            ['lsp_goto_definition', { file_path: file, line: 2, character: 43 }],
            ['lsp_find_references', { file_path: file, line: 1, character: 18 }],
            ['lsp_get_diagnostics', { file_path: file }],
            ['lsp_document_symbol', { file_path: file }],
            ['lsp_incoming_calls', { file_path: file, line: 1, character: 18 }],
            ['lsp_outgoing_calls', { file_path: file, line: 2, character: 18 }],
        ];
        const client = scope(a), observation = (await client.observe({ viewIds: [view] })).observation;
        assert.equal(client.adoptObservation(observation.observationId).status, 'adopted');
        try {
            for (const [name, args] of queries) {
                const outcome = await invoke(a, name, args, { view, client, observation });
                const kind = ({ lsp_hover: 'hover', lsp_goto_definition: 'definition', lsp_find_references: 'references', lsp_get_diagnostics: 'diagnostics', lsp_document_symbol: 'symbols', lsp_incoming_calls: 'incoming', lsp_outgoing_calls: 'outgoing' })[name];
                assert.ok(JSON.stringify(panel(a, view, kind).value).length > 2, name + ' has a real nonempty View result');
                assert.equal(outcome.value.data.value, undefined, 'Business results are only in Views');
                assert.equal(outcome.value.data.view_id, view);
            }
        } finally { client.releaseObservation(observation.observationId); }
        let loaded = await invoke(a, 'read_loaded_diagnostics', { filePath: file }, { view, changes: false });
        assert.ok(panel(a, view, 'diagnostics').value.some(d => d.code === 2322));
        await invoke(a, 'edit_file', { filePath: file, oldString: '"wrong"', newString: '1' }, { view: fileView(a, file).id });
        assert.match(await fs.readFile(file, 'utf8'), /const broken: number = 1;/, 'the opened file was edited by the shared FileDetail Tool');
        view = fileView(a, file).id;
        const fresh = await invoke(a, 'lsp_get_diagnostics', { file_path: file }, { view });
        assert.equal(panel(a, view, 'diagnostics').value.some(d => d.code === 2322), false);
        loaded = await invoke(a, 'read_loaded_diagnostics', { filePath: file }, { view, changes: false });
        assert.equal(panel(a, view, 'diagnostics').value.some(d => d.code === 2322), false);
        const selectedB = await invoke(a, 'lsp_hover', { file_path: second, line: 1, character: 14 }, { view });
        assert.equal(selectedB.value.data.view_id, fileView(a, second).id, 'the shared Tool selects any opened business path and reports its actual View');
        assert.ok(panel(a, fileView(a, second).id, 'hover').value, 'LSP output appears in the selected file View, not the invoking file View');
    });
    await runCase('search completeness, complete View-owned contracts and ViewType exclusive creation', async () => {
        await invoke(a, 'search_files_by_pattern', { pattern: '**/*.ts' });
        assert.deepEqual([...new Set(toolNames(a))].sort(), [...workspaceTools, ...fileMutations, ...languageTools,
            'close_file_detail', 'close_search_view', 'read_loaded_diagnostics', 'create_file_if_absent'].sort());
        await invoke(a, 'close_search_view', { view_id: 'search' }, { view: 'search' });
        await invoke(a, 'search_files_by_content', { pattern: 'caller\\(', include: '**/*.ts' });
        await eventually(() => viewText(a, 'search').includes('close_search_view'), 'SearchResult Tool UI publication');
        const before = viewText(a, 'search');
        await invoke(a, 'search_files_by_content', { pattern: '[' }, { status: 'failed', changes: false });
        assert.equal(viewText(a, 'search'), before);
        const createView = snapshot(a).views.find(view => view.type === 'WorkspaceCreate' && view.name === 'Workspace: ' + root).id;
        const relativePath = 'src/slice.ts', target = path.join(root, relativePath), content = 'export const 雪 = "😀";\n';
        const created = await invoke(a, 'create_file_if_absent', { workspacePath: root, relativePath, content }, { view: createView });
        assertJsonRecord(created.value, { success: true, data: {
            filePath: target, bytesWritten: Buffer.byteLength(content),
            message: 'create_file_if_absent completed. Read the current IDE Views for the updated state.', view_id: 'workspace',
        } }, 'created file receipt');
        assert.equal(await fs.readFile(target, 'utf8'), content);
        const duplicate = await invoke(a, 'create_file_if_absent', { workspacePath: root, relativePath, content: 'overwrite' }, { view: createView, status: 'failed', changes: false });
        assert.equal(duplicate.effects, 'none');
        assertJsonRecord(duplicate.details.result, { success: false, error: { code: 'RESOURCE_ALREADY_EXISTS', message: 'Target already exists' } }, 'duplicate file result');
        assert.equal(await fs.readFile(target, 'utf8'), content, 'A duplicate request never overwrites the created file');
        const missingParent = await invoke(a, 'create_file_if_absent', { workspacePath: root, relativePath: 'missing/slice.ts', content }, { view: createView, status: 'failed', changes: false });
        assert.equal(missingParent.effects, 'none');
        assertJsonRecord(missingParent.details.result, { success: false, error: { code: 'RESOURCE_PARENT_UNAVAILABLE', message: 'Target parent must already exist' } }, 'missing parent result');
        await assert.rejects(fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
    });
    await runCase('observed writes, ordered batch, rename identity, stale same-content inode and deletes', async () => {
        await invoke(a, 'write_file', { filePath: second, content: 'export const sibling = 8;\n' }, { view: fileView(a, second).id });
        await invoke(a, 'batch_edit', { edits: [{ filePath: second, oldString: '8', newString: '9' }, { filePath: second, oldString: '9', newString: '10' }] });
        assert.match(await fs.readFile(second, 'utf8'), /10/);
        // A two-item batch can publish its first commit before the final one.
        // Wait for the actual final content before starting the next edit.
        await eventually(() => viewText(a, fileView(a, second).id).includes('export const sibling = 10;'), 'complete batch snapshot');
        const created = path.join(root, 'new/deep/file.ts');
        await invoke(a, 'create_file', { filePath: created, content: 'export const created = true;\n' });
        const renamed = path.join(root, 'move/nested/file.ts'), beforeView = fileView(a, created);
        await invoke(a, 'rename_file', { oldPath: created, newPath: renamed }, { view: beforeView.id });
        assert.equal(fileView(a, renamed).id, beforeView.id); assert.equal(fileView(a, renamed).viewInstanceId, beforeView.viewInstanceId);
        const renamedView = fileView(a, renamed), content = await fs.readFile(renamed), stale = scope(a);
        const observed = await stale.observe({ viewIds: [renamedView.id] });
        assert.equal(observed.status, 'observed', JSON.stringify(observed));
        const observation = observed.observation;
        assert.equal(stale.adoptObservation(observation.observationId).status, 'adopted');
        const writeTool = observation.tools.find(tool => tool.name === 'write_file');
        assert.equal(writeTool.execution.kind, 'view-type');
        assert.ok(observation.bindings.some(binding => binding.toolId === writeTool.id && binding.execution.kind === 'view-type' &&
            binding.execution.activationId === writeTool.execution.activationId), 'stale-write check is bound to the observed FileDetail Tool activation');
        const replacement = renamed + '.replacement'; await fs.writeFile(replacement, content); await fs.rename(replacement, renamed);
        try { await invoke(a, 'write_file', { filePath: renamed, content: 'bad' }, { view: renamedView.id, status: 'failed', changes: false, client: stale, observation }); }
        finally { stale.releaseObservation(observation.observationId); }
        assert.deepEqual(await fs.readFile(renamed), content);
        await invoke(a, 'multi_open_file', { filePaths: [renamed] }, { changes: false });
        await invoke(a, 'delete_file', { filePath: renamed }, { view: fileView(a, renamed).id });
        await assert.rejects(fs.stat(renamed), { code: 'ENOENT' });
        const absent = path.join(root, 'create/file.ts'); await invoke(a, 'create_file', { filePath: absent, content: 'absent only' });
        assert.equal(await fs.readFile(absent, 'utf8'), 'absent only');
        await invoke(a, 'close_file_detail', { view_id: fileView(a, absent).id }, { view: fileView(a, absent).id });
        await invoke(a, 'multi_close_file', { filePaths: [second, second] });
    });
    await runCase('shutdown, actual resource release, fresh Worker and managed restoration', async () => {
        const data = a.data, oldViews = snapshot(a).views.map(view => view.viewInstanceId);
        await close(a); await close(b);
        const restarted = await start(root, 'restored', { data, sessionKey: 'a', historyPath: path.join(working, 'history/a.json') });
        assert.notEqual(restarted.worker, a.worker);
        assert.ok(fileView(restarted, file)); assert.ok(!fileView(restarted, second));
        assert.ok(snapshot(restarted).views.every(view => !oldViews.includes(view.viewInstanceId)));
        await close(restarted);
    });
    facts.passed = true;
} catch (error) {
    facts.failure = { message: String(error), stack: error.stack };
    console.error(error); process.exitCode = 1;
} finally {
    for (const app of apps) if (!app.closed) {
        try { await app.host.close(); } catch (error) { facts.cleanup.push({ id: app.id, failedCleanup: String(error), report: app.host.getResourceReport() }); }
        app.host.terminate(); await app.host.waitForResourceRelease();
    }
    facts.resourceLogs = apps.map(app => ({ id: app.id, logs: app.logs }));
    facts.finishedAt = new Date().toISOString(); facts.working = working;
    if (factsFile) { await fs.mkdir(path.dirname(factsFile), { recursive: true }); await fs.writeFile(factsFile, JSON.stringify(facts, null, 2)); }
    console.log('IDE_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length, calls: facts.calls.length, factsFile, working }));
}
