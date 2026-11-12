import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppRegistry, createDesktopId, createRuntime } from '@aotui/runtime';

const [databasePath, sqliteExecutable] = process.argv.slice(2);
if (!databasePath) throw new Error('Usage: node demo.mjs <database-file> [absolute-sqlite3-executable]');

const dataDir = await mkdtemp(join(tmpdir(), 'aotui-sqlite-demo-'));
const runtime = createRuntime();
try {
    const registry = new AppRegistry({ configPath: join(dataDir, 'registry.json') });
    await registry.registerTransient('local:' + fileURLToPath(new URL('./', import.meta.url)));
    const desktopId = await runtime.createDesktop(createDesktopId('sqlite-demo'));
    const desktop = runtime.getDesktop(desktopId);
    const [installation] = await registry.installAll(desktop, { dynamicConfig: {
        databasePath: resolve(databasePath), AOTUI_DATA_DIR: dataDir, ...(sqliteExecutable && { sqliteExecutable }),
    } });
    if (installation?.status !== 'installed') throw new Error(JSON.stringify(installation));
    const app = desktop.getInstalledApps().find(app => app.appId === installation.appId);
    if (!app?.appInstanceId) throw new Error('Missing SQLite work items instance');
    const access = runtime.getAppInteraction(desktopId, installation.appId, app.appInstanceId);
    if (access.status !== 'ready') throw new Error(JSON.stringify(access.issue));
    const client = access.interaction;

    async function show() {
        const prepared = await client.observe({ all: true });
        if (prepared.status !== 'observed') throw new Error(JSON.stringify(prepared.issue));
        const observation = prepared.observation;
        const adopted = client.adoptObservation(observation.observationId);
        if (adopted.status !== 'adopted') throw new Error(JSON.stringify(adopted.issue));
        for (const view of observation.views) if (view.kind === 'state') console.log(`\n${view.name}\n${view.content?.value}`);
        return observation;
    }

    async function invoke(observation, name, input) {
        const tool = observation.tools.find(tool => tool.name === name);
        const binding = observation.bindings.find(binding => binding.toolId === tool?.id);
        if (!binding) throw new Error(`Missing ${name}. Check that the example database is seeded and readable.`);
        const result = await client.invoke({ invocationId: name, observationId: observation.observationId, bindingId: binding.bindingId, input });
        console.log(JSON.stringify(result));
        if (result.kind !== 'receipt' || result.receipt.outcome.status !== 'succeeded') process.exitCode = 1;
    }

    await invoke(await show(), 'open_item', { item: 'items.items[0]' });
    if (!process.exitCode) await invoke(await show(), 'set_status', { item: 'detail.current', status: 'done' });
    await show();
} finally {
    const report = await runtime.beginShutdown().completion;
    if (report.resourcesReleased) await rm(dataDir, { recursive: true, force: true });
    if (!report.ok || !report.resourcesReleased) {
        console.error(report);
        process.exitCode = 1;
    }
}
