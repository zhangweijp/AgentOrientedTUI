import { readSqliteState } from '../../../tests/fixtures/sqlite-state.js';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedApp } from './managed-app.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { invokeObservedTool, linkPreactPeer } from '../../../tests/fixtures/semantic-worker-tools.js';

const repo = resolve(process.cwd(), '..'), url = (file: string) => pathToFileURL(file).href;
async function capture(file: string, body: string) {
    await writeFile(file, body);const root = process.env.AOTUI_W08_C1_FACTS_DIR;
    if (root) { const hash = createHash('sha256').update(body).digest('hex'), folder = join(root, 'c2-inputs');await mkdir(folder, { recursive: true });await writeFile(join(folder, hash), body);await writeFile(join(folder, hash+'.json'), JSON.stringify({ path: file, sha256: hash, beforeSandboxConstruction: true })); }
}
async function facts(name: string, value: object) { const root = process.env.AOTUI_W08_C1_FACTS_DIR;if (root) { await mkdir(root, { recursive: true });await writeFile(join(root, 'c2-app-'+name+'.json'), JSON.stringify(value, null, 2)); } }

it.each(['sync', 'async'] as const)('C2-18/20 actual SDK %s unmount failure is fixed and preserves confirmed flush', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c2-unmount-')), app = join(dir, 'app.mjs');
    await linkPreactPeer(dir);
    await capture(app, `import {h} from 'preact';import Type from 'typebox';import { createTUIApp, useAppRuntimeContext, defineViewType, StaticView } from ${JSON.stringify(url(join(repo,'sdk/dist/index.js')))};
const RootType = defineViewType()({ multiplicity: 'multiple', name: 'Root', tools: {
    save: {
        description: 'Save a value',
        inputSchema: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
        async execute({ input, context }) { await context.set(input.value); return { success: true }; },
    },
} });
function Root() {
    const {persistence} = useAppRuntimeContext();
    const set = value => persistence.save('value',value);
    return h('div', null, h(StaticView, { idPrefix: 'root', type: RootType, context: { set } }, 'Managed state'));
}
const factory=createTUIApp({persistence:true,viewTypes:[RootType], app_name:'close',component:Root});
const initialize=factory.initialize.bind(factory);factory.initialize=async(...args)=>{const renderer=await initialize(...args);return {...renderer,${mode === 'async' ? 'async ' : ''}close(){renderer.close();${mode === 'async' ? 'await Promise.resolve();' : ''}throw Error('private renderer detail');}};};export default factory;`);
    const sandbox = new ManagedApp({ appId: 'app', desktopId: 'd', appModulePath: url(app),
        workerScriptPath: join(repo,'runtime/dist/worker-runtime/index.js'), runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 3000, maxWorkers: 1 } }), config: { AOTUI_DATA_DIR: join(dir,'data'), AOTUI_APP_KEY: 'close' } }, () => {});
    try {
        await sandbox.start();await invokeObservedTool((sandbox as any).host,'save',{value:7},'root_1');const worker = (sandbox as any).host.worker;
        const close = sandbox.beginClose();expect(sandbox.beginClose()).toBe(close);const report = await close.completion;
        expect(report).toMatchObject({ state:'settled', resourcesReleased:true, ok:false, worker:'exited',
            persistence: { confirmedFlushes: 1, failedFlushes: 0 } });
        expect(report.failures).toEqual([{ stage: 'apps', appId: 'app', desktopId: 'd', codes: ['APP_UNMOUNT_FAILED'] }]);
        expect(worker.threadId).toBe(-1);expect(JSON.parse(readSqliteState(join(dir, 'data/app-state'), 'd', 'close', 'value')!).value).toBe(7);
        expect(JSON.stringify(report)).not.toContain('private renderer detail');await facts('unmount-'+mode,{report,threadId:worker.threadId});
    } finally { await sandbox.beginClose().completion;await rm(dir,{recursive:true,force:true}); }
}, 15000);
