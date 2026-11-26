import { fixtureHost } from './__tests__/worker-fixture.js';
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
            await symlink(join(root, '../sdk/node_modules/typebox'), join(modules, 'typebox'), 'dir');
            await symlink(join(root, '../core/node_modules/acorn'), join(modules, 'acorn'), 'dir');
            await symlink(join(root, '../core'), join(modules, '@aotui/core'), 'dir');
            await symlink(root, join(modules, '@aotui/runtime'), 'dir');
            await build({
                entryPoints: [join(root, 'src/worker-runtime/index.ts')],
                outfile: workerFile, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            const fixture = `
                import Type from 'typebox';
                import { createApp, createView, defineViewType } from './sdk/src/index.ts';



                const noArgs = Type.Object({}, { additionalProperties: false });
                const FileDetail = defineViewType()({ multiplicity: 'multiple', name: 'FileDetail', tools: {
                    fail: {
                        description: 'Fails as business result', inputSchema: noArgs,
                        execute: async () => ({ success: false, error: {
                            code: 'BUSINESS_FAILED', message: 'The requested file is locked',
                        } }),
                    },
                    ok: {
                        description: 'Successful Tool', inputSchema: noArgs,
                        execute: async () => ({ success: true, data: { message: 'completed' } }),
                    },
                    invalid: {
                        description: 'Reject invalid Tool arguments',
                        inputSchema: Type.Object({ target: Type.String() }, { additionalProperties: false }),
                        execute: async () => ({ success: true, data: { unreachable: true } }),
                    },
                } });

                export default createApp({ viewTypes: [FileDetail], app_name: 'test_result',
                    initialize({ prepareProjection }) {
                        const page = createView(FileDetail, { idPrefix: 'root', region: 'static',
                            render: () => ({ body: 'Tool receipts', context: {} }) });
                        prepareProjection({ views: [page] });
                    },
                });
            `;
            await build({
                stdin: {
                    contents: fixture, resolveDir: resolve(root, '..'),
                    sourcefile: 'p0-result-fixture.ts', loader: 'ts',
                },
                outfile: appFile, bundle: true, platform: 'node',
                format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent',
            });
            host = fixtureHost(AppWorkerHost, {
                appId: 'result_app' as any, desktopId: 'result_desktop' as any,
                appModulePath: appFile,
                config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR! },
            }, { script: workerFile });
            await host.start();
            await host.open();

            const failed = await invokeObservedTool(host, 'fail', {}, 'root_1');
            expect(failed).toMatchObject({ kind: 'receipt', receipt: {
                executionPhase: 'entered-returned', outcome: { status: 'failed', details: {
                    kind: 'tool-result', result: { success: false, error: { code: 'BUSINESS_FAILED',
                        message: 'The requested file is locked' } },
                } },
            } });

            const ok = await invokeObservedTool(host, 'ok', {}, 'root_1');
            expect(ok).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded',
                value: { success: true, data: { message: 'completed' } },
            } } });

            const invalid = await invokeObservedTool(host, 'invalid', { target: 42 }, 'root_1');
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
