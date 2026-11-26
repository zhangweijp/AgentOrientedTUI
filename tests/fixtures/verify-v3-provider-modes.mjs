import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const [consumerPath, evidencePath, filter] = process.argv.slice(2);
assert.ok(consumerPath && evidencePath, 'Usage: verify-v3-provider-modes.mjs <installed consumer> <new evidence directory> [case filter]');
const consumer = resolve(consumerPath), evidence = resolve(evidencePath);
await mkdir(evidence);
const stage = await mkdtemp(join(consumer, '.provider-modes-'));
await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
for (const fixture of ['provider-mode-files.ts', 'provider-mode-values.ts', 'provider-mode-local.mjs',
    'provider-mode-files.mjs', 'provider-mode-ref.mjs', 'provider-mode-run.mjs', 'batch-two-support.mjs',
    'batch-ten-delivery.mjs', 'claude-tool-search.mjs'])
    await cp(new URL(fixture, import.meta.url), join(stage, fixture));
for (const file of ['files.ts', 'file-io.mjs', 'file-io.d.mts'])
    await cp(join(consumer, 'node_modules/@aotui/sdk/examples/files', file), join(stage, file));
await cp(new URL('../../sdk/tests/fixtures/batch-three-contacts.ts', import.meta.url), join(stage, 'batch-three-contacts.ts'));
const run = promisify(execFile);
await run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022',
    '--module', 'NodeNext', '--types', 'node', '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false',
    '--outDir', 'dist', 'provider-mode-files.ts', 'provider-mode-values.ts', 'files.ts', 'batch-three-contacts.ts'], { cwd: stage });
await cp(join(stage, 'file-io.mjs'), join(stage, 'dist/file-io.mjs'));
try {
    const { stdout, stderr } = await run(process.execPath, [join(stage, 'provider-mode-run.mjs'), evidence, filter ?? ''], {
        env: { ...process.env, AOTUI_DATA_DIR: join(evidence, 'runtime-state') }, cwd: stage, maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(join(evidence, 'driver.log'), stdout + stderr);
    for (const line of stdout.split('\n').filter(line => line.startsWith('passed '))) console.log(line);
} catch (error) {
    await writeFile(join(evidence, 'driver.log'), error.stdout + error.stderr);
    throw new Error('Local experiment failed. See ' + join(evidence, 'driver.log'), { cause: error });
}
