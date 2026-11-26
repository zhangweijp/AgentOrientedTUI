import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { apps, close, facts, factsFile, fileView, invoke, modules, runCase, scope, start, toolNames, viewText, working } from './ide-test-harness.mjs';

const fileViews = result => result.views.filter(view => view.type === 'FileDetail').map(view => view.id);
function activeFiles(app, key) {
    const data = JSON.parse(readFileSync(path.join(app.data, 'ide-sessions', key, 'session.json'), 'utf8'));
    return data.activeFiles;
}

try {
    await runCase('FileDetail opening preserves two accepted pages over the default observation limit', async () => {
        const root = path.join(working, 'workspace');
        await fs.mkdir(root);
        const [a, b, c] = ['a.txt', 'b.txt', 'c.txt'].map(file => path.join(root, file));
        const page = 'before-open-proof ' + 'x'.repeat(245 * 1024 - 18);
        await Promise.all([a, b, c].map(file => fs.writeFile(file, page)));
        const historyPath = path.join(working, 'admission-history.json');
        const app = await start(root, 'admission', { historyPath });
        await invoke(app, 'multi_open_file', { filePaths: [a, b] });
        const client = scope(app), prepared = await client.prepare();
        assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
        const initial = prepared.candidate.observation;
        const first = fileView(app, a);
        assert.ok(first);
        const turn = client.adopt(prepared.candidate);
        const tool = initial.tools.find(tool => tool.name === 'multi_open_file');
        const attempt = await turn.invoke(app.id, { invocationId: 'too-many-files', observationId: initial.observationId,
            toolId: tool.id, input: { filePaths: [c] } });
        const preview = await client.preview(), next = await client.prepare();
        const known = fileViews(initial);
        assert.deepEqual({
            outcome: attempt.kind === 'receipt' ? attempt.receipt.outcome.status : attempt.code,
            preview: preview.status === 'previewed' ? fileViews(preview) : preview.issue.code,
            observation: next.status === 'prepared' ? fileViews(next.candidate.observation) : next.issue.code,
        }, { outcome: 'failed', preview: known, observation: known });
        assert.equal(attempt.receipt.outcome.details.result.error.code, 'OBSERVATION_CAPACITY');
        assert.deepEqual(next.candidate.observation.source, initial.source);
        assert.equal(fileView(app, a).viewInstanceId, first.viewInstanceId);
        turn.release();
        next.candidate.discard();

        await invoke(app, 'edit_file', { oldString: 'before-open-proof', newString: 'edited-open-proof' }, { view: first.id });
        assert.match(await fs.readFile(a, 'utf8'), /^edited-open-proof/);
        assert.ok(!(await fs.readFile(historyPath, 'utf8')).includes(c));
        await close(app);
        assert.deepEqual(await activeFiles(app, 'admission'), [a, b]);
        const restored = await start(root, 'restored', { data: app.data, sessionKey: 'admission', historyPath });
        assert.ok(fileView(restored, a));
        assert.ok(fileView(restored, b));
        assert.ok(!fileView(restored, c));
        await invoke(restored, 'close_file_detail', {}, { view: fileView(restored, a).id });
        await invoke(restored, 'multi_open_file', { filePaths: [c] });
        assert.ok(fileView(restored, c));
        assert.ok(!fileView(restored, a));
        await close(restored);
    });
    await runCase('SearchResult admission, disk receipts and capacity-aware session recovery', async () => {
        const root = path.join(working, 'disk-and-recovery');
        await fs.mkdir(root);
        const [a, b, pad, created] = ['a.txt', 'b.txt', 'pad.txt', 'created.txt'].map(file => path.join(root, file));
        await Promise.all([a, b].map(file => fs.writeFile(file, 'x'.repeat(245 * 1024))));
        await fs.writeFile(pad, 'pad-proof' + 'x'.repeat(176 * 1024 - 9));
        const historyPath = path.join(working, 'disk-history.json');
        const app = await start(root, 'disk', { historyPath });
        await invoke(app, 'multi_open_file', { filePaths: [a, b, pad] });
        const client = scope(app), before = await client.preview();
        assert.equal(before.status, 'previewed');
        await Promise.all(Array.from({ length: 180 }, (_, index) =>
            fs.writeFile(path.join(root, 'match-' + index + 'x'.repeat(200) + '.txt'), '')));
        const search = await invoke(app, 'search_files_by_pattern', { pattern: '**/match-*.txt' }, { status: 'failed' });
        assert.equal(search.details.result.error.code, 'OBSERVATION_CAPACITY');
        assert.ok(!toolNames(app).includes('close_search_view'));
        assert.deepEqual((await client.preview()).source, before.source);

        await invoke(app, 'search_files_by_pattern', { pattern: '**/a.txt' });
        const prepared = await client.prepare();
        assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
        const previous = prepared.candidate.observation;
        const turn = client.adopt(prepared.candidate);
        const searchView = previous.views.find(view => view.type === 'SearchResult');
        const replacing = await invoke(app, 'search_files_by_pattern', { pattern: '**/match-*.txt' },
            { status: 'failed', turn, observation: previous });
        assert.equal(replacing.details.result.error.code, 'OBSERVATION_CAPACITY');
        const recoveredSearch = (await client.preview()).views.find(view => view.type === 'SearchResult');
        assert.deepEqual(recoveredSearch.content, searchView.content);
        assert.equal(recoveredSearch.viewInstanceId, searchView.viewInstanceId);
        await invoke(app, 'search_files_by_pattern', { pattern: '**/b.txt' }, { turn, observation: previous });
        const acceptedSearch = (await client.preview()).views.find(view => view.type === 'SearchResult');
        assert.equal(acceptedSearch.id, searchView.id);
        assert.notEqual(acceptedSearch.viewInstanceId, searchView.viewInstanceId);
        assert.match(acceptedSearch.content.value, /b\.txt/);
        const stale = await invoke(app, 'close_search_view', {}, { view: searchView.id, status: 'rejected', turn, observation: previous });
        assert.equal(stale.code, 'VIEW_INSTANCE_REVOKED');
        turn.release();
        await invoke(app, 'close_search_view', {}, { view: acceptedSearch.id });
        const beforeCreate = await client.preview();

        const content = 'created text\n' + 'z'.repeat(48 * 1024);
        const creation = await invoke(app, 'create_file', { filePath: created, content }, { changes: false });
        assert.equal(creation.value.data.diskCommitted, true);
        assert.equal(creation.value.data.viewOpened, false);
        assert.match(creation.value.data.warnings.join(' '), /Close an open View before opening this file/);
        assert.equal(await fs.readFile(created, 'utf8'), content);
        assert.ok(!fileView(app, created));
        assert.ok(!(await fs.readFile(historyPath, 'utf8')).includes(created));
        assert.deepEqual((await client.preview()).source, beforeCreate.source);

        const growth = 'grown-proof' + 'y'.repeat(42 * 1024);
        const edit = await invoke(app, 'edit_file', { oldString: 'pad-proof', newString: growth },
            { view: fileView(app, pad).id, changes: false });
        assert.equal(edit.value.data.diskCommitted, true);
        assert.match(edit.value.data.warnings.join(' '), /view synchronization did not complete/);
        assert.ok((await fs.readFile(pad, 'utf8')).startsWith(growth));
        for (const read of [await client.preview(), await client.prepare()]) {
            assert.equal(read.status, 'rejected');
            assert.equal(read.issue.code, 'OBSERVATION_CAPACITY');
        }
        await close(app);
        assert.deepEqual(await activeFiles(app, 'disk'), [a, b, pad]);

        const recovered = await start(root, 'disk-recovered', { data: app.data, sessionKey: 'disk', historyPath });
        assert.ok(fileView(recovered, a));
        assert.ok(fileView(recovered, b));
        assert.ok(!fileView(recovered, pad));
        assert.ok(!fileView(recovered, created));
        assert.match(viewText(recovered, 'root'), /RESTORED_FILE_CAPACITY/);
        await invoke(recovered, 'close_file_detail', {}, { view: fileView(recovered, a).id });
        await invoke(recovered, 'multi_open_file', { filePaths: [created] });
        await invoke(recovered, 'search_files_by_pattern', { pattern: '**/match-*.txt' });
        assert.ok(fileView(recovered, created));
        assert.ok(toolNames(recovered).includes('close_search_view'));
        await close(recovered);
        assert.deepEqual(await activeFiles(recovered, 'disk'), [b, created]);
    });
    await runCase('capacity-rejected open preserves the mounted file IDs and the next receipt selects the actual FileDetail', async () => {
        const root = path.join(working, 'sequence-alignment');
        await fs.mkdir(root);
        const [a, b, c] = ['a.txt', 'b.txt', 'c.txt'].map(file => path.join(root, file));
        const page = 'seq-proof ' + 'x'.repeat(245 * 1024 - 10);
        await Promise.all([a, b, c].map(file => fs.writeFile(file, page)));
        const app = await start(root, 'seq-alignment', { historyPath: path.join(working, 'seq-history.json') });
        await invoke(app, 'multi_open_file', { filePaths: [a, b] });
        assert.equal(fileView(app, a)?.id, 'fd_1');
        assert.equal(fileView(app, b)?.id, 'fd_2');
        assert.ok(viewText(app, 'workspace').includes(a));
        assert.ok(viewText(app, 'workspace').includes(b));

        const rejected = await invoke(app, 'multi_open_file', { filePaths: [c] }, { status: 'failed' });
        assert.equal(rejected.details.result.error.code, 'OBSERVATION_CAPACITY');
        assert.equal(fileView(app, c), undefined);
        assert.ok(!viewText(app, 'workspace').includes(c));

        await invoke(app, 'close_file_detail', {}, { view: 'fd_2' });
        await invoke(app, 'multi_open_file', { filePaths: [c] });
        const prepared = await scope(app).prepare();
        assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
        const observed = prepared.candidate.observation;
        try {
            const observedC = observed.views.find(view => view.type === 'FileDetail' && view.content.value.includes(c));
            assert.equal(observedC?.id, 'fd_3');
            assert.equal(fileView(app, c)?.id, 'fd_3');
            assert.equal(observedC?.name, 'File: ' + c);
            assert.ok(fileView(app, c)?.content.value.includes(c));
            assert.ok(viewText(app, 'workspace').includes(c));
        } finally { prepared.candidate.discard(); }
        const edited = await invoke(app, 'edit_file', { oldString: 'seq-proof', newString: 'seq-edited' }, { view: 'fd_3' });
        assert.equal(edited.value.data.view_id, 'fd_3');
        await close(app);
    });
    facts.passed = true;
} catch (error) {
    facts.failure = { message: String(error), stack: error.stack };
    console.error(error);
    process.exitCode = 1;
} finally {
    for (const app of apps) if (!app.closed) {
        try { await close(app); }
        catch (error) {
            facts.cleanup.push({ id: app.id, failedCleanup: String(error), report: app.host.getResourceReport() });
            app.host.terminate();
            await app.host.waitForResourceRelease();
        }
    }
    facts.finishedAt = new Date().toISOString();
    if (factsFile) await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
}
