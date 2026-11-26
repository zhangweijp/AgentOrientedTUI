import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedApp } from './managed-app.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { invokeObservedTool } from '../../../tests/fixtures/semantic-worker-tools.js';

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
    initialize({ launchConfig, prepareProjection }) {
        const target = String(launchConfig.stateFile);
        const set = async value => {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, JSON.stringify({ value }), 'utf8');
        };
        const page = createView(RootType, { idPrefix: 'root', region: 'static',
            render: () => ({ body: 'App state', context: { set } }) });
        prepareProjection({ views: [page] });
    },
});
const initialize=factory.initialize.bind(factory);factory.initialize=async(...args)=>{const renderer=await initialize(...args);return {...renderer,${mode === 'async' ? 'async ' : ''}close(){renderer.close();${mode === 'async' ? 'await Promise.resolve();' : ''}throw Error('private instance detail');}};};export default factory;`);
    const sandbox = new ManagedApp({ appId: 'app', desktopId: 'd', appModulePath: url(app),
        workerScriptPath: join(repo,'runtime/dist/worker-runtime/index.js'), runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 3000, maxWorkers: 1 } }), config: { stateFile } }, () => {});
    try {
        await sandbox.start();await invokeObservedTool((sandbox as any).host,'save',{value:7},'root_1');const worker = (sandbox as any).host.worker;
        const close = sandbox.beginClose();expect(sandbox.beginClose()).toBe(close);const report = await close.completion;
        expect(report).toMatchObject({ state:'settled', resourcesReleased:true, ok:false, worker:'exited' });
        expect(report).not.toHaveProperty('persistence');
        expect(report.failures).toEqual([{ stage: 'apps', appId: 'app', desktopId: 'd', codes: ['APP_UNMOUNT_FAILED'] }]);
        expect(worker.threadId).toBe(-1);expect(JSON.parse(await readFile(stateFile, 'utf8')).value).toBe(7);
        expect(JSON.stringify(report)).not.toContain('private instance detail');await facts('unmount-'+mode,{report,threadId:worker.threadId});
    } finally { await sandbox.beginClose().completion;await rm(dir,{recursive:true,force:true}); }
}, 15000);
