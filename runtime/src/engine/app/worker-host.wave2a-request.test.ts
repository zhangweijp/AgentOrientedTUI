import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../../core/snapshot/index.js';
import { AppWorkerHost } from './worker-host.js';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

describe('Wave 2A: one immutable read-only invocation and deterministic failures', () => {
    let host: AppWorkerHost;
    let core: ReturnType<typeof createSnapshotCore>;
    let receiver: any;
    let clock: number;
    let request: { snapshotId: string; toolId: string; viewId: string; args: Record<string, unknown> };
    let handler: ReturnType<typeof vi.fn>;
    let dispatch: ReturnType<typeof vi.spyOn>;
    const toolId = JSON.stringify(['wave2a', 'FileDetail', 'inspect']);

    function publish(seq: number) {
        const views = ['A', 'B'].map(name => ({
            id: 'fd_' + name, viewInstanceId: name, type: 'FileDetail', name,
            kind: 'state', content: { format: 'markdown-v1', value: 'display ' + seq },
        }));
        const result = core.committer.accept({
            schemaVersion: 2, appId: 'wave2a', instanceId: host.appInstanceId,
            producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            views, refs: {}, tools: { [toolId]: {
                id: toolId, name: 'inspect', viewType: 'FileDetail', description: 'Inspect',
                inputSchema: { type: 'object' }, isMutating: false,
                targets: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId, bindingVersion: 1 })),
            } },
        });
        if (result.status !== 'published') throw new Error('Expected committed V2');
        return result.snapshot.id;
    }

    beforeEach(() => {
        clock = 0;
        host = new AppWorkerHost({
            appId: 'wave2a' as any, desktopId: 'test' as any, appModulePath: 'not-loaded',
            snapshotShadow: true, experimentalReadOnlyViewTools: true,
        });
        (host as any).status = 'running';
        (host as any).worker = { off() {}, removeAllListeners() {}, postMessage() {}, terminate() { return Promise.resolve(0); } };
        receiver = (host as any).shadowReceiver;
        core = createSnapshotCore({ now: () => clock, historyTtlMs: 20, leaseTtlMs: 100 });
        core.lifecycle.startApp('wave2a', host.appInstanceId);
        receiver.core = core;
        request = { snapshotId: publish(1), toolId, viewId: 'fd_A', args: { line: 7 } };
        handler = vi.fn(async (message: any) => ({ success: true, data: { target: message.target.viewId, args: message.args } }));
        dispatch = vi.spyOn(host as any, 'sendRequest').mockImplementation(async (message: any) =>
            message.type === 'VIEW_TOOL_INVOKE' ? handler(message) : undefined);
    });
    afterEach(() => {
        host.terminate();
        expect(core.store.inspect().activeLeases).toBe(0);
        vi.restoreAllMocks();
    });

    it.each(['snapshotId', 'toolId', 'viewId', 'args'] as const)('rejects a request %s getter without executing it', async field => {
        const getter = vi.fn(() => request[field]);
        const input = Object.defineProperty({ ...request }, field, { enumerable: true, get: getter });
        const authorize = vi.fn(() => true);
        await expect(host.executeReadOnlyViewTool(input, authorize)).resolves.toMatchObject({
            success: false, error: { code: 'OPERATION_INVALID_ARGS' },
        });
        expect(getter).not.toHaveBeenCalled();
        expect(authorize).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects invalid selectors, shapes and non-JSON input before source acquisition', async () => {
        const cyclic: any = {}; cyclic.self = cyclic;
        const inputs = [null, [], new Date(), { ...request, extra: true },
            { ...request, snapshotId: '' }, { ...request, toolId: ' ' }, { ...request, viewId: 1 },
            { ...request, args: null }, { ...request, args: [] }, { ...request, args: { date: new Date() } },
            { ...request, args: cyclic }, { ...request, args: { value: Infinity } },
            { ...request, args: { value: () => 1 } }, { ...request, [Symbol('extra')]: 1 },
            { ...request, snapshotId: 'x'.repeat(136 * 1024) }];
        const source = vi.spyOn(receiver, 'selectToolSource');
        const authorize = vi.fn(() => true);
        for (const input of inputs) {
            await expect(host.executeReadOnlyViewTool(input as any, authorize)).resolves.toMatchObject({
                success: false, error: { code: 'OPERATION_INVALID_ARGS' },
            });
        }
        expect(source).not.toHaveBeenCalled();
        expect(authorize).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('converts a throwing Proxy trap to invalid args, without claiming the trap cannot run', async () => {
        const trap = vi.fn(() => { throw new Error('Reflection failed'); });
        const authorize = vi.fn(() => true);
        await expect(host.executeReadOnlyViewTool(new Proxy(request, { getPrototypeOf: trap }), authorize))
            .resolves.toMatchObject({ success: false, error: { code: 'OPERATION_INVALID_ARGS' } });
        expect(trap).toHaveBeenCalledTimes(1);
        expect(authorize).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it.each([1, 'false', {}, null, undefined])('requires literal true authorization, received %j', async grant => {
        expect(await host.executeReadOnlyViewTool(request, (() => grant) as any)).toMatchObject({
            success: false, error: { code: 'TOOL_PERMISSION_DENIED' },
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('keeps every source recheck on A when the caller replaces all selectors and args during authorization', async () => {
        const started = gate(); const resume = gate();
        const original = { ...request };
        const source = vi.spyOn(receiver, 'selectToolSource');
        let scope: any;
        const pending = host.executeReadOnlyViewTool(request, async context => {
            scope = context; started.release(); await resume.promise; return true;
        });
        try {
            await started.promise;
            request.snapshotId = publish(2); request.toolId = 'replacement'; request.viewId = 'fd_B'; request.args = { line: 99 };
        } finally { resume.release(); }
        expect(await pending).toMatchObject({ success: true, data: { target: 'fd_A', args: { line: 7 } } });
        expect(source).toHaveBeenCalledTimes(2);
        for (const [selection] of source.mock.calls) expect(selection).toMatchObject({
            snapshotId: original.snapshotId, toolId: original.toolId, viewId: original.viewId,
        });
        expect(Object.isFrozen(scope)).toBe(true);
        expect(Object.isFrozen(scope.args)).toBe(true);
        expect(handler.mock.calls[0][0].args).toBe(scope.args);
    });

    it('cannot launder an expired historical A source with a fresh caller-supplied B snapshot', async () => {
        const started = gate(); const resume = gate();
        const oldId = request.snapshotId;
        const pending = host.executeReadOnlyViewTool(request, async () => {
            started.release(); await resume.promise; return true;
        });
        try {
            await started.promise;
            clock = 1; request.snapshotId = publish(2); request.viewId = 'fd_B';
            clock = 22;
            expect(core.store.getById(oldId).status).toBe('found'); // retained by the initial lease
        } finally { resume.release(); }
        expect(await pending).toMatchObject({ success: false, error: { code: 'SNAPSHOT_EXPIRED' } });
        expect(handler).not.toHaveBeenCalled();
    });

    it.each(['source', 'policy', 'dispatch'] as const)('does not read a %s exception message accessor', async point => {
        const getter = vi.fn(() => { throw new Error('Message accessor executed'); });
        const exception = Object.defineProperty(new Error(), 'message', { get: getter });
        const authorize = vi.fn(() => true);
        if (point === 'source') vi.spyOn(receiver, 'selectToolSource').mockImplementation(() => { throw exception; });
        if (point === 'policy') authorize.mockImplementation(() => { throw exception; });
        if (point === 'dispatch') dispatch.mockRejectedValueOnce(exception);
        await expect(host.executeReadOnlyViewTool(request, authorize)).resolves.toMatchObject({
            success: false, error: { code: 'VIEW_TOOL_DISPATCH_FAILED' },
        });
        expect(getter).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('preserves the existing args depth=24, nodes=10000 and 128 KiB approximate UTF-8 boundaries', async () => {
        const depth = (n: number) => { let value: any = 0; for (let i = 0; i < n; i++) value = { n: value }; return value; };
        const atBytes = '🙂'.repeat((128 * 1024 - 12) / 4);
        const cases = [
            { args: depth(24), valid: true }, { args: depth(25), valid: false },
            { args: { n: Array(9998).fill(null) }, valid: true }, { args: { n: Array(9999).fill(null) }, valid: false },
            { args: { text: atBytes }, valid: true }, { args: { text: atBytes + 'x' }, valid: false },
        ];
        for (const { args, valid } of cases) {
            const authorize = vi.fn(() => false);
            expect(await host.executeReadOnlyViewTool({ ...request, args }, authorize)).toMatchObject({
                success: false, error: { code: valid ? 'TOOL_PERMISSION_DENIED' : 'OPERATION_INVALID_ARGS' },
            });
            expect(authorize).toHaveBeenCalledTimes(valid ? 1 : 0);
        }
        expect(handler).not.toHaveBeenCalled();
    });

    it.each(['close', 'error', 'reset'] as const)('rejects after authorization if the App reached %s', async terminal => {
        const started = gate(); const resume = gate();
        const pending = host.executeReadOnlyViewTool(request, async () => {
            started.release(); await resume.promise; return true;
        });
        try {
            await started.promise;
            if (terminal === 'close') await host.close();
            if (terminal === 'reset') await host.releaseWorker();
            if (terminal === 'error') {
                vi.spyOn(console, 'error').mockImplementation(() => {});
                (host as any).handleError(new Error('Injected Worker failure'));
            }
        } finally { resume.release(); }
        expect(await pending).toMatchObject({ success: false, error: { code: 'APP_STOPPED' } });
        expect(handler).not.toHaveBeenCalled();
    });
});
