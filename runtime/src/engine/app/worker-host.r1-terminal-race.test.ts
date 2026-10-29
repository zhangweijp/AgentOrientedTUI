import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost, type WorkerStatus } from './worker-host.js';

const methods = ['start', 'open', 'pause', 'resume', 'reinitialize'] as const;
type Request = { type: string; requestId?: string };
const settle = (operation: Promise<void>) => operation.then(
    () => ({ status: 'fulfilled' as const }),
    (error: Error) => ({ status: 'rejected' as const, message: error.message }),
);

function respond(worker: EventEmitter, request: Request) {
    worker.emit('message', {
        type: request.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
        requestId: request.requestId, success: true,
    });
}

function controlledHost(status: WorkerStatus = 'running') {
    const sent: Request[] = [];
    const worker = Object.assign(new EventEmitter(), {
        postMessage(message: Request) { sent.push(message); },
        terminate() { return Promise.resolve(0); },
    });
    const host = new AppWorkerHost({
        appId: 'r1_app' as any, desktopId: 'r1_desktop' as any,
        appModulePath: 'not-loaded', existingWorker: worker as any, timeout: 1000,
    });
    (host as any).status = status;
    return { host, worker, sent };
}

const workerSource = `
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', message => {
        if (message.type === 'TERMINATE') return process.exit(0);
        parentPort.postMessage({
            type: message.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
            requestId: message.requestId, success: true,
        });
    });
`;

afterEach(() => { vi.restoreAllMocks(); });

describe('Stage 8 R1: fulfilled lifecycle transport does not outlive its context', () => {
    const terminalCases = methods.flatMap(method =>
        (['terminate', 'exit', 'error'] as const).map(terminal => ({ method, terminal })));

    it.each(terminalCases)('$method rejects after fulfilled transport followed by $terminal', async ({ method, terminal }) => {
        const { host, worker, sent } = controlledHost();
        if (terminal === 'error') vi.spyOn(console, 'error').mockImplementation(() => {});
        const pending = settle(host[method]());
        try {
            respond(worker, sent[0]);
            expect((host as any).pendingRequests.size).toBe(0);
            if (terminal === 'terminate') host.terminate();
            else if (terminal === 'exit') worker.emit('exit', 0);
            else worker.emit('error', new Error('Injected Worker failure after transport fulfilment'));
            const terminalStatus = host.getStatus();
            expect(terminalStatus).toBe(terminal === 'terminate' ? 'closed' : 'error');
            expect(await pending).toMatchObject({ status: 'rejected' });
            expect(host.getStatus()).toBe(terminalStatus);
        } finally {
            host.terminate();
            await pending;
        }
    });

    it('rejects reinitialize even when a second error leaves the same Worker and error status', async () => {
        const { host, worker, sent } = controlledHost();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        worker.emit('error', new Error('First failure'));
        const pending = settle(host.reinitialize());
        try {
            respond(worker, sent[0]);
            expect((host as any).pendingRequests.size).toBe(0);
            worker.emit('error', new Error('Second failure'));
            expect((host as any).worker).toBe(worker);
            expect(await pending).toMatchObject({ status: 'rejected' });
            expect(host.getStatus()).toBe('error');
        } finally {
            host.terminate();
            await pending;
        }
    });

    it.each(methods)('a later INIT on the same Worker invalidates an old %s continuation', async method => {
        const { host, worker, sent } = controlledHost('paused');
        const old = settle(host[method]());
        respond(worker, sent[0]);
        expect((host as any).pendingRequests.size).toBe(0);
        const fresh = settle(host.start());
        try {
            expect((host as any).worker).toBe(worker);
            if (method === 'start') {
                expect(sent).toHaveLength(1);
                expect(await fresh).toMatchObject({ status: 'rejected', message: expect.stringContaining('APP_INSTANCE_REUSE_UNSUPPORTED') });
                expect(await old).toMatchObject({ status: 'fulfilled' });
                expect(host.getStatus()).toBe('ready');
                return;
            }
            expect(sent[1].type).toBe('INIT');
            expect(await old).toMatchObject({ status: 'rejected' });
            expect(host.getStatus()).toBe('paused');
            respond(worker, sent[1]);
            expect(await fresh).toMatchObject({ status: 'fulfilled' });
            expect(host.getStatus()).toBe('ready');
        } finally {
            host.terminate();
            await fresh;
        }
    });

    it('allows a fresh INIT after a prior error when no new failure invalidates it', async () => {
        const { host, worker, sent } = controlledHost();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        worker.emit('error', new Error('Prior failure'));
        const fresh = settle(host.start());
        try {
            respond(worker, sent[0]);
            expect(await fresh).toMatchObject({ status: 'fulfilled' });
            expect(host.getStatus()).toBe('ready');
        } finally { host.terminate(); }
    });

    it('keeps active legacy-ACK transitions and requires RESET/new Host after close', async () => {
        const { host, worker, sent } = controlledHost();
        worker.postMessage = message => {
            sent.push(message);
            if (message.type !== 'TERMINATE') queueMicrotask(() => respond(worker, message));
        };
        let next: AppWorkerHost | undefined;
        try {
            await host.start();
            expect(host.getPersistenceReport().support).toBe('legacy-unverified');
            await host.open();
            expect(host.getStatus()).toBe('running');
            await host.pause();
            expect(host.getStatus()).toBe('paused');
            await host.resume();
            await host.reinitialize();
            expect(host.getStatus()).toBe('running');
            await host.close();
            const count = sent.length;
            await expect(host.open()).rejects.toThrow(/shutdown is pending/);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(sent).toHaveLength(count);expect(host.getStatus()).toBe('closed');
            const reset = await host.releaseWorker();expect(reset).toBe(worker);expect(sent.at(-1)?.type).toBe('RESET');
            next = new AppWorkerHost({ appId: 'r1_app' as any, desktopId: 'r1_desktop' as any, appModulePath: 'not-loaded', existingWorker: reset!, timeout: 1000 });
            expect(next.appInstanceId).not.toBe(host.appInstanceId);await next.start();await next.open();expect(next.getStatus()).toBe('running');expect((next as any).worker).toBe(worker);
        } finally { host.terminate();next?.terminate(); }
    });
});

describe('Stage 8 R1: real node:worker_threads response ordering', () => {
    it.each(methods)('%s rejects when a later external message listener synchronously terminates the Worker', async method => {
        const worker = new Worker(workerSource, { eval: true });
        const host = new AppWorkerHost({
            appId: 'r1_real' as any, desktopId: 'r1_desktop' as any,
            appModulePath: 'not-loaded', existingWorker: worker, timeout: 2000,
        });
        (host as any).status = 'running';
        const exited = new Promise<number>(resolve => worker.once('exit', resolve));
        const pending = settle(host[method]());
        let pendingAtTermination: number | undefined;
        let statusAtTermination: WorkerStatus | undefined;
        worker.once('message', () => {
            pendingAtTermination = (host as any).pendingRequests.size;
            host.terminate();
            statusAtTermination = host.getStatus();
        });
        try {
            const result = await pending;
            await exited;
            expect(pendingAtTermination).toBe(0);
            expect(statusAtTermination).toBe('closed');
            expect(result).toMatchObject({ status: 'rejected' });
            expect(host.getStatus()).toBe('closed');
            expect((host as any).worker).toBeNull();
        } finally {
            host.terminate();
            await worker.terminate();
            await exited;
        }
    });

    it('keeps a terminated Host closed while a new Host publicly initializes a different real Worker', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-r1-worker-'));
        let host: AppWorkerHost | undefined;
        let initial: Worker | undefined;
        let replacement: Worker | undefined;
        let fresh: ReturnType<typeof settle> | undefined;
        let nextHost: AppWorkerHost | undefined;
        let closedRestart: ReturnType<typeof settle> | undefined;
        try {
            const filename = join(directory, 'worker.cjs');
            await writeFile(filename, workerSource);
            initial = new Worker(filename);
            host = new AppWorkerHost({
                appId: 'r1_restart' as any, desktopId: 'r1_desktop' as any,
                appModulePath: 'not-loaded', existingWorker: initial,
                workerScriptPath: filename, timeout: 2000,
            });
            const currentHost = host;
            (host as any).status = 'running';
            const old = settle(host.pause());
            initial.once('message', () => {
                currentHost.terminate();
                closedRestart = settle(currentHost.start());
                nextHost = new AppWorkerHost({ appId: 'r1_restart' as any, desktopId: 'r1_desktop' as any,
                    appModulePath: 'not-loaded', workerScriptPath: filename, timeout: 2000 });
                fresh = settle(nextHost.start());
                replacement = (nextHost as any).worker;
            });
            expect(await old).toMatchObject({ status: 'rejected' });
            expect(replacement).toBeDefined();
            expect(replacement).not.toBe(initial);
            expect(host.getStatus()).toBe('closed');
            expect((host as any).worker).toBeNull();
            expect(await closedRestart).toMatchObject({ status: 'rejected', message: expect.stringContaining('APP_INSTANCE_REUSE_UNSUPPORTED') });
            expect(await fresh).toMatchObject({ status: 'fulfilled' });
            expect(host.getStatus()).toBe('closed');
            expect(nextHost!.getStatus()).toBe('ready');
            expect(nextHost!.appInstanceId).not.toBe(host.appInstanceId);
            expect(nextHost!.getPersistenceReport().support).toBe('legacy-unverified');
            expect((nextHost as any).worker).toBe(replacement);
        } finally {
            host?.terminate();
            nextHost?.terminate();
            await initial?.terminate();
            await replacement?.terminate();
            await fresh;
            await rm(directory, { recursive: true, force: true });
        }
    });
});
