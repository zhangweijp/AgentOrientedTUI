import { WORKER_PROTOCOL } from '../../spi/worker-protocol/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';

describe('Worker accepts only the managed App factory contract', () => {
    let temp: string;
    let workerScript: string;
    const root = resolve(process.cwd());
    const lifecycleMarkers = "persistenceSupport: 'state-session-v2', appLifecycleSupport: 'app-lifecycle-v2',";
    const managedMarkers = `${lifecycleMarkers} toolAuthoringProtocol: 'view-type-tools-v7',`;

    beforeAll(async () => {
        temp = await mkdtemp(join(tmpdir(), 'aotui-worker-factory-contract-'));
        const modules = join(temp, 'node_modules');
        await mkdir(modules, { recursive: true });
        for (const [owner, name] of [['../core', 'acorn'], ['../sdk', 'linkedom'], ['.', 'preact']]) {
            await symlink(join(root, owner, 'node_modules', name), join(modules, name), 'dir');
        }
        await mkdir(join(modules, '@aotui'), { recursive: true });
        await symlink(resolve(root, '../core'), join(modules, '@aotui/core'), 'dir');
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

    async function launch(appSource: string, workerFields: { protocol?: unknown; toolsEnabled?: unknown } = { protocol: WORKER_PROTOCOL, toolsEnabled: false }, appName?: string,
        config?: Record<string, unknown>, limitFields: { projectionLimits?: unknown } = { projectionLimits: DEFAULT_PROJECTION_LIMITS },
        storageFields: { manifestPersistence?: unknown; timeoutMs?: unknown } = {}) {
        const appScript = join(temp, `app-${Math.random().toString(36).slice(2)}.mjs`);
        await writeFile(appScript, appSource, 'utf8');
        const worker = new Worker(workerScript);
        const appInstanceId = `instance-${Math.random().toString(36).slice(2)}`;
        worker.on('message', (message: any) => {
            if (message?.type !== 'STATE_STORAGE_REQUEST' || message.action !== 'release') return;
            worker.postMessage({ type: 'STATE_STORAGE_RESPONSE', version: 2,
                instanceId: message.instanceId, sequence: message.sequence, action: 'release',
                result: { status: 'released' } });
        });
        const init = await request(worker, {
            type: 'INIT', requestId: 'init', appId: 'factory_test', desktopId: 'desktop_test',
            appInstanceId,
            appModulePath: pathToFileURL(appScript).href,
            ...workerFields,
            ...limitFields,
            ...(appName === undefined ? {} : { appName }),
            ...(config === undefined ? {} : { config }),
            timeoutMs: 3000,
            ...storageFields,
            appLifecycle: { protocol: 'app-lifecycle-v2', instanceId: appInstanceId },
        });
        return { worker, init, appInstanceId };
    }

    it.each([
        { fields: {}, path: 'INIT.projectionLimits' },
        { fields: { projectionLimits: { ...DEFAULT_PROJECTION_LIMITS, maxRefs: 0 } }, path: 'INIT.projectionLimits.maxRefs' },
        { fields: { projectionLimits: { ...DEFAULT_PROJECTION_LIMITS, metadata: {} } }, path: 'INIT.projectionLimits.metadata.maxDepth' },
    ])('rejects malformed effective limits at $path before importing the App', async ({ fields, path }) => {
        const { worker, init } = await launch('throw Error("App must not be imported")', undefined, undefined, undefined, fields);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false,
                error: { code: 'E_INIT_FAILED', diagnostic: { phase: 'INIT', path } } });
        } finally { await worker.terminate(); }
    });

    it.each([
        { fields: { toolsEnabled: false }, code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        { fields: { protocol: 'app-worker/future', toolsEnabled: true }, code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        { fields: { protocol: 'app-worker/v5', toolsEnabled: true }, code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        { fields: { protocol: WORKER_PROTOCOL }, code: 'APP_INIT_INVALID' },
        { fields: { protocol: WORKER_PROTOCOL, toolsEnabled: 'false' }, code: 'APP_INIT_INVALID' },
    ])('refuses malformed Worker INIT with $code before importing the App', async ({ fields, code }) => {
        const { worker, init } = await launch('throw Error("App must not be imported")', fields);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code } });
        } finally { await worker.terminate(); }
    });

    it('rejects the retired state namespace key before importing the App', async () => {
        const { worker, init } = await launch('throw Error("App must not be imported")', undefined, undefined, { AOTUI_APP_NAME: 'old_key' });
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'APP_CONFIG_UNSUPPORTED' } });
        } finally { await worker.terminate(); }
    });

    it('refuses a registered name that differs from the factory before rendering', async () => {
        const { worker, init } = await launch(`export default { ${managedMarkers} app_name: 'canonical', initialize() { throw Error('must not render'); } };`, undefined, 'alias');
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'APP_IDENTITY_MISMATCH' } });
            expect(init.error.message).toContain('INIT.appName');
        } finally { await worker.terminate(); }
    });

    it.each([
        ['callable factory and global config fallback', `const factory = Object.assign(() => globalThis.__AOTUI_APP_CONFIG__ ? ({ onOpen() {} }) : ({}), { ${managedMarkers} }); export default factory;`],
        ['legacy create factory', `export default { ${managedMarkers} create: () => ({ onOpen() {} }) };`],
        ['plain App instance export', `export default { ${managedMarkers} onOpen() {} };`],
        ['invalid export without a tool authoring protocol', `export default { ${lifecycleMarkers} app_name: 'broken' };`],
        ['named app instance export', `export const app = { ${managedMarkers} onOpen() {} };`],
        ['incomplete managed factory', `export default { ${managedMarkers} app_name: 'incomplete' };`],
        ['named-only managed factory', `export const factory = { ${managedMarkers} app_name: 'named', initialize() {} };`],
        ['factory without app_name', `export default { ${managedMarkers} initialize() {} };`],
        ['factory with empty app_name', `export default { ${managedMarkers} app_name: '', initialize() {} };`],
        ['factory with invalid app_name', `export default { ${managedMarkers} app_name: 1, initialize() {} };`],
        ['factory with wrong persistence marker', `export default { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v7', app_name: 'wrong_persistence', initialize() {} };`],
        ['factory missing lifecycle marker', `export default { persistenceSupport: 'state-session-v2', toolAuthoringProtocol: 'view-type-tools-v7', app_name: 'missing_lifecycle', initialize() {} };`],
        ['factory with wrong lifecycle marker', `export default { persistenceSupport: 'state-session-v2', appLifecycleSupport: 'app-lifecycle-v1', toolAuthoringProtocol: 'view-type-tools-v7', app_name: 'wrong_lifecycle', initialize() {} };`],
    ])('rejects %s', async (_name, source) => {
        const { worker, init } = await launch(source);
        try {
            const error = _name === 'factory with wrong persistence marker'
                ? { code: 'PERSISTENCE_UNAVAILABLE' }
                : { code: 'E_INIT_FAILED', diagnostic: { code: 'APP_INVALID_EXPORT' } };
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error });
        } finally {
            await worker.terminate();
        }
    });

    it.each([{}, { manifestPersistence: null }])('runs a no-storage factory with %j and does not negotiate storage', async fields => {
        const { worker, init, appInstanceId } = await launch(`
            export default {
                appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v7',
                app_name: 'no_storage',
                initialize(context) {
                    if ('persistence' in context) throw Error('UNEXPECTED_STATE_PORT');
                    context.defineViewTypes([]);
                    context.publishFrame(() => ({ views: [] }));
                    return { close() {} };
                }
            }
        `, undefined, undefined, { AOTUI_APP_KEY: 3, persistence: true }, undefined, fields);
        try {
            expect(init).toMatchObject({ type: 'INIT_RESPONSE', success: true, appInstanceId });
            expect(init).not.toHaveProperty('persistence');
            for (const type of ['APP_OPEN', 'APP_STOP', 'APP_CLOSE']) {
                const response = await request(worker, { type, requestId: type });
                expect(response).toMatchObject({ type: 'LIFECYCLE_RESPONSE', success: true });
                expect(response).not.toHaveProperty('persistence');
                if (type === 'APP_CLOSE') expect(response.appCleanup.state).toBe('completed');
            }
        } finally { await worker.terminate(); }
    });

    it.each([{ manifestPersistence: null }, { timeoutMs: -1 }])('rejects an opted-in factory with %j before business initialization', async fields => {
        const { worker, init } = await launch(`export default { ${managedMarkers} persistenceSupport: 'state-session-v2',
            app_name: 'needs_storage', initialize() { throw Error('Business initialization must not run'); } };`,
            undefined, undefined, undefined, undefined, fields);
        try {
            expect(init).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'PERSISTENCE_UNAVAILABLE' } });
            const opened = await request(worker, { type: 'APP_OPEN', requestId: 'open' });
            expect(opened).toMatchObject({ type: 'ERROR_RESPONSE', success: false, error: { code: 'E_NOT_INITIALIZED' } });
        } finally { await worker.terminate(); }
    });

    it.each([
        ['missing', `export default { ${lifecycleMarkers} app_name: 'missing_authoring', initialize() {} };`],
        ['retired v2', `export default { ${lifecycleMarkers} toolAuthoringProtocol: 'view-type-tools-v2', app_name: 'old_authoring', initialize() {} };`],
        ['retired v3', `export default { ${lifecycleMarkers} toolAuthoringProtocol: 'view-type-tools-v3', app_name: 'old_authoring', initialize() {} };`],
        ['wrong value', `export default { ${lifecycleMarkers} toolAuthoringProtocol: 'view-local-tools-v2', app_name: 'wrong_authoring', initialize() {} };`],
        ['accessor', `const factory = { ${lifecycleMarkers} app_name: 'accessor_authoring', initialize() {} }; Object.defineProperty(factory, 'toolAuthoringProtocol', { get() { throw new Error('authoring accessor invoked'); } }); export default factory;`],
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
                persistenceSupport: 'state-session-v2',
                appLifecycleSupport: 'app-lifecycle-v2',
                toolAuthoringProtocol: 'view-type-tools-v7',
                app_name: 'managed',
                async initialize(context) {
                    if (JSON.stringify(context.launchConfig) !== ${JSON.stringify(JSON.stringify(config))}) throw new Error('WRONG_LAUNCH_CONFIG');
                    if (context.projectionLimits.maxViews !== ${DEFAULT_PROJECTION_LIMITS.maxViews}) throw new Error('WRONG_PROJECTION_LIMITS');
                    if (Object.hasOwn(globalThis, '__AOTUI_APP_CONFIG__')) throw new Error('GLOBAL_CONFIG_FALLBACK_PRESENT');
                    if (context.publishFrame(() => ({ views: [] })).status !== 'prepared') throw Error('EMPTY_PROJECTION_NOT_PREPARED');
                    return { close() {} };
                },
            };
        `, undefined, 'managed', config);
        try {
            expect(init).toMatchObject({
                type: 'INIT_RESPONSE', success: true, appInstanceId,
                projectionLimits: DEFAULT_PROJECTION_LIMITS,
                appLifecycle: { protocol: 'app-lifecycle-v2', instanceId: appInstanceId },
                persistence: { protocol: 'state-session-v2', version: 2, instanceId: appInstanceId },
            });
            const opened = await request(worker, { type: 'APP_OPEN', requestId: 'open' });
            expect(opened).toMatchObject({ type: 'LIFECYCLE_RESPONSE', success: true });
            const closed = await request(worker, { type: 'APP_CLOSE', requestId: 'close' });
            expect(closed).toMatchObject({
                type: 'LIFECYCLE_RESPONSE', success: true,
                persistence: { protocol: 'state-session-v2', instanceId: appInstanceId, ok: true,
                    unmount: 'completed', dispose: { status: 'disposed', release: { status: 'released' } } },
            });
        } finally {
            await worker.terminate();
        }
    });
});
