import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const consumer = await realpath(process.argv[2]);
const cli = join(consumer, 'node_modules/.bin/agentina');
const execute = promisify(execFile);
const name = 'cli_manifest';
const folder = await mkdtemp(join(consumer, 'cli-app-'));
const home = join(folder, 'home');
const config = join(home, '.agentina/config.json');
const env = { ...process.env, HOME: home, USERPROFILE: home, AOTUI_DATA_DIR: join(home, 'data') };
delete env.AOTUI_APP_CATALOG_URL;
const runCli = (...args) => execute(cli, args, { cwd: folder, env, timeout: 5_000 });
async function waitFor(read, target) {
    const deadline = Date.now() + 5_000;
    while (!read().includes(target) && Date.now() < deadline) await setTimeout(20);
    assert.ok(read().includes(target), read());
}

try {
    await mkdir(home);
    await writeFile(join(folder, 'entry.mjs'), `
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const Item = defineViewType({ name: 'Item', multiplicity: 'single', region: 'dynamic' });
export default createApp({ app_name: '${name}', viewTypes: [Item], initialize({ prepareProjection }) {
    const current = createView(Item, { id: 'current', render: () => ({ body: 'View from the custom manifest entry' }) });
    prepareProjection({ views: [current] });
}});
`);
    await writeFile(join(folder, 'aoapp.json'), JSON.stringify({
        app_name: name, version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v7',
        appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './entry.mjs' },
    }));
    await runCli('install', '.');
    const first = JSON.parse(await readFile(config, 'utf8')).apps[name];
    assert.equal(first.source, 'local:' + folder);
    assert.equal(first.enabled, true);
    assert.equal(first.autoStart, true);
    assert.equal(first.distribution.type, 'local');
    await assert.rejects(runCli('install', '.'), error => error.code === 1 && error.stderr.includes('already registered'));
    await runCli('install', 'local:.', '--force', '--no-autostart');
    const forced = await readFile(config, 'utf8');
    assert.equal(JSON.parse(forced).apps[name].autoStart, false);
    for (const [command, arg] of [['add', '.'], ['link', '.'], ['uninstall', name]]) {
        await assert.rejects(runCli(command, arg), error => error.code === 1 && error.stderr.includes(`Unknown command: ${command}`));
    }
    assert.equal(await readFile(config, 'utf8'), forced);
    assert.ok((await runCli('list')).stdout.includes(name));
    assert.match((await runCli('search', 'planning')).stdout, /system-planning/);
    assert.match((await runCli('search', 'token')).stdout, /No app found for "token"/);

    const child = spawn(cli, ['run', name], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const finished = once(child, 'close');
    let output = '', errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    try {
        await waitFor(() => output + errors, 'Runtime ready.');
        child.stdin.write('snapshot\n');
        await waitFor(() => output, 'View from the custom manifest entry');
        assert.match(output, /<view view_id="current" view_type="Item" app_id="cli_manifest" app_name="cli_manifest">/);
        child.stdin.end('exit\n');
        assert.deepEqual(await finished, [0, null]);
        assert.equal(errors, '');
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await finished;
    }
    await runCli('remove', name);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).apps, {});
    assert.match(await readFile(join(folder, 'entry.mjs'), 'utf8'), /View from the custom manifest entry/);
    console.log('PASS installed agentina bin: install, search, list, run, snapshot, exit and remove');
} finally {
    await rm(folder, { recursive: true, force: true });
}
