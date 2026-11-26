import assert from 'node:assert/strict';
import { createRuntime, readAppManifest } from '@aotui/runtime';

const localPath = process.argv[2];
assert.equal((await readAppManifest(localPath)).metadata.app_name, 'notes');
const runtime = createRuntime();
let result;
try {
    const desktop = await runtime.createDesktop();
    const installationId = await desktop.registerPendingApp({ installationId: 'notes', localPath });
    const app = await desktop.openApp(installationId);
    async function observe() {
        const prepared = await app.observe();
        assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
        const adopted = desktop.adoptTurn({ apps: [{ candidate: prepared.candidate }] });
        assert.equal(adopted.status, 'adopted', JSON.stringify(adopted.issue));
        return { observation: prepared.candidate.observation, turn: adopted.turn };
    }
    const { observation, turn } = await observe();
    const edit = observation.tools.find(tool => tool.name === 'edit');
    assert.ok(edit);
    const invoked = await turn.invoke(app.appId, { invocationId: 'edit-1', observationId: observation.observationId,
        toolId: edit.id, input: { text: 'Reviewed' } });
    assert.equal(invoked.kind, 'receipt');
    const current = await observe();
    current.turn.release();
    result = { before: observation.views[0].content.value, after: current.observation.views[0].content.value,
        receipt: invoked.receipt };
} finally {
    const report = await runtime.beginClose().completion;
    assert.ok(report.ok && report.resourcesReleased, JSON.stringify(report));
}
console.log(JSON.stringify({ ...result, resourcesReleased: true }));
