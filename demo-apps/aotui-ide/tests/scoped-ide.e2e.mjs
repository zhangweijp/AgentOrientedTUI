import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repo, factsFile, facts, working, consumer, modules, apps, start, scope, snapshot, toolNames, viewText, fileView, invoke, close, eventuallyProjected, runCase } from './ide-test-harness.mjs';

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
    const prepared = await client.prepare();
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    const { observation } = prepared.candidate;
    prepared.candidate.discard();
    const view = observation.views.find(view => view.id === viewId);
    assert.ok(view, 'Expected to observe ' + viewId);
    return { ...observation, tools: observation.tools.filter(tool =>
        tool.viewType === view.type && (!tool.eligibleViewIds || tool.eligibleViewIds.includes(viewId))) };
}
try {
    const root = path.join(working, 'workspace'), other = path.join(working, 'workspace-sibling');
    await fs.mkdir(path.join(root, 'src'), { recursive: true }); await fs.mkdir(other);
    const file = path.join(root, 'src/main.ts'), second = path.join(root, 'src/second.ts');
    const source = 'export function leaf(value: number): number { return value + 1; }\nexport function caller(): number { return leaf(1); }\nconst broken: number = "wrong";\n';
    await fs.writeFile(file, source); await fs.writeFile(second, 'export const sibling = 7;\n');
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
    let a = await start(root, 'a');
    const b = await start(root, 'b');
    const historyPath = path.join(working, 'history/a.json');
    await runCase('workspace discovery, ViewType Tool sharing, app-owned open-file check, exact range, two Apps', async () => {
        const initial = await inspectTools(a, 'workspace');
        assert.deepEqual(initial.tools.map(tool => tool.name).sort(), workspaceTools.filter(name => name !== 'batch_edit').sort());
        assert.equal(snapshot(a).views.filter(view => view.type === 'FileDetail').length, 0);
        assert.ok(!toolNames(a).includes('batch_edit'), 'batch_edit is unavailable while no file is loaded');
        for (const name of fileMutations) assert.ok(!toolNames(a).includes(name), name + ' is absent before a file is opened');
        assert.match(viewText(a, 'root'), /### FileDetail[\s\S]*?edit_file/, 'Root lists registered FileDetail tools before any file opens');
        await invoke(a, 'multi_open_file', { filePaths: [file] });
        assert.ok(toolNames(a).includes('batch_edit'), 'batch_edit becomes available after a file is loaded');
        const onlyA = snapshot(a).views.filter(view => view.type === 'FileDetail');
        assert.equal(onlyA.length, 1);
        const secondBefore = await fs.readFile(second, 'utf8');
        const rejectedB = await invoke(a, 'edit_file', { filePath: second, oldString: '7', newString: '8' }, {
            view: onlyA[0].id, status: 'rejected', changes: false,
        });
        assert.equal(Object.hasOwn(rejectedB, 'effects'), false);
        assert.equal(rejectedB.code, 'TOOL_INVALID_ARGS', 'Runtime refuses a path override for the selected View');
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
                const activation = detail.toolBindings.find(binding => binding.toolId === tool.id)?.activationId;
                assert.ok(activation, name + ' is bound to this FileDetail');
                const previous = activations.get(name);
                if (previous === undefined) activations.set(name, activation);
                else assert.notEqual(activation, previous, name + ' has independent activation per FileDetail');
                assert.equal(observed.tools.filter(candidate => candidate.id === tool.id).length, 1);
                assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'filePath'));
                assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'oldPath'));
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
        const firstView = fileView(a, file).id, secondView = fileView(a, second).id;
        const firstText = viewText(a, firstView);
        const edited = await invoke(a, 'edit_file', { oldString: 'sibling = 7', newString: 'sibling = 8' }, { view: secondView });
        assert.equal(edited.value.data.view_id, secondView);
        assert.equal(await fs.readFile(second, 'utf8'), 'export const sibling = 8;\n');
        assert.equal(await fs.readFile(file, 'utf8'), source);
        await eventuallyProjected(a, () => viewText(a, secondView).includes('export const sibling = 8;'), 'edit published in second file View');
        assert.doesNotMatch(viewText(a, secondView), /export const sibling = 7;/);
        assert.equal(viewText(a, firstView), firstText);
        await invoke(a, 'edit_file', { oldString: 'sibling = 8', newString: 'sibling = 7' }, { view: secondView });
        await invoke(a, 'close_file_detail', {}, { view: firstView });
        assert.equal(toolNames(a).filter(name => name === 'edit_file').length, 1);
        await invoke(a, 'close_file_detail', {}, { view: secondView });
        assert.ok(!toolNames(a).includes('edit_file'), 'edit_file is withdrawn after the last FileDetail closes');
        assert.match(viewText(a, 'root'), /### FileDetail[\s\S]*?edit_file/);
        await invoke(a, 'multi_open_file', { filePaths: [file, second] });
    });
    await runCase('real TypeScript seven queries, current document changes, readonly diagnostic slice', async () => {
        await invoke(b, 'multi_open_file', { filePaths: [second] });
        const otherApp = await invoke(b, 'lsp_hover', { line: 1, character: 14 }, { view: fileView(b, second).id });
        assert.ok(panel(b, fileView(b, second).id, 'hover').value); assert.equal(snapshot(b).views.filter(view => view.type === 'FileDetail').length, 1);
        const otherFile = path.join(other, 'other.ts'); await fs.writeFile(otherFile, 'export const otherRoot = "other";\n');
        await invoke(a, 'multi_open_file', { filePaths: [otherFile] });
        await invoke(a, 'lsp_hover', { line: 1, character: 16 }, { view: fileView(a, otherFile).id });
        assert.ok(panel(a, fileView(a, otherFile).id, 'hover').value);
        let view = fileView(a, file).id;
        const queries = [
            ['lsp_hover', { line: 1, character: 18 }],
            ['lsp_goto_definition', { line: 2, character: 43 }],
            ['lsp_find_references', { line: 1, character: 18 }],
            ['lsp_get_diagnostics', {}],
            ['lsp_document_symbol', {}],
            ['lsp_incoming_calls', { line: 1, character: 18 }],
            ['lsp_outgoing_calls', { line: 2, character: 18 }],
        ];
        const client = scope(a), prepared = await client.prepare();
        assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
        const { observation } = prepared.candidate;
        const turn = client.adopt(prepared.candidate);
        try {
            for (const [name, args] of queries) {
                const outcome = await invoke(a, name, args, { view, turn, observation });
                const kind = ({ lsp_hover: 'hover', lsp_goto_definition: 'definition', lsp_find_references: 'references', lsp_get_diagnostics: 'diagnostics', lsp_document_symbol: 'symbols', lsp_incoming_calls: 'incoming', lsp_outgoing_calls: 'outgoing' })[name];
                assert.ok(JSON.stringify(panel(a, view, kind).value).length > 2, name + ' has a real nonempty View result');
                assert.equal(outcome.value.data.value, undefined, 'Business results are only in Views');
                assert.equal(outcome.value.data.view_id, view);
            }
        } finally { turn.release(); }
        let loaded = await invoke(a, 'read_loaded_diagnostics', {}, { view, changes: false });
        assert.ok(panel(a, view, 'diagnostics').value.some(d => d.code === 2322));
        await invoke(a, 'edit_file', { oldString: '"wrong"', newString: '1' }, { view: fileView(a, file).id });
        assert.match(await fs.readFile(file, 'utf8'), /const broken: number = 1;/, 'the opened file was edited by the shared FileDetail Tool');
        view = fileView(a, file).id;
        const fresh = await invoke(a, 'lsp_get_diagnostics', {}, { view });
        assert.equal(panel(a, view, 'diagnostics').value.some(d => d.code === 2322), false);
        loaded = await invoke(a, 'read_loaded_diagnostics', {}, { view, changes: false });
        assert.equal(panel(a, view, 'diagnostics').value.some(d => d.code === 2322), false);
        const selectedB = await invoke(a, 'lsp_hover', { line: 1, character: 14 }, { view: fileView(a, second).id });
        assert.equal(selectedB.value.data.view_id, fileView(a, second).id, 'the shared Tool runs on the selected View instance');
        assert.ok(panel(a, fileView(a, second).id, 'hover').value, 'LSP output appears in the selected file View');
    });
    // Start a new receipt lifetime before the remaining scenarios while keeping the same saved workspace.
    await close(a);
    a = await start(root, 'a-after-lsp', { data: a.data, sessionKey: 'a', historyPath });
    await runCase('search completeness, complete View-owned contracts and ViewType exclusive creation', async () => {
        await invoke(a, 'search_files_by_pattern', { pattern: '**/*.ts' });
        assert.deepEqual([...new Set(toolNames(a))].sort(), [...workspaceTools, ...fileMutations, ...languageTools,
            'close_file_detail', 'close_search_view', 'read_loaded_diagnostics', 'create_file_if_absent'].sort());
        await invoke(a, 'close_search_view', {}, { view: 'search' });
        assert.equal(toolNames(a).includes('close_search_view'), false);
        await invoke(a, 'search_files_by_content', { pattern: 'caller\\(', include: '**/*.ts' });
        await eventuallyProjected(a, () => viewText(a, 'search').includes(file) && toolNames(a).includes('close_search_view'),
            'SearchResult matches and close Tool');
        const search = await inspectTools(a, 'search');
        assert.deepEqual(search.tools.map(tool => [tool.viewType, tool.name]), [['SearchResult', 'close_search_view']]);
        const before = viewText(a, 'search');
        assert.doesNotMatch(before, /close_search_view/);
        await invoke(a, 'search_files_by_content', { pattern: '[' }, { status: 'failed', changes: false });
        assert.equal(viewText(a, 'search'), before);
        const createView = snapshot(a).views.find(view => view.type === 'WorkspaceCreate' && view.name === 'Workspace: ' + root).id;
        const relativePath = 'src/slice.ts', target = path.join(root, relativePath), content = 'export const 雪 = "😀";\n';
        const created = await invoke(a, 'create_file_if_absent', { relativePath, content }, { view: createView, changes: false });
        assertJsonRecord(created.value, { success: true, data: {
            filePath: target, bytesWritten: Buffer.byteLength(content),
            message: 'create_file_if_absent completed. Read the current IDE Views for the updated state.', view_id: 'workspace',
        } }, 'created file receipt');
        assert.equal(await fs.readFile(target, 'utf8'), content);
        const duplicate = await invoke(a, 'create_file_if_absent', { relativePath, content: 'overwrite' }, { view: createView, status: 'failed', changes: false });
        assert.equal(Object.hasOwn(duplicate, 'effects'), false);
        assertJsonRecord(duplicate.details.result, { success: false, error: { code: 'RESOURCE_ALREADY_EXISTS', message: 'Target already exists' } }, 'duplicate file result');
        assert.equal(await fs.readFile(target, 'utf8'), content, 'A duplicate request never overwrites the created file');
        const missingParent = await invoke(a, 'create_file_if_absent', { relativePath: 'missing/slice.ts', content }, { view: createView, status: 'failed', changes: false });
        assert.equal(Object.hasOwn(missingParent, 'effects'), false);
        assertJsonRecord(missingParent.details.result, { success: false, error: { code: 'RESOURCE_PARENT_UNAVAILABLE', message: 'Target parent must already exist' } }, 'missing parent result');
        await assert.rejects(fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
    });
    await runCase('observed writes, ordered batch, rename identity, stale same-content inode and deletes', async () => {
        await invoke(a, 'write_file', { content: 'export const sibling = 8;\n' }, { view: fileView(a, second).id });
        await invoke(a, 'batch_edit', { edits: [{ filePath: second, oldString: '8', newString: '9' }, { filePath: second, oldString: '9', newString: '10' }] });
        assert.match(await fs.readFile(second, 'utf8'), /10/);
        // A two-item batch can publish its first commit before the final one.
        // Wait for the actual final content before starting the next edit.
        await eventuallyProjected(a, () => viewText(a, fileView(a, second).id).includes('export const sibling = 10;'), 'complete batch snapshot');
        const created = path.join(root, 'new/deep/file.ts');
        await invoke(a, 'create_file', { filePath: created, content: 'export const created = true;\n' });
        const renamed = path.join(root, 'move/nested/file.ts'), beforeView = fileView(a, created);
        const rename = await invoke(a, 'rename_file', { newPath: renamed }, { view: beforeView.id });
        assert.equal(fileView(a, renamed).id, beforeView.id); assert.equal(fileView(a, renamed).viewInstanceId, beforeView.viewInstanceId);
        assert.equal(rename.value.data.view_id, beforeView.id);
        const renamedView = fileView(a, renamed), content = await fs.readFile(renamed), stale = scope(a);
        const prepared = await stale.prepare();
        assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
        const { observation } = prepared.candidate;
        const turn = stale.adopt(prepared.candidate);
        const writeTool = observation.tools.find(tool => tool.name === 'write_file');
        assert.ok(writeTool);
        assert.ok(snapshot(a).views.find(view => view.id === renamedView.id)?.toolBindings.some(binding =>
            binding.toolId === writeTool.id), 'the observed file owns the write operation');
        const replacement = renamed + '.replacement'; await fs.writeFile(replacement, content); await fs.rename(replacement, renamed);
        try { await invoke(a, 'write_file', { content: 'bad' }, { view: renamedView.id, status: 'failed', changes: false, turn, observation }); }
        finally { turn.release(); }
        assert.deepEqual(await fs.readFile(renamed), content);
        await invoke(a, 'multi_open_file', { filePaths: [renamed] }, { changes: false });
        await invoke(a, 'delete_file', {}, { view: fileView(a, renamed).id });
        await assert.rejects(fs.stat(renamed), { code: 'ENOENT' });
        const absent = path.join(root, 'create/file.ts'); await invoke(a, 'create_file', { filePath: absent, content: 'absent only' });
        assert.equal(await fs.readFile(absent, 'utf8'), 'absent only');
        await invoke(a, 'close_file_detail', {}, { view: fileView(a, absent).id });
        await invoke(a, 'multi_close_file', { filePaths: [second, second] });
    });
    await runCase('shutdown, actual resource release, fresh Worker and managed restoration', async () => {
        const data = a.data, oldViews = snapshot(a).views.map(view => view.viewInstanceId);
        await close(a); await close(b);
        const restarted = await start(root, 'restored', { data, sessionKey: 'a', historyPath });
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
