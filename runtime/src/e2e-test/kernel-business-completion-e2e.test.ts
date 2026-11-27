import { APP_LIFECYCLE_PROTOCOL, DEFAULT_PROJECTION_LIMITS, type PreparedAppSnapshotDraft } from '@aotui/core';
import { WORKER_PROTOCOL } from '../spi/worker-protocol/types.js';
import { expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the actual built SDK and actual Worker. The raw IPC client deliberately
// overlaps requests so the Worker must enforce its own business completion boundary.
it.each(['tool', 'close'] as const)('joins actual %s and captures its terminal before lifecycle cleanup', async operation => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-business-completion-'));
    const sdk = new URL('../../../sdk/dist/index.js', import.meta.url).href;
    const app = join(dir, 'app.mjs');
    let worker: Worker | undefined;
    try {
        await writeFile(app, `
            import { createApp, createView, defineViewType } from ${JSON.stringify(sdk)};
            import { parentPort } from 'node:worker_threads';
            const emit = (event, fields = {}) => parentPort.postMessage({ type: 'TEST_EVENT', event, ...fields });
            const Root = defineViewType()({ name: 'Root', multiplicity: 'single', region: 'static',
                onClose: { execute: ({ context }) => context.work() },
                tools: { work: { description: 'work', inputSchema: { type: 'object', properties: {} },
                    execute: ({ context }) => context.work() } } });
            export default createApp({ app_name: 'completion', viewTypes: [Root], initialize(author) {
                let release;
                const gate = new Promise(resolve => { release = resolve; });
                const result = { success: true, data: { value: 'before-cleanup' } };
                let entered = 0, stopped = 0, cleaned = 0;
                const receive = msg => {
                    if (msg.type === 'TEST_RELEASE') release();
                    if (msg.type === 'TEST_BARRIER') emit('barrier', { entered, stopped, cleaned });
                };
                parentPort.on('message', receive);
                const work = async () => {
                    entered++;
                    emit('entered');
                    await gate;
                    return result;
                };
                const page = createView(Root);
                author.registerLifecycle({
                    stop() { stopped++; emit('stopped'); },
                    close() {
                        cleaned++;
                        result.data.value = 'after-cleanup';
                        emit('cleaned', { entered, stopped, cleaned });
                        parentPort.off('message', receive);
                    },
                });
                author.publish(() => [page.frame({ body: 'ready', context: { work } })]);
            } });
        `);
        worker = new Worker(new URL('../../dist/worker-runtime/index.js', import.meta.url));
        const messages: Record<string, unknown>[] = [];
        const errors: Error[] = [];
        worker.on('message', value => messages.push(value));
        worker.on('error', error => errors.push(error));
        const send = (message: Record<string, unknown>) => worker!.postMessage(message);
        async function received(predicate: (m: Record<string, unknown>) => boolean) {
            return vi.waitFor(() => {
                expect(errors).toEqual([]);
                const message = messages.find(predicate);
                expect(message).toBeDefined();
                return message!;
            }, { timeout: 3000, interval: 5 });
        }
        const response = (id: string) => received(m => m.requestId === id && m.type !== 'SNAPSHOT_PREPARED' && m.type !== 'SNAPSHOT_PREPARE_FAILED');
        const event = (name: string) => received(m => m.type === 'TEST_EVENT' && m.event === name);
        const identity = { appId: 'completion', instanceId: 'instance-completion' };
        send({ type: 'INIT', requestId: 'init', appId: identity.appId, desktopId: 'desk',
            appInstanceId: identity.instanceId, appName: 'completion', appModulePath: pathToFileURL(app).href,
            protocol: WORKER_PROTOCOL, toolsEnabled: true, projectionLimits: DEFAULT_PROJECTION_LIMITS,
            appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, instanceId: identity.instanceId } });
        expect(await response('init')).toMatchObject({ type: 'INIT_RESPONSE', success: true });
        send({ type: 'APP_OPEN', requestId: 'open' });
        expect(await response('open')).toMatchObject({ type: 'LIFECYCLE_RESPONSE', success: true });
        const draft = (await received(m => m.type === 'SNAPSHOT_PREPARED')).draft as PreparedAppSnapshotDraft;
        const view = draft.views[0]!;
        const binding = view.toolBindings[0]!;
        const { id, name, viewType } = draft.tools[binding.toolId]!;
        const tool = { type: 'VIEW_TOOL_INVOKE', ...identity, tool: { id, name, viewType },
            receiver: { viewId: view.id, viewInstanceId: view.viewInstanceId, activationId: binding.activationId },
            effectiveArgs: {}, localRefs: [] };
        const close = { type: 'VIEW_CLOSE', ...identity, viewId: view.id, viewInstanceId: view.viewInstanceId, closeActivationId: view.closeActivationId };
        send({ ...(operation === 'tool' ? tool : close), requestId: 'business' });
        await event('entered');
        send({ ...(operation === 'tool' ? close : tool), requestId: 'overlap' });
        expect(await response('overlap')).toMatchObject({ terminal: { phase: 'not-entered' } });
        send({ type: 'APP_STOP', requestId: 'stop' });
        expect(await response('stop')).toMatchObject({ success: true });
        await event('stopped');
        send({ type: 'APP_CLOSE', requestId: 'close-first' });
        send({ type: 'APP_CLOSE', requestId: 'close-second' });
        send({ type: 'TEST_BARRIER' });
        expect(await event('barrier')).toMatchObject({ entered: 1, stopped: 1, cleaned: 0 });
        expect(messages.some(m => ['business', 'close-first', 'close-second'].includes(String(m.requestId)))).toBe(false);
        send({ ...tool, requestId: 'after-stop' });
        expect(await response('after-stop')).toMatchObject({ terminal: { phase: 'not-entered' } });
        send({ type: 'TEST_RELEASE' });
        expect(await response('business')).toMatchObject({ terminal: { phase: 'entered-returned',
            result: { success: true, data: { value: 'before-cleanup' } } } });
        expect(await event('cleaned')).toMatchObject({ entered: 1, stopped: 1, cleaned: 1 });
        for (const id of ['close-first', 'close-second']) {
            expect(await response(id)).toMatchObject({ success: true, appCleanup: { state: 'completed' } });
        }
        expect(messages.filter(m => m.event === 'cleaned')).toHaveLength(1);
    } finally {
        await worker?.terminate();
        await rm(dir, { recursive: true, force: true });
    }
}, 15000);
