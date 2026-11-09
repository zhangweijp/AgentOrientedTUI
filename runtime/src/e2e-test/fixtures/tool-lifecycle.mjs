import { h } from 'preact';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import Type from 'typebox';
import { createTUIApp, View, AppTools, ToolRef, defineToolSet, defineViewTypeTool,
    useAppLifecycle, useAppRuntimeContext, usePersistentState } from '@aotui/sdk';

const incrementInput = Type.Object({
    view_id: Type.String({ description: 'The counter business ID shown in the open Counter View.' }),
    amount: Type.Number(),
    hold: Type.Optional(Type.Boolean()),
    failure: Type.Optional(Type.String({ enum: ['none', 'partial', 'undeclared', 'throw'] })),
}, { additionalProperties: false });

function Counter({ owner, id, generation, Increment, enabled }) {
    const value = id === 'counter' ? owner.value : owner.secondaryValue;
    return h('section', {}, [
        h('p', {}, `Counter business ID: ${id}. Current value: ${value}. Render generation: ${generation}.`),
        enabled ? h(ToolRef, { tool: Increment }, 'Increment this counter') : h('p', {}, 'Counter actions are disabled.'),
    ]);
}


function createFixtureTools(binding) { return defineToolSet({
Increment: defineViewTypeTool({
        viewType: 'Counter',
        name: 'increment',
        description: 'Increment the counter ' + binding + '; use the business ID shown in the Counter View.',
        inputSchema: incrementInput,
    })
}); }
function Root() {
    const context = useAppRuntimeContext();
    const [, save] = usePersistentState('counter', 0);
    const owner = useMemo(() => ({ value: 0, secondaryValue: 0, live: true, entries: 0, save,
        resource: undefined, handlerRelease: undefined, cleanupRelease: undefined, rejectClose: false }), [save]);
    const [view, setView] = useState({ generation: 1, enabled: true, binding: 1 });
const fixtureTools0 = useMemo(() => createFixtureTools(view.binding), [view.binding]);
    const [, refresh] = useState(0);

    const Increment = fixtureTools0.Increment;
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
    return h(AppTools, { key: view.binding,  definition: fixtureTools0, bindings: {
Increment: { execute: async args => {
            if (!['counter', 'counter2'].includes(args.view_id) || !view.enabled) {
                return { success: false, error: { code: 'VIEW_NOT_OPEN', message: 'The requested counter is not open and enabled.' } };
            }
            owner.entries++; parentPort.postMessage({ type: 'TEST_ENTERED', entries: owner.entries });
            if (args.hold) await new Promise(resolve => { owner.handlerRelease = resolve; });
            // The application decides whether a suspended task may commit.
            if (!owner.live) return { success: false, error: { code: 'APP_STOPPED', message: 'App is stopping' }, effects: 'none' };
            if (args.failure === 'none') return { success: false, error: { code: 'EXPECTED', message: 'No effect' }, effects: 'none' };
            if (args.view_id === 'counter') { owner.value += args.amount; owner.save(owner.value); }
            else owner.secondaryValue += args.amount;
            refresh(x => x + 1);
            if (args.failure === 'partial') return { success: false, error: { code: 'EXPECTED', message: 'One effect' }, effects: 'partial' };
            if (args.failure === 'undeclared') return { success: false, error: { code: 'EXPECTED', message: 'Effects not declared' } };
            if (args.failure === 'throw') throw Error('effect happened');
            return { success: true, data: { value: args.view_id === 'counter' ? owner.value : owner.secondaryValue,
                view_id: args.view_id, generation: view.generation, entries: owner.entries } };
        }, enabled: view.enabled }
} }, h('main', {}, [
        h(View, {kind: 'state', id: 'counter', type: 'Counter', key: view.generation },
            h(Counter, { owner, id: 'counter', generation: view.generation, Increment, enabled: view.enabled })),
        h(View, {kind: 'state', id: 'counter2', type: 'Counter' },
            h(Counter, { owner, id: 'counter2', generation: 1, Increment, enabled: view.enabled })),
    ]));
}
const factory = createTUIApp({ app_name: 'tool_lifecycle', component: Root });
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
