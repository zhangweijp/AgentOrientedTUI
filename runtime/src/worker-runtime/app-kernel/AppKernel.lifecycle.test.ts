import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { detailFrame, publishedTool } from '../../../tests/fixtures/app-frame.js';
import { expect, it, vi } from 'vitest';
import type { AppContext } from '@aotui/core';
import { AppKernel } from './AppKernel.js';
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
function fixture(initialize: (context: any) => Promise<any> | any, extra = {}) {
    let runtime: any;
    const context = { appId: 'app', desktopId: 'd' } as AppContext;
    const kernel = new AppKernel({ ...context, instanceId: 'run', projectionLimits: DEFAULT_PROJECTION_LIMITS, factory: { async initialize(context: any) { runtime = context;return initialize(context); } }, ...extra });
    return { kernel, context, runtime: () => runtime, open: () => kernel.onOpen() };
}
it('passes the App lifecycle port to the App and waits for its cleanup', async () => {
    const close = vi.fn();
    const f = fixture(context => {
        expect(context.appLifecycle).toMatchObject({ protocol: 'app-lifecycle-v3' });
        context.appLifecycle.register({ close });
        context.defineViewTypes([]); context.publishFrame(() => ({ views: [] }));
    });
    await f.open();
    await f.kernel.onClose();
    expect(close).toHaveBeenCalledTimes(1);
});
it.each(['sync', 'async'])('C2-18 %s unmount failure still clears owned registries', async kind => {
    const f = fixture(context => {
        context.defineViewTypes([{ name: 'Detail', multiplicity: 'multiple', tools: [] }]);
        context.publishFrame(() => ({ views: [detailFrame({ refs: [{ valueSchema: { type: 'object' }, scope: 'protected', id: 'key', refType: 'Value', value: {} }] })] }));
        context.appLifecycle.register({ close: () => { if (kind === 'sync') throw Error('private sync');return Promise.reject(Error('private async')); } });
    });
    await f.open();expect(f.kernel['viewOwnedTools'].inspect().views).toBe(1);
    expect(Object.keys(f.kernel.getProjectionCoordinator()['prepared']?.refs ?? {})).toHaveLength(1);
    const closing = f.kernel.onClose();expect(f.kernel.onClose()).toBe(closing);await expect(closing).rejects.toMatchObject({ code: 'APP_UNMOUNT_FAILED', message: 'APP_UNMOUNT_FAILED' });
    expect(f.kernel.getProjectionCoordinator()['prepared']).toBeUndefined();expect(f.kernel['viewOwnedTools'].inspect().views).toBe(0);
    expect((f.kernel as any).viewRegistry).toBeUndefined();expect((f.kernel as any).typeTools).toBeUndefined();expect((f.kernel as any).viewKeyToId).toBeUndefined();
});
it('C2-19 closing during initialization joins the late registered owner without reviving', async () => {
    const entered = defer(), finish = defer(), unmount = vi.fn();
    const f = fixture(async context => { entered.resolve();await finish.promise;context.appLifecycle.register({ close: unmount }); });
    const opening = f.open();expect(f.open()).toBe(opening);await entered.promise;const closing = f.kernel.onClose();
    expect(f.runtime().registerView).toBeUndefined();expect(f.runtime().allocateViewId).toBeUndefined();expect(f.runtime().typeTools).toBeUndefined();
    expect(f.runtime().publishFrame(() => ({ views: [] }))).toMatchObject({ ok: false, state: 'preserved', issue: { code: 'APP_STOPPED' } });
    expect(f.runtime().markDirty).toBeUndefined();
    finish.resolve();await expect(opening).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');await closing;expect(unmount).toHaveBeenCalledTimes(1);
    await expect(f.open()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');expect(f.kernel.onClose()).toBe(closing);
});
it('C2-19 async unmount is actually awaited and its rejection never becomes a success', async () => {
    const entered = defer(), finish = defer();let ended = false;
    const f = fixture(context => { context.appLifecycle.register({ async close() { entered.resolve();await finish.promise;throw Error('private delayed'); } }); context.defineViewTypes([]); context.publishFrame(() => ({ views: [] })); });await f.open();
    const closing = f.kernel.onClose();void closing.then(() => { ended = true; }, () => { ended = true; });await entered.promise;expect(ended).toBe(false);
    finish.resolve();await expect(closing).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED');expect(ended).toBe(true);
});
it('PF01 closing rejects ordinary and Ref parameters on the shared type path without cancelling entered handlers',async ()=>{
    const lifecycle=defer(),entered=defer(),handlerGate=defer(),enteredHandler=defer(),calls:string[]=[];
    const f=fixture(context=>{
        const schema = (properties: Record<string, unknown>) => ({
            type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
        });
        const schemas = {
            held: schema({}),
            parameters: schema({ n: { type: 'number' } }),
            snapshot: schema({ file: { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }),
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
        context.appLifecycle.register({ async close(){entered.resolve();await lifecycle.promise;} });
    });
    await f.open();
    const operations = [
        { ...publishedTool(f.kernel, 'held'), args: {} },
        { ...publishedTool(f.kernel, 'parameters'), args: { n: 1 } },
        { ...publishedTool(f.kernel, 'snapshot'), args: { file: {} } },
    ];
    const invoke = operations.map(({ tool, receiver, args }) => () => f.kernel.invokeBoundTypeTool(tool, receiver, args, terminal => terminal));
    // Prove every registered mode is usable before the close barrier, not merely rejected everywhere.
    for(const call of invoke.slice(1))expect((await call() as any).phase).toBe('entered-returned');
    const running=invoke[0]();await enteredHandler.promise;const initial=calls.length;
    const closing=f.kernel.onClose();
    for (const { tool, receiver } of operations) expect(f.kernel.validateBoundTypeTool(tool, receiver).success).toBe(false);
    for(const call of invoke){const result:any=await call();expect(result.result?.success).toBe(false);if('phase'in result)expect(result.phase).toBe('not-entered');}
    expect(calls).toHaveLength(initial);expect(f.kernel['viewOwnedTools'].inspect().views).toBe(1);handlerGate.resolve();expect(await running).toMatchObject({phase:'entered-returned',result:{success:true,data:{value:19}}});
    await entered.promise;lifecycle.resolve();await closing;await f.kernel.onClose();expect(f.kernel['viewOwnedTools'].inspect().views).toBe(0);
});
