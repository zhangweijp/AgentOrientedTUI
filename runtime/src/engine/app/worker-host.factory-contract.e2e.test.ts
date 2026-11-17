import { SNAPSHOT_CAPABILITY } from '../../spi/worker-protocol/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_STATE_SESSION_LIMITS, DEFAULT_STATE_TRANSPORT_LIMITS } from '../../adapters/storage/state-storage-protocol.js';

describe('Worker accepts only the managed App factory contract', () => {
    let temp: string;
    let workerScript: string;
    const root = resolve(process.cwd());
    const lifecycleMarkers = "persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2',";
    const managedMarkers = `${lifecycleMarkers} toolAuthoringProtocol: 'view-type-tools-v5',`;

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

    async function launch(appSource: string, requestedCapabilities = [SNAPSHOT_CAPABILITY] as readonly string[], appName?: string, config?: Record<string, unknown>) {
        const appScript = join(temp, `app-${Math.random().toString(36).slice(2)}.mjs`);
        await writeFile(appScript, appSource, 'utf8');
        const worker = new Worker(workerScript);
        const appInstanceId = `instance-${Math.random().toString(36).slice(2)}`;
        worker.on('message', (message: any) => {
            if (message?.type !== 'STATE_STORAGE_REQUEST' || message.action !== 'release') return;
            worker.postMessage({ type: 'STATE_STORAGE_RESPONSE', version: 1,
                instanceId: message.instanceId, sequence: message.sequence, action: 'release',
                result: { status: 'released' } });
        });
        const init = await request(worker, {
            type: 'INIT', requestId: 'init', appId: 'factory_test', desktopId: 'desktop_test',
            appInstanceId,
            appModulePath: pathToFileURL(appScript).href,
            requestedCapabilities,
            ...(appName === undefined ? {} : { appName }),
            ...(config === undefined ? {} : { config }),
            persistence: { protocol: 'state-session-v1', version: 1, instanceId: appInstanceId,
                limits: DEFAULT_STATE_SESSION_LIMITS, transport: DEFAULT_STATE_TRANSPORT_LIMITS },
            appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: appInstanceId },
        });
        return { worker, init, appInstanceId };
    }

    it.each([{ requested: [] }, { requested: ['app-snapshot/v2'] }])('refuses unsupported Snapshot negotiation $requested before importing the App', async ({ requested }) => {
        const { worker, init } = await launch('throw Error("App must not be imported")', requested);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false,
                error: { code: requested.length ? 'WORKER_CAPABILITY_UNSUPPORTED' : 'WORKER_SNAPSHOT_UNSUPPORTED' } });
        } finally { await worker.terminate(); }
    });

    it('rejects the retired state namespace key before importing the App', async () => {
        const { worker, init } = await launch('throw Error("App must not be imported")', [SNAPSHOT_CAPABILITY], undefined, { AOTUI_APP_NAME: 'old_key' });
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'APP_CONFIG_UNSUPPORTED' } });
        } finally { await worker.terminate(); }
    });

    it('refuses a registered name that differs from the factory before rendering', async () => {
        const { worker, init } = await launch(`export default { ${managedMarkers} kernelConfig: { appName: 'canonical' }, initialize() { throw Error('must not render'); } };`, [SNAPSHOT_CAPABILITY], 'alias');
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'APP_IDENTITY_MISMATCH' } });
            expect(init.error.message).toContain('INIT.appName');
        } finally { await worker.terminate(); }
    });

    it.each([
        ['callable factory and global config fallback', `const factory = Object.assign(() => globalThis.__AOTUI_APP_CONFIG__ ? ({ onOpen() {} }) : ({}), { ${managedMarkers} }); export default factory;`],
        ['legacy create factory', `export default { ${managedMarkers} create: () => ({ onOpen() {} }) };`],
        ['plain App instance export', `export default { ${managedMarkers} onOpen() {} };`],
        ['named app instance export', `export const app = { ${managedMarkers} onOpen() {} };`],
        ['incomplete managed factory', `export default { ${managedMarkers} kernelConfig: { appName: 'incomplete' } };`],
        ['named-only managed factory', `export const factory = { ${managedMarkers} kernelConfig: { appName: 'named' }, initialize() {} };`],
        ['factory without kernel appName', `export default { ${managedMarkers} kernelConfig: {}, initialize() {} };`],
        ['factory with empty kernel appName', `export default { ${managedMarkers} kernelConfig: { appName: '' }, initialize() {} };`],
        ['factory with invalid kernel appName', `export default { ${managedMarkers} kernelConfig: { appName: 1 }, initialize() {} };`],
        ['factory missing persistence marker', `export default { appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v5', kernelConfig: { appName: 'missing_persistence' }, initialize() {} };`],
        ['factory with wrong persistence marker', `export default { persistenceSupport: 'state-session-v0', appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v5', kernelConfig: { appName: 'wrong_persistence' }, initialize() {} };`],
        ['factory missing lifecycle marker', `export default { persistenceSupport: 'state-session-v1', toolAuthoringProtocol: 'view-type-tools-v5', kernelConfig: { appName: 'missing_lifecycle' }, initialize() {} };`],
        ['factory with wrong lifecycle marker', `export default { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v1', toolAuthoringProtocol: 'view-type-tools-v5', kernelConfig: { appName: 'wrong_lifecycle' }, initialize() {} };`],
    ])('rejects %s', async (_name, source) => {
        const { worker, init } = await launch(source);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'E_INIT_FAILED' } });
        } finally {
            await worker.terminate();
        }
    });

    it.each([
        ['missing', `export default { ${lifecycleMarkers} kernelConfig: { appName: 'missing_authoring' }, initialize() {} };`],
        ['retired v2', `export default { ${lifecycleMarkers} toolAuthoringProtocol: 'view-type-tools-v2', kernelConfig: { appName: 'old_authoring' }, initialize() {} };`],
        ['retired v3', `export default { ${lifecycleMarkers} toolAuthoringProtocol: 'view-type-tools-v3', kernelConfig: { appName: 'old_authoring' }, initialize() {} };`],
        ['wrong value', `export default { ${lifecycleMarkers} toolAuthoringProtocol: 'view-local-tools-v2', kernelConfig: { appName: 'wrong_authoring' }, initialize() {} };`],
        ['accessor', `const factory = { ${lifecycleMarkers} kernelConfig: { appName: 'accessor_authoring' }, initialize() {} }; Object.defineProperty(factory, 'toolAuthoringProtocol', { get() { throw new Error('authoring accessor invoked'); } }); export default factory;`],
    ])('rejects %s tool authoring protocol before factory initialization', async (_name, source) => {
        const { worker, init } = await launch(source);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false,
                error: { code: 'APP_AUTHORING_PROTOCOL_UNSUPPORTED' } });
        } finally {
            await worker.terminate();
        }
    });

    it.each([undefined, { projectPath: '/fixture/project', AOTUI_APP_KEY: 'host_key' }])(
        'passes the Host launchConfig to the managed factory as supplied (%j)', async config => {
        const { worker, init, appInstanceId } = await launch(`
            export default {
                persistenceSupport: 'state-session-v1',
                appLifecycleSupport: 'app-lifecycle-v2',
                toolAuthoringProtocol: 'view-type-tools-v5',
                kernelConfig: { appName: 'managed', launchConfig: { projectPath: 'retired-default' } },
                async initialize(context) {
                    if (JSON.stringify(context.launchConfig) !== ${JSON.stringify(JSON.stringify(config))}) throw new Error('WRONG_LAUNCH_CONFIG');
                    if (Object.hasOwn(globalThis, '__AOTUI_APP_CONFIG__')) throw new Error('GLOBAL_CONFIG_FALLBACK_PRESENT');
                    if (context.publishFrame(() => ({ views: [] })).status !== 'prepared') throw Error('EMPTY_PROJECTION_NOT_PREPARED');
                    return { close() {} };
                },
            };
        `, undefined, 'managed', config);
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
