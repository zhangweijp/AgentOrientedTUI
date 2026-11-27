import { expect, it } from 'vitest';
import { APP_LIFECYCLE_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each(['direct', 'pending'].flatMap(method => ['missing', 'empty', 'configured'].map(kind => ({ method, kind }))))(
    'captures $kind launch configuration at $method installation and receives it in the actual Worker', async ({ method, kind }) => {
    const runtimeUrl = new URL('../../dist/index.js', import.meta.url);
    const sdkUrl = new URL('../../../sdk/dist/index.js', import.meta.url).href;
    const { createRuntime } = await import(runtimeUrl.href) as typeof import('../index.js');
    const directory = await mkdtemp(join(tmpdir(), 'aotui-config-'));
    const runtime = createRuntime();
    try {
        const path = join(directory, 'app.mjs');
        await writeFile(path, `import { createApp, createView, defineViewType } from ${JSON.stringify(sdkUrl)};
            let declarationConfig, declared, declarations = 0, initializations = 0;
            export default createApp({ app_name: 'configuration',
                viewTypes(config) {
                    declarations++;
                    declarationConfig = config;
                    const missing = config === undefined;
                    declared = defineViewType()({ name: missing ? 'Missing' : 'Provided', region: 'static', multiplicity: 'single',
                        tools: { [missing ? 'missing_read' : 'provided_read']: {
                            description: 'Read captured configuration', execute: ({ context }) => ({
                                success: true, data: { body: context.body, declarations, initializations },
                            }),
                        } },
                    });
                    return [declared];
                },
                initialize(author, types) {
                    initializations++;
                    const { launchConfig, projectionLimits, publish: publishAuthorFrame } = author;
                    if (types[0] !== declared || !Object.isFrozen(types) || !Object.is(launchConfig, declarationConfig)
                        || Object.hasOwn(author, 'launchConfig') !== (launchConfig !== undefined)) throw Error('canonical capture mismatch');
                    const body = launchConfig === undefined ? 'missing:' + projectionLimits.maxViews :
                        (launchConfig.env?.E2E_TEST_VAR ?? 'empty') + ':' + projectionLimits.maxViews + ':' +
                        Object.isFrozen(launchConfig) + ':' + (launchConfig.env === undefined || Object.isFrozen(launchConfig.env));
                    const root = (() => { const handle = createView(types[0]); return { handle, frame: () => handle.frame({ body, context: { body } }) }; })();
                    publishAuthorFrame(() => ([root]).map(page => page.frame()));
                },
            });
        `);
        await writeFile(join(directory, 'aoapp.json'), JSON.stringify({
            app_name: 'configuration', version: '1.0.0', entry: { main: './app.mjs' },
            toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL, appLifecycleSupport: APP_LIFECYCLE_PROTOCOL,
        }));
        const desktop = await runtime.createDesktop();
        const config = kind === 'missing' ? undefined : kind === 'empty' ? {} : { env: { E2E_TEST_VAR: 'confirmed' } };
        const projectionLimits = { maxViews: 2 };
        const starting = method === 'direct'
            ? desktop.installDynamicWorkerApp(path, { name: 'configuration', ...(config === undefined ? {} : { config }), projectionLimits })
            : desktop.registerPendingApp({ installationId: 'configuration', localPath: directory, ...(config === undefined ? {} : { config }), projectionLimits })
                .then(id => desktop.openApp(id));
        if (config?.env) config.env.E2E_TEST_VAR = 'late change';
        projectionLimits.maxViews = 3;
        const app = await starting;
        const body = kind === 'missing' ? 'missing:2' : kind === 'empty' ? 'empty:2:true:true' : 'confirmed:2:true:true';
        const viewId = kind === 'missing' ? 'Missing' : 'Provided';
        const toolName = kind === 'missing' ? 'missing_read' : 'provided_read';
        expect(await app.preview()).toMatchObject({ status: 'previewed', views: [{ id: viewId, content: { value: body } }] });
        const initial = await app.observe();
        expect(initial.status).toBe('prepared');
        if (initial.status !== 'prepared') throw Error(initial.issue.code);
        const observation = initial.candidate.observation;
        expect(observation.tools.map(tool => tool.name)).toEqual([toolName]);
        const adopted = desktop.adoptTurn({ apps: [{ candidate: initial.candidate }] });
        expect(adopted.status).toBe('adopted');
        if (adopted.status !== 'adopted') throw Error(adopted.issue.code);
        try {
            expect(await adopted.turn.invoke(app.appId, { observationId: observation.observationId,
                invocationId: 'read-config', toolId: observation.tools[0]!.id, input: {} })).toMatchObject({
                    kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true,
                        data: { body, declarations: 1, initializations: 1 } } } },
                });
        } finally { adopted.turn.release(); }
        expect(await app.beginClose().completion).toMatchObject({ resourcesReleased: true, worker: 'exited' });
    } finally {
        await runtime.beginClose().completion;
        await rm(directory, { recursive: true, force: true });
    }
});
