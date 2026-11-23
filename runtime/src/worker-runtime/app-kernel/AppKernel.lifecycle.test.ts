import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core/internal';
import { detailFrame, publishedTool } from '../../../tests/fixtures/app-frame.js';
import { expect, it, vi } from 'vitest';
import type { AppContext } from '@aotui/core';
import { AppKernel } from './AppKernel.js';
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
function fixture(initialize: (context: any) => Promise<any> | any, extra = {}) {
    let runtime: any;
    const context = { appId: 'app', desktopId: 'd' } as AppContext;
    const kernel = new AppKernel({ ...context, instanceId: 'run', projectionLimits: DEFAULT_PROJECTION_LIMITS, appName: 'test_app', factory: { async initialize(context: any) { runtime = context;return initialize(context); } }, ...extra });
    return { kernel, context, runtime: () => runtime, open: () => kernel.onOpen() };
}
it('passes the App lifecycle port to the App and waits for its cleanup', async () => {
    const close = vi.fn();
    const f = fixture(context => {
        expect(context.appLifecycle).toMatchObject({ protocol: 'app-lifecycle-v2' });
        context.appLifecycle.register({ close });
        return { close() {} };
    });
    await f.open();
    await f.kernel.onClose();
    expect(close).toHaveBeenCalledTimes(1);
});
it.each(['sync', 'async'])('C2-18 %s unmount failure still clears owned registries', async kind => {
    const f = fixture(context => {
        context.defineViewTypes([{ name: 'Detail', multiplicity: 'multiple', tools: [] }]);
        context.publishFrame(() => ({ views: [detailFrame({ refs: [{ scope: 'protected', id: 'key', refType: 'Value', value: {} }] })] }));
        return { close: () => { if (kind === 'sync') throw Error('private sync');return Promise.reject(Error('private async')); } };
    });
    await f.open();expect(f.kernel['viewOwnedTools'].inspect().views).toBe(1);
    expect(Object.keys(f.kernel.getProjectionCoordinator()['prepared']?.refs ?? {})).toHaveLength(1);
    const closing = f.kernel.onClose();expect(f.kernel.onClose()).toBe(closing);await expect(closing).rejects.toMatchObject({ code: 'APP_UNMOUNT_FAILED', message: 'APP_UNMOUNT_FAILED' });
    expect(f.kernel.getProjectionCoordinator()['prepared']).toBeUndefined();expect(f.kernel['viewOwnedTools'].inspect().views).toBe(0);
    expect((f.kernel as any).viewRegistry).toBeUndefined();expect((f.kernel as any).typeTools).toBeUndefined();expect((f.kernel as any).viewKeyToId).toBeUndefined();
});
it('C2-19 closing during initialization owns the late renderer without registering or reviving', async () => {
    const entered = defer(), finish = defer(), unmount = vi.fn();
    const f = fixture(async () => { entered.resolve();await finish.promise;return { close: unmount }; });
    const opening = f.open();expect(f.open()).toBe(opening);await entered.promise;const closing = f.kernel.onClose();
    expect(f.runtime().registerView).toBeUndefined();expect(f.runtime().allocateViewId).toBeUndefined();expect(f.runtime().typeTools).toBeUndefined();
    expect(() => f.runtime().publishFrame(() => ({ views: [] }))).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(f.runtime().markDirty).toBeUndefined();
    await expect(f.kernel.onReinitialize()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');
    finish.resolve();await expect(opening).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');await closing;expect(unmount).toHaveBeenCalledTimes(1);
    await expect(f.open()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');expect(f.kernel.onClose()).toBe(closing);
});
it('C2-19 async unmount is actually awaited and its rejection never becomes a success', async () => {
    const entered = defer(), finish = defer();let ended = false;
    const f = fixture(() => ({ async close() { entered.resolve();await finish.promise;throw Error('private delayed'); } }));await f.open();
    const closing = f.kernel.onClose();void closing.then(() => { ended = true; }, () => { ended = true; });await entered.promise;expect(ended).toBe(false);
    finish.resolve();await expect(closing).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED');expect(ended).toBe(true);
});
it.each(['sync', 'async'])('C2-20 %s delete failure is fixed, called once and joined by independent close cleanup', async kind => {
    const entered = defer(), finish = defer(), unmount = vi.fn(), onDelete = vi.fn(() => { entered.resolve();if (kind === 'async') return finish.promise.then(() => { throw Error('private delete'); });throw Error('private delete'); });
    const f = fixture(() => ({ close: unmount }), { onDelete });await f.open();const deleting = f.kernel.onDelete();expect(f.kernel.onDelete()).toBe(deleting);await entered.promise;
    const closing = f.kernel.onClose();if (kind === 'async') expect(unmount).not.toHaveBeenCalled();finish.resolve();
    await expect(deleting).rejects.toMatchObject({ code: 'APP_DELETE_FAILED', message: 'APP_DELETE_FAILED' });await closing;expect(onDelete).toHaveBeenCalledTimes(1);expect(unmount).toHaveBeenCalledTimes(1);
});

it.each(['delete','close'] as const)('PF01 %s hanging rejects ordinary and Ref parameters on the shared type path without cancelling entered handlers',async stage=>{
    const lifecycle=defer(),entered=defer(),handlerGate=defer(),enteredHandler=defer(),calls:string[]=[];
    const f=fixture(context=>{
        const schema = (properties: Record<string, unknown>) => ({
            type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
        });
        const schemas = {
            held: schema({}),
            parameters: schema({ n: { type: 'number' } }),
            snapshot: schema({ file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }),
        };
        context.defineViewTypes([{ name: 'Detail', multiplicity: 'multiple', tools: Object.entries(schemas)
            .map(([name, inputSchema]) => ({ name, description: name, inputSchema })) }]);
        context.publishFrame(() => ({ views: [detailFrame({ bindings: Object.keys(schemas).map(name => ({
            name, enabled: true, async execute() {
                calls.push(name);
                if (name === 'held') { enteredHandler.resolve(); await handlerGate.promise; }
                return { success: true, data: { value: 19 } };
            },
        })) })] }));
        return {async close(){if(stage==='close'){entered.resolve();await lifecycle.promise;}}};
    },{onDelete:async()=>{entered.resolve();await lifecycle.promise;}});
    await f.open();
    const operations = [
        { ...publishedTool(f.kernel, 'held'), args: {} },
        { ...publishedTool(f.kernel, 'parameters'), args: { n: 1 } },
        { ...publishedTool(f.kernel, 'snapshot'), args: { file: {} } },
    ];
    const invoke = operations.map(({ tool, receiver, args }) => () => f.kernel.invokeBoundTypeTool(tool, receiver, args));
    // Prove every registered mode is usable before the close barrier, not merely rejected everywhere.
    for(const call of invoke.slice(1))expect((await call() as any).phase).toBe('entered-returned');
    const running=invoke[0]();await enteredHandler.promise;const initial=calls.length;
    const closing=stage==='delete'?f.kernel.onDelete():f.kernel.onClose();await entered.promise;
    for (const { tool, receiver } of operations) expect(f.kernel.validateBoundTypeTool(tool, receiver).success).toBe(false);
    for(const call of invoke){const result:any=await call();expect(result.result?.success).toBe(false);if('phase'in result)expect(result.phase).toBe('not-entered');}
    expect(calls).toHaveLength(initial);handlerGate.resolve();expect(await running).toMatchObject({phase:'entered-returned',result:{success:true,data:{value:19}}});
    lifecycle.resolve();await closing;await f.kernel.onClose();expect(f.kernel['viewOwnedTools'].inspect().views).toBe(0);
});
