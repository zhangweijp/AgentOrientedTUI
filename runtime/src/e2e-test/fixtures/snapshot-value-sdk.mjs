import { parentPort } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref as publishRef, arrayRef, formatRef, refParam } from '@aotui/sdk';

const SENTINEL = 'W03_B_SDK_PRIVATE_b6143_秘密';
let calls = 0, handlerEntries = 0, guards = 0;
let releaseHandler;
parentPort.on('message', message => {
    if (message.type === 'TEST_INSPECT') parentPort.postMessage({ type: 'TEST_COUNTS', tag: message.tag, calls, handlerEntries, guards });
});

const ref = kind => refParam(kind, Type.Object({}, { additionalProperties: true }));
const declaration = (name, fields) => ({
    description: 'Private original-Ref contract check',
    inputSchema: Type.Object(fields, { additionalProperties: false }),
    enabled: context => context.toolEnabled,
    execute: ({ input, context }) => context.execute(context.receiver, name, input),
});
const FileType = defineViewType()({ multiplicity: 'multiple', name:'File', tools: {
    read: declaration('read', { file: ref('Data'), value: Type.Optional(Type.String()),
        choice: Type.Optional(Type.String({ enum: ['allowed'] })), text: Type.Optional(Type.String({ minLength: 1 })), mode: Type.Optional(Type.String()) }),
    typed: declaration('typed', { file: ref('File') }),
    diagnostics: declaration('diagnostics', Object.fromEntries([['file', ref('Data')],
        ...Array.from({ length: 20 }, (_, i) => ['界😀'.repeat(80) + i, Type.Number()])])),
} });
const labelFor = owner => owner === 'aa' ? 'alpha' : 'beta';
const schema = Type.Object({});
const scalar = { schema, scope: 'protected', refType: 'Data' };
const array = { schema: Type.Array(schema), scope: 'protected', itemType: 'Data' };

export default createApp({
    app_name: 'ref_sdk_fixture', viewTypes: [FileType],
    initialize({ publish: commit, registerLifecycle }) {
        const initial = () => ({ text: 'A', showRef: true, enabled: true, revision: 1 });
        let state = { aa: initial(), bb: initial(), toolEnabled: true };
        function execute(receiver, name, args) {
            parentPort.postMessage({ type: 'TEST_HANDLER_ENTRY', name, receiver, entries: ++handlerEntries });
            const owner = args.file.owner, current = state[owner];
            if (!current || !current.enabled) { guards++; parentPort.postMessage({ type: 'TEST_APP_GUARD', owner, guards });
                return { success: false, error: { code: 'VIEW_NOT_OPEN', message: 'The fixture object is unavailable.' } }; }
            calls++;
            if (name !== 'read') return { success: true };
            parentPort.postMessage({ type: 'TEST_READ_HANDLER_ENTERED', owner, calls });
            if (args.mode === 'throw') throw new Error(SENTINEL);
            if (args.mode === 'reject') return Promise.reject({ get message() { throw new Error(SENTINEL); }, toString() { throw new Error(SENTINEL); } });
            if (args.mode === 'false') return { success: false, error: { code: 'E_INVALID_ARGS', message: 'Business rejected' }, data: { calls } };
            if (args.mode === 'non-json') return { success: true, data: { private: undefined } };
            if (args.mode === 'invalid-result') return { success: 'invalid' };
            if (args.mode === 'oversize') return { success: true, data: { text: 'x'.repeat(525000) } };
            if (args.mode === 'barrier') { parentPort.postMessage({ type: 'TEST_HANDLER_ENTERED', calls });
                return new Promise(resolve => { releaseHandler = () => resolve({ success: true, data: { calls } }); }); }
            return { success: true, data: { owner, args, calls, revision: current.revision } };
        }
        const makeFile = owner => (() => { const handle = createView(FileType, { idPrefix: owner, region: 'dynamic' }); return { handle, frame: () => {
            const current = state[owner], label = labelFor(owner);
            const refs = [], body = [];
            if (current.showRef) {
                const value = publishRef(label, {
                    owner, text: current.text, secret: SENTINEL, nested: { items: [1, false, null] },
                }, scalar);
                const items = arrayRef('array_' + label, [], array);
                // Payload.type deliberately says File while metadata remains Data.
                const metadata = publishRef('metadata_' + label, { type: 'File', owner, revision: 1 }, scalar);
                refs.push(value, items, metadata);
                body.push(formatRef('Stable file', value), formatRef('Array', items), formatRef('Metadata', metadata));
            }
            if (owner === 'bb') {
                const foreign = publishRef('private_beta', { owner: 'bb' }, scalar);
                refs.push(foreign);
                body.push(formatRef('Foreign', foreign));
            }
            body.push('Revision ' + current.revision);
            return handle.frame({ body: body.join('\n\n'), refs, context: { receiver: owner, execute, toolEnabled: state.toolEnabled } });
        } }; })();
        const views = [makeFile('aa'), makeFile('bb')];
        const receive = message => {
            if (message.type !== 'TEST_COMMAND') return;
            const { command: type, viewId, data } = message;
            if (type === 'configure') {
                state = { ...state, ...(typeof data.toolEnabled === 'boolean' ? { toolEnabled: data.toolEnabled } : {}),
                    [viewId]: { ...state[viewId], ...data } };
                commit(() => (views).map(page => page.frame()));
            }
            if (type === 'release-handler') releaseHandler?.();
        };
        parentPort.on('message', receive);
        registerLifecycle({ stop() { parentPort.off('message', receive); } });
        commit(() => (views).map(page => page.frame()));
    },
});
