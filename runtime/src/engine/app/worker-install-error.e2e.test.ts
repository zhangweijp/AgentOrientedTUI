import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppManager } from './manager.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';

describe('installation errors across a real Worker and AppManager', () => {
    const root = resolve(process.cwd());
    let temp: string, workerScript: string;
    beforeAll(async () => {
        temp = await mkdtemp(join(tmpdir(), 'aotui-install-error-'));
        await mkdir(join(temp, 'node_modules'));
        await mkdir(join(temp, 'node_modules/@aotui'), { recursive: true });
        await symlink(join(root, '../sdk'), join(temp, 'node_modules/@aotui/sdk'), 'dir');
        for (const name of ['linkedom', 'preact']) {
            await symlink(join(root, 'node_modules', name), join(temp, 'node_modules', name), 'dir');
        }
        workerScript = join(temp, 'worker.mjs');
        await build({ entryPoints: [join(root, 'src/worker-runtime/index.ts')], outfile: workerScript,
            bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    });
    afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

    async function fixture(id: string, source: string) {
        const file = join(temp, id + '.mjs');
        await writeFile(file, source);
        const manager = new AppManager({
            id: 'diagnostics' as any, emitSignal() {}, logSystem() {},
        }, { runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 3000, maxWorkers: 1 } }) });
        const installing = manager.install(pathToFileURL(file).href, {
            appId: id as any, workerScriptPath: workerScript,
            config: { AOTUI_APP_KEY: id, AOTUI_DATA_DIR: join(temp, 'data-' + id) },
        });
        return { manager, installing, sandbox: manager.getWorkerSandbox(id as any) };
    }

    function app(renderBody: string) {
        return `import { h } from 'preact';
import { createTUIApp } from '@aotui/sdk';
export default {
    persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2',
    toolAuthoringProtocol: 'view-type-tools-v4', displayName: 'diagnostics',
    kernelConfig: { name: 'diagnostics', appName: 'diagnostics' },
    initialize(context) {
        function InitialRender() { ${renderBody} }
        return createTUIApp({ app_name: 'diagnostics', component: () => h(InitialRender, {}) }).initialize(context);
    },
};`;
    }

    it.each([
        ['OPEN', 'E_OPEN_FAILED', 'TypeError', 'initial-render-sentinel',
            app("throw new TypeError('initial-render-sentinel');")],
        ['INIT', 'E_INIT_FAILED', 'SyntaxError', 'module-import-sentinel',
            "throw new SyntaxError('module-import-sentinel'); export default {};"],
    ])('preserves the original %s exception through both INSTALL_FAILED wrappers and releases resources',
        async (phase, code, name, message, source) => {
            const id = 'broken_' + phase.toLowerCase();
            const f = await fixture(id, source);
            try {
                const error = await f.installing.catch(error => error);
                expect(error).toBeInstanceOf(Error);
                expect(error).toMatchObject({
                    code: 'INSTALL_FAILED', message: 'INSTALL_FAILED',
                    cause: { code: 'INSTALL_FAILED', cause: {
                        code, appId: id, phase,
                        cause: { name, message, stack: expect.stringContaining(message) },
                    } },
                });
                expect(error.cause.cause.code).not.toBe('PERSISTENCE_CLOSE_FAILED');
                expect(error.cause.cause.cause.stack).toContain(id + '.mjs');
                for (const wrapper of [error, error.cause, error.cause.cause]) {
                    expect(Object.getOwnPropertyDescriptor(wrapper, 'cause')?.enumerable).toBe(false);
                }
                expect(JSON.stringify(error)).not.toContain(message);
                const released = f.sandbox!.getCloseReport();
                expect(released).toMatchObject({ state: 'settled', resourcesReleased: true });
                expect(released.host?.interactions).toMatchObject({ closed: true, retainedOperations: 0, retainedBytes: 0 });
                // Developer diagnostics stay on the rejected Error, not in bounded cleanup summaries.
                expect(JSON.stringify(released)).not.toContain(message);
                if (phase === 'OPEN') {
                    // Initial failure deliberately aborts persistence without a final save;
                    // the separate dispose facts still prove that its owner was released.
                    expect(released.host?.storage.lifecycle).toMatchObject({
                        ok: false, unmount: 'completed', dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } },
                    });
                    expect(released.host?.storage.lifecycle?.flush).toMatchObject({ status: 'disposed', ok: false, entries: [] });
                }
                expect(f.manager.getDynamicAppIds()).toEqual([]);
            } finally {
                expect((await f.manager.cleanupAsync()).resourcesReleased).toBe(true);
            }
        });

    it('keeps successful first render, installation and close working without diagnostic wrappers', async () => {
        const f = await fixture('healthy_render', app("return h('section', {}, 'ready');"));
        try {
            await expect(f.installing).resolves.toBe('healthy_render');
            expect(f.manager.getInstalledApps()).toMatchObject([{ appId: 'healthy_render', status: 'running' }]);
        } finally {
            const report = await f.manager.cleanupAsync();
            expect(report).toMatchObject({ ok: true, resourcesReleased: true,
                interactions: { retainedOperations: 0, retainedBytes: 0 },
                resources: { retainedStorageOwners: 0, storageActualIO: 0 } });
        }
    });
});
