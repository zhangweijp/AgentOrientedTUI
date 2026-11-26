import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each(['direct', 'pending'])('captures launch configuration at %s installation and receives it in the actual Worker', async method => {
    const runtimeUrl = new URL('../../dist/index.js', import.meta.url);
    const sdkUrl = new URL('../../../sdk/dist/index.js', import.meta.url).href;
    const { createRuntime } = await import(runtimeUrl.href) as typeof import('../index.js');
    const directory = await mkdtemp(join(tmpdir(), 'aotui-config-'));
    const runtime = createRuntime();
    try {
        const path = join(directory, 'app.mjs');
        await writeFile(path, `
            import { createApp, createView, defineViewType } from ${JSON.stringify(sdkUrl)};
            const Root = defineViewType()({ name: 'Root', region: 'static', multiplicity: 'single' });
            export default createApp({ app_name: 'configuration', viewTypes: [Root],
                initialize({ launchConfig, projectionLimits, prepareProjection }) {
                    const root = createView(Root, { render: () => ({
                        body: launchConfig.env.E2E_TEST_VAR + ':' + projectionLimits.maxViews,
                    }) });
                    prepareProjection({ views: [root] });
                },
            });
        `);
        await writeFile(join(directory, 'aoapp.json'), JSON.stringify({
            app_name: 'configuration', version: '1.0.0', entry: { main: './app.mjs' },
            toolAuthoringProtocol: 'view-type-tools-v8', appLifecycleSupport: 'app-lifecycle-v2',
        }));
        const desktop = await runtime.createDesktop();
        const config = { env: { E2E_TEST_VAR: 'confirmed' } };
        const projectionLimits = { maxViews: 2 };
        const starting = method === 'direct'
            ? desktop.installDynamicWorkerApp(path, { name: 'configuration', config, projectionLimits })
            : desktop.registerPendingApp({ installationId: 'configuration', localPath: directory, config, projectionLimits })
                .then(id => desktop.openApp(id));
        config.env.E2E_TEST_VAR = 'late change';
        projectionLimits.maxViews = 3;
        const app = await starting;
        expect(await app.preview()).toMatchObject({ status: 'previewed', views: [{ content: { value: 'confirmed:2' } }] });
        const initial = await app.observe();
        expect(initial.status).toBe('prepared');
        expect(await app.preview()).toMatchObject({ status: 'previewed', views: [{ id: 'Root' }] });
        if (initial.status !== 'prepared') throw Error(initial.issue.code);
        expect(desktop.adoptTurn({ apps: [{ candidate: initial.candidate }] }).status).toBe('adopted');
        expect(await app.beginClose().completion).toMatchObject({ resourcesReleased: true, worker: 'exited' });
    } finally {
        await runtime.beginClose().completion;
        await rm(directory, { recursive: true, force: true });
    }
});
