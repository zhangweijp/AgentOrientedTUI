import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppManagerOptions } from './manager.js';
import { createSqliteStateStorage } from '../../adapters/storage/sqlite-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from './state-storage-host.js';
import { readSqliteState } from '../../../tests/fixtures/sqlite-state.js';
let AppManager: typeof import('./manager.js').AppManager;
import { defineRuntimeConfig } from '../../spi/config/index.js';

describe('installation errors across a real Worker and AppManager', () => {
    const root = resolve(process.cwd());
    let temp: string;
    beforeAll(async () => {
        temp = await mkdtemp(join(tmpdir(), 'aotui-install-error-'));
        await mkdir(join(temp, 'node_modules'));
        await mkdir(join(temp, 'node_modules/@aotui'), { recursive: true });
        await symlink(join(root, '../sdk'), join(temp, 'node_modules/@aotui/sdk'), 'dir');
        for (const [owner, name] of [['../core', 'acorn'], ['../sdk', 'linkedom'], ['.', 'preact']]) {
            await symlink(join(root, owner, 'node_modules', name), join(temp, 'node_modules', name), 'dir');
        }
        ({ AppManager } = await import(pathToFileURL(join(root, 'dist/engine/app/manager.js')).href));
    });
    afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

    async function fixture(id: string, source: string, storageBackend?: AppManagerOptions['storageBackend']) {
        const file = join(temp, id + '.mjs');
        const data = join(temp, 'data-' + id);
        await writeFile(file, source);
        const manager = new AppManager({
            id: 'diagnostics' as any, emitSignal() {}, logSystem() {},
        }, { runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 3000, maxWorkers: 1 } }),
            ...(storageBackend ? { storageBackend } : {}) });
        const installing = manager.install(pathToFileURL(file).href, {
            installationId: id, name: 'diagnostics',
            config: { AOTUI_APP_KEY: id, AOTUI_DATA_DIR: data },
        });
        return { manager, installing, data, sandbox: manager.getWorkerSandbox('diagnostics' as any) };
    }

    function app(renderBody: string) {
        return `import { h } from 'preact';
import { createTUIApp, defineViewType } from '@aotui/sdk';
export default {
    persistenceSupport: 'state-session-v2', appLifecycleSupport: 'app-lifecycle-v2',
    toolAuthoringProtocol: 'view-type-tools-v7',
    kernelConfig: { appName: 'diagnostics' },
    initialize(context) {
        function InitialRender() { ${renderBody} }
        return createTUIApp({viewTypes:[],  app_name: 'diagnostics', component: () => h(InitialRender, {}) }).initialize(context);
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
                        code, appId: 'diagnostics', phase,
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
                    expect(released.host?.storage.unsafe).toBe(false);
                    expect(released.host?.storage.lifecycle).toMatchObject({
                        ok: true, unmount: 'completed', dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } },
                    });
                    expect(released.host?.storage.lifecycle?.flush).toMatchObject({ status: 'completed', ok: true, entries: [] });
                } else expect(released.host?.storage).toMatchObject({ support: 'rejected', unsafe: false });
                expect(f.manager.getWorkerSandbox('diagnostics' as any)).toBeUndefined();
            } finally {
                expect((await f.manager.cleanupAsync()).resourcesReleased).toBe(true);
            }
        });

    it.each([false, true])('preserves an actual save outcome after a startup error (rejected write: %s)', async rejectWrite => {
        const backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS);
        let writes = 0;
        const id = rejectWrite ? 'open_after_rejection' : 'open_after_save';
        const f = await fixture(id, `import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: 'diagnostics', persistence: true, viewTypes: [],
    async initialize({ persistence }) {
        await persistence.save('draft', 'written during open').catch(() => {});
        throw new TypeError('original open error');
    },
});`, { async open(input) {
            const opened = await backend.open(input);
            if (opened.status !== 'opened') return opened;
            return { status: 'opened', storage: { ...opened.storage, async replace(address, text) {
                writes++;
                return rejectWrite ? { status: 'failed', effects: 'none', issue: { code: 'IO_FAILED', message: 'Storage I/O failed' } }
                    : opened.storage.replace(address, text);
            } } };
        } });
        try {
            await expect(f.installing).rejects.toMatchObject({ code: 'INSTALL_FAILED', cause: { code: 'INSTALL_FAILED',
                cause: { code: 'E_OPEN_FAILED', cause: { name: 'TypeError', message: 'original open error' } } } });
            expect(writes).toBe(1);
            const stored = readSqliteState(join(f.data, 'app-state'), 'diagnostics', id, 'draft');
            if (rejectWrite) expect(stored).toBeUndefined();
            else expect(JSON.parse(stored!).value).toBe('written during open');
            expect(f.sandbox!.getCloseReport()).toMatchObject({ ok: false, resourcesReleased: true,
                host: { worker: 'exited', storage: { unsafe: rejectWrite, actualIO: 0, ownerRetained: false,
                    lifecycle: { ok: !rejectWrite, unmount: 'completed', flush: { ok: !rejectWrite,
                        entries: [{ status: rejectWrite ? 'failed' : 'saved' }] }, dispose: { release: { status: 'released' } } } } } });
            expect(backend.getStats().ownerSlots).toBe(0);
        } finally { await f.manager.cleanupAsync(); }
    });

    it('keeps successful first render, installation and close working without diagnostic wrappers', async () => {
        const f = await fixture('healthy_render', app("return h('section', {}, 'ready');"));
        try {
            await expect(f.installing).resolves.toBe('diagnostics');
            expect(f.manager.getInstalledApps()).toMatchObject([{ installationId: 'healthy_render', appId: 'diagnostics', status: 'running' }]);
        } finally {
            const report = await f.manager.cleanupAsync();
            expect(report).toMatchObject({ ok: true, resourcesReleased: true,
                interactions: { retainedOperations: 0, retainedBytes: 0 },
                resources: { retainedStorageOwners: 0, storageActualIO: 0 } });
        }
    });
});
