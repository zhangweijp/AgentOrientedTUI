import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureDOMViews } from './dom-snapshot-producer.js';
import { createSnapshotCore, SemanticProjectionCoordinator } from '../core/index.js';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';

function fixture(ids: string[] = []) {
    const { document } = parseHTML('<html><body><main></main></body></html>'), container = document.querySelector('main')!;
    const attachments = new WeakMap<object, { id: string; type: string; owner: object; bindings: [] }>();
    for (const id of ids) {
        const node = document.createElement('section');
        node.setAttribute('data-view-id', id);
        attachments.set(node, { id, type: 'File', owner: {}, bindings: [] });
        container.appendChild(node);
    }
    const fragments = ids.map(viewId => ({ viewId: viewId as any, viewName: viewId, viewType: 'File', markup: 'stable', kind: 'state' as const }));
    const capture = (current = fragments) => captureDOMViews(container, current, node => attachments.get(node));
    const views = (current = fragments) => capture(current).map(({ owner, bindings, ...view }) => ({
        ...view, viewInstanceId: 'instance-' + view.id, toolBindings: [],
    }));
    return { document, container, fragments, capture, views };
}
const identity = () => ({ appId: 'app', instanceId: 'run' });

it('C04 explicit empty owned inventories produce a legal V5 snapshot with no tools', () => {
    const f = fixture(), core = createSnapshotCore();
    core.lifecycle.startApp('app', 'run');
    const projection = new SemanticProjectionCoordinator({ identity, readFrame: () => ({ views: f.views(), tools: [] }) });
    expect(projection.commit(() => {})).toBe('prepared');
    expect(projection.publishTo(core.committer)).toMatchObject({ status: 'published', snapshot: { views: [], refs: {}, tools: {} } });
    projection.close();
    core.lifecycle.dispose();
});

it('retains an empty-body View beside its healthy sibling and publishes the complete set', () => {
    const f = fixture(['healthy', 'empty']);
    const fragments = f.fragments.map(fragment => ({
        ...fragment, markup: fragment.viewId === 'empty' ? '' : 'HEALTHY_BODY',
    }));
    const core = createSnapshotCore();
    core.lifecycle.startApp('app', 'run');
    const projection = new SemanticProjectionCoordinator({ identity, readFrame: () => ({ views: f.views(fragments), tools: [] }) });
    expect(projection.commit(() => {})).toBe('prepared');
    expect(projection.publishTo(core.committer).status).toBe('published');
    expect(core.store.readLatest('app')).toMatchObject({
        status: 'ready',
        snapshot: { views: [{ id: 'healthy', content: { value: 'HEALTHY_BODY' } }, { id: 'empty', content: { value: '' } }] },
    });
    projection.close();
    core.lifecycle.dispose();
});

it('C06 missing inventories fail closed', () => {
    const f = fixture(['a']);
    for (const value of [undefined, null, {}]) {
        expect(() => captureDOMViews(f.container, f.fragments, value as any)).toThrow();
        const projection = new SemanticProjectionCoordinator({ identity, readFrame: () => ({ views: f.views(), tools: value as any }) });
        expect(projection.commit(() => {})).toBe('failed');
        expect(projection.nextPublication()).toHaveProperty('failure');
    }
});

it('C06 zero fragments with orphan DOM nodes and extra DOM beside owned Views reject', () => {
    for (const ids of [[], ['a']]) {
        const f = fixture(ids), orphan = f.document.createElement('section');
        orphan.setAttribute('data-view-id', 'orphan');
        f.container.appendChild(orphan);
        expect(() => f.capture()).toThrow(/complete set/);
    }
});

it('C06 fragments must be exactly the owned/DOM identity set, including duplicate and missing cases', () => {
    const f = fixture(['a', 'b']);
    expect(f.capture()).toHaveLength(2);
    for (const fragments of [[], [f.fragments[0]], [f.fragments[0], f.fragments[0]], [...f.fragments, f.fragments[0]],
        [f.fragments[0], { ...f.fragments[1], viewId: 'orphan' }]]) expect(() => f.capture(fragments)).toThrow();
    f.container.querySelector('[data-view-id="b"]')!.remove();
    expect(() => f.capture()).toThrow(/complete set/);
});

it('C06 duplicate DOM, unattached nodes, wrong types, Ref owner and Tool target checks remain', () => {
    const f = fixture(['a']); const node = f.container.firstElementChild!;
    const duplicate = node.cloneNode(true); f.container.appendChild(duplicate);
    expect(() => f.capture()).toThrow(/Duplicate/); duplicate.remove();
    expect(() => captureDOMViews(f.container, f.fragments, () => undefined)).toThrow(/attached View owner/);
    expect(() => f.capture([{ ...f.fragments[0]!, viewType: 'Wrong' }])).toThrow(/attached View owner/);
    const refs = new SemanticProjectionCoordinator({ identity, readFrame: () => ({ views: f.views(), tools: [] }) });
    expect(refs.commit(() => { refs.registerRef({ viewId: 'missing', viewInstanceId: 'different' }, 'file', { text: 'x' }); })).toBe('failed');
    expect(refs.nextPublication()).toMatchObject({ failure: { issue: { message: expect.stringMatching(/missing View instance/) } } });

    const schema = compileOrdinarySchema({ type: 'object', properties: {}, additionalProperties: false });
    if (!schema.ok) throw new Error('Invalid fixture schema');
    const tools = new SemanticProjectionCoordinator({ identity, readFrame: () => ({
        views: f.views(), tools: [{ id: JSON.stringify(['app', 'Missing', 'read']), name: 'read', viewType: 'Missing',
            nameSharedAcrossViewTypes: false, description: 'Read', inputSchema: ordinaryParameterProfile(schema.contract) }],
    }) });
    expect(tools.commit(() => {})).toBe('failed');
    expect(tools.nextPublication()).toMatchObject({ failure: { issue: { message: expect.stringMatching(/enabled View binding/) } } });
});
