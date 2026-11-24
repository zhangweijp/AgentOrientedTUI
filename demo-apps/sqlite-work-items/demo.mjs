import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopId, createRuntime } from '@aotui/runtime';

const [databasePath, sqliteExecutable] = process.argv.slice(2);
if (!databasePath) throw new Error('Usage: node demo.mjs <database-file> [absolute-sqlite3-executable]');

const dataDir = await mkdtemp(join(tmpdir(), 'aotui-sqlite-demo-'));
const runtime = createRuntime();
try {
    const desktop = await runtime.createDesktop(createDesktopId('sqlite-demo'));
    const installationId = await desktop.registerPendingApp({
        installationId: 'sqlite_work_items',
        localPath: fileURLToPath(new URL('./', import.meta.url)),
        config: { databasePath: resolve(databasePath), AOTUI_DATA_DIR: dataDir, ...(sqliteExecutable && { sqliteExecutable }) },
    });
    const app = await desktop.openApp(installationId);

    async function show() {
        const prepared = await app.observe();
        if (prepared.status !== 'prepared') throw new Error(JSON.stringify(prepared.issue));
        const { candidate } = prepared;
        const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
        if (adopted.status !== 'adopted') {
            candidate.discard();
            throw new Error(JSON.stringify(adopted.issue));
        }
        const { observation } = candidate;
        for (const view of observation.views) console.log(`\n${view.name}\n${view.content.value}`);
        return { observation, turn: adopted.turn };
    }

    async function invoke({ observation, turn }, name, localRef, input = {}) {
        const tool = observation.tools.find(tool => tool.name === name);
        if (!tool) throw new Error(`Missing ${name}. Check that the example database is seeded and readable.`);
        const view = observation.views.find(view => view.type === tool.viewType);
        if (!view) throw new Error(`Missing View for ${name}.`);
        const item = `$ref.${observation.source.appId}.${view.id}.${localRef}`;
        const result = await turn.invoke(app.appId, { invocationId: name, observationId: observation.observationId,
            toolId: tool.id, input: { ...input, item } });
        console.log(JSON.stringify(result));
        if (result.kind !== 'receipt' || result.receipt.outcome.status !== 'succeeded') process.exitCode = 1;
    }

    await invoke(await show(), 'open_item', 'items[0]');
    if (!process.exitCode) await invoke(await show(), 'set_status', 'current', { status: 'done' });
    await show();
} finally {
    const report = await runtime.beginClose().completion;
    if (report.resourcesReleased) await rm(dataDir, { recursive: true, force: true });
    if (!report.ok || !report.resourcesReleased) {
        console.error(report);
        process.exitCode = 1;
    }
}
