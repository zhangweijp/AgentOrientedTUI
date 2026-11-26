import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
        for (const [owner, name] of [['../core', 'acorn']]) {
            await symlink(join(root, owner, 'node_modules', name), join(temp, 'node_modules', name), 'dir');
        }
        ({ AppManager } = await import(pathToFileURL(join(root, 'dist/engine/app/manager.js')).href));
    });
    afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

    async function fixture(id: string, source: string) {
        const file = join(temp, id + '.mjs');
        const data = join(temp, 'data-' + id);
        await writeFile(file, source);
        const manager = new AppManager({
            id: 'diagnostics' as any, emitSignal() {}, logSystem() {},
        }, { runtimeConfig: defineRuntimeConfig({ worker: { timeoutMs: 3000, maxWorkers: 1 } }) });
        const installing = manager.install(pathToFileURL(file).href, {
            installationId: id, name: 'diagnostics',
            config: { AOTUI_DATA_DIR: data },
        });
        return { manager, installing, data, sandbox: manager.getManagedApp('diagnostics' as any) };
    }

    function app(renderBody: string) {
        return `import { createApp, createView, defineViewType } from '@aotui/sdk';
const Page = defineViewType({ name: 'Page', multiplicity: 'single', region: 'dynamic' });
export default createApp({ app_name: 'diagnostics', viewTypes: [Page], initialize({ prepareProjection }) {
    const page = createView(Page, { render() { ${renderBody} } });
    prepareProjection({ views: [page] });
} });`;
    }

    it.each([
        ['OPEN', 'E_OPEN_FAILED', 'TypeError', 'initial-render-sentinel',
            app("throw new TypeError('initial-render-sentinel');")],
        ['INIT', 'E_INIT_FAILED', 'SyntaxError', 'module-import-sentinel',
            "throw new SyntaxError('module-import-sentinel'); export default {};"],
    ])('preserves the original %s exception with the installation error and releases resources',
        async (phase, code, name, message, source) => {
            const id = 'broken_' + phase.toLowerCase();
            const f = await fixture(id, source);
            try {
                const error = await f.installing.catch(error => error);
                expect(error).toBeInstanceOf(Error);
                expect(error).toMatchObject({
                    code: 'INSTALL_FAILED', message: 'INSTALL_FAILED',
                    cause: { code, appId: 'diagnostics', phase,
                        cause: { name, message, stack: expect.stringContaining(message) } },
                });
                expect(error.cause.cause.stack).toContain(id + '.mjs');
                for (const wrapper of [error, error.cause]) {
                    expect(Object.getOwnPropertyDescriptor(wrapper, 'cause')?.enumerable).toBe(false);
                }
                expect(JSON.stringify(error)).not.toContain(message);
                const released = error.closeReport;
                expect(released).toMatchObject({ state: 'settled', resourcesReleased: true });
                expect(released.interactions).toMatchObject({ verified: true, retainedOperations: 0 });
                // Developer diagnostics stay on the rejected Error, not in bounded cleanup summaries.
                expect(JSON.stringify(released)).not.toContain(message);
                expect(released).not.toHaveProperty('persistence');
                expect(f.manager.getManagedApp('diagnostics' as any)).toBeUndefined();
            } finally {
                f.manager.clearInactiveInstallations();
            }
        });

    it('preserves an App-owned file write made before a startup error', async () => {
        const id = 'open_after_save';
        const f = await fixture(id, `import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '@aotui/sdk';
export default createApp({ app_name: 'diagnostics', viewTypes: [],
    async initialize({ launchConfig }) {
        const dir = String(launchConfig.AOTUI_DATA_DIR);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'draft.txt'), 'written during open', 'utf8');
        throw new TypeError('original open error');
    },
});`);
        try {
            const error = await f.installing.catch(error => error);
            expect(error).toMatchObject({ code: 'INSTALL_FAILED',
                cause: { code: 'E_OPEN_FAILED', cause: { name: 'TypeError', message: 'original open error' } } });
            await expect(readFile(join(f.data, 'draft.txt'), 'utf8')).resolves.toBe('written during open');
            expect(error.closeReport).toMatchObject({ ok: false, resourcesReleased: true, worker: 'exited' });
        } finally { f.manager.clearInactiveInstallations(); }
    });

    it('keeps successful first render, installation and close working without diagnostic wrappers', async () => {
        const f = await fixture('healthy_render', app("return { body: 'ready' };"));
        try {
            await expect(f.installing).resolves.toMatchObject({ appId: 'diagnostics', instanceId: expect.any(String) });
            expect(f.manager.listApps()).toMatchObject([{ installationId: 'healthy_render', appId: 'diagnostics', status: 'running' }]);
        } finally {
            const report = await f.sandbox!.beginClose().completion;
            expect(report).toMatchObject({ ok: true, resourcesReleased: true,
                interactions: { retainedOperations: 0 } });
        }
    });
});
