import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_STATE_SESSION_LIMITS, DEFAULT_STATE_TRANSPORT_LIMITS } from '../../adapters/storage/state-storage-protocol.js';

describe('Worker accepts only the managed component factory contract', () => {
    let temp: string;
    let workerScript: string;
    const root = resolve(process.cwd());
    const managedMarkers = "persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2',";

    beforeAll(async () => {
        temp = await mkdtemp(join(tmpdir(), 'aotui-worker-factory-contract-'));
        const modules = join(temp, 'node_modules');
        await mkdir(modules, { recursive: true });
        for (const name of ['linkedom', 'preact']) {
            await symlink(join(root, 'node_modules', name), join(modules, name), 'dir');
        }
        workerScript = join(temp, 'worker.mjs');
        await build({
            entryPoints: [join(root, 'src/worker-runtime/index.ts')],
            outfile: workerScript,
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node20',
            packages: 'external',
            logLevel: 'silent',
        });
    });

    afterAll(async () => {
        if (temp) await rm(temp, { recursive: true, force: true });
    });

    async function request(worker: Worker, message: Record<string, unknown>) {
        return new Promise<any>((resolveMessage, reject) => {
            const onError = (error: Error) => {
                worker.off('message', onMessage);
                reject(error);
            };
            const onMessage = (response: any) => {
                if (response?.requestId !== message.requestId) return;
                worker.off('message', onMessage);
                worker.off('error', onError);
                resolveMessage(response);
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
            worker.postMessage(message);
        });
    }

    async function launch(appSource: string) {
        const appScript = join(temp, `app-${Math.random().toString(36).slice(2)}.mjs`);
        await writeFile(appScript, appSource, 'utf8');
        const worker = new Worker(workerScript);
        const appInstanceId = `instance-${Math.random().toString(36).slice(2)}`;
        worker.on('message', (message: any) => {
            if (message?.type !== 'STATE_STORAGE_REQUEST' || message.operation !== 'release') return;
            worker.postMessage({ type: 'STATE_STORAGE_RESPONSE', version: 1,
                instanceId: message.instanceId, sequence: message.sequence, operation: 'release',
                result: { status: 'released' } });
        });
        const init = await request(worker, {
            type: 'INIT', requestId: 'init', appId: 'factory_test', desktopId: 'desktop_test',
            appInstanceId,
            appModulePath: pathToFileURL(appScript).href,
            config: { factoryContractMarker: 'launch-config' },
            persistence: { protocol: 'state-session-v1', version: 1, instanceId: appInstanceId,
                limits: DEFAULT_STATE_SESSION_LIMITS, transport: DEFAULT_STATE_TRANSPORT_LIMITS },
            appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: appInstanceId },
        });
        return { worker, init, appInstanceId };
    }

    it.each([
        ['callable factory and global config fallback', `const factory = Object.assign(() => globalThis.__AOTUI_APP_CONFIG__ ? ({ onOpen() {} }) : ({}), { ${managedMarkers} }); export default factory;`],
        ['legacy create factory', `export default { ${managedMarkers} create: () => ({ onOpen() {} }) };`],
        ['plain App instance export', `export default { ${managedMarkers} onOpen() {} };`],
        ['named app instance export', `export const app = { ${managedMarkers} onOpen() {} };`],
        ['incomplete managed factory', `export default { ${managedMarkers} displayName: 'incomplete', kernelConfig: { name: 'incomplete', appName: 'incomplete' } };`],
        ['named-only managed factory', `export const factory = { ${managedMarkers} displayName: 'named', kernelConfig: { name: 'named', appName: 'named' }, initializeComponent() {} };`],
        ['factory without kernel appName', `export default { ${managedMarkers} displayName: 'missing_name', kernelConfig: { name: 'missing_name' }, initializeComponent() {} };`],
        ['factory with empty kernel appName', `export default { ${managedMarkers} displayName: 'empty_name', kernelConfig: { name: 'empty_name', appName: '' }, initializeComponent() {} };`],
        ['factory with invalid kernel appName', `export default { ${managedMarkers} displayName: 'invalid_name', kernelConfig: { name: 'invalid_name', appName: 1 }, initializeComponent() {} };`],
        ['factory with empty displayName', `export default { ${managedMarkers} displayName: '', kernelConfig: { name: 'empty_display', appName: 'empty_display' }, initializeComponent() {} };`],
        ['factory missing persistence marker', `export default { appLifecycleSupport: 'app-lifecycle-v2', displayName: 'missing_persistence', kernelConfig: { appName: 'missing_persistence' }, initializeComponent() {} };`],
        ['factory with wrong persistence marker', `export default { persistenceSupport: 'state-session-v0', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'wrong_persistence', kernelConfig: { appName: 'wrong_persistence' }, initializeComponent() {} };`],
        ['factory missing lifecycle marker', `export default { persistenceSupport: 'state-session-v1', displayName: 'missing_lifecycle', kernelConfig: { appName: 'missing_lifecycle' }, initializeComponent() {} };`],
        ['factory with wrong lifecycle marker', `export default { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v1', displayName: 'wrong_lifecycle', kernelConfig: { appName: 'wrong_lifecycle' }, initializeComponent() {} };`],
    ])('rejects %s', async (_name, source) => {
        const { worker, init } = await launch(source);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'E_INIT_FAILED' } });
        } finally {
            await worker.terminate();
        }
    });

    it('initializes the managed object factory with launchConfig and without a global fallback', async () => {
        const { worker, init, appInstanceId } = await launch(`
            export default {
                persistenceSupport: 'state-session-v1',
                appLifecycleSupport: 'app-lifecycle-v2',
                displayName: 'managed',
                kernelConfig: { name: 'managed', appName: 'managed' },
                async initializeComponent(_container, context) {
                    if (context.launchConfig?.factoryContractMarker !== 'launch-config') throw new Error('LAUNCH_CONFIG_MISSING');
                    if (Object.hasOwn(globalThis, '__AOTUI_APP_CONFIG__')) throw new Error('GLOBAL_CONFIG_FALLBACK_PRESENT');
                    return { unmount() {} };
                },
            };
        `);
        try {
            expect(init).toMatchObject({
                type: 'INIT_RESPONSE', success: true, appInstanceId,
                appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: appInstanceId },
                persistence: { protocol: 'state-session-v1', version: 1, instanceId: appInstanceId },
            });
            const opened = await request(worker, { type: 'APP_OPEN', requestId: 'open' });
            expect(opened).toMatchObject({ type: 'LIFECYCLE_RESPONSE', success: true });
            const closed = await request(worker, { type: 'APP_CLOSE', requestId: 'close' });
            expect(closed).toMatchObject({
                type: 'LIFECYCLE_RESPONSE', success: true,
                persistence: { protocol: 'state-session-v1', instanceId: appInstanceId, ok: true,
                    unmount: 'completed', dispose: { status: 'disposed', release: { status: 'released' } } },
            });
        } finally {
            await worker.terminate();
        }
    });
});
