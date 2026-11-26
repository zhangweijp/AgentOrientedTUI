import { expect, it, vi } from 'vitest';
import { createRuntime, type AppExecutionBackend, type AppExecutionEvent, type AppExecutionHandle, type AppExecutionProjection,
    type AppExecutionRequest, type IDesktop, type RunningApp } from '../index.js';

const frame: AppExecutionProjection = {
    revision: 1,
    views: [{ id: 'file', type: 'File', name: 'File', region: 'dynamic', body: 'A read-only view of this test file.',
        viewInstanceId: 'file-mount', tools: [{ name: 'edit', activationId: 'edit-activation' }] }],
    refs: [{ id: 'text', viewId: 'file', viewInstanceId: 'file-mount', scope: 'public', valueSchema: { type: 'string' }, value: 'seed' }],
    tools: [{ name: 'edit', viewType: 'File', multiplicity: 'single', description: 'Edit the file.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
};

function controlled(releaseOnTerminate = true) {
    const runs: {
        started: string; emit: (event: AppExecutionEvent) => void;
        invoked: ReturnType<typeof Promise.withResolvers<Extract<AppExecutionRequest, { kind: 'invoke' }>>>;
        terminate: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
        messages: AppExecutionRequest[];
    }[] = [];
    const backend: AppExecutionBackend = {
        start(launch, emit) {
            expect(launch.checkProjection(frame)).toBeUndefined();
            const invoked = Promise.withResolvers<Extract<AppExecutionRequest, { kind: 'invoke' }>>();
            const messages: AppExecutionRequest[] = [];
            const terminate = vi.fn<() => void | Promise<void>>(() => {
                if (releaseOnTerminate) emit({ kind: 'exited' });
            });
            runs.push({ started: launch.instanceId, emit, invoked, terminate, messages });
            return { terminate, send(request) {
                messages.push(request);
                const { id } = request;
                switch (request.kind) {
                    case 'initialize': return emit({ kind: 'reply', id, status: 'ready' });
                    case 'open':
                        emit({ kind: 'projection', frame });
                        return emit({ kind: 'reply', id, status: 'done' });
                    case 'observe': return emit({ kind: 'projection', id, frame });
                    case 'invoke': return invoked.resolve(request);
                    case 'stop':
                        return emit({ kind: 'reply', id, status: 'done', cleanup: { state: 'stopped', issues: [] } });
                    case 'close':
                        return emit({ kind: 'reply', id, status: 'done', cleanup: { state: 'completed', issues: [] } });
                }
            } };
        },
    };
    return { backend, runs };
}

async function register(desktop: IDesktop, installationId = 'isolated') {
    await desktop.registerPendingApp({ installationId, name: 'files', backend: 'sandbox' });
    return installationId;
}

async function observe(desktop: IDesktop, app: RunningApp) {
    const prepared = await app.observe();
    if (prepared.status !== 'prepared') throw new Error(JSON.stringify(prepared));
    const { candidate } = prepared;
    const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
    if (adopted.status !== 'adopted') throw new Error(JSON.stringify(adopted));
    return { turn: adopted.turn, observation: candidate.observation };
}

it('captures a backend at registration, coalesces duplicate starts and never substitutes the default', async () => {
    const { backend, runs } = controlled();
    const registry = { sandbox: backend, unavailable: { start() {
        throw Object.assign(new Error('The configured execution is denied'), { code: 'SANDBOX_DENIED' });
    } } };
    const runtime = createRuntime({ executionBackends: registry, worker: { maxWorkers: 1, timeoutMs: 1000 } });
    try {
        const desktop = await runtime.createDesktop();
        await expect(desktop.registerPendingApp({ installationId: 'unset', name: 'files', backend: 'missing' }))
            .rejects.toMatchObject({ code: 'EXECUTION_BACKEND_UNAVAILABLE', path: 'options.backend' });
        await desktop.registerPendingApp({ installationId: 'unavailable', name: 'files', backend: 'unavailable' });
        await expect(desktop.openApp('unavailable')).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'SANDBOX_DENIED' },
            closeReport: { resourcesReleased: true, worker: 'not-created' },
        });
        registry.sandbox = registry.unavailable;
        const installation = await register(desktop);
        expect(runs).toHaveLength(0);
        await expect(desktop.openApp(installation, { backend: 'unavailable' } as never)).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        const [first, second] = await Promise.all([desktop.openApp(installation), desktop.openApp(installation)]);
        expect(first).toBe(second);
        expect(runs.map(run => run.started)).toEqual([first.instanceId]);
        expect((await first.beginClose().completion).resourcesReleased).toBe(true);
        const next = await desktop.openApp(installation);
        expect(next.instanceId).not.toBe(first.instanceId);
        runs[0]!.emit({ kind: 'projection', frame: { ...frame, revision: 90, views: [] } });
        expect((await observe(desktop, next)).observation.views.map(view => view.id)).toEqual(['file']);
        expect(runs).toHaveLength(2);
    } finally { await runtime.beginClose().completion; }
});

it.each([false, true])('settles dispatch after channel end while keeping the slot until exit (tail reply: %s)', async tail => {
    const { backend, runs } = controlled(false);
    const runtime = createRuntime({ executionBackends: { sandbox: backend }, worker: { maxWorkers: 1, timeoutMs: 1000 } });
    try {
        const desktop = await runtime.createDesktop();
        const installation = await register(desktop);
        const app = await desktop.openApp(installation);
        const { turn, observation } = await observe(desktop, app);
        const pendingCandidate = await app.observe();
        if (pendingCandidate.status !== 'prepared') throw new Error(JSON.stringify(pendingCandidate));
        const input = { invocationId: 'edit-once', observationId: observation.observationId, toolId: observation.tools[0]!.id, input: { value: 'once' } };
        const pending = turn.invoke(app.appId, input, 1000);
        const run = runs[0]!, request = await run.invoked.promise;
        expect(request).toMatchObject({ tool: { viewType: 'File', name: 'edit' }, input: { value: 'once' } });
        expect(request.tool).not.toHaveProperty('id');
        if (tail) run.emit({ kind: 'reply', id: request.id, status: 'tool',
            terminal: { phase: 'entered-returned', result: { success: true, data: { written: 1 } } } });
        run.emit({ kind: 'channelEnded' });
        const terminal = await pending;
        expect(terminal).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: tail ? 'succeeded' : 'unknown' } } });
        expect(await app.readReceipt(input)).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_INVALID' });
        const query = { invocationId: input.invocationId, observationId: input.observationId };
        expect((await app.readReceipt(query))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: tail ? 'succeeded' : 'unknown' } } });
        expect(await app.observe()).toMatchObject({ status: 'rejected', issue: { code: 'EXECUTION_CHANNEL_ENDED' } });
        expect(desktop.adoptTurn({ apps: [{ candidate: pendingCandidate.candidate }] })).toMatchObject({ status: 'rejected' });
        pendingCandidate.candidate.discard();
        await register(desktop, 'other');
        await expect(desktop.openApp('other')).rejects.toMatchObject({ cause: { code: 'WORKER_CAPACITY_EXCEEDED' } });
        expect(runs).toHaveLength(1);
        expect(run.messages.filter(message => message.kind === 'invoke')).toHaveLength(1);
        run.terminate.mockRejectedValueOnce(new Error('Transport refused to terminate'));
        const closing = app.beginClose();
        const pendingRelease = await closing.wait({ timeoutMs: 10 });
        expect(pendingRelease).toMatchObject({ status: 'settled', report: { resourcesReleased: false, worker: 'retiring',
            failures: expect.arrayContaining([expect.objectContaining({ codes: expect.arrayContaining(['WORKER_TERMINATION_FAILED']) })]) } });
        await expect(desktop.openApp('other')).rejects.toMatchObject({ cause: { code: 'WORKER_CAPACITY_EXCEEDED' } });
        run.emit({ kind: 'exited' });
        run.emit({ kind: 'exited' });
        const next = await desktop.openApp('other');
        expect(next.instanceId).not.toBe(app.instanceId);
        expect(runs).toHaveLength(2);
        expect(closing.inspect().resourcesReleased).toBe(false);
        expect(await app.beginClose().completion).toMatchObject({ worker: 'exited', resourcesReleased: true, hasFailures: true,
            failures: expect.arrayContaining([expect.objectContaining({ codes: expect.arrayContaining(['WORKER_TERMINATION_FAILED']) })]) });
        expect(run.terminate).toHaveBeenCalledOnce();
    } finally {
        for (const run of runs) run.emit({ kind: 'exited' });
        await runtime.beginClose().completion;
    }
});

it('keeps the new handle when close is reentered during start', async () => {
    let closing: ReturnType<ReturnType<typeof createRuntime>['beginClose']> | undefined;
    const terminate = vi.fn();
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 1000 }, executionBackends: {
        sandbox: { start(_launch, emit) {
            closing = runtime.beginClose();
            return { send() { throw new Error('Closing must prevent the handshake'); }, terminate() {
                terminate();
                emit({ kind: 'exited' });
            } };
        } },
    } });
    const desktop = await runtime.createDesktop();
    const installation = await register(desktop);
    await expect(desktop.openApp(installation)).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    expect(await closing?.completion).toMatchObject({ resourcesReleased: true, workers: { report: { total: 0 } } });
    expect(terminate).toHaveBeenCalledOnce();
});

it('observes a transport that exits synchronously during start without dispatching initialization', async () => {
    const send = vi.fn(), terminate = vi.fn();
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 1000 }, executionBackends: {
        sandbox: { start(_launch, emit) {
            emit({ kind: 'channelEnded', issue: { code: 'EXECUTION_START_CRASH', message: 'The process ended during start' } });
            emit({ kind: 'exited' });
            return { send, terminate };
        } },
    } });
    try {
        const desktop = await runtime.createDesktop();
        await expect(desktop.openApp(await register(desktop))).rejects.toMatchObject({ code: 'INSTALL_FAILED',
            cause: { code: 'EXECUTION_START_CRASH' }, closeReport: { resourcesReleased: true, worker: 'exited' },
        });
        expect(send).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
    } finally { await runtime.beginClose().completion; }
});

it('rejects a reused handle without terminating the original execution', async () => {
    const { backend, runs } = controlled();
    let shared: AppExecutionHandle | undefined;
    const runtime = createRuntime({ worker: { maxWorkers: 2, timeoutMs: 1000 }, executionBackends: {
        sandbox: { start(launch, emit) { return shared ??= backend.start(launch, emit); } },
    } });
    try {
        const desktop = await runtime.createDesktop();
        const app = await desktop.openApp(await register(desktop));
        await expect(desktop.openApp(await register(desktop, 'second'))).rejects.toMatchObject({
            code: 'INSTALL_FAILED', cause: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' },
            closeReport: { resourcesReleased: true, worker: 'not-created' },
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]?.terminate).not.toHaveBeenCalled();
        expect((await observe(desktop, app)).observation.views).toHaveLength(1);
        expect((await app.beginClose().completion).resourcesReleased).toBe(true);
        expect(runs[0]?.terminate).toHaveBeenCalledOnce();
    } finally { await runtime.beginClose().completion; }
});

it('reports the original handshake failure when a created execution has not yet exited', async () => {
    const emitters: ((event: AppExecutionEvent) => void)[] = [];
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs: 1000 }, executionBackends: {
        sandbox: { start(_launch, emit) {
            emitters.push(emit);
            return { send({ id }) { emit({ kind: 'reply', id, status: 'failed', issue: {
                code: 'PROTOCOL_UNSUPPORTED', message: 'Expected app.v1', path: '$.hello.version',
            } }); }, terminate: () => Promise.reject(new Error('Sandbox management refusal')) };
        } },
    } });
    try {
        const desktop = await runtime.createDesktop();
        const installation = await register(desktop);
        await expect(desktop.openApp(installation)).rejects.toMatchObject({ code: 'INSTALL_FAILED',
            cause: { code: 'PROTOCOL_UNSUPPORTED', cause: { path: '$.hello.version' } },
            closeReport: { worker: 'retiring', resourcesReleased: false, failures: expect.arrayContaining([
                expect.objectContaining({ codes: expect.arrayContaining(['WORKER_TERMINATION_FAILED']) }),
            ]) },
        });
        expect(emitters).toHaveLength(1);
    } finally {
        for (const emit of emitters) emit({ kind: 'exited' });
        expect(await runtime.beginClose().completion).toMatchObject({ resourcesReleased: true, workers: { report: { total: 0 } } });
    }
});

it('retries failed release from Runtime without repeating App cleanup or counting a termination request as exit', async () => {
    const { backend, runs } = controlled(false);
    const runtime = createRuntime({ executionBackends: { sandbox: backend }, worker: { maxWorkers: 1, timeoutMs: 1000 } });
    const desktop = await runtime.createDesktop();
    await desktop.openApp(await register(desktop));
    const run = runs[0]!;
    run.terminate.mockImplementationOnce(() => { throw new Error('First termination refused'); });
    const first = runtime.beginClose();
    const partial = await first.completion;
    expect(partial).toMatchObject({ state: 'settled', resourcesReleased: false,
        workers: { report: { state: 'closing', total: 1 } } });
    expect(partial.failures).toContainEqual(expect.objectContaining({
        codes: expect.arrayContaining(['WORKER_TERMINATION_FAILED']),
    }));
    const retry = runtime.beginClose();
    expect(retry).not.toBe(first);
    expect(await retry.wait({ timeoutMs: 10 })).toMatchObject({ status: 'deadline',
        report: { state: 'closing', resourcesReleased: false, workers: { report: { total: 1 } } } });
    expect(run.terminate).toHaveBeenCalledTimes(2);
    run.emit({ kind: 'exited' });
    const released = await retry.completion;
    expect(released).toMatchObject({ resourcesReleased: true, hasFailures: true, workers: { report: { state: 'closed', total: 0 } } });
    expect(released.failures).toContainEqual(expect.objectContaining({
        codes: expect.arrayContaining(['WORKER_TERMINATION_FAILED']),
    }));
    expect(run.messages.filter(message => message.kind === 'stop' || message.kind === 'close').map(message => message.kind))
        .toEqual(['stop', 'close']);
});
