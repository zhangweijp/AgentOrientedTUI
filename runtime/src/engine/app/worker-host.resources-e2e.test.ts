import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { AppWorkerHost } from './worker-host.js';
import { createNodeStateStorage } from '../../adapters/storage/node-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from './state-storage-host.js';
import { fileSystemService } from '../../../../demo-apps/aotui-ide/src/core/file-system-service.js';

const repo = resolve(process.cwd(), '..'), url = (p: string) => pathToFileURL(p).href;
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
async function capture(file: string, body: string) {
    await writeFile(file, body);const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) {
        const hash = createHash('sha256').update(body).digest('hex');await mkdir(join(folder, 'c1-inputs'), { recursive: true });
        await writeFile(join(folder, 'c1-inputs', hash), body);await writeFile(join(folder, 'c1-inputs', hash + '.json'), JSON.stringify({ path: file, sha256: hash, capturedBeforeHostConstruction: true }));
    }
}
async function facts(name: string, report: object) {
    const folder = process.env.AOTUI_W08_C1_FACTS_DIR ?? process.env.AOTUI_W08_B2_FACTS_DIR;
    if (folder) { await mkdir(folder, { recursive: true });await writeFile(join(folder, 'c1-' + name + '.json'), JSON.stringify(report, null, 2)); }
}
async function fixture(extra: object = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-host-')), app = join(dir, 'app.mjs');
    await capture(app, `import {createTUIApp,usePersistentState} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};let setter;
function Root(){[,setter]=usePersistentState('value',0);return null;}
export default createTUIApp({app_name:'c1',component:Root,onOperation:async(op,args)=>{setter(args.value);return {success:true};}});`);
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: url(app), timeout: 2000,
        workerScriptPath: join(repo, 'runtime/dist/worker-runtime/index.js'), config: { AOTUI_DATA_DIR: join(dir, 'data'), AOTUI_APP_NAME: 'c1' }, ...extra });
    return { dir, host, record: join(dir, 'data/app-state/d/c1/value.json') };
}
it('C1-11 actual accepted file CAS keeps its result and prevents physical termination until the adapter completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-c1-file-')), file = join(dir, 'file.txt'), app = join(dir, 'app.mjs');
    await writeFile(file, 'before\n');const source = await fileSystemService.readVersionedFile(dir, file), entered = defer(), finish = defer();
    await capture(app, `import {h} from ${JSON.stringify(url(join(repo, 'runtime/node_modules/preact/dist/preact.module.js')))};
import {createTUIApp,View,useEntityRef,useViewTypeTool} from ${JSON.stringify(url(join(repo, 'sdk/dist/index.js')))};
function Detail(){const ref=useEntityRef('file',{entityType:'File',entityId:${JSON.stringify(file)},entityVersion:${JSON.stringify(source.version)}});useViewTypeTool('replace_file',{description:'replace',params:{},isMutating:true},async()=>({success:false}));return h('p',{},ref('file'));}
export default createTUIApp({app_name:'cas',component:()=>h(View,{id:'detail',type:'Detail'},h(Detail,{}))});`);
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: url(app),
        workerScriptPath: join(repo, 'runtime/dist/worker-runtime/index.js'), snapshotShadow: true, experimentalVersionedMutations: true });
    try {
        await host.start();await host.open();await vi.waitFor(() => expect(host.getSnapshotShadowReport()).toMatchObject({ health: 'ready', lastToolCount: 1 }));
        const worker = (host as any).worker, terminate = vi.spyOn(worker, 'terminate');
        const request = { snapshotId: host.getSnapshotShadowReport()!.snapshotId!, toolId: JSON.stringify(['app', 'Detail', 'replace_file']), viewId: 'detail', refId: 'file', newContent: 'after\n' };
        const writing = host.executeVersionedFileReplace(request, () => true, async input => { entered.resolve();await finish.promise;return fileSystemService.replaceFileIfVersion(dir, input.filePath, input.expectedVersion, input.newContent); });
        await entered.promise;host.terminate();const waiting = host.waitForResourceRelease();let settled = false;void waiting.then(() => { settled = true; });
        expect(host.getResourceReport()).toMatchObject({ state: 'closing', worker: 'retiring', activeFileReplacements: 1, resourcesReleased: false });
        expect(terminate).not.toHaveBeenCalled();await Promise.resolve();expect(settled).toBe(false);finish.resolve();
        expect(await writing).toMatchObject({ success: true, data: { filePath: file } });const report = await waiting;
        expect(await readFile(file, 'utf8')).toBe('after\n');expect(worker.threadId).toBe(-1);expect(report).toMatchObject({ worker: 'exited', activeFileReplacements: 0, resourcesReleased: true });
        await facts('held-file-cas', { report, actualDiskResult: 'after\n', physicalThreadId: worker.threadId, prematureTerminationCalls: 0 });
    } finally { finish.resolve();host.terminate();await host.waitForResourceRelease();await rm(dir, { recursive: true, force: true }); }
}, 15000);

it.each(['open', 'replace'] as const)('C1-12 actual Node backend %s remains supervised after actual Worker exit', async held => {
    const backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS), entered = defer(), finish = defer();
    const f = await fixture({ persistenceBackend: { async open(input: any) {
        const result = await backend.open(input);if (result.status !== 'opened') return result;
        if (held === 'open') { entered.resolve();await finish.promise; }
        return { status: 'opened', storage: { ...result.storage, async replace(address: any, text: string) {
            if (held === 'replace') { entered.resolve();await finish.promise; }return result.storage.replace(address, text);
        } } };
    } } });
    const host = f.host;
    try {
        await host.start();const opening = host.open().then(() => true, () => false);
        let closing: Promise<boolean> | undefined;
        if (held === 'replace') { expect(await opening).toBe(true);await host.executeOperation('set' as any, { value: 12 }, 'snapshot' as any);closing = host.close().then(() => true, () => false); }
        await entered.promise;const worker = (host as any).worker, exited = once(worker, 'exit');host.terminate();const waiting = host.waitForResourceRelease();
        await exited;expect(worker.threadId).toBe(-1);if (closing) expect(await closing).toBe(false);await opening;
        expect(backend.getStats().ownerSlots).toBe(1);expect(host.getResourceReport()).toMatchObject({ state: 'closing', worker: 'exited', resourcesReleased: false, storage: { actualIO: 1, ...(held === 'open' ? { opening: true } : { ownerRetained: true }) } });
        let settled = false;void waiting.then(() => { settled = true; });await Promise.resolve();expect(settled).toBe(false);
        const before = host.getResourceReport();finish.resolve();const report = await waiting;
        expect(backend.getStats().ownerSlots).toBe(0);expect(report).toMatchObject({ state: 'settled', worker: 'exited', resourcesReleased: true, storage: { unsafe: true, actualIO: 0, opening: false, release: { status: 'released' } } });
        if (held === 'replace') expect(JSON.parse(await readFile(f.record, 'utf8')).value).toBe(12);
        await facts('held-storage-' + held, { before, report, backend: backend.getStats(), actualEffectMayOutliveWorker: true });
    } finally { finish.resolve();host.terminate();await host.waitForResourceRelease();await rm(f.dir, { recursive: true, force: true }); }
}, 15000);

it.each(['failed', 'unknown'] as const)('C1-19 a terminal backend %s release is settled but cannot claim resourcesReleased', async status => {
    const backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const f = await fixture({ persistenceBackend: { async open(input: any) {
        const result = await backend.open(input);if (result.status !== 'opened') return result;
        return { status: 'opened', storage: { ...result.storage, async release() { await result.storage.release();return { status, issue: { code: 'IO_FAILED' } }; } } };
    } } });
    try {
        await f.host.start();await f.host.open();await f.host.executeOperation('set' as any, { value: 1 }, 's' as any);
        await expect(f.host.close()).rejects.toThrow();expect(await f.host.releaseWorker()).toBeNull();const report = await f.host.waitForResourceRelease();
        expect(report).toMatchObject({ state: 'settled', worker: 'exited', resourcesReleased: false, storage: { unsafe: true, ownerRetained: true, release: { status } } });
        expect(Object.isFrozen(report)).toBe(true);expect(Object.isFrozen(report.issues)).toBe(true);expect(report.issues.length).toBeLessThanOrEqual(4);
        await facts('backend-release-' + status, { report, backend: backend.getStats(), controlledReceiptAfterActualBackendRelease: true });
    } finally { f.host.terminate();await f.host.waitForResourceRelease();await rm(f.dir, { recursive: true, force: true }); }
}, 15000);
