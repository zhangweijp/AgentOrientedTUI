import { h } from 'preact';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import Type from 'typebox';
import { createTUIApp, View, defineViewType,
    useAppLifecycle, useAppRuntimeContext, usePersistentState } from '@aotui/sdk';

const incrementInput = Type.Object({
    amount: Type.Number(),
    hold: Type.Optional(Type.Boolean()),
    failure: Type.Optional(Type.String({ enum: ['declined', 'after-update', 'throw'] })),
}, { additionalProperties: false });

function Counter({ owner, id, generation, enabled }) {
    const value = id === 'counter' ? owner.value : owner.secondaryValue;
    return h('section', {}, [
        h('p', {}, `Counter business ID: ${id}. Current value: ${value}. Render generation: ${generation}.`),
        enabled ? null : h('p', {}, 'Counter actions are disabled.'),
    ]);
}


const CounterType = defineViewType()({ name:'Counter', tools: {
    increment: {
        description:'Increment the selected Counter.', inputSchema:incrementInput,
        enabled: ({ id, view }) => id === 'counter2' || view.enabled,
        async execute({ input: args, context: { id, owner, view, refresh } }) {
            owner.entries++; parentPort.postMessage({ type: 'TEST_ENTERED', entries: owner.entries });
            if (args.hold) await new Promise(resolve => { owner.handlerRelease = resolve; });
            // The application decides whether a suspended task may commit.
            if (!owner.live) return { success: false, error: { code: 'APP_STOPPED', message: 'App is stopping' } };
            if (args.failure === 'declined') return { success: false, error: { code: 'EXPECTED', message: 'Counter was not updated' } };
            if (id === 'counter') { owner.value += args.amount; owner.save(owner.value); }
            else owner.secondaryValue += args.amount;
            refresh(x => x + 1);
            if (args.failure === 'after-update') return { success: false, error: { code: 'EXPECTED', message: 'Counter was updated' }, data: { counterUpdated: true } };
            if (args.failure === 'throw') throw Error('PRIVATE_COUNTER_EXCEPTION');
            return { success: true, data: { value: id === 'counter' ? owner.value : owner.secondaryValue,
                view_id: id, generation: view.generation, entries: owner.entries } };
        },
    },
} });
function Root() {
    const context = useAppRuntimeContext();
    const [, save] = usePersistentState('counter', 0);
    const owner = useMemo(() => ({ value: 0, secondaryValue: 0, live: true, entries: 0, save,
        resource: undefined, handlerRelease: undefined, cleanupRelease: undefined, rejectClose: false }), [save]);
    const [view, setView] = useState({ generation: 1, enabled: true, binding: 1 });
    const [, refresh] = useState(0);

    useAppLifecycle({ stop() { owner.live = false; parentPort.postMessage({ type: 'TEST_STOPPED', value: owner.value }); },
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
    const pageContext = id => ({ id, owner, view, refresh });
    return h('main', {}, [
        h(View, {kind: 'state', id: 'counter', type: CounterType, key: view.generation + ':' + view.binding, context:pageContext('counter') },
            h(Counter, { owner, id: 'counter', generation: view.generation, enabled: view.enabled })),
        h(View, {kind: 'state', id: 'counter2', type: CounterType, context:pageContext('counter2') },
            h(Counter, { owner, id: 'counter2', generation: 1, enabled: view.enabled })),
    ]);
}
const factory = createTUIApp({persistence:true, app_name: 'tool_lifecycle', component: Root, viewTypes:[CounterType] });
const initialize = factory.initialize;
factory.initialize = async (...args) => {
    if (args[0].launchConfig.holdInitialization) {
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
