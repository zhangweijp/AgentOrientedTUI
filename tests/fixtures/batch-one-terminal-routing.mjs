import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@aotui/runtime';
import { appClient, observe } from './batch-two-support.mjs';

const [output, fixture = fileURLToPath(new URL('../../demo-apps/terminal-app', import.meta.url))] = process.argv.slice(2);
const projectPath = await realpath(await mkdtemp(join(tmpdir(), 'aotui-terminal-routing-')));
const runtime = createRuntime();
let sequence = 0;

async function start(projectionLimits) {
    const desktop = await runtime.createDesktop();
    await desktop.registerPendingApp({ installationId: 'terminal', localPath: fixture, config: { projectPath }, projectionLimits });
    const appId = (await desktop.openApp('terminal')).appId;
    return appClient(desktop, appId).client;
}

async function invoke(client, observation, name, input, viewId) {
    const tool = observation.tools.find(tool => tool.name === name);
    assert.ok(tool, name);
    const result = await client.invoke({ observationId: observation.observationId, toolId: tool.id,
        invocationId: 'terminal-check-' + ++sequence, input, ...(viewId === undefined ? {} : { viewId }) });
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    return result.receipt.outcome;
}

async function open(client, command, observation) {
    const owned = observation ?? await observe(client, true);
    try { return await invoke(client, owned, 'new_terminal_and_send_command', { command }); }
    finally { if (!observation) client.release(owned.observationId); }
}

const pages = observation => observation.views.filter(view => view.type === 'Terminal');
const tails = observation => Object.fromEntries(pages(observation).map(view => [view.id,
    Number(/Output Tail:\*\* (\d+) lines/.exec(view.content.value)?.[1])]));
const evidence = {};
try {
    const client = await start();
    const rejected = await open(client, 'cd . && pwd');
    assert.equal(rejected.details?.result.error?.code, 'COMMAND_REJECTED');
    const first = await open(client, 'cd .');
    const second = await open(client, 'cd .');
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    const ids = [first.value.data.view_id, second.value.data.view_id];
    const active = await observe(client, true);
    assert.deepEqual(pages(active).map(view => view.id), ids);
    const before = tails(active);
    assert.deepEqual(before, { [ids[0]]: 50, [ids[1]]: 50 });
    const expanded = await invoke(client, active, 'load_more_output', { tail_lines: 3 }, ids[1]);
    assert.equal(expanded.status, 'succeeded');
    const after = await observe(client);
    assert.deepEqual(tails(after), { [ids[0]]: 50, [ids[1]]: 53 });
    client.release(after.observationId);

    assert.equal((await invoke(client, active, 'close_terminal', {}, ids[1])).status, 'succeeded');
    const reopened = await open(client, 'cd .', active);
    assert.equal(reopened.status, 'succeeded');
    const old = await invoke(client, active, 'load_more_output', { tail_lines: 1 }, ids[1]);
    assert.equal(old.code, 'VIEW_INSTANCE_REVOKED');
    client.release(active.observationId);
    const current = await observe(client);
    assert.notEqual(reopened.value.data.view_id, ids[1]);
    assert.deepEqual(tails(current), { [ids[0]]: 50, [reopened.value.data.view_id]: 50 });
    client.release(current.observationId);
    evidence.routing = { rejected, ids, before, after: tails(after), reopened, revoked: old.code };

    const limited = await start({ maxViews: 3 });
    const accepted = await open(limited, 'cd .');
    assert.equal(accepted.status, 'succeeded');
    const held = await observe(limited, true);
    const full = await open(limited, "printf 'unexpected' > rejected-command.txt", held);
    assert.equal(full.details?.result.error?.code, 'OBSERVATION_CAPACITY');
    const unchanged = await observe(limited);
    assert.deepEqual(pages(unchanged).map(({ id, viewInstanceId }) => [id, viewInstanceId]),
        pages(held).map(({ id, viewInstanceId }) => [id, viewInstanceId]));
    assert.equal((await invoke(limited, held, 'load_more_output', { tail_lines: 1 }, accepted.value.data.view_id)).status, 'succeeded');
    await delay(100);
    await assert.rejects(readFile(join(projectPath, 'rejected-command.txt')), { code: 'ENOENT' });
    limited.release(unchanged.observationId);
    limited.release(held.observationId);
    evidence.capacity = { code: full.details.result.error.code, existingId: accepted.value.data.view_id, commandEffect: 'absent' };
    evidence.passed = true;
} finally {
    const shutdown = await runtime.beginClose().completion;
    evidence.released = shutdown.resourcesReleased;
    if (output) await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    await rm(projectPath, { recursive: true, force: true });
    assert.equal(shutdown.resourcesReleased, true);
}
console.log('PASS Terminal receipt routing, reversible capacity and old mount revocation');
