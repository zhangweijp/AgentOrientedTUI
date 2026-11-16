import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { AppWorkerHost } from './worker-host.js';

it('forwards the exact usage event to the Worker SDK hook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aotui-llm-usage-'));
    const runtimeRoot = resolve(process.cwd());
    const repoRoot = resolve(runtimeRoot, '..');
    const workerScript = join(directory, 'worker.mjs');
    const appFile = join(directory, 'app.mjs');
    const modules = join(directory, 'node_modules');
    let host: AppWorkerHost | undefined;
    let worker: Worker | undefined;
    try {
        await mkdir(join(modules, '@aotui'), { recursive: true });
        await symlink(join(runtimeRoot, 'node_modules/preact'), join(modules, 'preact'), 'dir');
        await symlink(join(repoRoot, 'sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
        await symlink(join(runtimeRoot, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
        await symlink(runtimeRoot, join(modules, '@aotui/runtime'), 'dir');

        await build({
            entryPoints: [join(runtimeRoot, 'src/worker-runtime/index.ts')],
            outfile: workerScript, bundle: true, platform: 'node', format: 'esm',
            target: 'node20', packages: 'external', logLevel: 'silent',
        });

        await build({
            stdin: {
                contents: `
                    import { h } from 'preact';
                    import { useEffect } from 'preact/hooks';
                    import { parentPort } from 'node:worker_threads';
                    import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
                    import { View } from './sdk/src/components/View.tsx';
                    import { useLLMUsage } from './sdk/src/hooks/useLLMUsage.ts';
const _FixtureRoot = defineViewType({ name:'Root' });

import { defineViewType } from './sdk/src/tools/view-type-tool.ts';

                    function Content() {
                        useLLMUsage(event => parentPort.postMessage({
                            type: 'TEST_LLM_EVENT', detail: event,
                        }));
                        useEffect(() => {
                            parentPort.postMessage({ type: 'TEST_LLM_LISTENER_READY' });
                        }, []);
                        return h('p', {}, 'Listening for LLM usage');
                    }
                    function Root() {
                        return h(View, {kind: 'instruction', id: 'root', type: _FixtureRoot }, h(Content, {}));
                    }
                    export default createTUIApp({viewTypes:[_FixtureRoot],  app_name: 'llm_usage_test', component: Root });
                `,
                resolveDir: repoRoot,
                sourcefile: 'llm-usage-fixture.tsx',
                loader: 'tsx',
            },
            outfile: appFile, bundle: true, platform: 'node', format: 'esm',
            target: 'node20', packages: 'external', logLevel: 'silent',
        });

        worker = new Worker(workerScript);
        let observed: any;
        let listenerReady = false;
        worker.on('message', message => {
            if (message?.type === 'TEST_LLM_EVENT') observed = message.detail;
            if (message?.type === 'TEST_LLM_LISTENER_READY') listenerReady = true;
        });
        host = new AppWorkerHost({
            appId: 'llm_usage_test' as any,
            desktopId: 'desktop' as any,
            appModulePath: appFile,
            workerScriptPath: workerScript,
            existingWorker: worker,
        });
        const usage = Object.freeze({
            timestamp: 10, providerId: 'test-provider', modelId: 'model-123',
            promptTokens: 11, completionTokens: 7, totalTokens: 18,
        });
        const before = structuredClone(usage);

        await host.start();
        await host.open();
        await vi.waitFor(() => expect(listenerReady).toBe(true));
        host.pushLLMUsage(usage);
        await vi.waitFor(() => expect(observed).toEqual(before));
        expect(usage).toEqual(before);
        await host.close();
    } finally {
        host?.terminate();
        await worker?.terminate();
        await host?.waitForResourceRelease();
        await rm(directory, { recursive: true, force: true });
    }
});
