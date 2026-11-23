import * as SDK from '@aotui/sdk';
import { Type } from 'typebox';
import { h } from 'preact';
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
        : { success: true, data: name === 'capacity' ? { nodes: args.file.list.length + 4, view, id } : { args, view, revision, id } };
    if (mode === 'hold') return new Promise(resolve => held.set(id, () => resolve(result())));
    return Promise.resolve(result());
}
// Private protocol fixture: returned arguments are controlled witnesses, not a public App data pattern.
const labelFor = view => view === 'aa' ? 'alpha' : 'beta';
const valueSchema = () => Type.Object({}, { additionalProperties: true });
const specialNames = ['', '__proto__', 'constructor', 'x-aotui-ref', 'x-aotui-parameter-contract', 'line\nname'];
function makeTools() {
    const ref = kind => SDK.refParam(kind, valueSchema());
    const declare = (name, fields, additionalProperties = false) => ({
        description: 'Inspect an explicitly granted original value for the protocol fixture.',
        inputSchema: Type.Object(fields, { additionalProperties }),
        enabled: ({ state }) => state.enabled,
        execute({ input: args, context: { id, state } }) {
            parentPort.postMessage({ type: 'REF_HANDLER_ENTRY', name, receiver:id });
            const param = name.startsWith('special_') ? specialNames[Number(name.slice(8))] : 'file';
            const view = name === 'plain' ? id : args[param].view;
            if (view !== 'aa' && view !== 'bb' || view === 'aa' && !state.show || view === 'bb' && !state.showSecond) {
                parentPort.postMessage({ type: 'REF_APP_GUARD', name, view });
                return { success: false, error: { code: 'VIEW_NOT_OPEN', message: 'The selected fixture object is not open.' } };
            }
            return enter(name, view, args, state.revision, param);
        },
    });
    const definitions = {
        inspect: declare('inspect', { file: ref('Data'), choice: Type.String({ enum: ['7', 'ok'] }),
            text: Type.Optional(Type.String({ maxLength: 1 })),
            tags: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 3 })),
            n: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 3 })),
            meta: Type.Optional(Type.Object({}, { additionalProperties: true, default: literal })) }),
        capacity: declare('capacity', { file: ref('Data') }),
        open_ref: declare('open_ref', { file: ref('Data') }, true),
        typed: declare('typed', { file: ref('File') }),
        plain: declare('plain', {}),
    };
    for (const [index, param] of specialNames.entries())
        definitions['special_' + index] = declare('special_' + index, Object.fromEntries([[param, ref('Data')]]));
    return SDK.defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix,name:"File",tools:definitions});
}
const File = makeTools();
const Guide = SDK.defineViewType({ multiplicity: 'multiple', createId: ({ prefix }) => prefix,name:"Root"});
function NewTools({ view, state }) {
    const label = labelFor(view);
    const file = SDK.useDataRef(label, { label: state.text, view, literal }, { scope: 'protected', refType: 'Data' });
    // Complete effectiveArgs has root + payload + view scalar + list array + N entries: N + 4 nodes.
    const big = SDK.useDataRef('capacity_' + label, { view, list: Array(Math.max(0, state.capacityNodes - 4)).fill(null) }, { scope: 'protected', refType: 'Data' });
    const foreign = SDK.useDataRef('private_' + label, { view }, { scope: 'protected', refType: 'Data' });
    return h('section', {}, [h('p', {}, `Private fixture object: ${view}`),
        h('p', {}, [file('Original file value'), big('List value'), foreign('View-specific value')]),
        h('p', {}, 'Private protocol tools: inspect and plain; availability is supplied by the committed Tool catalog.')]);
}

function Root() {
    const [state, set] = useState({ text: 'A', revision: 1, rule: false, defaultValue: 2, enabled: true, show: true, showSecond: true, refType: '', capacityNodes: 8, tag: 0 });
    useLayoutEffect(() => {
        const receive = message => {
            if (message.type !== 'TEST_COMMAND') return;
            const { command: type, data } = message;
            if (type === 'state') set(previous => ({ ...previous, ...data.patch, tag: data.tag }));
            else if (type === 'mode') { mode = data.mode;parentPort.postMessage({ type: 'REF_V2_CONTROL_ACK', tag: data.tag }); }
            else if (type === 'release') { held.get(data.id)?.();held.delete(data.id);parentPort.postMessage({ type: 'REF_V2_CONTROL_ACK', tag: data.tag }); }
        };
        parentPort.on('message', receive);return () => parentPort.off('message', receive);
    }, []);
    useLayoutEffect(() => { parentPort.postMessage({ type: 'REF_V2_COMMITTED', state, tag: state.tag }); }, [state]);
    const key = JSON.stringify([state.rule,state.defaultValue,state.refType]);
    const view = id => h(SDK.DynamicView, { key: id + key, idPrefix: id, type: File, context: { id, state } }, h(NewTools, { view: id, state }));
    return h('main',{},[
        h(SDK.StaticView, {key: 'root', idPrefix: 'root', type: Guide }, [h('h1', {}, 'Reference Inspector Application Instruction'),
            h('h2', {}, 'What Reference Inspector is'), h('p', {}, 'Inspect displayed values from their original file views.'),
            h('h2', {}, 'How to use Reference Inspector'), h('p', {}, 'Use a displayed reference with the inspect tool. Read its result for the original value.'),
            h('h2', {}, 'Views of Reference Inspector'), state.show || state.showSecond ? h('section', {}, [h('h3', {}, 'File'), h('h4', {}, 'File Instruction'), h('p', {}, 'Displays original values and inspection tools.'), h('h4', {}, 'File Available Tools'), h('p', {}, 'inspect, capacity, open_ref, typed, plain')]) : null]),
        state.show ? view('aa') : null, state.showSecond ? view('bb') : null,
    ]);
}
export default SDK.createTUIApp({ app_name: 'ref_v2_fixture', component: Root, viewTypes:[Guide,File] });
