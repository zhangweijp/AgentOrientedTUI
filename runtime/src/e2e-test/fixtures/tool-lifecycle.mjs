import { h } from 'preact';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { createTUIApp, View, useViewTypeTool,
    experimental_useAppLifecycle, useAppRuntimeContext, usePersistentState } from '@aotui/sdk';

function Counter({ owner, generation, binding }) {
    const [, refresh] = useState(0);
    useViewTypeTool('increment', { description: 'Increment the counter ' + binding,
        params: { amount: { type: 'number', required: true }, hold: { type: 'boolean' },
            failure: { type: 'enum', options: ['none', 'partial', 'undeclared', 'throw'] } } }, async args => {
        owner.entries++; parentPort.postMessage({ type: 'TEST_ENTERED', entries: owner.entries });
        if (args.hold) await new Promise(resolve => { owner.handlerRelease = resolve; });
        // The application decides whether a suspended business operation may commit.
        if (!owner.live) return { success: false, error: { code: 'APP_STOPPED', message: 'App is stopping' }, effects: 'none' };
        if (args.failure === 'none') return { success: false, error: { code: 'EXPECTED', message: 'No effect' }, effects: 'none' };
        owner.value += args.amount; owner.save(owner.value); refresh(x => x + 1);
        if (args.failure === 'partial') return { success: false, error: { code: 'EXPECTED', message: 'One effect' }, effects: 'partial' };
        if (args.failure === 'undeclared') return { success: false, error: { code: 'EXPECTED', message: 'Effects not declared' } };
        if (args.failure === 'throw') throw Error('effect happened');
        return { success: true, data: { value: owner.value, generation, entries: owner.entries } };
    });
    return h('p', {}, 'Counter ' + owner.value);
}
function Root() {
    const context = useAppRuntimeContext();
    const [, save] = usePersistentState('counter', 0);
    const owner = useMemo(() => ({ value: 0, live: true, entries: 0, save,
        resource: undefined, handlerRelease: undefined, cleanupRelease: undefined, rejectClose: false }), []);
    const [view, setView] = useState({ generation: 1, enabled: true, binding: 1 });
    experimental_useAppLifecycle({ stop() { owner.live = false; parentPort.postMessage({ type: 'TEST_STOPPED', value: owner.value }); },
        async close() {
            parentPort.postMessage({ type: 'TEST_CLEANUP_ENTERED' });
            await new Promise(resolve => { owner.cleanupRelease = resolve; });
            const resource = await owner.resource; await resource?.close();
            parentPort.off('message', owner.listener);
            parentPort.postMessage({ type: 'TEST_RESOURCE_CLOSED' });
            if (owner.rejectClose) throw Error('controlled cleanup failure');
        },
    });
    useLayoutEffect(() => {
        owner.resource = open(context.launchConfig.testFile, 'a');
        owner.listener = message => {
            if (message.type !== 'TEST_CONTROL') return;
            if (message.action === 'release-handler') owner.handlerRelease?.();
            if (message.action === 'release-cleanup') owner.cleanupRelease?.();
            if (message.action === 'reject-close') owner.rejectClose = true;
            if (message.action === 'remount' && owner.live) setView(v => ({ ...v, generation: v.generation + 1 }));
            if (message.action === 'rebind' && owner.live) setView(v => ({ ...v, binding: v.binding + 1 }));
            if (message.action === 'disable' && owner.live) setView(v => ({ ...v, enabled: false }));
            if (message.action === 'enable' && owner.live) setView(v => ({ ...v, enabled: true }));
            parentPort.postMessage({ type: 'TEST_ACK', tag: message.tag, value: owner.value, entries: owner.entries });
        };
        parentPort.on('message', owner.listener);
    }, []);
    return h(View, { id: 'counter', type: 'Counter', key: view.generation },
        view.enabled ? h(Counter, { owner, ...view }) : h('p', {}, 'Counter ' + owner.value));
}
const factory = createTUIApp({ app_name: 'tool_lifecycle', component: Root, experimentalAppLifecycle: true });
const initialize = factory.initializeComponent;
factory.initializeComponent = async (...args) => {
    if (args[1].launchConfig.holdInitialization) {
        parentPort.postMessage({ type: 'TEST_INITIALIZING' });
        await new Promise(resolve => {
            const listener = message => {
                if (message.type !== 'TEST_RELEASE_INIT') return;
                parentPort.off('message', listener); resolve();
            };
            parentPort.on('message', listener);
        });
    }
    try { return await initialize(...args); } catch (error) { console.error('TOOL_FIXTURE_INITIALIZE', error); throw error; }
};
export default factory;
