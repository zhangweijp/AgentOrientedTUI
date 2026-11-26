import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { setupFiles } from './batch-ten-delivery.mjs';

const args = process.argv.slice(2);
const liveFiles = args.includes('--live-files');
const [appPath, evidence, pythonExecutable] = args.filter(arg => arg !== '--live-files');
const root = await mkdtemp(join(tmpdir(), 'aotui-author-check-'));
const runtime = createRuntime(), facts = { scenarios: [], passed: false };
try {
    for (const maxViews of liveFiles ? [4] : [3, 2]) {
        const folder = join(root, String(maxViews));
        await setupFiles(folder);
        const desktop = await runtime.createDesktop('author-' + maxViews);
        const location = pythonExecutable
            ? { command: [pythonExecutable, '-u', resolve(appPath)], name: 'delivered_files' }
            : { localPath: resolve(appPath) };
        const config = liveFiles ? { folder, traceProjection: true } : { folder };
        await desktop.registerPendingApp({ installationId: 'files', ...location, config, projectionLimits: { maxViews } });
        const app = await desktop.openApp('files');
        const receipts = [];
        let turn, observation;
        async function observe() {
            const prepared = await app.observe();
            assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
            const adopted = desktop.adoptTurn({ apps: [{ candidate: prepared.candidate }] });
            assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
            turn = adopted.turn;
            observation = prepared.candidate.observation;
            return observation;
        }
        async function call(name, input, viewId) {
            const tool = observation.tools.find(item => item.name === name);
            assert.ok(tool, name);
            const result = await turn.invoke(app.appId, { invocationId: 'call-' + receipts.length,
                observationId: observation.observationId, toolId: tool.id, input, ...(viewId ? { viewId } : {}) });
            assert.equal(result.kind, 'receipt', JSON.stringify(result));
            receipts.push(result.receipt);
            return result.receipt.outcome;
        }
        const addedName = '运行后新增的文件.log';
        const fileNames = liveFiles ? ['A.txt', 'B.txt', addedName] : ['A.txt', 'B.txt'];
        const views = () => observation.views.filter(view => fileNames.includes(view.name));
        const view = name => views().find(item => item.name === name);
        const read = name => readFile(join(folder, name), 'utf8');
        const tool = name => observation.tools.find(entry => entry.name === name);

        await observe();
        assert.equal(observation.tools.some(tool => tool.name === 'edit'), false);
        const runtimeExample = liveFiles && app.appId === 'turn_files';
        const schemas = {};
        if (liveFiles) {
            for (const name of runtimeExample ? ['open_file', 'set_writable'] : ['open_file']) {
                schemas[name] = { ...tool(name).inputSchema.properties.name };
                assert.deepEqual(schemas[name], { type: 'string' });
            }
        }
        assert.equal((await call('open_file', { name: 'A.txt' })).status, 'succeeded');
        await observe();
        const a = view('A.txt');
        assert.ok(a);
        const second = await call('open_file', { name: 'B.txt' });
        await observe();
        assert.equal(view('A.txt').viewInstanceId, a.viewInstanceId);
        assert.equal(observation.tools.filter(tool => tool.name === 'edit').length, 1);
        let live;
        if (liveFiles) {
            assert.equal(second.status, 'succeeded');
            const directory = () => observation.views.find(entry => entry.id === 'directory').content.value;
            assert.match(directory(), /A\.txt/);
            assert.match(directory(), /B\.txt/);
            assert.ok(!directory().includes(addedName));

            const initialText = 'This file only exists after the first observation.';
            const newText = '已编辑✎';
            const outside = join(root, 'outside.txt');
            await writeFile(outside, newText);
            await mkdir(join(folder, 'subfolder'));
            await symlink(outside, join(folder, 'linked.txt'), 'file');
            await writeFile(join(folder, addedName), initialText);
            async function expectUnavailable(name, input, viewId) {
                const result = await call(name, input, viewId);
                assert.equal(result.status, 'failed', JSON.stringify(result));
                assert.equal(result.details?.result.error?.code, 'FILE_UNAVAILABLE', JSON.stringify(result));
                assert.equal(receipts.at(-1).executionPhase, 'entered-returned');
            }
            for (const name of ['missing.txt', 'subfolder', 'linked.txt', '../outside.txt', addedName.toUpperCase()])
                await expectUnavailable('open_file', { name });
            if (runtimeExample) {
                await writeFile(join(folder, '.fail-file-view'), 'projection fault marker');
                await expectUnavailable('open_file', { name: '.fail-file-view' });
                await rm(join(folder, '.fail-file-view'));
            }
            assert.equal((await call('open_file', { name: addedName })).status, 'succeeded');
            await observe();
            const added = view(addedName);
            assert.ok(added?.content.value.includes(initialText));
            assert.ok(directory().split('\n')[0].includes(addedName), directory());
            assert.equal(view('A.txt').viewInstanceId, a.viewInstanceId);
            assert.equal(observation.tools.filter(entry => entry.name === 'edit').length, 1);
            const expectText = Object.hasOwn(tool('edit').inputSchema.properties, 'expected');
            const edit = (text, expected) => ({ text, ...(expectText ? { expected } : {}) });

            if (runtimeExample) {
                assert.equal((await call('set_writable', { name: addedName, writable: false })).status, 'succeeded');
                await observe();
                assert.equal(view(addedName).viewInstanceId, added.viewInstanceId);
                assert.equal((await call('edit', edit('Disallowed write', initialText), added.id)).status, 'rejected');
                assert.equal(await read(addedName), initialText);
                assert.equal((await call('set_writable', { name: addedName, writable: true })).status, 'succeeded');
                await observe();
            }
            assert.equal((await call('edit', edit(newText, initialText), added.id)).status, 'succeeded');
            await observe();
            assert.equal(view(addedName).viewInstanceId, added.viewInstanceId);
            assert.ok(view(addedName).content.value.includes(newText));
            assert.equal(await read(addedName), newText);
            assert.equal(await read('A.txt'), 'Original A');
            assert.equal(await read('B.txt'), 'Original B');
            if (runtimeExample) {
                assert.ok(!directory().includes('edits.jsonl'), directory());
                await expectUnavailable('open_file', { name: 'edits.jsonl' });
                await expectUnavailable('open_file', { name: 'EDITS.JSONL' });
                assert.deepEqual((await read('edits.jsonl')).trim().split('\n').map(JSON.parse), [{ name: addedName, text: newText }]);
            }

            await rm(join(folder, addedName));
            await expectUnavailable('edit', edit('Do not recreate the file', newText), added.id);
            await assert.rejects(read(addedName), { code: 'ENOENT' });
            await symlink(outside, join(folder, addedName), 'file');
            await expectUnavailable('edit', edit('Do not follow the link', newText), added.id);
            assert.equal(await readFile(outside, 'utf8'), newText);
            live = { schemas, addedName, addedViewId: added.id, diskAfterEdit: newText };
        } else if (maxViews === 3) {
            assert.equal(second.status, 'succeeded');
            assert.equal(views().length, 2);
            const address = `$ref.${app.appId}.${a.id}.content`;
            assert.deepEqual(await turn.inspectRef(address, 'value'), { status: 'ready', value: 'Original A' });
            assert.equal((await call('edit', { text: address }, view('B.txt').id)).status, 'succeeded');
            assert.equal(await read('A.txt'), 'Original A');
            assert.equal(await read('B.txt'), 'Original A');
        } else {
            assert.equal(second.status, 'failed', JSON.stringify(second));
            assert.equal(second.details?.result.error?.code, 'OBSERVATION_CAPACITY');
            assert.equal(views().length, 1);
            assert.equal((await call('edit', { text: 'A is still editable' }, a.id)).status, 'succeeded');
            const closed = await desktop.closeView({ appId: app.appId, instanceId: app.instanceId,
                viewId: a.id, viewInstanceId: a.viewInstanceId }, turn);
            assert.equal(closed.status, 'closed', JSON.stringify(closed));
            await observe();
            assert.equal((await call('open_file', { name: 'B.txt' })).status, 'succeeded');
            await observe();
            assert.deepEqual(views().map(view => view.name), ['B.txt']);
            if (observation.tools.some(tool => tool.name === 'reload_a')) {
                const reload = await call('reload_a', {});
                assert.equal(reload.status, 'failed');
                assert.equal(reload.details?.result.error?.code, 'OBSERVATION_CAPACITY');
                await observe();
                assert.deepEqual(views().map(view => view.name), ['B.txt']);
            }
            assert.equal(await read('A.txt'), 'A is still editable');
            assert.equal(await read('B.txt'), 'Original B');
        }
        await observe();
        const disk = { A: await read('A.txt'), B: await read('B.txt') };
        assert.ok(view('B.txt').content.value.includes(disk.B));
        turn.release();
        const report = await desktop.beginClose().completion;
        assert.equal(report.ok, true, JSON.stringify(report));
        facts.scenarios.push({ maxViews, receipts, views: views(), disk, report, ...(live ? { live } : {}) });
    }
    facts.passed = true;
} finally {
    facts.closed = await runtime.beginClose().completion;
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(root, { recursive: true, force: true });
}
