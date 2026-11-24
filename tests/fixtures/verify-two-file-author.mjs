import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { setupFiles } from './batch-ten-delivery.mjs';

const [appPath, evidence] = process.argv.slice(2);
const root = await mkdtemp(join(tmpdir(), 'aotui-author-check-'));
const runtime = createRuntime(), facts = { scenarios: [], passed: false };
try {
    for (const maxViews of [3, 2]) {
        const folder = join(root, String(maxViews));
        await setupFiles(folder);
        const desktop = await runtime.createDesktop('author-' + maxViews);
        await desktop.registerPendingApp({ installationId: 'files', localPath: resolve(appPath), config: { folder }, projectionLimits: { maxViews } });
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
        const views = () => observation.views.filter(view => view.name === 'A.txt' || view.name === 'B.txt');
        const view = name => views().find(item => item.name === name);
        const read = name => readFile(join(folder, name), 'utf8');

        await observe();
        assert.equal(observation.tools.some(tool => tool.name === 'edit'), false);
        assert.equal((await call('open_file', { name: 'A.txt' })).status, 'succeeded');
        await observe();
        const a = view('A.txt');
        assert.ok(a);
        const second = await call('open_file', { name: 'B.txt' });
        await observe();
        assert.equal(view('A.txt').viewInstanceId, a.viewInstanceId);
        assert.equal(observation.tools.filter(tool => tool.name === 'edit').length, 1);
        if (maxViews === 3) {
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
        facts.scenarios.push({ maxViews, receipts, views: views(), disk, report });
    }
    facts.passed = true;
} finally {
    facts.closed = await runtime.beginClose().completion;
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(root, { recursive: true, force: true });
}
