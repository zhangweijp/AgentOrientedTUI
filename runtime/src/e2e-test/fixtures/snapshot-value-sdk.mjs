import { h } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';
import { createTUIApp } from '@fixture/sdk/app-factory/createTUIApp.js';
import { View } from '@fixture/sdk/components/View.js';
import { useViewTypeTool } from '@fixture/sdk/hooks/useViewTypeTool.js';
import { useDataRef, useEntityRef } from '@fixture/sdk/hooks/useRef.js';
import { useAppRuntimeContext } from '@fixture/sdk/context/AppRuntimeContext.js';
import { AppRuntimeContext as OldAppContext } from '@fixture/old-sdk/context/AppRuntimeContext.js';
import { View as OldView } from '@fixture/old-sdk/components/View.js';
import { useViewTypeTool as oldTool } from '@fixture/old-sdk/hooks/useViewTypeTool.js';
import { useDataRef as oldRef } from '@fixture/old-sdk/hooks/useRef.js';

const SENTINEL = 'W03_B_SDK_PRIVATE_b6143_秘密';
let calls = 0, oldCalls = 0;
let releaseHandler;
const params = () => ({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' },
    value: { type: 'string' }, choice: { type: 'enum', options: ['allowed'] },
    text: { type: 'string', constraints: { pattern: '^ok$' } }, mode: { type: 'string' } });

function Marker({ owner, text }) {
    const ref = useDataRef('file', { owner, text, secret: SENTINEL, nested: { items: [1, false, null] } });
    const array = useDataRef('array', []);
    const entity = useEntityRef('entity', { entityType: 'File', entityId: owner, entityVersion: '1' });
    return h('p', {}, [ref('Stable file'), array('Array'), entity('Entity')]);
}
function ForeignMarker() { return h('p', {}, useDataRef('bb_only', { other: true })('Foreign')); }
function Content({ owner }) {
    const [state, set] = useState({ text: 'A', showRef: true, enabled: true, revision: 1 });
    useLayoutEffect(() => {
        const receive = event => {
            if (event.detail.viewId !== owner) return;
            if (event.detail.type === 'configure') set(previous => ({ ...previous, ...event.detail.data }));
            if (event.detail.type === 'release-handler') releaseHandler?.();
        };
        document.body.addEventListener('aotui:external-event', receive);
        return () => document.body.removeEventListener('aotui:external-event', receive);
    }, []);
    useViewTypeTool('read', { description: 'Read file', isMutating: false, params: params() }, args => {
        calls++;
        parentPort.postMessage({ type: 'TEST_READ_HANDLER_ENTERED', owner, calls });
        if (args.mode === 'throw') throw new Error(SENTINEL);
        if (args.mode === 'reject') return Promise.reject({ get message() { throw new Error(SENTINEL); }, toString() { throw new Error(SENTINEL); } });
        if (args.mode === 'false') return { success: false, error: { code: 'E_INVALID_ARGS', message: 'Business rejected' }, data: { calls } };
        if (args.mode === 'non-json') return { success: true, data: { private: undefined } };
        if (args.mode === 'invalid-result') return { success: 'invalid' };
        if (args.mode === 'oversize') return { success: true, data: { text: 'x'.repeat(525000) } };
        if (args.mode === 'barrier') {
            parentPort.postMessage({ type: 'TEST_HANDLER_ENTERED', calls });
            return new Promise(resolve => { releaseHandler = () => resolve({ success: true, data: { calls } }); });
        }
        return { success: true, data: { owner, args, calls, revision: state.revision } };
    }, { enabled: state.enabled });
    useViewTypeTool('stats', { description: 'Read counts', isMutating: false, params: {} }, async () => ({ success: true, data: { calls, oldCalls } }));
    for (const [name, extra] of [['optional', { file: { ...params().file, required: false } }],
        ['multi', { file: params().file, second: params().file }],
        ['typed', { file: { ...params().file, refType: 'File' } }],
        ['diagnostics', Object.fromEntries([['file', params().file], ...Array.from({ length: 20 }, (_, i) =>
            ['界😀'.repeat(80) + i, { type: 'number', required: true }])])]]) {
        useViewTypeTool(name, { description: 'Bounded check', isMutating: false, params: extra }, async () => {
            calls++; return { success: true };
        });
    }
    return h('section', {}, [state.showRef ? h(Marker, { owner, text: state.text, key: 'ref' }) : null,
        owner === 'bb' ? h(ForeignMarker, { key: 'foreign' }) : null,
        h('p', { key: 'revision' }, 'Revision ' + state.revision)]);
}
function OldContent() {
    const ref = oldRef('file', { owner: 'legacy', text: 'A' });
    oldTool('read', { description: 'Read file', isMutating: false, params: params() }, async () => { oldCalls++; return { success: true }; });
    oldTool('plain', { description: 'Old ordinary', isMutating: false, params: { fail: { type: 'boolean' } } }, async args => args.fail
        ? { success: false, error: { code: 'BUSINESS_FAILED', message: 'Expected' } }
        : { success: true, data: { calls, oldCalls } });
    return h('p', {}, ref('Old file'));
}
function Root() {
    const context = useAppRuntimeContext();
    return h('main', {}, [h(View, { id: 'aa', type: 'File', key: 'aa' }, h(Content, { owner: 'aa' })),
        h(View, { id: 'bb', type: 'File', key: 'bb' }, h(Content, { owner: 'bb' })),
        h(OldAppContext.Provider, { key: 'old', value: context }, h(OldView, { id: 'legacy', type: 'LegacyFile' }, h(OldContent, {})))]);
}
export default createTUIApp({ app_name: 'ref_sdk_fixture', component: Root });
