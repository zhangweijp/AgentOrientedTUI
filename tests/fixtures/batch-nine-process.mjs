import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNodeConsoleExecutor, createNodeScopedConsoleExecutor } from '@aotui/agent-driver-adapter';

const program = (code, options = {}) => ({ code, names: [], inputs: { status: 'ready', refs: {}, paths: [] },
    signal: new AbortController().signal, recheck() {}, async invoke() { throw Error('No Tool registered'); }, ...options });
const exited = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
const err = { code: 'FIXTURE_REF_REVOKED', message: 'Revoked before begin.' };
const executor = createNodeScopedConsoleExecutor({ timeoutMs: 1_700 });
const facts = {};
try {
    const first = await executor(program('let x = 1; const getFirst = () => x; var sum = 2; const object = {};'));
    assert.equal(first.scope, 'retained');
    const pid = first.environmentPid;
    assert.ok(pid);
    const mutation = await executor(program('x = 4; object.key = 8; var sum = sum + 1; const broken = broken;'));
    assert.equal(mutation.error.code, 'CONSOLE_PROGRAM_FAILED');
    const retained = await executor(program('inspect([x,getFirst(),sum,object.key,typeof broken]);'));
    assert.deepEqual(retained.output, ["[ 4, 1, 3, 8, 'undefined' ]"]);
    assert.equal(retained.environmentPid, pid);
    const skip = await executor(program('x = 999;', { recheck: () => err }));
    assert.equal(skip.error.code, err.code);
    const shadow = await executor(program('const refs = {};'));
    assert.equal(shadow.error.code, 'CONSOLE_PROGRAM_FAILED');
    assert.match(shadow.error.message, /supplied for each Console run/);
    const resetSkipped = await executor(program('inspect("must not run");', { reset: true, recheck: () => err }));
    assert.equal(resetSkipped.error.code, err.code);
    assert.notEqual(resetSkipped.process.pid, pid);
    exited(resetSkipped.process.pid);
    assert.deepEqual((await executor(program('inspect(x);'))).output, ['4']);
    const reset = await executor(program('inspect(typeof x); let after = 7;', { reset: true }));
    assert.deepEqual(reset.output, ['undefined']);
    assert.equal(reset.scope, 'reset');
    assert.notEqual(reset.environmentPid, pid);
    exited(pid);
    facts.reset = { first, mutation, retained, skip, shadow, resetSkipped, reset };

    const entered = Promise.withResolvers(), allow = Promise.withResolvers();
    const waiting = executor(program('await tools.wait({}); inspect(after);', { names: ['wait'],
        async invoke() { entered.resolve();await allow.promise;return {}; },
    }));
    await Promise.race([entered.promise, waiting.then(result => { throw Error(JSON.stringify(result)); })]);
    try {
        const busy = await executor(program('after = 100;'));
        assert.equal(busy.error.code, 'CONSOLE_BUSY');
        facts.busy = busy;
    } finally { allow.resolve(); }
    assert.deepEqual((await waiting).output, ['7']);

    process.kill(reset.environmentPid, 'SIGKILL');
    for (let i = 0; i < 40; i++) {
        try { exited(reset.environmentPid);break; } catch { await sleep(10); }
    }
    await sleep(20);
    const unexpected = await executor(program('inspect("do not run on unexpected loss");'));
    assert.equal(unexpected.error.code, 'CONSOLE_STATE_LOST');
    assert.equal(unexpected.scope, 'lost');
    assert.deepEqual(unexpected.output, []);
    const recovered = await executor(program('inspect(typeof after);'));
    assert.deepEqual(recovered.output, ['undefined']);
    const timeout = await executor(program('inspect("before timeout"); while (true) {}'));
    assert.equal(timeout.error.code, 'CONSOLE_TIMEOUT');
    assert.equal(timeout.scope, 'lost');
    assert.deepEqual(timeout.output, ['before timeout']);
    exited(recovered.environmentPid);
    facts.loss = { unexpected, recovered, timeout };
} finally { await executor.dispose(); }

const starting = createNodeScopedConsoleExecutor();
const pending = starting(program('inspect("never start");'));
await starting.dispose();
facts.closedDuringStartup = await pending;
assert.equal(facts.closedDuringStartup.error.code, 'CONSOLE_CANCELLED');
assert.deepEqual(facts.closedDuringStartup.output, []);
exited(facts.closedDuringStartup.process.pid);
const one = createNodeConsoleExecutor();
const first = await one(program('const x: number = 3; inspect(x);'));
const second = await one(program('inspect(typeof x);'));
assert.deepEqual(first.output, ['3']);
assert.deepEqual(second.output, ['undefined']);
exited(first.process.pid);exited(second.process.pid);
facts.oneShot = { first, second };
await writeFile(process.argv[2], JSON.stringify(facts, null, 2));
