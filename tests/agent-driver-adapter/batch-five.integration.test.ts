import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const prepare = fileURLToPath(new URL('../fixtures/prepare-batch-two-consumer.mjs', import.meta.url));

it('sends author Markdown, table structure and original mount routes through both installed API hosts', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aotui-markdown-integration-'));
    const evidence = process.env.AOTUI_BATCH_FIVE_EVIDENCE || scratch;
    try {
        const runs = await Promise.allSettled(['product', 'independent'].map(async mode => {
            const configured = mode === 'product' ? process.env.AOTUI_BATCH_FIVE_PRODUCT : process.env.AOTUI_BATCH_FIVE_INDEPENDENT;
            const consumer = configured || join(scratch, `${mode}-consumer`);
            if (!configured) await run(process.execPath, [prepare, consumer, 'batch-five', ...(mode === 'product' ? ['--product'] : [])]);
            const folder = join(evidence, mode);
            await mkdir(folder, { recursive: true });
            await run(process.execPath, [join(consumer, 'batch-five-host.mjs'), mode, folder], { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
            return JSON.parse(await readFile(join(folder, mode + '.json'), 'utf8'));
        }));
        const result = runs.map(run => {
            if (run.status === 'rejected') throw run.reason;
            return run.value;
        });
        for (const proof of result) {
            expect(proof).toMatchObject({ passed: true, shutdown: { resourcesReleased: true, workers: { report: { total: 0 } } },
                effects: { stored: 'stored once', writes: [{ operation: 'save_bad_table' }],
                    handlers: [{ id: 'right', value: 'left in original observation' }], pings: [{ peer: 'healthy' }] } });
        }
        const [product, portable] = result;
        expect(product.initial).toEqual(portable.initial);
        expect(product.fault.issue).toEqual(portable.fault.issue);
        expect(product.fault.repaired).toEqual(portable.fault.repaired);
        const requestFacts = (proof: typeof product) => proof.requests.map(({ label, body }: { label: string; body: {
            messages: { role: string; content: unknown }[];
            tools: { function: { name: string; parameters: object } }[];
        } }) => ({ label, views: body.messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' &&
            message.content.startsWith('<view ') ? [message.content] : []).sort(),
        tools: body.tools.map(tool => tool.function).filter(tool => !tool.name.startsWith('system-') && tool.name !== 'run_code')
            .map(tool => [tool.name, tool.parameters]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }));
        for (const { body } of product.requests) expect(body.tools.filter((tool: { function: { name: string } }) =>
            tool.function.name === 'run_code')).toHaveLength(1);
        expect(requestFacts(product)).toEqual(requestFacts(portable));
    } finally { await rm(scratch, { recursive: true, force: true }); }
}, 100_000);
