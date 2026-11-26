import { expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { invokeObservedTool } from '../../../tests/fixtures/semantic-worker-tools.js';

const repo = resolve(process.cwd(), '..'), url = (p: string) => pathToFileURL(p).href;

async function capture(file: string, body: string) {
    await writeFile(file, body);const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) {
        await mkdir(join(folder, 'c1-inputs'), { recursive: true });const hash = createHash('sha256').update(body).digest('hex');
        await writeFile(join(folder, 'c1-inputs', hash), body);
        await writeFile(join(folder, 'c1-inputs', hash + '.json'), JSON.stringify({ path: file, sha256: hash, capturedBeforeExecution: true }));
    }
}
async function fact(name: string, value: object) {
    const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) { await mkdir(folder, { recursive: true });await writeFile(join(folder, 'c1-' + name + '.json'), JSON.stringify(value, null, 2)); }
}
it('C1-08 separate Runtimes use the bundled Worker and each Runtime shares one capacity bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-runtimes-')), app = join(dir, 'app.mjs');
    await capture(app, `import { createApp, createView, defineViewType } from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};
const RootType = defineViewType()({ multiplicity: 'multiple', name: 'Root', tools: {
    inspect: {
        description: 'Inspect launch facts',
        execute: async ({ context }) => ({ success: true, data: { launch: context.launch.C1_LAUNCH } }),
    },
} });
export default createApp({ viewTypes: [RootType], app_name: 'c1',
    initialize({ launchConfig: launch, prepareProjection }) {
        const page = createView(RootType, { idPrefix: 'root', region: 'static',
            render: () => ({ body: 'Worker capacity', context: { launch } }) });
        prepareProjection({ views: [page] });
    },
});`);
    const { createRuntime } = await import(url(join(repo, 'runtime/dist/index.js')));
    const workerFile = join(repo, 'runtime/dist/worker-runtime/index.js');
    const runtimes = [createRuntime({ worker: { timeoutMs: 2345, maxWorkers: 1 } }), createRuntime({ worker: { maxWorkers: 1 } })] as any[];
    const sandboxes: any[] = [], workers: any[] = [];
    try {
        for (const [index, runtime] of runtimes.entries()) {
            const desktop = await runtime.createDesktop();
            const { appId } = await desktop.installDynamicWorkerApp(url(app), { name: 'c1', config: { C1_LAUNCH: index ? 'B' : 'A', AOTUI_DATA_DIR: dir } });
            const sandbox = desktop.appManager.getManagedApp(appId);sandboxes.push(sandbox);workers.push(sandbox.host.worker);
            const inspect = async () => {
                const result = await invokeObservedTool((sandbox as any).host, 'inspect', {}, 'root_1');
                expect(result).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
                return result.receipt.outcome.value.data;
            };
            expect(sandbox.host.worker).toBeInstanceOf(Worker);
            expect((await inspect()).launch).toBe(index ? 'B' : 'A');
            if (!index) {
                expect(sandbox.host.timeout).toBe(2345);
                const other = await runtime.createDesktop();
                await expect(other.installDynamicWorkerApp(url(app), { name: 'c1', config: { AOTUI_DATA_DIR: dir } })).rejects.toMatchObject({
                    code: 'INSTALL_FAILED', cause: { code: 'WORKER_CAPACITY_EXCEEDED' },
                });
            }
        }
        const firstRuntimeClose = await runtimes[0].beginClose().completion;
        expect(firstRuntimeClose.ok).toBe(true);expect(firstRuntimeClose.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 1 } });
        expect(workers[0].threadId).toBe(-1);
        const result = await invokeObservedTool((sandboxes[1] as any).host, 'inspect', {}, 'root_1');
        expect((result as any).receipt.outcome.value.data.launch).toBe('B');
        const secondRuntimeClose = await runtimes[1].beginClose().completion;
        expect(secondRuntimeClose.ok).toBe(true);expect(secondRuntimeClose.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0 } });
        expect(workers[1].threadId).toBe(-1);
        await fact('runtime-capacity', { bundledWorker: workerFile, independentOwners: true, sameRuntimeDesktopCap: 1, reports: [firstRuntimeClose.workers.report, secondRuntimeClose.workers.report] });
    } finally {
        await Promise.all(runtimes.map(runtime => runtime.beginClose().completion));
        await rm(dir, { recursive: true, force: true });
    }
}, 20000);
