import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const apps = ['demo-apps/aotui-ide', 'demo-apps/planning-app', 'demo-apps/terminal-app', 'demo-apps/lite-browser-app'];
const packages = ['core', 'sdk', 'runtime', 'agent-driver-v2', 'agent-driver-adapter', ...apps, 'host'];

test('first launch installs, builds and registers once, then subsequent launches only rebuild', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aotui-dev-shell-')));
    const bin = join(root, 'bin');
    try {
        for (const directory of [...packages, 'bin', 'scripts']) await mkdir(join(root, directory), { recursive: true });
        for (const path of ['setup.sh', 'run.sh', 'scripts/dev-packages.sh'])
            await copyFile(new URL('../' + path, import.meta.url), join(root, path));

        const command = `#!/bin/bash
printf '%s|%s|%s\\n' "\${0##*/}" "\${PWD#\$AOTUI_TEST_ROOT/}" "\$*"
if [ "\${0##*/}" = pnpm ]; then
    if [ "\$1" = install ]; then mkdir -p node_modules; fi
    if [ "\$1" = -C ] && [ "\$3" = install ]; then mkdir -p "\$2/node_modules/linkedom"; fi
fi
`;
        for (const name of ['pnpm', 'npm', 'node']) await writeFile(join(bin, name), command, { mode: 0o755 });
        const env = { ...process.env, PATH: bin + delimiter + process.env.PATH,
            AOTUI_TEST_ROOT: root, AOTUI_CONSOLE_NODE: process.execPath };
        const run = () => execFileSync('bash', ['run.sh'], { cwd: root, env, encoding: 'utf8' }).trim().split('\n');
        const calls = run();
        const actualPackages = action => calls.filter(line => line.startsWith('pnpm|') && line.includes(' ' + action))
            .map(line => line.split('|')[2].split(' ')[1]);
        assert.deepEqual(actualPackages('install'), packages);
        assert.deepEqual(actualPackages('build'), packages);
        assert.equal(calls.filter(line => line === 'npm|host|link').length, 1);
        assert.deepEqual(calls.filter(line => line.includes('/app-distribution/cli.js install . --force'))
            .map(line => line.split('|')[1]), apps);
        assert.deepEqual(calls.filter(line => line.includes('/scripts/link-local-preact.mjs'))
            .map(line => line.split(' ').at(-1).slice(root.length + 1)), apps);
        assert.equal(calls.at(-1), 'pnpm|host|electron:dev');

        const subsequent = run();
        assert.deepEqual(subsequent.filter(line => line.endsWith(' build'))
            .map(line => line.split('|')[2].split(' ')[1]), packages);
        assert.equal(subsequent.filter(line => line.includes('install') || line === 'npm|host|link').length, 0);
        assert.equal(subsequent.at(-1), 'pnpm|host|electron:dev');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
