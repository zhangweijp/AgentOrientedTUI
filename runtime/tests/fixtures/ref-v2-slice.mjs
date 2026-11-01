import * as SDK from '@aotui/sdk';
import { h, Component } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { parentPort } from 'node:worker_threads';

let mode = 'normal', sequence = 0;
const held = new Map(), literal = { 'x-aotui-ref': { kind: 'DATA' }, 'x-aotui-parameter-contract': 'DATA', refSource: 'DATA' };
function enter(name, view, args, revision, refName = 'file') {
    const id = ++sequence;
    parentPort.postMessage({ type: 'REF_V2_HANDLER_ENTER', id, name, view, revision,
        args: name === 'capacity' ? { count: args.file.list.length } : args,
        frozen: Object.isFrozen(args), refFrozen: !args[refName] || Object.isFrozen(args[refName]),
        nestedFrozen: !args[refName]?.list || Object.isFrozen(args[refName].list) });
    if (mode === 'throw') throw Error('REF_V2_PRIVATE_EXCEPTION');
    const result = () => mode === 'business' ? { success: false, data: { retained: true }, error: { code: 'BUSINESS', message: 'Controlled business failure' } }
        : mode === 'malformed' ? { success: true, data: [] }
        : mode === 'huge' ? { success: true, data: { value: 'x'.repeat(600000) } }
        : { success: true, data: name === 'capacity' ? { nodes: args.file.list.length + 3, view, id } : { args, view, revision, id } };
    if (mode === 'hold') return new Promise(resolve => held.set(id, () => resolve(result())));
    return Promise.resolve(result());
}
class Boundary extends Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { parentPort.postMessage({ type: 'REF_V2_UNSUPPORTED' }); }
    render() { return this.state.failed ? h('p', {}, 'Read-only reference support is unavailable') : this.props.children; }
}
function NewTools({ view, state }) {
    const file = SDK.useDataRef('file', { label: state.text, view, literal });
    const big = SDK.useDataRef('big', { list: Array(Math.max(0, state.capacityNodes - 3)).fill(null) });
    const foreign = SDK.useDataRef('foreign-' + view, { view });
    const ref = { type: 'reference', required: true, refSource: 'snapshot-value-v1', ...(state.refType ? { refType: state.refType } : {}) };
    const params = { file: ref, choice: { type: 'enum', options: ['7', 'ok'], required: true },
        text: { type: 'string', constraints: { maxLength: state.rule ? 2 : 1 } },
        tags: { type: 'array', itemType: 'string', constraints: { minLength: 2, maxLength: 3 } },
        n: { type: 'number', default: state.defaultValue, constraints: { min: 1, max: 3 } }, meta: { type: 'object', default: literal } };
    const [Inspect] = SDK.useViewTypeTool('inspect', { description: 'When to use: inspect a displayed file value. How to use: provide its Ref and an output choice.', params, isMutating: false }, args => enter('inspect', view, args, state.revision), { enabled: state.enabled });
    SDK.useViewTypeTool('capacity', { description: 'Count a referenced list', params: { file: ref }, isMutating: false }, args => enter('capacity', view, args, state.revision), { enabled: state.enabled });
    SDK.useViewTypeTool('open_ref', { description: 'Keep extra parameters', params: { file: ref }, additionalProperties: true, isMutating: false }, args => enter('open_ref', view, args, state.revision), { enabled: state.enabled });
    SDK.useViewTypeTool('typed', { description: 'Require an explicitly typed Ref', params: { file: { ...ref, refType: 'File' } }, isMutating: false }, args => enter('typed', view, args, state.revision));
    SDK.useViewTypeTool('plain', { description: 'Ordinary read', params: {}, isMutating: false }, args => enter('plain', view, args, state.revision));
    for (const [index, param] of ['', '__proto__', 'constructor', 'x-aotui-ref', 'x-aotui-parameter-contract', 'line\nname'].entries())
        SDK.useViewTypeTool('special_' + index, { description: 'Preserve an exact own parameter name', params: Object.fromEntries([[param, ref]]), isMutating: false }, args => enter('special_' + index, view, args, state.revision, param));
    return h('section', {}, [h('p', {}, [file('Original file value'), big('List value'), foreign('View-specific value')]), h(Inspect, {}, 'Inspect file')]);
}
function Root() {
    const [state, set] = useState({ text: 'A', revision: 1, rule: false, defaultValue: 2, enabled: true, show: true, showSecond: true, refType: '', capacityNodes: 8, tag: 0 });
    useLayoutEffect(() => {
        const receive = event => {
            const { type, data } = event.detail;
            if (type === 'state') set(previous => ({ ...previous, ...data.patch, tag: data.tag }));
            else if (type === 'mode') { mode = data.mode;parentPort.postMessage({ type: 'REF_V2_CONTROL_ACK', tag: data.tag }); }
            else if (type === 'release') { held.get(data.id)?.();held.delete(data.id);parentPort.postMessage({ type: 'REF_V2_CONTROL_ACK', tag: data.tag }); }
        };
        document.body.addEventListener('aotui:external-event', receive);return () => document.body.removeEventListener('aotui:external-event', receive);
    }, []);
    useLayoutEffect(() => { parentPort.postMessage({ type: 'REF_V2_COMMITTED', state, tag: state.tag }); }, [state]);
    const view = id => h(SDK.View, { key: id, id, type: 'File' }, h(Boundary, {}, h(NewTools, { view: id, state })));
    return h('main', {}, [
        h(SDK.View, { key: 'root', id: 'root', type: 'Root' }, [h('h1', {}, 'Reference Inspector Application Instruction'),
            h('h2', {}, 'What Reference Inspector is'), h('p', {}, 'Inspect displayed values from their original file views.'),
            h('h2', {}, 'How to use Reference Inspector'), h('p', {}, 'Use a displayed reference with the inspect tool. Read its result for the original value.'),
            h('h2', {}, 'Views of Reference Inspector'), state.show || state.showSecond ? h('section', {}, [h('h3', {}, 'File'), h('h4', {}, 'File Instruction'), h('p', {}, 'Displays original values and inspection tools.'), h('h4', {}, 'File Available Tools'), h('p', {}, 'inspect, capacity, open_ref, typed, plain')]) : null]),
        state.show ? view('aa') : null, state.showSecond ? view('bb') : null,
    ]);
}
export default SDK.createTUIApp({ app_name: 'ref_v2_fixture', component: Root });
