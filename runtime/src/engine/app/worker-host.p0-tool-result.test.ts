import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { invokeObservedTool } from '../../../tests/fixtures/semantic-worker-tools.js';

describe('P0: real WorkerHost TypeTool outcome is not transport status', () => {
    it('preserves business failure, succeeds on success and fails closed on an invalid Ref', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'aotui-p0-result-'));
        const root = resolve(process.cwd());
        const workerFile = join(temporary, 'worker.mjs');
        const appFile = join(temporary, 'app.mjs');
        let host: AppWorkerHost | undefined;
        try {
            const modules = join(temporary, 'node_modules');
            await mkdir(join(modules, '@aotui'), { recursive: true });
            await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
            await symlink(join(root, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
            await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerFile, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import { h } from 'preact';
                import Type from 'typebox';
                import { createTUIApp, defineViewTypeTool, AppTools, defineToolSet } from './sdk/src/index.ts';
                import { View } from './sdk/src/components/View.tsx';


const fixtureTools0 = defineToolSet({
Fail: defineViewTypeTool({
                        viewType: 'FileDetail', name: 'fail',
                        description: 'Fails as business result', inputSchema: Type.Object({}, {additionalProperties:false}), }),
OK: defineViewTypeTool({
                        viewType: 'FileDetail', name: 'ok', description: 'Successful Tool',
                        inputSchema: Type.Object({}, {additionalProperties:false}), }),
Invalid: defineViewTypeTool({
                        viewType: 'FileDetail', name: 'invalid', description: 'Reject invalid Tool arguments',
                        inputSchema: Type.Object({target:Type.String()}, {additionalProperties:false}), })
});
function App() {
                    return h(AppTools, { definition: fixtureTools0, bindings: {
Fail: { execute: async () => ({ success:false, error:{
                        code:'BUSINESS_FAILED', message:'The requested file is locked',
                    }}) },
OK: { execute: async () => ({success:true,data:{message:'completed'}}) },
Invalid: { execute: async () => ({success:true,data:{unreachable:true}}) }
} }, h(View,{kind: 'instruction',id:'root',type:'FileDetail'},'Tool receipts'));
                }
                export default createTUIApp({app_name:'test_result',component:App});
            `;
            await build({
                stdin: {
                    contents: fixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'p0-result-fixture.tsx', loader: 'tsx',
                },
                outfile: appFile, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            host = new AppWorkerHost({
                appId: 'result_app' as any, desktopId: 'result_desktop' as any,
                appModulePath: appFile, workerScriptPath: workerFile,
                interactionModes: ['view-type-parameters-v1'],
                config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR! },
            });
            await host.start();
            await host.open();

            const failed = await invokeObservedTool(host, 'fail', {}, 'root');
            expect(failed).toMatchObject({ kind: 'receipt', receipt: {
                executionPhase: 'entered-returned', outcome: { status: 'unknown', details: {
                    kind: 'tool-result', result: { success: false, error: { code: 'BUSINESS_FAILED',
                        message: 'The requested file is locked' } },
                } },
            } });

            const ok = await invokeObservedTool(host, 'ok', {}, 'root');
            expect(ok).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded',
                value: { success: true, data: { message: 'completed' } },
            } } });

            const invalid = await invokeObservedTool(host, 'invalid', { target: 42 }, 'root');
            expect(invalid).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'not-dispatched',
                outcome: { status: 'rejected' },
            } });
        } finally {
            host?.terminate();
            await host?.waitForResourceRelease();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 12_000);
});
