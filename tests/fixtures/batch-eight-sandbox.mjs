import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNodeConsoleExecutor } from '@aotui/agent-driver-adapter';

// The trusted probe uses the exact private launcher and package assets used by run_code.
const entry = import.meta.resolve('@aotui/agent-driver-adapter');
const { launchIsolatedNode } = await import(new URL('./console/node-process.js', entry));
const folder = await mkdtemp(join(tmpdir(), 'aotui-console-probe-'));
const canary = join(folder, 'canary.txt');
const pidExited = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
const key = 'AOTUI_CONSOLE_TEST_SECRET';
const prior = process.env[key];
process.env[key] = 'synthetic-env-canary';
let requests = 0;
const server = createServer((_request, response) => { requests++;response.end('synthetic'); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const input = { status: 'ready', refs: {}, paths: [] };
const config = process.versions.electron ? { nodePath: process.env.AOTUI_CONSOLE_NODE } : {};
const executor = createNodeConsoleExecutor({ ...config, timeoutMs: 2_000 });
const empty = code => ({ code, names: [], inputs: input, signal: new AbortController().signal,
    recheck() {}, invoke() { throw new Error('No Tool should be invoked'); } });
const facts = { platform: process.platform, arch: process.arch, node: process.version, electron: process.versions.electron };
try {
    await writeFile(canary, 'synthetic-file-canary');
    const bootstrap = join(folder, 'probe.mjs');
    await writeFile(bootstrap, `
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
const canary = ${JSON.stringify(canary)};
async function attempt(operation) {
    try { return { allowed: true, value: await operation() }; }
    catch (error) { return { allowed: false, code: error.cause?.code ?? error.code ?? error.name }; }
}
const result = {
    env: process.env[${JSON.stringify(key)}] ?? null,
    cwd: process.cwd(),
    read: await attempt(() => readFileSync(canary, 'utf8')),
    write: await attempt(() => writeFileSync(canary, 'modified')),
    network: await attempt(() => fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}`)}, { signal: AbortSignal.timeout(800) })),
    subprocess: await attempt(() => {
        const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 800 });
        if (result.error) throw result.error;
        return result.status;
    }),
};
createWriteStream('', { fd: 4 }).end(JSON.stringify(result));
`);
    const child = launchIsolatedNode(config, pathToFileURL(bootstrap));
    const exited = once(child, 'close');
    let report = '';
    for await (const chunk of child.stdio[4]) report += chunk;
    assert.deepEqual(await exited, [0, null]);
    pidExited(child.pid);
    facts.restrictions = JSON.parse(report);
    for (const action of ['read', 'write', 'network', 'subprocess']) assert.equal(facts.restrictions[action].allowed, false, action);
    assert.equal(facts.restrictions.env, null);
    assert.equal(facts.restrictions.cwd, '/');
    assert.equal(requests, 0);
    assert.equal(await readFile(canary, 'utf8'), 'synthetic-file-canary');

    const [first, second] = await Promise.all([
        executor(empty('const perRun: number = 1 + 2; inspect(await Promise.resolve(perRun));')),
        executor(empty('inspect(typeof perRun);')),
    ]);
    assert.deepEqual(first.output, ['3']);
    assert.deepEqual(second.output, ['undefined']);
    assert.notEqual(first.process.pid, second.process.pid);
    for (const result of [first, second]) pidExited(result.process.pid);
    facts.independentProcesses = [first, second];

    const ready = Promise.withResolvers(), stop = new AbortController();
    let cancelledCalls = 0;
    const abandoned = executor({ ...empty('inspect("entered"); await tools.wait({});'), names: ['wait'], signal: stop.signal,
        invoke(_name, _args, _slot, signal) {
            cancelledCalls++;
            ready.resolve();
            return once(signal, 'abort').then(() => ({ outcomeStatus: 'rejected' }));
        },
    });
    await Promise.race([ready.promise, abandoned.then(result => { throw new Error(JSON.stringify(result)); })]);
    stop.abort();
    facts.cancelled = await abandoned;
    assert.equal(facts.cancelled.error.code, 'CONSOLE_CANCELLED');
    assert.deepEqual(facts.cancelled.output, ['entered']);
    assert.equal(cancelledCalls, 1);
    pidExited(facts.cancelled.process.pid);

    facts.timeout = await createNodeConsoleExecutor({ ...config, timeoutMs: 1_000 })(empty('for (;;) {}'));
    assert.equal(facts.timeout.error.code, 'CONSOLE_TIMEOUT');
    pidExited(facts.timeout.process.pid);
    facts.prepareFailure = await createNodeConsoleExecutor({ nodePath: join(folder, 'missing-node') })(empty('throw Error("must not run")'));
    assert.equal(facts.prepareFailure.error.code, 'CONSOLE_ENVIRONMENT_UNAVAILABLE');
    assert.match(facts.prepareFailure.error.message, /AOTUI_CONSOLE_NODE/);
    assert.equal(facts.prepareFailure.process, undefined);
    facts.recheck = await executor({ ...empty('throw Error("must not run")'),
        recheck: () => ({ code: 'FIXTURE_REVOKED', message: 'Original paths revoked before execution.' }) });
    assert.equal(facts.recheck.error.code, 'FIXTURE_REVOKED');
    pidExited(facts.recheck.process.pid);
    facts.requests = requests;
    facts.exited = true;
    await writeFile(process.argv[2], JSON.stringify(facts, null, 2));
} finally {
    server.closeAllConnections();
    server.close();
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
    await rm(folder, { recursive: true, force: true });
}
