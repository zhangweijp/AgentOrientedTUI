import { parentPort } from 'node:worker_threads';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk';

const incrementInput = Type.Object({
    amount: Type.Number(),
    hold: Type.Optional(Type.Boolean()),
    failure: Type.Optional(Type.String({ enum: ['declined', 'after-update', 'throw'] })),
}, { additionalProperties: false });

function Counter({ owner, id, generation, enabled }) {
    const value = id === 'counter' ? owner.value : owner.secondaryValue;
    return [
        `Counter business ID: ${id}. Current value: ${value}. Render generation: ${generation}.`,
        ...(enabled ? [] : ['Counter actions are disabled.']),
    ].join('\n\n');
}


const CounterType = defineViewType()({ multiplicity: 'multiple', name:'Counter', tools: {
    increment: {
        description:'Increment the selected Counter.', inputSchema:incrementInput,
        enabled: ({ id, view }) => id === 'counter2' || view.enabled,
        async execute({ input: args, context: { id, owner, view, refresh } }) {
            owner.entries++; parentPort.postMessage({ type: 'TEST_ENTERED', entries: owner.entries });
            if (args.hold) await new Promise(resolve => { owner.handlerRelease = resolve; });
            // The application decides whether a suspended task may commit.
            if (!owner.live) return { success: false, error: { code: 'APP_STOPPED', message: 'App is stopping' } };
            if (args.failure === 'declined') return { success: false, error: { code: 'EXPECTED', message: 'Counter was not updated' } };
            if (id === 'counter') { owner.value += args.amount; await owner.save(owner.value); }
            else owner.secondaryValue += args.amount;
            refresh();
            if (args.failure === 'after-update') return { success: false, error: { code: 'EXPECTED', message: 'Counter was updated' }, data: { counterUpdated: true } };
            if (args.failure === 'throw') throw Error('PRIVATE_COUNTER_EXCEPTION');
            return { success: true, data: { value: id === 'counter' ? owner.value : owner.secondaryValue,
                view_id: id, generation: view.generation, entries: owner.entries } };
        },
    },
} });
export default createApp({
    app_name: 'tool_lifecycle', viewTypes: [CounterType],
    async initialize({ appId, launchConfig, registerLifecycle, publish: commit, signal }) {
        if (launchConfig.holdInitialization) {
            parentPort.postMessage({ type: 'TEST_INITIALIZING' });
            await new Promise(resolve => {
                const listener = message => {
                    if (message.type !== 'TEST_RELEASE_INIT') return;
                    parentPort.off('message', listener);
                    resolve();
                };
                parentPort.on('message', listener);
            });
        }
        const stateDir = launchConfig.AOTUI_DATA_DIR;
        const owner = {
            value: 0, secondaryValue: 0, live: true, entries: 0,
            async save(value) {
                await mkdir(stateDir, { recursive: true });
                await writeFile(join(stateDir, `${appId}-counter.json`), JSON.stringify(value), 'utf8');
            },
            resource: undefined,
            handlerRelease: undefined, cleanupRelease: undefined, rejectClose: false,
        };
        let view = { generation: 1, enabled: true, binding: 1 };
        const makePage = id => (() => { const handle = createView(CounterType, { idPrefix: id, region: 'dynamic' }); return { handle, frame: () => handle.frame({ body: Counter({ owner, id, generation: id === 'counter' ? view.generation : 1, enabled: view.enabled }), context: { id, owner, view, refresh } }) }; })();
        let first = makePage('counter');
        const second = makePage('counter2');
        const refresh = () => commit(() => ([first, second]).map(page => page.frame()));

        registerLifecycle({ stop() {
            owner.live = false;
            parentPort.postMessage({ type: 'TEST_STOPPED', value: owner.value });
        }, async close() {
            parentPort.postMessage({ type: 'TEST_CLEANUP_ENTERED' });
            await new Promise(resolve => { owner.cleanupRelease = resolve; });
            const resource = await owner.resource;
            await resource?.close();
            parentPort.off('message', listener);
            parentPort.postMessage({ type: 'TEST_RESOURCE_CLOSED' });
            if (owner.rejectClose) throw Error('controlled cleanup failure');
        } });
        const listener = message => {
            if (message.type !== 'TEST_CONTROL') return;
            if (message.action === 'release-handler') owner.handlerRelease?.();
            if (message.action === 'release-cleanup') owner.cleanupRelease?.();
            if (message.action === 'reject-close') owner.rejectClose = true;
            if ((message.action === 'remount' || message.action === 'rebind') && owner.live) {
                view = message.action === 'remount' ? { ...view, generation: view.generation + 1 } : { ...view, binding: view.binding + 1 };
                first = makePage('counter');
                refresh();
            }
            if ((message.action === 'disable' || message.action === 'enable') && owner.live) {
                view = { ...view, enabled: message.action === 'enable' };
                refresh();
            }
            parentPort.postMessage({ type: 'TEST_ACK', tag: message.tag, value: owner.value, entries: owner.entries });
        };
        parentPort.on('message', listener);
        owner.resource = open(launchConfig.testFile, 'a');
        if (!signal.aborted) refresh();
    },
});
