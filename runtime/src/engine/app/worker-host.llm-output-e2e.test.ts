import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { AppWorkerHost } from './worker-host.js';

it('forwards provider/model metadata to the Worker DOM event without mutating caller metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aotui-llm-output-'));
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
                    import { useLLMOutputChannel } from './sdk/src/hooks/useLLMOutputChannel.ts';

                    function Content() {
                        useLLMOutputChannel(event => parentPort.postMessage({
                            type: 'TEST_LLM_EVENT', detail: event,
                        }));
                        useEffect(() => {
                            parentPort.postMessage({ type: 'TEST_LLM_LISTENER_READY' });
                        }, []);
                        return h('p', {}, 'Listening for LLM output');
                    }
                    function Root() {
                        return h(View, { id: 'root', type: 'Root' }, h(Content, {}));
                    }
                    export default createTUIApp({ app_name: 'llm_output_test', component: Root });
                `,
                resolveDir: repoRoot,
                sourcefile: 'llm-output-fixture.tsx',
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
            appId: 'llm_output_test' as any,
            desktopId: 'desktop' as any,
            appModulePath: appFile,
            workerScriptPath: workerScript,
            existingWorker: worker,
        });
        const meta = Object.freeze({
            model: 'Model label', providerId: 'test-provider', modelId: 'model-123',
            usage: Object.freeze({ promptTokens: 11, completionTokens: 7, totalTokens: 18 }),
        });
        const before = structuredClone(meta);

        await host.start();
        await host.open();
        await vi.waitFor(() => expect(listenerReady).toBe(true));
        host.pushLLMOutput({ reasoning: 'reasoning', content: 'answer' }, 'complete', meta);
        await vi.waitFor(() => expect(observed).toBeDefined());

        expect(observed).toMatchObject({
            type: 'complete', content: 'answer', reasoning: 'reasoning', meta: before,
        });
        expect(meta).toEqual(before);
        await host.close();
    } finally {
        host?.terminate();
        await worker?.terminate();
        await host?.waitForResourceRelease();
        await rm(directory, { recursive: true, force: true });
    }
});
