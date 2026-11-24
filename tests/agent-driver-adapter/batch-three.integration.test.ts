import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
it('runs the same Ref contract through actual product and independent model requests from installed packages', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aotui-ref-contract-'));
    const consumer = process.env.AOTUI_BATCH_THREE_PACKAGE_DIR ?? join(scratch, 'consumer');
    const output = process.env.AOTUI_BATCH_THREE_EVIDENCE ?? scratch;
    try {
        await mkdir(output, { recursive: true });
        if (!process.env.AOTUI_BATCH_THREE_PACKAGE_DIR) {
            const installer = fileURLToPath(new URL('../fixtures/prepare-batch-two-consumer.mjs', import.meta.url));
            await run(process.execPath, [installer, consumer, 'batch-three']);
        }
        const facts = new Map<string, any>();
        for (const mode of ['product', 'independent']) {
            const evidence = join(output, mode), modules = join(evidence, 'modules');
            await mkdir(modules, { recursive: true });
            await run(process.execPath, ['--import', join(consumer, 'trace-batch-three-worker.mjs'),
                join(consumer, 'batch-three-public-host.mjs'), evidence, mode], {
                cwd: consumer, env: { ...process.env, AOTUI_BATCH_THREE_MODULES: modules },
            });
            const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
            const threads = Object.values(result.workers as Record<string, { threadId: number }[]>)
                .map(events => events[0]!.threadId);
            expect(new Set(threads).size).toBe(2);
            expect((await readdir(modules)).length).toBeGreaterThanOrEqual(2);
            for (const thread of threads) {
                const loaded = await readFile(join(modules, thread + '.jsonl'), 'utf8');
                expect(loaded).toContain('/worker-runtime/tool-invocation.js');
                expect(loaded).toContain('/dist/batch-three-');
                expect(loaded).not.toMatch(/(?:\/|\+)acorn(?:\/|@)/);
            }
            facts.set(mode, result);
        }
        const business = ({ writes }: { writes: any[] }) => writes.map(({ threadId: _, ...write }) => write);
        expect(business(facts.get('product'))).toEqual(business(facts.get('independent')));
    } finally { await rm(scratch, { recursive: true, force: true }); }
}, 120_000);
