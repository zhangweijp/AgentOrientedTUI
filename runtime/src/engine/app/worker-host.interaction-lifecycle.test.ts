import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AppWorkerHost } from './worker-host.js';
import { createViewOwnedTools } from '../../core/index.js';
import type { ScopePolicy, ExecutionBinding, ExecutionFact, InputValidation, OperationQuery } from '../../core/index.js';

function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; }
const success = (): ExecutionFact => ({ kind: 'action', phase: 'entered-returned', outcome: { status: 'succeeded', value: 1 } });

// Controlled Receiver + actual Core: async validator/query are not SDK provider APIs.
function fixture() {
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: '/unused',
        snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalInteractionModes: ['ordinary-v1'] });
    const receiver = (host as any).shadowReceiver;
    const registry = createViewOwnedTools('app', host.appInstanceId), view = registry.mount('v', 'Detail');
    registry.registerTool(view.viewInstanceId, { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} }, isMutating: false }, () => ({ success: true }));
    const tool = registry.listTools()[0];
    receiver.acceptPrepared({ schemaVersion: 2, appId: 'app', instanceId: host.appInstanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 10,
        views: [{ id: 'v', viewInstanceId: view.viewInstanceId, type: 'Detail', name: 'Detail', kind: 'state', content: { format: 'markdown-v1', value: 'value' } }], refs: {},
        tools: { [tool.id]: { id: tool.id, name: tool.name, viewType: tool.viewType, description: tool.description, inputSchema: tool.inputSchema, isMutating: false, targets: tool.targets } } });
    const calls = { project: 0, validate: 0, authorize: 0, execute: 0, read: 0, query: 0 };
    const policy: ScopePolicy = { project: ({ source }) => ({ views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })), refs: [],
        targets: Object.values(source.tools).flatMap(t => t.targets.map(target => ({ toolId: t.id, target }))), content: [] }), authorize: () => true, canReadReceipt: () => true };
    const controls = { project: policy.project, authorize: policy.authorize, read: policy.canReadReceipt,
        validate: (() => ({ ok: true, value: {} })) as ExecutionBinding['validateInput'], execute: (() => success()) as ExecutionBinding['execute'],
        query: (() => ({ status: 'pending' })) as (id: string) => OperationQuery | Promise<OperationQuery> };
    const binding: ExecutionBinding = { identity: {}, mode: 'ordinary', validateInput: (...args) => { calls.validate++;return controls.validate(...args); },
        isLive: () => ({ ok: true }), execute: context => { calls.execute++;return controls.execute(context); },
        operations: { owns: () => true, query: (_meta, id) => { calls.query++;return controls.query(id); } } };
    function open() {
        const opened = receiver.createInteractionScope({ project: (...args: Parameters<ScopePolicy['project']>) => { calls.project++;return controls.project(...args); },
            authorize: (...args: Parameters<ScopePolicy['authorize']>) => { calls.authorize++;return controls.authorize(...args); },
            canReadReceipt: (...args: Parameters<ScopePolicy['canReadReceipt']>) => { calls.read++;return controls.read(...args); } }, { resolve: () => binding });
        if (opened.status !== 'opened') throw Error('scope');return opened.client as import('../../core/index.js').ScopeClient;
    }
    const client = open();
    async function observe(target = client) { const result = await target.observe({ viewIds: ['v'] });if (result.status !== 'observed') throw Error(result.issue.code);
        return { invocationId: 'call', observationId: result.observation.observationId, bindingId: result.observation.bindings[0].bindingId, input: {} }; }
    return { host, receiver, registry, controls, calls, client, open, observe };
}

it.each(['project', 'validate', 'authorize', 'execute', 'read', 'query'] as const)('B2 C17–20 actual %s completion retains Host ownership after physical cleanup', async stage => {
    const f = fixture(), entered = deferred(), gate = deferred<any>();let work: Promise<unknown>;
    if (stage === 'project') { f.controls.project = () => { entered.resolve();return gate.promise; };work = f.client.observe({ viewIds: ['v'] }); }
    else {
        const request = await f.observe();
        if (stage === 'query') {
            f.controls.execute = () => ({ kind: 'action', phase: 'entered-returned', outcome: { status: 'accepted', operationId: 'op' } });await f.client.invoke(request);
            f.controls.query = () => { entered.resolve();return gate.promise; };work = f.client.readReceipt('call');
        } else {
            const hold = () => { entered.resolve();return gate.promise; };
            if (stage === 'validate') f.controls.validate = hold;
            if (stage === 'authorize') f.controls.authorize = hold;
            if (stage === 'execute') f.controls.execute = hold;
            if (stage === 'read') f.controls.read = hold;
            work = f.client.invoke(request);
        }
    }
    await entered.promise;const before = f.host.getResourceReport();expect(before.interactions.retainedScopes).toBe(1);
    f.host.terminate();const completion = f.host.waitForResourceRelease();let done = false;void completion.then(() => { done = true; });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const pending = f.host.getResourceReport();expect(pending.storage.release?.status).toBe('released');expect(pending.interactions.closed).toBe(true);
    expect(pending.interactions.retainedScopes).toBe(1);expect(pending.resourcesReleased).toBe(false);expect(done).toBe(false);
    gate.resolve(stage === 'project' ? { views: [], refs: [], targets: [], content: [] } : stage === 'validate' ? { ok: true, value: {} } satisfies InputValidation : stage === 'execute' ? success() : stage === 'query' ? { status: 'pending' } : true);
    await work;expect(await completion).toMatchObject({ state: 'settled', resourcesReleased: true, interactions: { closed: true, retainedScopes: 0, retainedBytes: 0 } });
    expect(before.interactions.retainedScopes).toBe(1);f.registry.dispose();
});

it('B2 C15 terminal flag precedes abort reentry and blocks safe/raw/legacy entrances without inventing uncertain transport', async () => {
    const f = fixture(), entered = deferred(), gate = deferred<any>(), internals = f.host as any;
    const worker = { off() {}, postMessage() {}, terminate: async () => {} };internals.worker = worker;internals.status = 'running';internals.ordinaryCapability = { worker, version: internals.lifecycleContextVersion };
    const reentry: Promise<unknown>[] = [];
    f.controls.project = ({ signal }) => { signal.addEventListener('abort', () => {
        expect(f.host.hasOrdinaryCapability()).toBe(false);expect(f.host.createInteractionScope(f.controls as any).status).toBe('rejected');
        reentry.push(f.client.observe({ viewIds: ['v'] }), f.host.executeReadOnlyViewTool({} as any, () => { throw Error('must not authorize'); }),
            f.host.executeSnapshotValueRefTool({}, () => { throw Error('must not authorize'); }), f.host.executeVersionedFileReplace({} as any, () => { throw Error('must not authorize'); }, async () => { throw Error('must not write'); }),
            internals.sendRequest({ type: 'VIEW_TOOL_INVOKE', requestId: 'raw' }));
        f.host.beginInteractionClose();
    });entered.resolve();return gate.promise; };
    const observing = f.client.observe({ viewIds: ['v'] });await entered.promise;f.host.beginInteractionClose();await Promise.all(reentry);
    expect(f.calls.project).toBe(1);expect(f.host.getInteractionReport()?.transportUncertain).toBe(false);
    internals.ordinaryCapability = { worker, version: internals.lifecycleContextVersion };expect(f.host.hasOrdinaryCapability()).toBe(false);
    f.host.terminate();gate.resolve({ views: [], refs: [], targets: [], content: [] });await observing;await f.host.waitForResourceRelease();f.registry.dispose();
});

it('B2 C19 concurrent actual callback finally blocks completion until the last resolve or reject', async () => {
    const f = fixture(), gates = [deferred<any>(), deferred<any>()], entered = deferred(), second = f.open();let count = 0;
    f.controls.project = () => { const current = count++;if (count === 2) entered.resolve();return gates[current].promise; };
    const first = f.client.observe({ viewIds: ['v'] }), last = second.observe({ viewIds: ['v'] });await entered.promise;
    f.host.terminate();const complete = f.host.waitForResourceRelease();gates[0].resolve({ views: [], refs: [], targets: [], content: [] });await first;
    expect(f.host.getResourceReport().interactions.retainedScopes).toBe(1);gates[1].reject(Error('policy failure'));await last;
    expect((await complete).interactions).toEqual({ closed: true, retainedScopes: 0, retainedBytes: 0 });f.registry.dispose();
});

it.each(['late-ack', 'prior-error', 'reinitialize'] as const)('B2 C15/25 legacy transport INIT may finish after %s while all interaction entrances remain permanently closed', async scenario => {
    let init: any, handlers = 0, reinitializes = 0;
    class Transport extends EventEmitter {
        threadId = 1;
        postMessage(message: any) {
            if (message.type.startsWith('VIEW_TOOL_')) handlers++;
            if (message.type === 'APP_REINITIALIZE') reinitializes++;
            if (message.type === 'INIT') { init = message;return; }
            if (message.type === 'TERMINATE') return;
            queueMicrotask(() => this.emit('message', { type: message.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: message.requestId, success: true }));
        }
        async terminate() { this.threadId = -1;this.emit('exit', 0);return 0; }
    }
    // The original Shadow start contract rejects any INIT after status=error.
    // Successful prior-error INIT is a legacy transport case with no Shadow.
    const shadow = scenario !== 'prior-error';
    const worker = new Transport(), host = new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', existingWorker: worker as any,
        snapshotShadow: shadow, experimentalReadOnlyViewTools: shadow, experimentalVersionedMutations: shadow,
        experimentalInteractionModes: shadow ? ['ordinary-v1', 'ordinary-v2', 'snapshot-value-v1', 'snapshot-value-v2', 'create-if-absent-v1'] : [] });
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        if (scenario === 'prior-error') worker.emit('error', Error('earlier error'));
        if (scenario === 'reinitialize') await host.reinitialize('controlled legacy transport');
        const starting = host.start();expect(init.type).toBe('INIT');if (scenario === 'late-ack') host.beginInteractionClose();
        worker.emit('message', { type: 'INIT_RESPONSE', requestId: init.requestId, success: true, appInstanceId: init.appInstanceId, acceptedCapabilities: init.requestedCapabilities });
        await starting;await host.open();expect(host.getStatus()).toBe('running');
        for (const available of [() => host.hasOrdinaryCapability(), () => host.hasOrdinaryParametersCapability(), () => host.hasSnapshotValueRefCapability(),
            () => host.hasSnapshotValueParametersCapability(), () => host.hasCreateIfAbsentCapability()]) expect(available()).toBe(false);
        expect(host.createInteractionScope({} as any)).toMatchObject({ issue: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        const authorize = vi.fn(() => true), replace = vi.fn(async () => ({ status: 'written' as const, version: 'unused' }));
        for (const work of [host.executeReadOnlyViewTool({} as any, authorize), host.executeSnapshotValueRefTool({}, authorize),
            host.executeVersionedFileReplace({} as any, authorize, replace),
            ...['VIEW_TOOL_INVOKE', 'VIEW_TOOL_VALIDATE', 'VIEW_TOOL_INVOKE_ORDINARY_V1', 'VIEW_TOOL_INVOKE_ORDINARY_V2',
                'VIEW_TOOL_INVOKE_REF_V1', 'VIEW_TOOL_INVOKE_REF_V2', 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1'].map(type => (host as any).sendRequest({ type, requestId: type }))])
            expect(await work).toMatchObject({ success: false });
        expect(authorize).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();expect(handlers).toBe(0);expect(reinitializes).toBe(scenario === 'reinitialize' ? 1 : 0);
        expect(host.getResourceReport().interactions).toEqual({ closed: true, retainedScopes: 0, retainedBytes: 0 });
    } finally { logging.mockRestore();host.terminate();await host.waitForResourceRelease(); }
});

it('B2 Q01 original Shadow error guard still rejects a later INIT without a Worker message', async () => {
    const host = new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', snapshotShadow: true,
        experimentalReadOnlyViewTools: true, experimentalInteractionModes: ['ordinary-v1', 'ordinary-v2', 'snapshot-value-v1', 'snapshot-value-v2', 'create-if-absent-v1'] });
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        (host as any).handleError(Error('controlled Shadow failure'));
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect((host as any).worker).toBeNull();expect(host.createInteractionScope({} as any).status).toBe('rejected');
        expect([host.hasOrdinaryCapability(), host.hasOrdinaryParametersCapability(), host.hasSnapshotValueRefCapability(),
            host.hasSnapshotValueParametersCapability(), host.hasCreateIfAbsentCapability()]).toEqual([false, false, false, false, false]);
        expect(host.getResourceReport().interactions.closed).toBe(true);
    } finally { logging.mockRestore();host.terminate();await host.waitForResourceRelease(); }
});
