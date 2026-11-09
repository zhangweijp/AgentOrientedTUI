// Private execution fixture: echoed values are test witnesses, not a public App authoring example.
import { h } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import Type from 'typebox';
import { createTUIApp, View, useDataRef, useArrayRef, AppTools, defineToolSet, defineViewTypeTool, refParam } from '@aotui/sdk';

const SENTINEL = 'W03_B_SDK_PRIVATE_b6143_秘密';
let calls = 0, handlerEntries = 0, guards = 0;
let releaseHandler;
parentPort.on('message', message => {
    if (message.type === 'TEST_INSPECT') parentPort.postMessage({ type: 'TEST_COUNTS', tag: message.tag, calls, handlerEntries, guards });
});

const ref = kind => refParam(kind, Type.Object({}, { additionalProperties: true }));
const declaration = (name, fields) => defineViewTypeTool({ viewType: 'File', name, description: 'Private original-Ref contract check',
     inputSchema: Type.Object(fields, { additionalProperties: false }) });
const tools = defineToolSet({
    read: declaration('read', { file: ref('Data'), value: Type.Optional(Type.String()),
        choice: Type.Optional(Type.String({ enum: ['allowed'] })), text: Type.Optional(Type.String({ minLength: 1 })), mode: Type.Optional(Type.String()) }),
    typed: declaration('typed', { file: ref('File') }),
    diagnostics: declaration('diagnostics', Object.fromEntries([['file', ref('Data')],
        ...Array.from({ length: 20 }, (_, i) => ['界😀'.repeat(80) + i, Type.Number()])])),
});
const labelFor = owner => owner === 'aa' ? 'alpha' : 'beta';
function Marker({ owner, text }) {
    const label = labelFor(owner);
    const reference = useDataRef(label, { owner, text, secret: SENTINEL, nested: { items: [1, false, null] } }, { refType: 'Data' });
    const [array] = useArrayRef('array_' + label, [], { itemType: 'Data' });
    // Payload.type deliberately says File while actual metadata remains Data.
    const metadata = useDataRef('metadata_' + label, { type: 'File', owner, revision: 1 }, { refType: 'Data' });
    return h('p', {}, [reference('Stable file'), array('Array'), metadata('Metadata')]);
}
function ForeignMarker() { return h('p', {}, useDataRef('private_beta', { owner: 'bb' }, { refType: 'Data' })('Foreign')); }
function Content({ owner, state }) {
    return h('section', {}, [state.showRef ? h(Marker, { owner, text: state.text, key: 'ref' }) : null,
        owner === 'bb' ? h(ForeignMarker, { key: 'foreign' }) : null, h('p', { key: 'revision' }, 'Revision ' + state.revision)]);
}
function Root() {
    const initial = () => ({ text: 'A', showRef: true, enabled: true, revision: 1 });
    const [state, set] = useState({ aa: initial(), bb: initial(), toolEnabled: true });
    useLayoutEffect(() => {
        const receive = event => {
            const { type, viewId, data } = event.detail;
            if (type === 'configure') set(previous => ({ ...previous,
                ...(typeof data.toolEnabled === 'boolean' ? { toolEnabled: data.toolEnabled } : {}),
                [viewId]: { ...previous[viewId], ...data } }));
            if (type === 'release-handler') releaseHandler?.();
        };
        document.body.addEventListener('aotui:external-event', receive);
        return () => document.body.removeEventListener('aotui:external-event', receive);
    }, []);
    function execute(name, args) {
        parentPort.postMessage({ type: 'TEST_HANDLER_ENTRY', name, entries: ++handlerEntries });
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
    const bindings = Object.fromEntries(Object.keys(tools).map(name => [name, { execute: args => execute(name, args), enabled: state.toolEnabled }]));
    return h(AppTools, { definition: tools, bindings }, h('main', {}, [
        h(View, {kind: 'state', id: 'aa', type: 'File', key: 'aa' }, h(Content, { owner: 'aa', state: state.aa })),
        h(View, {kind: 'state', id: 'bb', type: 'File', key: 'bb' }, h(Content, { owner: 'bb', state: state.bb })),
    ]));
}
export default createTUIApp({ app_name: 'ref_sdk_fixture', component: Root });
