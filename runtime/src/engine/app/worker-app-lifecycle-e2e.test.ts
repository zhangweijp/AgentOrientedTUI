import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.cwd(), '..'), url = (file: string) => pathToFileURL(file).href;
async function capture(file: string, body: string) {
    await writeFile(file, body);const root = process.env.AOTUI_W08_C1_FACTS_DIR;
    if (root) { const hash = createHash('sha256').update(body).digest('hex'), folder = join(root, 'c2-inputs');await mkdir(folder, { recursive: true });await writeFile(join(folder, hash), body);await writeFile(join(folder, hash+'.json'), JSON.stringify({ path: file, sha256: hash, beforeSandboxConstruction: true })); }
}
async function facts(name: string, value: object) { const root = process.env.AOTUI_W08_C1_FACTS_DIR;if (root) { await mkdir(root, { recursive: true });await writeFile(join(root, 'c2-app-'+name+'.json'), JSON.stringify(value, null, 2)); } }

it.each(['sync', 'async'] as const)('C2-18/20 actual SDK %s unmount failure is fixed and preserves App file write', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c2-unmount-')), app = join(dir, 'app.mjs'), stateFile = join(dir, 'data', 'value.json');
    await capture(app, `import {mkdir, writeFile} from 'node:fs/promises';import {dirname} from 'node:path';import { createApp, createView, defineViewType } from ${JSON.stringify(url(join(repo,'sdk/dist/index.js')))};
const RootType = defineViewType()({ multiplicity: 'multiple', name: 'Root', tools: {
    save: {
        description: 'Save a value',
        inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        async execute({ input, context }) { await context.set(input.value); return { success: true }; },
    },
} });
const factory = createApp({ viewTypes: [RootType], app_name: 'close',
    initialize({ launchConfig, publish: publishAuthorFrame, registerLifecycle }) {
        registerLifecycle({ ${mode === 'async' ? 'async ' : ''}close(){${mode === 'async' ? 'await Promise.resolve();' : ''}throw Error('private instance detail');} });
        const target = String(launchConfig.stateFile);
        const set = async value => {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, JSON.stringify({ value }), 'utf8');
        };
        const page = (() => { const handle = createView(RootType, { idPrefix: 'root', region: 'static' }); return { handle, frame: () => handle.frame({ body: 'App state', context: { set } }) }; })();
        publishAuthorFrame(() => ([page]).map(page => page.frame()));
    },
});
export default factory;`);
    const { createRuntime } = await import(url(join(repo, 'runtime/dist/index.js'))) as typeof import('../../index.js');
    const runtime = createRuntime({ worker: { timeoutMs: 3000, maxWorkers: 1 } });
    try {
        const desktop = await runtime.createDesktop('d');
        const running = await desktop.installDynamicWorkerApp(app, { name: 'close', config: { stateFile } });
        const prepared = await running.observe();
        if (prepared.status !== 'prepared') throw Error(prepared.issue.code);
        const adopted = desktop.adoptTurn({ apps: [{ candidate: prepared.candidate }] });
        if (adopted.status !== 'adopted') throw Error(adopted.issue.code);
        const { observationId, tools: [tool] } = prepared.candidate.observation;
        const invocation = { observationId, invocationId: 'save-once' };
        expect(await adopted.turn.invoke(running.appId, { ...invocation, toolId: tool.id, viewId: 'root_1', input: { value: 7 } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        const close = running.beginClose();expect(running.beginClose()).toBe(close);const report = await close.completion;
        expect(report).toMatchObject({ state: 'settled', resourcesReleased: true, ok: false, worker: 'exited' });
        expect(report.failures).toEqual([{ stage: 'apps', appId: 'close', desktopId: 'd', codes: ['APP_CLOSE_FAILED'] }]);
        expect(report.appCleanupReport).toMatchObject({ protocol: 'app-lifecycle-v3', state: 'failed', issues: ['APP_CLEANUP_FAILED'] });
        expect(JSON.parse(await readFile(stateFile, 'utf8')).value).toBe(7);
        expect(JSON.stringify(report)).not.toContain('private instance detail');
        const shutdown = await runtime.beginClose().completion;
        expect(shutdown.workers.report?.total).toBe(0);
        await facts('unmount-' + mode, { report, workers: shutdown.workers });
    } finally {
        await runtime.beginClose().completion;
        await rm(dir, { recursive: true, force: true });
    }
}, 15000);
